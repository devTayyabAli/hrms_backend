/**
 * Adds the columns that let an approved employee request change attendance:
 *   employee_requests."timeFrom" / "timeTo" / "resolution"
 *   attendance_records."workLocation" / "overtimeMinutes"
 *
 * Dev-mode schema sync only creates missing tables — it never adds a column
 * to one that already exists — so tenants provisioned before these columns
 * existed need them added explicitly. Every column is nullable and nothing is
 * backfilled, so existing rows and the code already running are unaffected.
 * Additive and idempotent; run it before deploying the code that reads them.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-request-resolution-columns.ts [--dry-run]
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

const COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'employee_requests', column: 'timeFrom', type: 'VARCHAR(5)' },
  { table: 'employee_requests', column: 'timeTo', type: 'VARCHAR(5)' },
  { table: 'employee_requests', column: 'resolution', type: 'JSONB' },
  { table: 'attendance_records', column: 'workLocation', type: 'VARCHAR(16)' },
  { table: 'attendance_records', column: 'overtimeMinutes', type: 'INTEGER' },
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
      const existing = await connection.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_name IN ('employee_requests', 'attendance_records')`,
        { type: QueryTypes.SELECT },
      );
      const tables = new Set(existing.map((row) => row.table_name));
      const have = new Set(existing.map((row) => `${row.table_name}.${row.column_name}`));

      const missing = COLUMNS.filter(
        (col) => tables.has(col.table) && !have.has(`${col.table}.${col.column}`),
      );
      if (missing.length === 0) {
        console.log(`- ${tenant.name} (${database}): up to date`);
        continue;
      }
      if (!dryRun) {
        for (const col of missing) {
          await connection.query(
            `ALTER TABLE ${col.table} ADD COLUMN IF NOT EXISTS "${col.column}" ${col.type}`,
          );
        }
      }
      console.log(
        `${dryRun ? '[dry-run] would add' : 'added'} ${missing
          .map((col) => `${col.table}.${col.column}`)
          .join(', ')} for ${tenant.name} (${database})`,
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
