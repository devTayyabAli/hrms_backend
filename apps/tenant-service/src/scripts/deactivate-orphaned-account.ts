/**
 * One-off cleanup for an orphaned tenant account: a `User` row (user-service,
 * this tenant's own per-tenant database) with an HR/Employee portal role but
 * no matching `Employee` record behind it — the invitation that should have
 * created one got stuck `PENDING`.
 *
 * Concretely, for tayyabarine@gmail.com / CloudPeak Innovations
 * (tenantId d6567b91-cb9b-43e0-88b3-801b296d6dcf): `EmployeeInvitationService
 * .activateEmployeeAccount` created this `User` row (Step 1) successfully,
 * then Step 2 (create/upsert the `AuthCredential`) failed — this email
 * already owns an `AuthCredential` for a *different*, since-deleted tenant
 * (48e68ab7-0559-42c3-a2d4-b6600de5e5cb), and `AuthService.createAdminCredential`
 * refuses to hijack a credential that belongs to another tenant. So this
 * account never got a working login for CloudPeak Innovations at all — it's
 * a dangling profile row, not a live security exposure — but it still
 * inflates the tenant's "Users" count and should be marked inactive rather
 * than left silently dangling.
 *
 * This only flips `isActive: false` on the `users` row in the *target*
 * tenant's own database. It deliberately does not touch the unrelated
 * `AuthCredential` row for the other (deleted) tenant — that's out of scope
 * here and touching it wouldn't affect CloudPeak Innovations either way.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/deactivate-orphaned-account.ts <tenantId> <email> [--dry-run]
 */
import * as dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { getDatabaseConfig } from '@app/database';
import { CryptoUtils } from '@app/common';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const [tenantId, email] = args;
  if (!tenantId || !email) {
    throw new Error('Usage: deactivate-orphaned-account.ts <tenantId> <email> [--dry-run]');
  }

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

  const [dbConfigRows]: any = await platformConnection.query(
    `SELECT "databaseName", host, port, username, password, dialect FROM tenant_database_configs WHERE "tenantId" = :tenantId`,
    { replacements: { tenantId } },
  );
  if (dbConfigRows.length === 0) {
    throw new Error(`No tenant_database_configs row found for tenant ${tenantId}`);
  }
  const dbConfig = dbConfigRows[0];
  await platformConnection.close();

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

  const [userRows]: any = await tenantConnection.query(
    `SELECT id, email, "isActive" FROM users WHERE email = :email`,
    { replacements: { email } },
  );
  console.log(`users row(s) in tenant ${tenantId}:`, userRows);

  if (userRows.length === 0) {
    console.log('Nothing to do — no matching row.');
  } else if (dryRun) {
    console.log('[dry-run] would set isActive = false on the row above.');
  } else {
    await tenantConnection.query(`UPDATE users SET "isActive" = false WHERE email = :email`, {
      replacements: { email },
    });
    console.log(`Deactivated ${email} in tenant ${tenantId}'s users table.`);
  }

  await tenantConnection.close();
}

main().catch((error) => {
  console.error('Deactivation failed:', error.message);
  process.exit(1);
});
