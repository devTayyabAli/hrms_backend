/**
 * Payroll Phase 2: the `payslips` table, in every tenant database.
 *
 * A payslip holds only its number and email delivery state; every amount is
 * read from the locked payroll_records row it references. Creates the table
 * (and its enum) only where missing — the dev server's schema sync may
 * already have created it from the model — and adds any later columns.
 * Idempotent.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-payslips-table.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes, Sequelize } from 'sequelize';
import {
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  tenantDatabaseName,
} from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

const DDL = `
  CREATE TABLE IF NOT EXISTS payslips (
    "id" UUID PRIMARY KEY,
    "tenantId" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRecordId" UUID NOT NULL REFERENCES payroll_records("id") ON UPDATE CASCADE,
    "employeeId" UUID NOT NULL,
    "payslipNumber" VARCHAR(32) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    "generatedByUserId" UUID,
    "emailStatus" enum_payslips_emailStatus NOT NULL DEFAULT 'NOT_SENT',
    "emailedTo" VARCHAR(255),
    "emailedAt" TIMESTAMP WITH TIME ZONE,
    "emailedByUserId" UUID,
    "emailedByEmail" VARCHAR(255),
    "emailError" VARCHAR(300),
    "emailQueuedAt" TIMESTAMP WITH TIME ZONE,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS payslip_record_unique ON payslips ("payrollRecordId");
  CREATE UNIQUE INDEX IF NOT EXISTS payslip_number_unique ON payslips ("payslipNumber");
  CREATE UNIQUE INDEX IF NOT EXISTS payslip_sequence_unique ON payslips ("sequence");
  CREATE INDEX IF NOT EXISTS payslip_employee_idx ON payslips ("employeeId");
  CREATE INDEX IF NOT EXISTS payslip_run_idx ON payslips ("payrollRunId");
`;

/** Columns added after the table first shipped, for tenants that already have it. */
const LATER_COLUMNS: { column: string; type: string }[] = [{ column: 'emailQueuedAt', type: 'TIMESTAMP WITH TIME ZONE' }];

const exists = async (connection: Sequelize, table: string) =>
  (
    await connection.query(`SELECT 1 FROM information_schema.tables WHERE table_name = :table`, {
      type: QueryTypes.SELECT,
      replacements: { table },
    })
  ).length > 0;

async function migrate(connection: Sequelize, dryRun: boolean): Promise<string> {
  if (!(await exists(connection, 'payroll_records'))) return 'payroll_records missing, skipped';
  if (await exists(connection, 'payslips')) {
    const have = new Set(
      (
        await connection.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'payslips'`,
          { type: QueryTypes.SELECT },
        )
      ).map((row) => row.column_name),
    );
    const missing = LATER_COLUMNS.filter((col) => !have.has(col.column));
    if (!missing.length) return 'up to date';
    if (!dryRun) {
      for (const col of missing) await connection.query(`ALTER TABLE payslips ADD COLUMN IF NOT EXISTS "${col.column}" ${col.type}`);
    }
    return `payslips: +${missing.map((col) => col.column).join(', ')}`;
  }
  if (!dryRun) {
    await connection.query(
      `DO $$ BEGIN CREATE TYPE "enum_payslips_emailStatus" AS ENUM ('NOT_SENT', 'SENDING', 'SENT', 'FAILED');
       EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await connection.query(DDL);
  }
  return 'created payslips';
}

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
      console.log(`${dryRun ? '[dry-run] ' : ''}${tenant.name} (${database}): ${await migrate(connection, dryRun)}`);
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
