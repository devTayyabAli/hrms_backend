/**
 * Payroll Phase 1 schema, for every tenant database:
 *
 * - employees: salary effective date and bank details;
 * - payroll_runs: currency, skipped employees and the lifecycle trail
 *   (created / submitted / approved / returned / paid — who and when);
 * - payroll_records: the calculation snapshot (days, proration, earnings,
 *   each deduction, notes, bank);
 * - salary_revisions and payroll_adjustments: new tables;
 * - entity_audit_logs: created if user-service hasn't yet (same shape).
 *
 * Dev-mode schema sync only creates missing tables — it never adds a column
 * to one that already exists — so existing tenants need the columns added
 * explicitly. Everything is additive: new money/day columns default to 0 and
 * the rest are nullable, so existing runs keep reading as before. Idempotent;
 * run it before deploying the code that reads them.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-payroll-phase1-schema.ts [--dry-run]
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

const MONEY = 'DECIMAL(14,2) NOT NULL DEFAULT 0';
const DAYS = 'DECIMAL(6,2) NOT NULL DEFAULT 0';

const COLUMNS: Record<string, { column: string; type: string }[]> = {
  // bankName / bankAccountNumber / iban already exist in older tenants with
  // these exact sizes — only added where they're missing.
  employees: [
    { column: 'salaryEffectiveFrom', type: 'DATE' },
    { column: 'bankName', type: 'VARCHAR(128)' },
    { column: 'bankAccountTitle', type: 'VARCHAR(150)' },
    { column: 'bankAccountNumber', type: 'VARCHAR(64)' },
    { column: 'iban', type: 'VARCHAR(34)' },
  ],
  payroll_runs: [
    { column: 'currency', type: 'VARCHAR(3)' },
    { column: 'skippedEmployees', type: 'JSONB' },
    { column: 'calculatedAt', type: 'TIMESTAMP WITH TIME ZONE' },
    { column: 'createdByUserId', type: 'UUID' },
    { column: 'submittedAt', type: 'TIMESTAMP WITH TIME ZONE' },
    { column: 'submittedByUserId', type: 'UUID' },
    { column: 'approvedAt', type: 'TIMESTAMP WITH TIME ZONE' },
    { column: 'approvedByUserId', type: 'UUID' },
    { column: 'returnedAt', type: 'TIMESTAMP WITH TIME ZONE' },
    { column: 'returnedByUserId', type: 'UUID' },
    { column: 'returnReason', type: 'VARCHAR(500)' },
    { column: 'paidAt', type: 'TIMESTAMP WITH TIME ZONE' },
    { column: 'paidByUserId', type: 'UUID' },
    { column: 'paymentDate', type: 'DATE' },
    { column: 'paymentReference', type: 'VARCHAR(120)' },
    { column: 'actorEmails', type: 'JSONB' },
  ],
  // Both tables may already exist — the dev server's schema sync creates them
  // from the models — so their later columns are added here too.
  salary_revisions: [{ column: 'changedByEmail', type: 'VARCHAR(255)' }],
  payroll_adjustments: [{ column: 'createdByEmail', type: 'VARCHAR(255)' }],
  payroll_records: [
    { column: 'salaryEffectiveFrom', type: 'DATE' },
    { column: 'workingDays', type: DAYS },
    { column: 'eligibleDays', type: DAYS },
    { column: 'absenceDays', type: DAYS },
    { column: 'unpaidLeaveDays', type: DAYS },
    { column: 'paidLeaveDays', type: DAYS },
    { column: 'paidDays', type: DAYS },
    { column: 'unrecordedDays', type: DAYS },
    { column: 'prorationFactor', type: 'DECIMAL(8,6) NOT NULL DEFAULT 1' },
    { column: 'employedFrom', type: 'DATE' },
    { column: 'employedTo', type: 'DATE' },
    { column: 'dailyRate', type: MONEY },
    { column: 'earnedBasic', type: MONEY },
    { column: 'earnedAllowances', type: MONEY },
    { column: 'overtimeMinutes', type: 'INTEGER NOT NULL DEFAULT 0' },
    { column: 'overtimePay', type: MONEY },
    { column: 'absenceDeduction', type: MONEY },
    { column: 'unpaidLeaveDeduction', type: MONEY },
    { column: 'recurringDeductions', type: MONEY },
    { column: 'adjustmentDeductions', type: MONEY },
    { column: 'notes', type: 'JSONB' },
    { column: 'bankName', type: 'VARCHAR(128)' },
    { column: 'bankAccountTitle', type: 'VARCHAR(150)' },
    { column: 'bankAccountNumber', type: 'VARCHAR(64)' },
    { column: 'iban', type: 'VARCHAR(34)' },
  ],
};

/** Enum types named the way Sequelize names them, so later syncs agree. */
const ENUMS: { name: string; values: string[] }[] = [
  { name: 'enum_payroll_adjustments_type', values: ['EARNING', 'DEDUCTION'] },
  { name: 'enum_entity_audit_logs_action', values: ['CREATE', 'UPDATE', 'DELETE'] },
];

const TABLES: { table: string; ddl: string }[] = [
  {
    table: 'salary_revisions',
    ddl: `CREATE TABLE IF NOT EXISTS salary_revisions (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "employeeId" UUID NOT NULL REFERENCES employees("id") ON UPDATE CASCADE,
      "effectiveFrom" DATE NOT NULL,
      "basicSalary" ${MONEY},
      "allowances" ${MONEY},
      "recurringDeductions" ${MONEY},
      "reason" VARCHAR(300),
      "changedByUserId" UUID,
      "changedByEmail" VARCHAR(255),
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS salary_revision_employee_date_unique
      ON salary_revisions ("employeeId", "effectiveFrom");`,
  },
  {
    table: 'payroll_adjustments',
    ddl: `CREATE TABLE IF NOT EXISTS payroll_adjustments (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "payrollRunId" UUID NOT NULL,
      "payrollRecordId" UUID NOT NULL REFERENCES payroll_records("id") ON DELETE CASCADE ON UPDATE CASCADE,
      "type" enum_payroll_adjustments_type NOT NULL,
      "amount" DECIMAL(14,2) NOT NULL,
      "reason" VARCHAR(300) NOT NULL,
      "createdByUserId" UUID,
      "createdByEmail" VARCHAR(255),
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payroll_adjustment_record_idx ON payroll_adjustments ("payrollRecordId");
    CREATE INDEX IF NOT EXISTS payroll_adjustment_run_idx ON payroll_adjustments ("payrollRunId");`,
  },
  {
    table: 'entity_audit_logs',
    ddl: `CREATE TABLE IF NOT EXISTS entity_audit_logs (
      "id" UUID PRIMARY KEY,
      "tableName" VARCHAR(255) NOT NULL,
      "recordId" VARCHAR(255) NOT NULL,
      "action" enum_entity_audit_logs_action NOT NULL,
      "userId" UUID,
      "changes" JSONB,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL
    );`,
  },
];

const tableExists = async (connection: Sequelize, table: string) =>
  (
    await connection.query(`SELECT 1 FROM information_schema.tables WHERE table_name = :table`, {
      type: QueryTypes.SELECT,
      replacements: { table },
    })
  ).length > 0;

async function migrate(connection: Sequelize, dryRun: boolean): Promise<string[]> {
  const done: string[] = [];

  for (const [table, columns] of Object.entries(COLUMNS)) {
    if (!(await tableExists(connection, table))) {
      done.push(`${table}: table missing, skipped`);
      continue;
    }
    const existing = await connection.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = :table`,
      { type: QueryTypes.SELECT, replacements: { table } },
    );
    const have = new Set(existing.map((row) => row.column_name));
    const missing = columns.filter((col) => !have.has(col.column));
    if (!missing.length) continue;
    if (!dryRun) {
      for (const col of missing) {
        await connection.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${col.column}" ${col.type}`);
      }
    }
    done.push(`${table}: +${missing.map((col) => col.column).join(', ')}`);
  }

  for (const { name, values } of ENUMS) {
    if (dryRun) continue;
    await connection.query(
      `DO $$ BEGIN CREATE TYPE "${name}" AS ENUM (${values.map((v) => `'${v}'`).join(', ')});
       EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
  }

  for (const { table, ddl } of TABLES) {
    if (await tableExists(connection, table)) continue;
    if (table === 'payroll_adjustments' && !(await tableExists(connection, 'payroll_records'))) {
      done.push('payroll_adjustments: payroll_records missing, skipped');
      continue;
    }
    if (table === 'salary_revisions' && !(await tableExists(connection, 'employees'))) {
      done.push('salary_revisions: employees missing, skipped');
      continue;
    }
    if (!dryRun) await connection.query(ddl);
    done.push(`created ${table}`);
  }

  return done;
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
      const done = await migrate(connection, dryRun);
      console.log(
        done.length
          ? `${dryRun ? '[dry-run] ' : ''}${tenant.name} (${database}): ${done.join('; ')}`
          : `- ${tenant.name} (${database}): up to date`,
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
