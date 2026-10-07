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
 * `tenant-provisioning.service.ts` does on creation. It only fills in empty
 * names, or replaces a name that is just the organization's name (left by the
 * old invitation resend) — never a name the admin set themselves.
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

  // Also picks up admins whose name is the organization's name — the old
  // invitation resend stored the org name as `adminName`, and activation
  // copied it onto the credential.
  const [credentials]: any = await connection.query(`
    SELECT c.id, c.email, c."tenantId", c.phone
    FROM auth_credentials c
    LEFT JOIN tenants t ON t.id::text = c."tenantId"::text
    WHERE c.role IN ('Admin', 'ORGANIZATION_ADMIN')
      AND c."tenantId" IS NOT NULL
      AND (
        (COALESCE(c."firstName", '') = '' AND COALESCE(c."lastName", '') = '')
        OR LOWER(TRIM(CONCAT_WS(' ', NULLIF(c."firstName", ''), NULLIF(c."lastName", ''))))
           IN (LOWER(TRIM(COALESCE(t.name, ''))), LOWER(TRIM(COALESCE(t."organizationName", ''))),
               LOWER(TRIM(COALESCE(c."tenantName", ''))))
      )
  `);

  let updated = 0;
  let skipped = 0;

  for (const credential of credentials) {
    const [invitations]: any = await connection.query(
      `
      SELECT i."adminName", i.phone
      FROM organization_admin_invitations i
      JOIN tenants t ON t.id::text = i."tenantId"::text
      WHERE i."tenantId"::text = :tenantId
        AND i."adminEmail" = :email
        AND i."adminName" IS NOT NULL
        AND i."adminName" != ''
        AND LOWER(TRIM(i."adminName")) NOT IN (LOWER(TRIM(COALESCE(t.name, ''))), LOWER(TRIM(COALESCE(t."organizationName", ''))))
      ORDER BY i."createdAt" DESC
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
    // Only fills a missing phone — never replaces one the admin set.
    const phone: string | null = credential.phone || invitations[0]?.phone || null;

    console.log(
      `${dryRun ? '[dry-run] would set' : 'setting'} ${credential.email}: firstName="${firstName}" lastName="${lastName}" phone="${phone ?? ''}"`,
    );

    if (!dryRun) {
      await connection.query(
        `UPDATE auth_credentials SET "firstName" = :firstName, "lastName" = :lastName, phone = :phone WHERE id = :id`,
        { replacements: { firstName, lastName, phone, id: credential.id } },
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
