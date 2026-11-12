/**
 * Makes the database hold "one review of a person for each cycle".
 *
 * The code already refuses a second review for the same person and cycle, but
 * two requests at the same moment (a launch and an Employee Management change,
 * say) could both pass that check. This adds a unique index over
 * (employeeId, cycleId) for the reviews that belong to a cycle. Reviews written
 * by hand, with no cycle, are not covered.
 *
 * Safe by default: it only REPORTS until you pass --apply. A database that
 * already has two reviews for the same person and cycle is left alone and
 * listed, because which one to keep is HR's decision: nothing is merged or
 * deleted here. Fix those (close or delete the extra review in the app), then
 * run it again. A database that has the index already is skipped.
 *
 * Run `db:sync-tenant-columns` first so the `cycleId` column exists.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-review-cycle-unique-index.ts [--apply]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import {
  createPlatformConnection,
  createTenantConnection,
  tenantDatabaseName,
  writeOpsLog,
} from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

const INDEX_NAME = 'performance_review_employee_cycle_unique_idx';

interface TenantRow {
  id: string;
  name: string;
}

interface Duplicate {
  employeeId: string;
  cycleId: string;
  reviews: number;
  reviewIds: string[];
}

interface TenantOutcome {
  tenantId: string;
  name: string;
  database: string;
  /** What happened, or would happen without --apply. */
  result: 'CREATED' | 'WOULD_CREATE' | 'ALREADY_THERE' | 'BLOCKED_BY_DUPLICATES' | 'SKIPPED' | 'FAILED';
  duplicates: Duplicate[];
  note?: string;
}

async function checkTenant(tenant: TenantRow, apply: boolean): Promise<TenantOutcome> {
  const database = tenantDatabaseName(tenant.id);
  const outcome: TenantOutcome = { tenantId: tenant.id, name: tenant.name, database, result: 'SKIPPED', duplicates: [] };
  const connection = createTenantConnection(database);
  try {
    await connection.authenticate();
    const columns = await connection.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'performance_reviews' AND column_name IN ('employeeId', 'cycleId')`,
      { type: QueryTypes.SELECT },
    );
    if (columns.length < 2) {
      outcome.note = 'there is no performance_reviews.cycleId yet: run db:sync-tenant-columns first';
      return outcome;
    }

    const [existing] = await connection.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'performance_reviews' AND indexname = '${INDEX_NAME}'`,
      { type: QueryTypes.SELECT },
    );
    if (Number(existing?.count ?? 0) > 0) {
      outcome.result = 'ALREADY_THERE';
      return outcome;
    }

    const rows = await connection.query<{ employeeId: string; cycleId: string; reviews: string; reviewIds: string[] }>(
      `SELECT "employeeId", "cycleId", COUNT(*) AS reviews, array_agg(id::text ORDER BY "createdAt") AS "reviewIds"
         FROM performance_reviews
        WHERE "cycleId" IS NOT NULL
        GROUP BY "employeeId", "cycleId"
       HAVING COUNT(*) > 1`,
      { type: QueryTypes.SELECT },
    );
    outcome.duplicates = rows.map((row) => ({ employeeId: row.employeeId, cycleId: row.cycleId, reviews: Number(row.reviews), reviewIds: row.reviewIds }));
    if (outcome.duplicates.length > 0) {
      outcome.result = 'BLOCKED_BY_DUPLICATES';
      return outcome;
    }

    if (!apply) {
      outcome.result = 'WOULD_CREATE';
      return outcome;
    }
    await connection.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON performance_reviews ("employeeId", "cycleId") WHERE "cycleId" IS NOT NULL`);
    outcome.result = 'CREATED';
  } catch (error: any) {
    outcome.result = 'FAILED';
    outcome.note = error?.parent?.message || error?.message || String(error);
  } finally {
    await connection.close();
  }
  return outcome;
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  const platform = createPlatformConnection();
  let tenants: TenantRow[];
  try {
    tenants = await platform.query<TenantRow>(`SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY' ORDER BY "createdAt" ASC`, { type: QueryTypes.SELECT });
  } finally {
    await platform.close();
  }

  console.log(`${apply ? '' : '[report only, pass --apply to create the index] '}Checking ${tenants.length} tenant database(s) for ${INDEX_NAME}.\n`);

  const outcomes: TenantOutcome[] = [];
  for (const tenant of tenants) {
    const outcome = await checkTenant(tenant, apply);
    outcomes.push(outcome);
    const line = `${outcome.result.padEnd(22)} ${tenant.name} (${outcome.database})`;
    if (outcome.result === 'FAILED') console.error(`! ${line}: ${outcome.note}`);
    else if (outcome.result === 'BLOCKED_BY_DUPLICATES') {
      console.warn(`~ ${line}: ${outcome.duplicates.length} person/cycle pair(s) have more than one review`);
      for (const duplicate of outcome.duplicates) console.warn(`    employee ${duplicate.employeeId}, cycle ${duplicate.cycleId}: ${duplicate.reviewIds.join(', ')}`);
    } else if (outcome.result === 'SKIPPED') console.warn(`~ ${line}: ${outcome.note}`);
    else console.log(`- ${line}`);
  }

  const count = (result: TenantOutcome['result']) => outcomes.filter((outcome) => outcome.result === result).length;
  const logPath = writeOpsLog('add-review-cycle-unique-index.json', { ranAt: new Date().toISOString(), apply, tenantCount: tenants.length, outcomes });
  console.log(
    `\n${count('CREATED')} created, ${count('WOULD_CREATE')} would be created, ${count('ALREADY_THERE')} already there, ${count('BLOCKED_BY_DUPLICATES')} blocked by duplicates, ${count('SKIPPED')} skipped, ${count('FAILED')} failed.`,
  );
  console.log(`Ops log: ${logPath}`);
  if (count('FAILED') > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Review unique index check failed:', error.message);
  process.exit(1);
});
