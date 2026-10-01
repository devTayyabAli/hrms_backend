/**
 * Enables the Recruitment module for every provisioned tenant.
 *
 * `HRMSModuleKey.RECRUITMENT` is deliberately excluded from
 * `OrganizationModuleAccessService.DEFAULT_MODULES` (it's listed there as a
 * "future/opt-in" module), so onboarding never writes a row for it unless the
 * org-creation request explicitly asked for it. With no row and no default,
 * `isModuleEnabled` falls through to its final `not configured or enabled`
 * branch — the exact error the Recruitment pages hit for every existing
 * tenant once the feature was wired up.
 *
 * This is additive and idempotent: it upserts one row per tenant keyed on
 * `moduleKey`, so re-running it is harmless and it never touches any other
 * module's row.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/enable-recruitment-module.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import { OrganizationModuleAccess } from '../models';
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

const MODULE_KEY = 'recruitment';

interface TenantRow {
  id: string;
  name: string;
}

interface TenantOutcome {
  tenantId: string;
  name: string;
  database: string;
  action: 'enabled' | 'already-enabled' | 'skipped';
  error?: string;
}

async function enableForTenant(
  tenant: TenantRow,
  dryRun: boolean,
): Promise<TenantOutcome> {
  const database = tenantDatabaseName(tenant.id);
  const outcome: TenantOutcome = {
    tenantId: tenant.id,
    name: tenant.name,
    database,
    action: 'skipped',
  };

  const connection = createTenantConnection(database);
  try {
    await connection.authenticate();
    bindOperationalModels(connection, [OrganizationModuleAccess]);

    const model = connection.models
      .OrganizationModuleAccess as typeof OrganizationModuleAccess;
    const existing = await model.findOne({ where: { moduleKey: MODULE_KEY } });

    if (existing?.enabled) {
      outcome.action = 'already-enabled';
      return outcome;
    }

    outcome.action = 'enabled';
    if (!dryRun) {
      await model.upsert({
        tenantId: tenant.id,
        moduleKey: MODULE_KEY,
        enabled: true,
        allowedActions: ['all'],
      });
    }
  } catch (error: any) {
    outcome.error = error.message;
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
    `${dryRun ? '[dry-run] ' : ''}Enabling '${MODULE_KEY}' for ${tenants.length} provisioned tenant(s).\n`,
  );

  const outcomes: TenantOutcome[] = [];
  let enabled = 0;
  let failed = 0;

  for (const tenant of tenants) {
    const outcome = await enableForTenant(tenant, dryRun);
    outcomes.push(outcome);

    if (outcome.error) {
      failed++;
      console.error(`! ${tenant.name} (${outcome.database}): ${outcome.error}`);
      continue;
    }

    if (outcome.action === 'already-enabled') {
      console.log(`- ${tenant.name} (${outcome.database}): already enabled`);
    } else {
      enabled++;
      console.log(
        `${dryRun ? '[dry-run] would enable' : 'enabled'} for ${tenant.name} (${outcome.database})`,
      );
    }
  }

  const logPath = writeOpsLog('enable-recruitment-module.json', {
    ranAt: new Date().toISOString(),
    dryRun,
    tenantCount: tenants.length,
    enabled,
    failed,
    outcomes,
  });

  console.log(
    `\n${dryRun ? 'Would enable' : 'Enabled'} for ${enabled} tenant(s). ${failed} failed.`,
  );
  console.log(`Ops log: ${logPath}`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Enabling the Recruitment module failed:', error.message);
  process.exit(1);
});
