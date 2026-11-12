/**
 * Gives open performance reviews that were created before reviewers existed
 * the reviewer they would have had: the employee's reporting manager.
 *
 * A review now has a reviewer (by default the employee's reporting manager).
 * Reviews made earlier have none, which means HR completes them. This fills in
 * the reporting manager for those still open, so managers see them under
 * "Reviewing". Only reviews that are not completed and not published are
 * touched, only where the employee has a manager who still works here, and
 * nothing HR already chose is overwritten (a reviewer that is set is left
 * alone). They are left unpinned, so a later change of manager flags them for HR's
 * decision (they are not moved by themselves).
 *
 * It also gives every review that has no snapshot yet one, rebuilt from the
 * employee as they are now (marked `approximate`), because the best that can
 * be said about a review made before snapshots is who the person is today.
 * Reviews with a snapshot already are left alone. Until a review has one, the
 * rule that keeps completed reviews from a newly assigned manager cannot tell
 * whose it was and does not narrow it.
 *
 * Quiet: nobody is notified. Run `db:sync-tenant-columns` first so the
 * reviewer and snapshot columns exist.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/backfill-review-reviewers.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import {
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  tenantDatabaseName,
  writeOpsLog,
} from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

interface TenantRow {
  id: string;
  name: string;
}

interface TenantOutcome {
  tenantId: string;
  name: string;
  database: string;
  /** Reviews that were (dry run) or were given a reviewer. */
  reviews: number;
  /** Reviews that were (dry run) or were given a snapshot. */
  snapshots: number;
  skipped?: string;
  error?: string;
}

/** Open reviews with no reviewer whose employee has a reporting manager still on the books. */
const OPEN_WITHOUT_REVIEWER = `
  FROM performance_reviews r
  JOIN employees e ON e.id = r."employeeId"
  JOIN employees m ON m.id = e."reportingManagerId" AND m.status IN ('ACTIVE', 'ON_LEAVE')
 WHERE r."reviewerId" IS NULL
   AND r.status <> 'COMPLETED'
   AND r."publishedAt" IS NULL
   AND e."reportingManagerId" IS NOT NULL
   AND e."reportingManagerId" <> r."employeeId"`;

/** Reviews with no snapshot yet, whose employee still has a record. */
const WITHOUT_SNAPSHOT = `
  FROM performance_reviews r
  JOIN employees e ON e.id = r."employeeId"
 WHERE r."employeeSnapshot" IS NULL`;

async function backfillTenant(tenant: TenantRow, dryRun: boolean): Promise<TenantOutcome> {
  const database = tenantDatabaseName(tenant.id);
  const outcome: TenantOutcome = { tenantId: tenant.id, name: tenant.name, database, reviews: 0, snapshots: 0 };
  const connection = createTenantConnection(database);
  try {
    await connection.authenticate();
    const columns = await connection.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'performance_reviews' AND column_name IN ('reviewerId', 'reviewerPinned', 'employeeSnapshot')`,
      { type: QueryTypes.SELECT },
    );
    if (columns.length < 3) {
      outcome.skipped = 'the reviewer columns do not exist yet: run db:sync-tenant-columns first';
      return outcome;
    }
    if (dryRun) {
      const [row] = await connection.query<{ count: string }>(`SELECT COUNT(*) AS count ${OPEN_WITHOUT_REVIEWER}`, { type: QueryTypes.SELECT });
      outcome.reviews = Number(row?.count ?? 0);
      const [snap] = await connection.query<{ count: string }>(`SELECT COUNT(*) AS count ${WITHOUT_SNAPSHOT}`, { type: QueryTypes.SELECT });
      outcome.snapshots = Number(snap?.count ?? 0);
    } else {
      const [, meta] = (await connection.query(
        `UPDATE performance_reviews AS r
            SET "reviewerId" = e."reportingManagerId", "reviewerPinned" = FALSE, "updatedAt" = NOW()
          FROM employees e, employees m
         WHERE e.id = r."employeeId"
           AND m.id = e."reportingManagerId" AND m.status IN ('ACTIVE', 'ON_LEAVE')
           AND r."reviewerId" IS NULL
           AND r.status <> 'COMPLETED'
           AND r."publishedAt" IS NULL
           AND e."reportingManagerId" IS NOT NULL
           AND e."reportingManagerId" <> r."employeeId"`,
      )) as [unknown, { rowCount?: number }];
      outcome.reviews = Number(meta?.rowCount ?? 0);

      // After the reviewers, so a review given one above has it in its snapshot.
      const [, snapMeta] = (await connection.query(
        `UPDATE performance_reviews AS r
            SET "employeeSnapshot" = jsonb_build_object(
                  'takenAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'approximate', TRUE,
                  'employee', jsonb_build_object('id', e.id, 'name', btrim(concat(e."firstName", ' ', e."lastName")), 'employeeCode', e."employeeCode"),
                  'departmentId', e."departmentId",
                  'departmentName', (SELECT d.name FROM departments d WHERE d.id = e."departmentId"),
                  'designationId', e."designationId",
                  'designationTitle', (SELECT g.title FROM designations g WHERE g.id = e."designationId"),
                  'employmentType', e."employmentType",
                  'reportingManagerId', e."reportingManagerId",
                  'reportingManagerName', (SELECT btrim(concat(m."firstName", ' ', m."lastName")) FROM employees m WHERE m.id = e."reportingManagerId"),
                  'reviewerId', r."reviewerId",
                  'reviewerName', (SELECT btrim(concat(v."firstName", ' ', v."lastName")) FROM employees v WHERE v.id = r."reviewerId")
                ),
                "updatedAt" = NOW()
          FROM employees e
         WHERE e.id = r."employeeId"
           AND r."employeeSnapshot" IS NULL`,
      )) as [unknown, { rowCount?: number }];
      outcome.snapshots = Number(snapMeta?.rowCount ?? 0);
    }
  } catch (error: any) {
    outcome.error = error?.parent?.message || error?.message || String(error);
  } finally {
    await connection.close();
  }
  return outcome;
}

async function main(): Promise<void> {
  const { dryRun } = parseCliFlags();
  const platform = createPlatformConnection();
  let tenants: TenantRow[];
  try {
    tenants = await platform.query<TenantRow>(`SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY' ORDER BY "createdAt" ASC`, { type: QueryTypes.SELECT });
  } finally {
    await platform.close();
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Giving open reviews their reporting manager as reviewer, in ${tenants.length} tenant database(s).\n`);

  const outcomes: TenantOutcome[] = [];
  let total = 0;
  let totalSnapshots = 0;
  let failed = 0;
  for (const tenant of tenants) {
    const outcome = await backfillTenant(tenant, dryRun);
    outcomes.push(outcome);
    if (outcome.error) {
      failed++;
      console.error(`! ${tenant.name} (${outcome.database}): ${outcome.error}`);
    } else if (outcome.skipped) {
      console.warn(`~ ${tenant.name}: skipped, ${outcome.skipped}`);
    } else {
      total += outcome.reviews;
      totalSnapshots += outcome.snapshots;
      console.log(`${outcome.reviews || outcome.snapshots ? (dryRun ? '[dry-run] would update' : 'updated') : '-'} ${tenant.name}: ${outcome.reviews} reviewer(s), ${outcome.snapshots} snapshot(s)`);
    }
  }

  const logPath = writeOpsLog('backfill-review-reviewers.json', { ranAt: new Date().toISOString(), dryRun, tenantCount: tenants.length, totalReviews: total, totalSnapshots, failed, outcomes });
  console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${total} reviewer(s) and ${totalSnapshots} snapshot(s) across ${tenants.length} tenant(s). ${failed} failed.`);
  console.log(`Ops log: ${logPath}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Review reviewer backfill failed:', error.message);
  process.exit(1);
});
