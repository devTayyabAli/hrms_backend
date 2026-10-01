/**
 * Adds roles.dataScope — whose records a role's permissions reach
 * (ORGANIZATION, DEPARTMENT, TEAM, SELF). Null keeps a role on its default:
 * organization-wide, or only-me for the Employee role.
 *
 * Dev-mode schema sync only creates missing tables — it never adds a column
 * to one that already exists — so tenants provisioned before these columns
 * existed need them added explicitly. All nullable; nothing is backfilled.
 * Additive and idempotent; run it before deploying the code that reads them.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-role-data-scope-column.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import {
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  tenantDatabaseName,
} from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

const TABLE = 'roles';
const COLUMNS: { column: string; type: string }[] = [
  { column: 'dataScope', type: 'VARCHAR(16)' },
];

async function main(): Promise<void> {
  const { dryRun } = parseCliFlags();
  const platform = createPlatformConnection();
  let tenants: { id: string; name: string }[];
  try {
    tenants = await platform.query(
      `SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY' ORDER BY "createdAt" ASC`,
      { type: QueryTypes.SELECT },
    );
  } finally {
    await platform.close();
  }

  let failed = 0;
  for (const tenant of tenants) {
    const database = tenantDatabaseName(tenant.id);
    const connection = createTenantConnection(database);
    try {
      const existing = await connection.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = :table`,
        { type: QueryTypes.SELECT, replacements: { table: TABLE } },
      );
      if (existing.length === 0) {
        console.log(`- ${tenant.name} (${database}): no ${TABLE} table yet, skipped`);
        continue;
      }
      const have = new Set(existing.map((row) => row.column_name));
      const missing = COLUMNS.filter((col) => !have.has(col.column));
      if (missing.length === 0) {
        console.log(`- ${tenant.name} (${database}): up to date`);
        continue;
      }
      if (!dryRun) {
        for (const col of missing) {
          await connection.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${col.column}" ${col.type}`);
        }
      }
      console.log(
        `${dryRun ? '[dry-run] would add' : 'added'} ${missing.map((col) => col.column).join(', ')} for ${tenant.name} (${database})`,
      );
    } catch (error: any) {
      failed++;
      console.error(`! ${tenant.name} (${database}): ${error.message}`);
    } finally {
      await connection.close();
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
