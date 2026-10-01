/**
 * Adds `roles."permissionsConfigured"` to every provisioned tenant database.
 *
 * Dev-mode schema sync only creates missing tables — it never adds a column
 * to one that already exists — so tenants provisioned before the column was
 * introduced need it added explicitly. New tenants get it from the model.
 *
 * Existing rows start at `false`, so user-service seeds each system role's
 * default permissions (e.g. HR's module grants) the first time it's read,
 * then never touches them again. Additive and idempotent.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/add-role-permissions-configured.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import {
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  tenantDatabaseName,
} from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

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
      const [{ exists }] = await connection.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_name = 'roles' AND column_name = 'permissionsConfigured'
         ) AS exists`,
        { type: QueryTypes.SELECT },
      );
      if (exists) {
        console.log(`- ${tenant.name} (${database}): already has the column`);
        continue;
      }
      if (!dryRun) {
        await connection.query(
          `ALTER TABLE roles ADD COLUMN IF NOT EXISTS "permissionsConfigured" BOOLEAN NOT NULL DEFAULT false`,
        );
      }
      console.log(`${dryRun ? '[dry-run] would add' : 'added'} column for ${tenant.name} (${database})`);
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
