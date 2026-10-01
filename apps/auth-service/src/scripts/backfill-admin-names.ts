/**
 * One-off backfill for `auth_credentials.firstName`/`lastName` on Admin
 * accounts activated before those columns existed (or before the activation
 * flow started passing them — see `organization-admin-invitation.service.ts`
 * `activateInvitation`, Step 3).
 *
 * The platform and tenant tables live in the same physical database (see
 * `PLATFORM_DB_NAME` / `DATABASE_URL` in `.env`), so this reads the name the
 * admin actually entered from `organization_admin_invitations.adminName`
 * (the most recent invitation per tenant) and splits it the same way
 * `tenant-provisioning.service.ts` does on creation. It never overwrites a
 * name that's already set — only fills in empty ones.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/auth-service/src/scripts/backfill-admin-names.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { getDatabaseConfig } from '@app/database';
import { AuthCredential } from '../models';

dotenv.config({ path: '.env.development' });
dotenv.config();

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
    models: [AuthCredential],
  });

  const [credentials]: any = await connection.query(`
    SELECT id, email, "tenantId"
    FROM auth_credentials
    WHERE role = 'Admin'
      AND "tenantId" IS NOT NULL
      AND (COALESCE("firstName", '') = '' AND COALESCE("lastName", '') = '')
  `);

  let updated = 0;
  let skipped = 0;

  for (const credential of credentials) {
    const [invitations]: any = await connection.query(
      `
      SELECT "adminName"
      FROM organization_admin_invitations
      WHERE "tenantId" = :tenantId
        AND "adminEmail" = :email
        AND "adminName" IS NOT NULL
        AND "adminName" != ''
      ORDER BY "createdAt" DESC
      LIMIT 1
      `,
      { replacements: { tenantId: credential.tenantId, email: credential.email } },
    );

    const adminName: string | undefined = invitations[0]?.adminName;
    if (!adminName) {
      console.log(`- ${credential.email}: no invitation with a name found, skipping`);
      skipped++;
      continue;
    }

    const firstName = adminName.split(' ')[0];
    const lastName = adminName.split(' ').slice(1).join(' ');

    console.log(
      `${dryRun ? '[dry-run] would set' : 'setting'} ${credential.email}: firstName="${firstName}" lastName="${lastName}"`,
    );

    if (!dryRun) {
      await connection.query(
        `UPDATE auth_credentials SET "firstName" = :firstName, "lastName" = :lastName WHERE id = :id`,
        { replacements: { firstName, lastName, id: credential.id } },
      );
    }
    updated++;
  }

  console.log(
    `${dryRun ? 'Would update' : 'Updated'} ${updated} admin credential(s), skipped ${skipped} (no matching invitation).`,
  );

  await connection.close();
}

main().catch((error) => {
  console.error('Admin name backfill failed:', error.message);
  process.exit(1);
});
