/**
 * Payroll Phase 4 (compensation) schema, for every tenant database:
 *
 * - new tables payroll_components, salary_structures,
 *   salary_structure_components, employee_recurring_items, employee_loans,
 *   reimbursements;
 * - salary_revisions: the compensation components behind each revision;
 * - payroll_records: the component breakdown, loan recovery and other
 *   employer contributions;
 * - payroll_adjustments: employee, payroll period and effective date, so an
 *   entry can be made before its payroll exists (run and line become
 *   nullable for those).
 *
 * Nothing existing is removed and no existing value changes. Two backfills
 * fill NEW columns only: each existing adjustment's employee and period,
 * copied from the line and run it is already on. Idempotent.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-payroll-compensation-schema.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes, Sequelize } from 'sequelize';
import { createPlatformConnection, createTenantConnection, parseCliFlags, tenantDatabaseName } from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

const MONEY = 'DECIMAL(14,2) NOT NULL DEFAULT 0';
const STAMPS = `"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL`;

const COLUMNS: Record<string, { column: string; type: string }[]> = {
  salary_revisions: [
    { column: 'structureId', type: 'UUID' },
    { column: 'structureName', type: 'VARCHAR(120)' },
    { column: 'components', type: 'JSONB' },
    { column: 'previousComponents', type: 'JSONB' },
    { column: 'source', type: 'VARCHAR(16)' },
  ],
  payroll_records: [
    { column: 'loanRecovery', type: MONEY },
    { column: 'otherEmployerContributions', type: MONEY },
    { column: 'components', type: 'JSONB' },
  ],
  payroll_adjustments: [
    { column: 'employeeId', type: 'UUID' },
    { column: 'payrollPeriod', type: 'VARCHAR(7)' },
    { column: 'effectiveDate', type: 'DATE' },
  ],
};

const TABLES: { table: string; needs?: string; ddl: string }[] = [
  {
    table: 'payroll_components',
    ddl: `CREATE TABLE IF NOT EXISTS payroll_components (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "code" VARCHAR(32) NOT NULL,
      "name" VARCHAR(120) NOT NULL,
      "type" VARCHAR(24) NOT NULL,
      "category" VARCHAR(32) NOT NULL,
      "calculationMethod" VARCHAR(16) NOT NULL,
      "value" DECIMAL(14,4),
      "percentageBase" VARCHAR(24),
      "baseComponents" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "formula" TEXT,
      "taxTreatment" VARCHAR(16) NOT NULL DEFAULT 'RULE_DEPENDENT',
      "includedInGross" BOOLEAN NOT NULL DEFAULT true,
      "includedInOvertimeBase" BOOLEAN NOT NULL DEFAULT false,
      "includedInLeaveBase" BOOLEAN NOT NULL DEFAULT false,
      "effectiveFrom" DATE NOT NULL,
      "effectiveTo" DATE,
      "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
      "description" TEXT,
      "isSystem" BOOLEAN NOT NULL DEFAULT false,
      "createdByEmail" VARCHAR(255),
      "updatedByEmail" VARCHAR(255),
      ${STAMPS}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS payroll_component_code_unique ON payroll_components ("code");`,
  },
  {
    table: 'salary_structures',
    ddl: `CREATE TABLE IF NOT EXISTS salary_structures (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "code" VARCHAR(32) NOT NULL,
      "name" VARCHAR(120) NOT NULL,
      "description" TEXT,
      "effectiveFrom" DATE NOT NULL,
      "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
      "createdByEmail" VARCHAR(255),
      "updatedByEmail" VARCHAR(255),
      ${STAMPS}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS salary_structure_code_unique ON salary_structures ("code");`,
  },
  {
    table: 'salary_structure_components',
    needs: 'payroll_components',
    ddl: `CREATE TABLE IF NOT EXISTS salary_structure_components (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "structureId" UUID NOT NULL REFERENCES salary_structures("id") ON DELETE CASCADE ON UPDATE CASCADE,
      "componentId" UUID NOT NULL REFERENCES payroll_components("id") ON UPDATE CASCADE,
      "calculationMethod" VARCHAR(16),
      "value" DECIMAL(14,4),
      "percentageBase" VARCHAR(24),
      "baseComponents" JSONB,
      "formula" TEXT,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      ${STAMPS}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS salary_structure_component_unique ON salary_structure_components ("structureId", "componentId");`,
  },
  {
    table: 'employee_recurring_items',
    needs: 'employees',
    ddl: `CREATE TABLE IF NOT EXISTS employee_recurring_items (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "employeeId" UUID NOT NULL REFERENCES employees("id") ON UPDATE CASCADE,
      "kind" VARCHAR(12) NOT NULL,
      "name" VARCHAR(120) NOT NULL,
      "category" VARCHAR(32) NOT NULL,
      "calculationMethod" VARCHAR(16) NOT NULL DEFAULT 'FIXED',
      "amount" DECIMAL(14,4) NOT NULL,
      "percentageBase" VARCHAR(12),
      "frequency" VARCHAR(12) NOT NULL DEFAULT 'MONTHLY',
      "startDate" DATE NOT NULL,
      "endDate" DATE,
      "totalAmount" DECIMAL(14,2),
      "taxTreatment" VARCHAR(16) NOT NULL DEFAULT 'RULE_DEPENDENT',
      "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
      "reason" VARCHAR(300),
      "createdByEmail" VARCHAR(255),
      "updatedByEmail" VARCHAR(255),
      ${STAMPS}
    );
    CREATE INDEX IF NOT EXISTS employee_recurring_item_employee_idx ON employee_recurring_items ("employeeId", "kind");`,
  },
  {
    table: 'employee_loans',
    needs: 'employees',
    ddl: `CREATE TABLE IF NOT EXISTS employee_loans (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "employeeId" UUID NOT NULL REFERENCES employees("id") ON UPDATE CASCADE,
      "kind" VARCHAR(12) NOT NULL,
      "principal" DECIMAL(14,2) NOT NULL,
      "installmentAmount" DECIMAL(14,2) NOT NULL,
      "installments" INTEGER,
      "issuedOn" DATE NOT NULL,
      "startDate" DATE NOT NULL,
      "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
      "reason" VARCHAR(300),
      "createdByEmail" VARCHAR(255),
      "updatedByEmail" VARCHAR(255),
      ${STAMPS}
    );
    CREATE INDEX IF NOT EXISTS employee_loan_employee_idx ON employee_loans ("employeeId", "status");`,
  },
  {
    table: 'reimbursements',
    needs: 'employees',
    ddl: `CREATE TABLE IF NOT EXISTS reimbursements (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "employeeId" UUID NOT NULL REFERENCES employees("id") ON UPDATE CASCADE,
      "amount" DECIMAL(14,2) NOT NULL,
      "category" VARCHAR(40) NOT NULL,
      "expenseDate" DATE NOT NULL,
      "description" VARCHAR(500) NOT NULL,
      "fileId" UUID,
      "fileName" VARCHAR(255),
      "mimeType" VARCHAR(127),
      "status" VARCHAR(12) NOT NULL DEFAULT 'SUBMITTED',
      "payrollPeriod" VARCHAR(7),
      "payrollRunId" UUID,
      "payrollRecordId" UUID,
      "submittedByEmail" VARCHAR(255),
      "decidedByEmail" VARCHAR(255),
      "decidedAt" TIMESTAMP WITH TIME ZONE,
      "decisionNote" VARCHAR(300),
      ${STAMPS}
    );
    CREATE INDEX IF NOT EXISTS reimbursement_employee_idx ON reimbursements ("employeeId", "status");
    CREATE INDEX IF NOT EXISTS reimbursement_run_idx ON reimbursements ("payrollRunId");`,
  },
];

const tableExists = async (connection: Sequelize, table: string) =>
  (
    await connection.query(`SELECT 1 FROM information_schema.tables WHERE table_name = :table`, {
      type: QueryTypes.SELECT,
      replacements: { table },
    })
  ).length > 0;

const columnsOf = async (connection: Sequelize, table: string) =>
  new Map(
    (
      await connection.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = :table`,
        { type: QueryTypes.SELECT, replacements: { table } },
      )
    ).map((row) => [row.column_name, row.is_nullable]),
  );

async function migrate(connection: Sequelize, dryRun: boolean): Promise<string[]> {
  const done: string[] = [];
  for (const [table, columns] of Object.entries(COLUMNS)) {
    if (!(await tableExists(connection, table))) {
      done.push(`${table}: table missing, skipped`);
      continue;
    }
    const have = await columnsOf(connection, table);
    const missing = columns.filter((col) => !have.has(col.column));
    if (!missing.length) continue;
    // Table and column names are constants above — nothing user-supplied.
    if (!dryRun) for (const col of missing) await connection.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${col.column}" ${col.type}`);
    done.push(`${table}: +${missing.map((col) => col.column).join(', ')}`);
  }

  // An adjustment can now wait for its payroll: run and line become optional.
  if (await tableExists(connection, 'payroll_adjustments')) {
    const have = await columnsOf(connection, 'payroll_adjustments');
    for (const column of ['payrollRunId', 'payrollRecordId']) {
      if (have.get(column) === 'NO') {
        if (!dryRun) await connection.query(`ALTER TABLE payroll_adjustments ALTER COLUMN "${column}" DROP NOT NULL`);
        done.push(`payroll_adjustments.${column}: now optional`);
      }
    }
  }

  for (const { table, needs, ddl } of TABLES) {
    if (await tableExists(connection, table)) continue;
    if (needs && !(await tableExists(connection, needs)) && !(dryRun && TABLES.some((t) => t.table === needs))) {
      done.push(`${table}: ${needs} missing, skipped`);
      continue;
    }
    if (!dryRun) await connection.query(ddl);
    done.push(`created ${table}`);
  }

  // Existing adjustments: their employee and period, from the line and run they're on.
  if (!dryRun && (await tableExists(connection, 'payroll_adjustments')) && (await columnsOf(connection, 'payroll_adjustments')).has('payrollPeriod')) {
    const [, affected]: any = await connection.query(
      `UPDATE payroll_adjustments a
          SET "employeeId" = r."employeeId",
              "payrollPeriod" = to_char(run."periodStart", 'YYYY-MM')
         FROM payroll_records r
         JOIN payroll_runs run ON run."id" = r."payrollRunId"
        WHERE a."payrollRecordId" = r."id"
          AND (a."employeeId" IS NULL OR a."payrollPeriod" IS NULL)`,
    );
    const count = Number(affected?.rowCount ?? affected ?? 0);
    if (count > 0) done.push(`backfilled employee and period on ${count} adjustment(s)`);
  } else if (dryRun && (await tableExists(connection, 'payroll_adjustments'))) {
    const [{ n }] = await connection.query<{ n: number }>(`SELECT count(*)::int AS n FROM payroll_adjustments`, { type: QueryTypes.SELECT });
    if (n > 0) done.push(`would backfill employee and period on up to ${n} adjustment(s)`);
  }
  return done;
}

async function main(): Promise<void> {
  const { dryRun } = parseCliFlags();
  const platform = createPlatformConnection();
  let tenants: { id: string; name: string }[];
  try {
    tenants = await platform.query(`SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY' ORDER BY "createdAt" ASC`, {
      type: QueryTypes.SELECT,
    });
  } finally {
    await platform.close();
  }
  let failed = 0;
  for (const tenant of tenants) {
    const database = tenantDatabaseName(tenant.id);
    const connection = createTenantConnection(database);
    try {
      const done = await migrate(connection, dryRun);
      console.log(`${dryRun ? '[dry-run] ' : ''}${tenant.name} (${database}): ${done.length ? done.join('; ') : 'up to date'}`);
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
