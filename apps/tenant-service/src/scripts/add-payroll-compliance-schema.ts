/**
 * Payroll Phase 3 (compliance) schema, for every tenant database:
 *
 * - new tables compliance_rules, employee_tax_profiles, tax_certificates;
 * - payroll_records: the compliance snapshot columns;
 * - payroll_runs: complianceNotes;
 * - payroll_adjustments: category (defaults to OTHER).
 *
 * Nothing existing is changed or removed. One backfill fills a NEW column
 * only: normalDeductions := deductions on lines calculated before compliance
 * existed (their whole deduction was the "normal" kind), so old runs read
 * correctly. Idempotent — the backfill only touches rows still at 0.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-payroll-compliance-schema.ts [--dry-run]
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

const COLUMNS: Record<string, { column: string; type: string }[]> = {
  payroll_records: [
    { column: 'normalDeductions', type: MONEY },
    { column: 'taxYear', type: 'INTEGER' },
    { column: 'taxableIncome', type: MONEY },
    { column: 'incomeTax', type: MONEY },
    { column: 'eobiEmployee', type: MONEY },
    { column: 'eobiEmployer', type: MONEY },
    { column: 'pfEmployee', type: MONEY },
    { column: 'pfEmployer', type: MONEY },
    { column: 'statutoryDeductions', type: MONEY },
    { column: 'employerContributions', type: MONEY },
    { column: 'complianceSnapshot', type: 'JSONB' },
  ],
  payroll_runs: [{ column: 'complianceNotes', type: 'JSONB' }],
  payroll_adjustments: [
    { column: 'category', type: "VARCHAR(24) NOT NULL DEFAULT 'OTHER'" },
  ],
};

const ENUMS: { name: string; values: string[] }[] = [
  {
    name: 'enum_compliance_rules_ruleType',
    values: ['INCOME_TAX', 'EOBI', 'PROVIDENT_FUND'],
  },
  {
    name: 'enum_compliance_rules_status',
    values: ['DRAFT', 'ACTIVE', 'RETIRED'],
  },
];

const TABLES: { table: string; ddl: string }[] = [
  {
    table: 'compliance_rules',
    ddl: `CREATE TABLE IF NOT EXISTS compliance_rules (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "country" VARCHAR(2) NOT NULL DEFAULT 'PK',
      "ruleType" "enum_compliance_rules_ruleType" NOT NULL,
      "name" VARCHAR(150) NOT NULL,
      "taxYear" INTEGER,
      "effectiveFrom" DATE NOT NULL,
      "effectiveTo" DATE,
      "status" "enum_compliance_rules_status" NOT NULL DEFAULT 'DRAFT',
      "configuration" JSONB NOT NULL,
      "requiresReview" BOOLEAN NOT NULL DEFAULT false,
      "reviewNotes" TEXT,
      "source" TEXT,
      "templateKey" VARCHAR(64),
      "createdByEmail" VARCHAR(255),
      "updatedByEmail" VARCHAR(255),
      "activatedAt" TIMESTAMP WITH TIME ZONE,
      "activatedByEmail" VARCHAR(255),
      "retiredAt" TIMESTAMP WITH TIME ZONE,
      "retiredByEmail" VARCHAR(255),
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS compliance_rule_type_status_idx ON compliance_rules ("ruleType", "status", "effectiveFrom");`,
  },
  {
    table: 'employee_tax_profiles',
    ddl: `CREATE TABLE IF NOT EXISTS employee_tax_profiles (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "employeeId" UUID NOT NULL REFERENCES employees("id") ON UPDATE CASCADE,
      "taxYear" INTEGER NOT NULL,
      "effectiveFrom" DATE,
      "ntn" VARCHAR(32),
      "taxStatus" VARCHAR(16),
      "residency" VARCHAR(16) NOT NULL DEFAULT 'RESIDENT',
      "previousEmployerTaxableIncome" ${MONEY},
      "previousEmployerTaxDeducted" ${MONEY},
      "annualDeductibleAllowances" ${MONEY},
      "annualTaxCredits" ${MONEY},
      "taxAdjustment" ${MONEY},
      "taxAdjustmentReason" VARCHAR(300),
      "reductionCode" VARCHAR(40),
      "medicalAllowanceMonthly" ${MONEY},
      "freeMedicalProvided" BOOLEAN NOT NULL DEFAULT false,
      "eobiCovered" BOOLEAN NOT NULL DEFAULT true,
      "eobiRegistrationNumber" VARCHAR(40),
      "pfMember" BOOLEAN,
      "pfJoinDate" DATE,
      "notes" TEXT,
      "updatedByEmail" VARCHAR(255),
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS employee_tax_profile_year_unique ON employee_tax_profiles ("employeeId", "taxYear");`,
  },
  {
    table: 'tax_certificates',
    ddl: `CREATE TABLE IF NOT EXISTS tax_certificates (
      "id" UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "employeeId" UUID NOT NULL,
      "taxYear" INTEGER NOT NULL,
      "certificateNumber" VARCHAR(32) NOT NULL,
      "sequence" INTEGER NOT NULL,
      "summary" JSONB NOT NULL,
      "generatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "generatedByEmail" VARCHAR(255),
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tax_certificate_number_unique ON tax_certificates ("certificateNumber");
    CREATE UNIQUE INDEX IF NOT EXISTS tax_certificate_sequence_unique ON tax_certificates ("sequence");
    CREATE INDEX IF NOT EXISTS tax_certificate_employee_year_idx ON tax_certificates ("employeeId", "taxYear");`,
  },
];

const tableExists = async (connection: Sequelize, table: string) =>
  (
    await connection.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = :table`,
      {
        type: QueryTypes.SELECT,
        replacements: { table },
      },
    )
  ).length > 0;

async function migrate(
  connection: Sequelize,
  dryRun: boolean,
): Promise<string[]> {
  const done: string[] = [];
  for (const [table, columns] of Object.entries(COLUMNS)) {
    if (!(await tableExists(connection, table))) {
      done.push(`${table}: table missing, skipped`);
      continue;
    }
    const have = new Set(
      (
        await connection.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = :table`,
          {
            type: QueryTypes.SELECT,
            replacements: { table },
          },
        )
      ).map((row) => row.column_name),
    );
    const missing = columns.filter((col) => !have.has(col.column));
    if (!missing.length) continue;
    if (!dryRun)
      for (const col of missing)
        await connection.query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${col.column}" ${col.type}`,
        );
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
    if (
      table === 'employee_tax_profiles' &&
      !(await tableExists(connection, 'employees'))
    ) {
      done.push('employee_tax_profiles: employees missing, skipped');
      continue;
    }
    if (!dryRun) await connection.query(ddl);
    done.push(`created ${table}`);
  }

  if (await tableExists(connection, 'payroll_records')) {
    const [{ n }] = await connection
      .query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payroll_records
        WHERE "complianceSnapshot" IS NULL AND "normalDeductions" = 0 AND "deductions" <> 0`,
        { type: QueryTypes.SELECT },
      )
      .catch(() => [{ n: 0 }]);
    if (n > 0) {
      if (!dryRun) {
        await connection.query(
          `UPDATE payroll_records SET "normalDeductions" = "deductions"
            WHERE "complianceSnapshot" IS NULL AND "normalDeductions" = 0 AND "deductions" <> 0`,
        );
      }
      done.push(`backfilled normalDeductions on ${n} earlier payroll line(s)`);
    }
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
        `${dryRun ? '[dry-run] ' : ''}${tenant.name} (${database}): ${done.length ? done.join('; ') : 'up to date'}`,
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
