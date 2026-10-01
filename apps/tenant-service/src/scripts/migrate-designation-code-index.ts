/**
 * Migrates every existing tenant database's `designations` table off the
 * old tenant-wide-unique `code` index (`unique_designation_code`) onto a
 * department-scoped one (`unique_designation_code_per_department`, matching
 * `designation.model.ts`) — see `OrganizationSetupService.createDesignation`
 * for the bug this fixes: a level code like "L4" could only be used once
 * per organization, not once per department.
 *
 * Changing the model alone doesn't touch already-provisioned tenant
 * databases (`sync()` never drops/redefines an existing index), so this
 * runs the DDL directly against each one. Safe to re-run: both statements
 * are `IF EXISTS`/`IF NOT EXISTS`. No existing data can violate the new,
 * looser constraint — the old constraint was strictly tighter, so nothing
 * that satisfied it can fail to satisfy this one.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/migrate-designation-code-index.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { getDatabaseConfig } from '@app/database';
import { CryptoUtils } from '@app/common';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = getDatabaseConfig(true) as any;

  const platformConnection = new Sequelize({
    dialect: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    dialectOptions: config.dialectOptions,
    logging: false,
  });

  const [tenants]: any = await platformConnection.query(`
    SELECT tdc."tenantId", tdc."databaseName", tdc.host, tdc.port, tdc.username, tdc.password, tdc.dialect
    FROM tenant_database_configs tdc
  `);

  let migrated = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    const tenantConnection = new Sequelize({
      dialect: tenant.dialect,
      host: tenant.host,
      port: tenant.port,
      username: tenant.username,
      password: CryptoUtils.decrypt(tenant.password),
      database: tenant.databaseName,
      dialectOptions: config.dialectOptions,
      logging: false,
    });

    try {
      const [tables]: any = await tenantConnection.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'designations'`,
      );
      if (tables.length === 0) {
        console.log(
          `- ${tenant.databaseName}: no designations table yet, skipping`,
        );
        skipped++;
        continue;
      }

      console.log(
        `${dryRun ? '[dry-run] would migrate' : 'migrating'} ${tenant.databaseName}`,
      );
      if (!dryRun) {
        await tenantConnection.query(
          `DROP INDEX IF EXISTS "unique_designation_code";`,
        );
        await tenantConnection.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS "unique_designation_code_per_department" ON "designations" ("tenantId", "departmentId", "code");`,
        );
      }
      migrated++;
    } finally {
      await tenantConnection.close();
    }
  }

  console.log(
    `${dryRun ? 'Would migrate' : 'Migrated'} ${migrated} tenant database(s), skipped ${skipped}.`,
  );

  await platformConnection.close();
}

main().catch((error) => {
  console.error('Designation code index migration failed:', error.message);
  process.exit(1);
});
