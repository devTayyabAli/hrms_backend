/**
 * One-off cleanup for a tenant whose provisioning crashed partway through
 * (see the `organization_module_access does not exist` bug — provisioning
 * created the Tenant row, its `tenant_database_configs` row and the empty
 * per-tenant database, then failed before finishing). Left in place, the
 * tenant's slug/domain permanently blocks retrying with the same
 * organization name (`TenantProvisioningService.createOrganizationAndProvision`'s
 * duplicate-slug guard).
 *
 * Deletes, in order: the `tenant_database_configs` row, the `tenants` row,
 * then drops the (empty, schema-less) per-tenant database itself.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/cleanup-failed-tenant.ts <tenantId> [--dry-run]
 */
import * as dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { getDatabaseConfig } from '@app/database';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const tenantId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!tenantId) {
    throw new Error('Usage: cleanup-failed-tenant.ts <tenantId> [--dry-run]');
  }

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
  });

  const [tenantRows]: any = await connection.query(
    `SELECT id, "organizationName", slug, domain, status FROM tenants WHERE id = :tenantId`,
    { replacements: { tenantId } },
  );
  if (tenantRows.length === 0) {
    console.log(`No tenant found with id ${tenantId} — nothing to do.`);
    await connection.close();
    return;
  }
  console.log('tenant:', tenantRows[0]);

  const [dbConfigRows]: any = await connection.query(
    `SELECT "databaseName" FROM tenant_database_configs WHERE "tenantId" = :tenantId`,
    { replacements: { tenantId } },
  );
  const databaseName = dbConfigRows[0]?.databaseName;
  console.log('tenant_database_configs.databaseName:', databaseName || '(none)');

  if (dryRun) {
    console.log(
      `[dry-run] would delete tenant_database_configs row, tenants row, and DROP DATABASE "${databaseName}".`,
    );
    await connection.close();
    return;
  }

  await connection.query(`DELETE FROM tenant_database_configs WHERE "tenantId" = :tenantId`, {
    replacements: { tenantId },
  });
  await connection.query(`DELETE FROM tenants WHERE id = :tenantId`, { replacements: { tenantId } });
  console.log('Deleted tenant_database_configs and tenants rows.');

  if (databaseName) {
    await connection.query(
      `SELECT pg_terminate_backend(pg_stat_activity.pid)
       FROM pg_stat_activity
       WHERE pg_stat_activity.datname = :databaseName
       AND pid <> pg_backend_pid();`,
      { replacements: { databaseName } },
    );
    await connection.query(`DROP DATABASE IF EXISTS "${databaseName}";`);
    console.log(`Dropped database "${databaseName}".`);
  }

  await connection.close();
}

main().catch((error) => {
  console.error('Cleanup failed:', error.message);
  process.exit(1);
});
