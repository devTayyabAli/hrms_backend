/**
 * Prepares existing organizations for the Workspace screens (Tasks, Projects,
 * Company Calendar):
 *
 *   1. Creates `workspace_projects`, `workspace_tasks`, `calendar_events` and `company_documents`
 *      (or adds the columns they have gained since, e.g. holiday type)
 *      in each tenant database. New tenants get them at provisioning, and dev
 *      databases on first connection (sync), but production tenants created
 *      before this shipped need this step. `sync()` without `alter` only ever
 *      creates what is missing, so re-running is harmless.
 *   2. Enables the `projects` ("Projects & Tasks"), `calendar` and `documents` modules.
 *      Both are opt-in add-ons with no default, so without a row the module
 *      guard refuses every Workspace route. Skip with --skip-modules when the
 *      modules are sold per plan and enabled from the Super Admin instead.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/tenant-service/src/scripts/setup-workspace.ts [--dry-run] [--tenant=<id>] [--skip-modules]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import { OrganizationModuleAccess } from '../models';
import { TENANT_OPERATIONAL_MODELS } from '../services/tenant-model-provider.service';
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

const NEW_MODELS = ['WorkspaceProject', 'WorkspaceTask', 'CalendarEvent', 'CompanyDocument'];
const MODULE_KEYS = ['projects', 'calendar', 'documents'];

const argValue = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]?.trim() || undefined;

interface Outcome {
  tenantId: string;
  name: string;
  database: string;
  tables: string[];
  modules: string[];
  error?: string;
}

async function setupTenant(tenant: { id: string; name: string }, dryRun: boolean, skipModules: boolean): Promise<Outcome> {
  const database = tenantDatabaseName(tenant.id);
  const outcome: Outcome = { tenantId: tenant.id, name: tenant.name, database, tables: [], modules: [] };
  const connection = createTenantConnection(database);
  try {
    await connection.authenticate();
    bindOperationalModels(connection, TENANT_OPERATIONAL_MODELS);
    const query = connection.getQueryInterface();

    const tables = await query.showAllTables();
    for (const modelName of NEW_MODELS) {
      const model = connection.models[modelName];
      const table = model.getTableName() as string;
      if (!tables.includes(table)) {
        outcome.tables.push(table);
        if (!dryRun) await model.sync();
        continue;
      }
      // Columns added since the table first shipped (e.g. the holiday
      // type/optional flags on calendar_events).
      const existing = await query.describeTable(table);
      for (const attribute of Object.values(model.getAttributes()) as any[]) {
        const column = attribute.field ?? attribute.fieldName;
        if (!column || existing[column]) continue;
        outcome.tables.push(`${table}.${column}`);
        if (!dryRun) await query.addColumn(table, column, { ...attribute, primaryKey: false, references: undefined });
      }
    }

    if (!skipModules) {
      const Access = connection.models.OrganizationModuleAccess as typeof OrganizationModuleAccess;
      for (const moduleKey of MODULE_KEYS) {
        const existing = await Access.findOne({ where: { moduleKey } });
        if (existing?.enabled) continue;
        outcome.modules.push(moduleKey);
        if (!dryRun) {
          await Access.upsert({ tenantId: tenant.id, moduleKey, enabled: true, allowedActions: ['all'] });
        }
      }
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
  const onlyTenant = argValue('tenant');
  const skipModules = process.argv.includes('--skip-modules');

  const platform = createPlatformConnection();
  let tenants: { id: string; name: string }[];
  try {
    tenants = await platform.query(
      `SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY' ${onlyTenant ? 'AND id = :id' : ''} ORDER BY "createdAt" ASC`,
      { type: QueryTypes.SELECT, replacements: onlyTenant ? { id: onlyTenant } : undefined },
    );
  } finally {
    await platform.close();
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Setting up Workspace for ${tenants.length} tenant(s).\n`);
  const outcomes: Outcome[] = [];
  let failed = 0;
  for (const tenant of tenants) {
    const outcome = await setupTenant(tenant, dryRun, skipModules);
    outcomes.push(outcome);
    if (outcome.error) {
      failed++;
      console.error(`! ${tenant.name} (${outcome.database}): ${outcome.error}`);
      continue;
    }
    const did = [
      outcome.tables.length ? `schema: ${outcome.tables.join(', ')}` : '',
      outcome.modules.length ? `modules: ${outcome.modules.join(', ')}` : '',
    ].filter(Boolean);
    console.log(`${tenant.name} (${outcome.database}): ${did.length ? `${dryRun ? 'would add ' : 'added '}${did.join(' · ')}` : 'up to date'}`);
  }

  const logPath = writeOpsLog('setup-workspace.json', { ranAt: new Date().toISOString(), dryRun, outcomes });
  console.log(`\n${failed} failed. Ops log: ${logPath}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Workspace setup failed:', error.message);
  process.exit(1);
});
