/**
 * Additive schema reconciliation for tenant-service's **platform-database**
 * models (tenants, subscriptions, plans, invitations, billing …).
 *
 * These tables live in the single platform DB but are owned by tenant-service,
 * which left them with no column-sync coverage at all: the platform script
 * (apps/auth-service/src/scripts/sync-platform-columns.ts) only lists
 * auth-service models, and sync-tenant-columns.ts only reconciles the
 * per-tenant databases. `sequelize.sync()` creates missing *tables* but never
 * adds *columns* to a table that already exists, so a column added to e.g.
 * Tenant after its table was created silently never reached the database and
 * surfaced at runtime as `column "<name>" does not exist` (Postgres 42703).
 *
 * Deliberately **additive only**: it adds columns the models declare and the
 * database lacks, and never drops, renames or retypes anything — safe to
 * re-run and safe on a database holding real rows. A NOT NULL column with no
 * default is added as nullable (adding it as NOT NULL would fail against
 * existing rows); those are reported so the values can be backfilled and the
 * constraint tightened deliberately.
 *
 * Usage:
 *   npm run db:sync-platform-tenant-columns -- [--dry-run]
 */
import * as dotenv from 'dotenv';
import { Model } from 'sequelize-typescript';
import {
  Tenant,
  TenantDatabaseConfig,
  OrganizationAdminInvitation,
  Plan,
  Subscription,
  Payment,
  Invoice,
  BillingEvent,
  CustomReport,
  BackupSettings,
  BackupRecord,
} from '../models';
import { bindOperationalModels, createPlatformConnection, parseCliFlags } from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

/**
 * Every tenant-service model that lives in the platform database. Anything
 * missing here simply never gets reconciled — the gap this script exists to
 * close — so add new platform models to this list.
 */
const PLATFORM_MODELS: Array<typeof Model> = [
  Tenant,
  TenantDatabaseConfig,
  OrganizationAdminInvitation,
  Plan,
  Subscription,
  Payment,
  Invoice,
  BillingEvent,
  CustomReport,
  BackupSettings,
  BackupRecord,
];

async function main(): Promise<void> {
  const { dryRun } = parseCliFlags();
  const connection = createPlatformConnection();
  bindOperationalModels(connection, PLATFORM_MODELS);

  const [rows]: any = await connection.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  );

  const existingColumns = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!existingColumns.has(row.table_name)) {
      existingColumns.set(row.table_name, new Set());
    }
    existingColumns.get(row.table_name).add(row.column_name);
  }

  const queryInterface = connection.getQueryInterface();
  let added = 0;
  const relaxed: string[] = [];

  for (const model of Object.values(connection.models) as any[]) {
    const tableName = model.getTableName() as string;
    const columns = existingColumns.get(tableName);

    // A table that doesn't exist yet is `sync()`'s job, not ours.
    if (!columns) {
      console.log(`- ${tableName}: table does not exist yet, skipping`);
      continue;
    }

    const attributes = model.getAttributes();
    for (const attributeName of Object.keys(attributes)) {
      const attribute = attributes[attributeName];
      const field: string = attribute.field || attributeName;
      if (columns.has(field)) continue;

      // Existing rows would violate a NOT NULL column added without a default,
      // so NOT NULL is only enforceable when a default can backfill them.
      const hasDefault = attribute.defaultValue !== undefined;
      const enforceNotNull = attribute.allowNull === false && hasDefault;
      const definition = { ...attribute, allowNull: !enforceNotNull };
      delete definition.field;

      const relaxedHere = attribute.allowNull === false && !enforceNotNull;
      if (relaxedHere) {
        relaxed.push(`${tableName}.${field}`);
      }

      console.log(
        `${dryRun ? '[dry-run] would add' : 'adding'} ${tableName}.${field}` +
          (relaxedHere ? ' (as NULLABLE — model declares NOT NULL)' : ''),
      );

      if (!dryRun) {
        await queryInterface.addColumn(tableName, field, definition);
      }
      added++;
    }
  }

  console.log(
    added === 0
      ? 'Platform (tenant-service) schema is up to date — no columns missing.'
      : `${dryRun ? 'Would add' : 'Added'} ${added} column(s).`,
  );

  if (relaxed.length > 0) {
    console.log(`Backfill then tighten manually (added nullable): ${relaxed.join(', ')}`);
  }

  await connection.close();
}

main().catch((error) => {
  console.error('Platform (tenant-service) column sync failed:', error.message);
  process.exit(1);
});
