/**
 * Additive schema reconciliation for the platform database.
 *
 * The platform DB has no migration files — its schema comes from
 * `sequelize.sync()` (see `synchronize` in `libs/database/src/config/database.config.ts`).
 * Plain `sync()` creates missing *tables* but never adds *columns* to a table
 * that already exists, so every column added to a platform model after its
 * table was first created silently never reaches the database and shows up at
 * runtime as `column "<name>" does not exist` (error 42703).
 *
 * This script closes that gap. It is deliberately **additive only**: it adds
 * columns the models declare and the database lacks, and never drops, renames
 * or retypes anything — so it is safe to re-run and safe on a database holding
 * real rows. A `NOT NULL` column with no default is added as nullable (adding
 * it as NOT NULL would fail against existing rows); the script reports those
 * so the values can be backfilled and the constraint tightened deliberately.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/auth-service/src/scripts/sync-platform-columns.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { getDatabaseConfig } from '@app/database';
import {
  SuperAdmin,
  AuthCredential,
  NotificationPreferences,
  UserSession,
  FileMetadata,
  AuditLog,
  PlatformSettings,
  SecuritySettings,
  AllowedIpAddress,
  PlatformDomain,
} from '../models';

dotenv.config({ path: '.env.development' });
dotenv.config();

const PLATFORM_MODELS = [
  SuperAdmin,
  AuthCredential,
  NotificationPreferences,
  UserSession,
  FileMetadata,
  AuditLog,
  PlatformSettings,
  SecuritySettings,
  AllowedIpAddress,
  PlatformDomain,
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = getDatabaseConfig(true) as any;

  const connection = new Sequelize({
    dialect: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    dialectOptions: config.dialectOptions,
    logging: false,
    models: PLATFORM_MODELS,
  });

  const queryInterface = connection.getQueryInterface();
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
      // Note the normalized attribute may carry `allowNull: undefined`, which
      // Postgres' query generator also renders as NOT NULL — hence the
      // explicit `allowNull` on every definition rather than passing it through.
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
      ? 'Platform schema is up to date — no columns missing.'
      : `${dryRun ? 'Would add' : 'Added'} ${added} column(s).`,
  );

  if (relaxed.length > 0) {
    console.log(
      `Backfill then tighten manually (added nullable): ${relaxed.join(', ')}`,
    );
  }

  await connection.close();
}

main().catch((error) => {
  console.error('Platform column sync failed:', error.message);
  process.exit(1);
});
