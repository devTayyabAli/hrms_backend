/**
 * One-off backfill for `auth_credentials.firstName`/`lastName` on HR/Employee
 * accounts activated before `EmployeeInvitationService.activateEmployeeAccount`
 * started passing them through to `CREATE_ADMIN_CREDENTIAL` (same gap as
 * `backfill-admin-names.ts` fixed for Admin accounts, just on the employee
 * portal invitation path instead of the org-admin one).
 *
 * Unlike the Admin case, the authoritative name for an HR/Employee account
 * lives in that tenant's own `employees` table (tenant-service, a per-tenant
 * database — see `TenantDatabaseConfig`), not in a platform-DB invitation
 * row. For each empty-named HR/Employee `AuthCredential`, this resolves its
 * tenant's own database and looks up the matching `employees` row by email.
 * Never overwrites a name that's already set.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/auth-service/src/scripts/backfill-employee-names.ts [--dry-run]
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

  const [credentials]: any = await platformConnection.query(`
    SELECT id, email, "tenantId"
    FROM auth_credentials
    WHERE role IN ('HR', 'Employee')
      AND "tenantId" IS NOT NULL
      AND (COALESCE("firstName", '') = '' AND COALESCE("lastName", '') = '')
  `);

  let updated = 0;
  let skipped = 0;

  for (const credential of credentials) {
    const [dbConfigRows]: any = await platformConnection.query(
      `SELECT "databaseName", host, port, username, password, dialect FROM tenant_database_configs WHERE "tenantId" = :tenantId`,
      { replacements: { tenantId: credential.tenantId } },
    );
    if (dbConfigRows.length === 0) {
      console.log(`- ${credential.email}: no tenant database config for tenant ${credential.tenantId}, skipping`);
      skipped++;
      continue;
    }
    const dbConfig = dbConfigRows[0];

    const tenantConnection = new Sequelize({
      dialect: dbConfig.dialect,
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.username,
      password: CryptoUtils.decrypt(dbConfig.password),
      database: dbConfig.databaseName,
      dialectOptions: config.dialectOptions,
      logging: false,
    });

    const [employeeRows]: any = await tenantConnection.query(
      `SELECT "firstName", "lastName" FROM employees WHERE email = :email LIMIT 1`,
      { replacements: { email: credential.email } },
    );
    await tenantConnection.close();

    const employee = employeeRows[0];
    if (!employee || !employee.firstName) {
      console.log(`- ${credential.email}: no matching employee record found, skipping`);
      skipped++;
      continue;
    }

    console.log(
      `${dryRun ? '[dry-run] would set' : 'setting'} ${credential.email}: firstName="${employee.firstName}" lastName="${employee.lastName || ''}"`,
    );

    if (!dryRun) {
      await platformConnection.query(
        `UPDATE auth_credentials SET "firstName" = :firstName, "lastName" = :lastName WHERE id = :id`,
        {
          replacements: {
            firstName: employee.firstName,
            lastName: employee.lastName || '',
            id: credential.id,
          },
        },
      );
    }
    updated++;
  }

  console.log(
    `${dryRun ? 'Would update' : 'Updated'} ${updated} HR/Employee credential(s), skipped ${skipped}.`,
  );

  await platformConnection.close();
}

main().catch((error) => {
  console.error('Employee name backfill failed:', error.message);
  process.exit(1);
});
