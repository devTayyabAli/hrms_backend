/**
 * Additive schema reconciliation for every tenant database.
 *
 * Tenant schemas come from `sequelize.sync({ force: false })` in
 * TenantModelProviderService, which creates missing *tables* but never adds
 * *columns* to a table that already exists. So a column added to an
 * operational model after that table was first created silently never
 * reaches the database and surfaces at runtime as
 * `column "<name>" does not exist` (Postgres 42703).
 *
 * This is the per-tenant counterpart to
 * apps/auth-service/src/scripts/sync-platform-columns.ts, which does the same
 * job for the single platform database.
 *
 * Run it after adding a column to any model listed in OPERATIONAL_MODELS.
 * New *tables* (e.g. employees, attendance_records on a tenant provisioned
 * before they existed) are created by this script too, since it syncs before
 * reconciling columns.
 *
 * Deliberately **additive only**: it adds columns the models declare and the
 * database lacks, and never drops, renames or retypes anything — safe to
 * re-run and safe on a database holding real rows. A NOT NULL column with no
 * default is added as nullable (adding it as NOT NULL would fail against
 * existing rows); those are reported so the values can be backfilled and the
 * constraint tightened deliberately.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/sync-tenant-columns.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes, Sequelize } from 'sequelize';
import { ProjectionOutbox } from '@app/database';
import {
  Department,
  Designation,
  Employee,
  AttendanceRecord,
  WorkingHours,
  LeavePolicy,
  AttendancePolicy,
  OrganizationPolicy,
  OrganizationModuleAccess,
  PerformanceGoal,
  PerformanceReview,
  PayrollRun,
  PayrollRecord,
  EmployeeDocument,
  EmployeeRequest,
  EmployeeNotification,
  EmployeeInvitation,
  HrReportRun,
} from '../models';
import {
  bindOperationalModels,
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  tenantDatabaseName,
  writeOpsLog,
} from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

/**
 * Must mirror the model list bound in
 * TenantModelProviderService.getConnection — anything missing here simply
 * never gets reconciled. Employee precedes AttendanceRecord so table
 * creation order satisfies the FK between them.
 */
const OPERATIONAL_MODELS = [
  Department,
  Designation,
  Employee,
  AttendanceRecord,
  WorkingHours,
  LeavePolicy,
  AttendancePolicy,
  OrganizationPolicy,
  OrganizationModuleAccess,
  // Performance and payroll columns added after those tables first existed.
  // Employee is already earlier in this list, which these FKs require.
  PerformanceGoal,
  PerformanceReview,
  PayrollRun,
  PayrollRecord,
  EmployeeDocument,
  EmployeeRequest,
  EmployeeNotification,
  // HR Portal: employee portal invitations and the report run log.
  EmployeeInvitation,
  HrReportRun,
  // SuperAdmin read model: the per-tenant outbox the relay drains. Must exist
  // before any service that emits projection events is deployed.
  ProjectionOutbox,
];

interface TenantRow {
  id: string;
  name: string;
}

interface TenantOutcome {
  tenantId: string;
  name: string;
  database: string;
  added: string[];
  relaxed: string[];
  enumValues: string[];
  /** sync() failed but reconciliation continued — the tenant is not abandoned. */
  syncError?: string;
  error?: string;
}

/**
 * Sequelize wraps the useful detail: a bare `.message` on a validation or
 * database error reads "Validation error", naming neither the table nor the
 * constraint, which makes the failure impossible to act on from the log.
 */
function describeError(error: any): string {
  const detail =
    error?.errors?.map((e: any) => `${e.path ?? '?'}: ${e.message}`).join('; ') ||
    error?.parent?.message ||
    error?.original?.message ||
    '';
  return detail ? `${error?.message} — ${detail}` : String(error?.message ?? error);
}

/**
 * Adds enum values the models have gained since a tenant was provisioned.
 *
 * `sync({ force: false })` creates missing tables and this script adds missing
 * columns, but neither touches an enum type that already exists — so a new
 * member (say a new AttendanceSource) compiles, passes tests against a fresh
 * database, and then fails at runtime on every tenant provisioned before it
 * with "invalid input value for enum". Postgres has no IF NOT EXISTS for enum
 * members before 12, and adding one inside a transaction is restricted, so
 * each value goes in its own statement and an already-present value is
 * tolerated rather than treated as an error.
 */
async function reconcileEnumValues(
  connection: Sequelize,
  dryRun: boolean,
): Promise<string[]> {
  const added: string[] = [];

  const existing = await connection.query<{ typname: string; enumlabel: string }>(
    `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'`,
    { type: QueryTypes.SELECT },
  );

  const labelsByType = new Map<string, Set<string>>();
  for (const row of existing) {
    let labels = labelsByType.get(row.typname);
    if (!labels) {
      labels = new Set<string>();
      labelsByType.set(row.typname, labels);
    }
    labels.add(row.enumlabel);
  }

  for (const model of Object.values(connection.models) as any[]) {
    const tableName = model.getTableName() as string;
    const attributes = model.getAttributes();

    for (const attributeName of Object.keys(attributes)) {
      const attribute = attributes[attributeName];
      const values: string[] | undefined = attribute?.type?.values;
      if (!Array.isArray(values) || !values.length) continue;

      const field: string = attribute.field || attributeName;
      // Sequelize's naming for a column-backed enum type.
      const typeName = `enum_${tableName}_${field}`;
      const present = labelsByType.get(typeName);
      // No such type yet means sync() will create it complete.
      if (!present) continue;

      for (const value of values) {
        if (present.has(value)) continue;
        added.push(`${typeName}.${value}`);
        if (!dryRun) {
          await connection.query(
            `ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS '${value.replace(/'/g, "''")}'`,
          );
        }
      }
    }
  }

  return added;
}

async function reconcileTenant(
  tenant: TenantRow,
  dryRun: boolean,
): Promise<TenantOutcome> {
  const database = tenantDatabaseName(tenant.id);
  const outcome: TenantOutcome = {
    tenantId: tenant.id,
    name: tenant.name,
    database,
    added: [],
    relaxed: [],
    enumValues: [],
  };

  const connection = createTenantConnection(database);
  try {
    await connection.authenticate();
    bindOperationalModels(connection, OPERATIONAL_MODELS);

    // Creates any table this tenant is missing entirely. Columns on tables
    // that already exist are this script's job, below.
    //
    // Isolated on purpose: sync() also tries to create every index a model
    // declares, and one that existing rows cannot satisfy — a unique index
    // over duplicate values — throws. Letting that propagate would abandon
    // the whole tenant, so a table this script could have created never gets
    // created and an enum value never gets added, all because of an unrelated
    // constraint. The failure is recorded and reconciliation continues.
    if (!dryRun) {
      try {
        await connection.sync({ force: false });
      } catch (error: any) {
        outcome.syncError = describeError(error);
      }
    }

    const queryInterface = connection.getQueryInterface();
    const rows = await connection.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
      { type: QueryTypes.SELECT },
    );

    const existingColumns = new Map<string, Set<string>>();
    for (const row of rows) {
      let columns = existingColumns.get(row.table_name);
      if (!columns) {
        columns = new Set<string>();
        existingColumns.set(row.table_name, columns);
      }
      columns.add(row.column_name);
    }

    for (const model of Object.values(connection.models) as any[]) {
      const tableName = model.getTableName() as string;
      const columns = existingColumns.get(tableName);

      // On a dry run the table may legitimately not exist yet because we
      // skipped sync(); either way, creating tables is sync()'s job.
      if (!columns) continue;

      const attributes = model.getAttributes();
      for (const attributeName of Object.keys(attributes)) {
        const attribute = attributes[attributeName];
        const field: string = attribute.field || attributeName;
        if (columns.has(field)) continue;

        // Existing rows would violate a NOT NULL column added without a
        // default, so NOT NULL is only enforceable when a default can
        // backfill them. The normalized attribute may carry
        // `allowNull: undefined`, which Postgres' query generator also
        // renders as NOT NULL — hence setting `allowNull` explicitly rather
        // than passing it through.
        const hasDefault = attribute.defaultValue !== undefined;
        const enforceNotNull = attribute.allowNull === false && hasDefault;
        const definition = { ...attribute, allowNull: !enforceNotNull };
        delete definition.field;

        if (attribute.allowNull === false && !enforceNotNull) {
          outcome.relaxed.push(`${tableName}.${field}`);
        }
        outcome.added.push(`${tableName}.${field}`);

        if (!dryRun) {
          await queryInterface.addColumn(tableName, field, definition);
        }
      }
    }

    outcome.enumValues = await reconcileEnumValues(connection, dryRun);
  } catch (error: any) {
    outcome.error = describeError(error);
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
    tenants = await platform.query<TenantRow>(
      `SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY' ORDER BY "createdAt" ASC`,
      { type: QueryTypes.SELECT },
    );
  } finally {
    await platform.close();
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Reconciling ${tenants.length} provisioned tenant database(s).\n`,
  );

  const outcomes: TenantOutcome[] = [];
  let totalAdded = 0;
  let totalEnumValues = 0;
  let syncFailed = 0;
  let failed = 0;

  // Sequential on purpose: one connection at a time keeps this gentle on the
  // database's connection limit, and the ops log stays in a readable order.
  for (const tenant of tenants) {
    const outcome = await reconcileTenant(tenant, dryRun);
    outcomes.push(outcome);

    if (outcome.error) {
      failed++;
      console.error(`! ${tenant.name} (${outcome.database}): ${outcome.error}`);
      continue;
    }

    totalAdded += outcome.added.length;
    totalEnumValues += outcome.enumValues.length;
    if (outcome.added.length === 0 && outcome.enumValues.length === 0) {
      console.log(`- ${tenant.name} (${outcome.database}): up to date`);
    } else {
      if (outcome.added.length > 0) {
        console.log(
          `${dryRun ? '[dry-run] would add' : 'added'} ${outcome.added.length} column(s) to ${tenant.name}: ${outcome.added.join(', ')}`,
        );
      }
      if (outcome.relaxed.length > 0) {
        console.log(
          `    added NULLABLE though the model declares NOT NULL — backfill then tighten: ${outcome.relaxed.join(', ')}`,
        );
      }
      if (outcome.enumValues.length > 0) {
        console.log(
          `${dryRun ? '[dry-run] would add' : 'added'} ${outcome.enumValues.length} enum value(s) to ${tenant.name}: ${outcome.enumValues.join(', ')}`,
        );
      }
    }

    if (outcome.syncError) {
      syncFailed++;
      console.warn(
        `  ~ ${tenant.name}: table/index creation partially failed, reconciliation continued: ${outcome.syncError}`,
      );
    }
  }

  const logPath = writeOpsLog('sync-tenant-columns.json', {
    ranAt: new Date().toISOString(),
    dryRun,
    tenantCount: tenants.length,
    totalColumnsAdded: totalAdded,
    totalEnumValuesAdded: totalEnumValues,
    failed,
    outcomes,
  });

  console.log(
    `\n${dryRun ? 'Would add' : 'Added'} ${totalAdded} column(s) and ${totalEnumValues} enum value(s) across ${tenants.length} tenant(s). ${failed} failed.`,
  );
  console.log(`Ops log: ${logPath}`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Tenant column sync failed:', error.message);
  process.exit(1);
});
