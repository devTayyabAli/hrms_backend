/**
 * Explicit Rollback Procedure Script
 *
 * Provides a reversible rollback procedure for Tenant Database Isolation.
 * If data migration or verification fails during cutover, this script:
 * 1. Restores/preserves platform database operational rows intact.
 * 2. Cleans up populated per-tenant database operational tables.
 * 3. Logs a structured rollback report with timestamp to
 *    `ops-logs/rollback-completion-log.json`.
 *
 * SAFETY: this script refuses to run once
 * `archive-platform-tenant-tables.ts` has archived the legacy platform
 * tables, because at that point the tenant databases are the *only*
 * remaining copy of the data and destroying their rows would be permanent
 * data loss. Pass --force to override that check (only if you have an
 * independent backup). Pass --dry-run to see what would be deleted without
 * deleting anything.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/rollback-tenant-data-isolation.ts [--dry-run] [--force]
 */
import 'reflect-metadata';
import { QueryTypes } from 'sequelize';
import {
  Department,
  Designation,
  WorkingHours,
  LeavePolicy,
  AttendancePolicy,
  OrganizationPolicy,
  OrganizationModuleAccess,
} from '../models';
import {
  bindOperationalModels,
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  readOpsLog,
  tenantDatabaseName,
  writeOpsLog,
} from './lib/tenant-script-utils';

const OPERATIONAL_MODELS = [
  Department,
  Designation,
  WorkingHours,
  LeavePolicy,
  AttendancePolicy,
  OrganizationPolicy,
  OrganizationModuleAccess,
];

interface ArchiveCompletionLog {
  archivedTables?: string[];
}

/**
 * Refuses rollback if the platform legacy tables have already been archived
 * (renamed away) — at that point a tenant database is the only remaining
 * copy of that tenant's data, and destroying it would be unrecoverable.
 */
export function assertSafeToRollback(force: boolean): void {
  const archiveLog = readOpsLog<ArchiveCompletionLog>(
    'archive-completion-log.json',
  );
  const archivedCount = archiveLog?.archivedTables?.length ?? 0;

  if (archivedCount > 0 && !force) {
    throw new Error(
      `Refusing to roll back: archive-completion-log.json shows ${archivedCount} platform table(s) already ` +
        `archived. Tenant databases are the only remaining copy of this data — rolling back now would ` +
        `permanently delete it. Re-run with --force only if you have verified an independent backup exists.`,
    );
  }
}

export async function runRollback() {
  const { dryRun, force } = parseCliFlags();
  assertSafeToRollback(force);

  const timestamp = new Date().toISOString();
  console.log(
    `=== Starting Tenant Isolation Rollback Procedure [${timestamp}]${dryRun ? ' (DRY RUN)' : ''} ===`,
  );

  const platformDb = createPlatformConnection();
  await platformDb.authenticate();

  const tenants = await platformDb.query<{ id: string; name: string }>(
    `SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY'`,
    { type: QueryTypes.SELECT },
  );

  console.log(
    `Found ${tenants.length} tenant(s) to rollback in physical tenant databases.`,
  );

  const rollbackSummary: Array<{
    tenantId: string;
    databaseName: string;
    clearedTables: string[];
    status: string;
  }> = [];

  for (const tenant of tenants) {
    const tenantId = tenant.id;
    const dbName = tenantDatabaseName(tenantId);
    console.log(
      `--- ${dryRun ? 'Previewing' : 'Rolling back'} tenant DB: ${dbName} ---`,
    );

    const tenantDb = createTenantConnection(dbName);
    const clearedTables: string[] = [];

    try {
      await tenantDb.authenticate();
      bindOperationalModels(tenantDb, OPERATIONAL_MODELS);

      for (const Model of OPERATIONAL_MODELS) {
        const destModel = tenantDb.models[Model.name];
        if (dryRun) {
          const count = await destModel.count({ where: { tenantId } });
          console.log(
            `  [dry-run] ${Model.name}: ${count} row(s) would be destroyed`,
          );
        } else {
          await destModel.destroy({ where: { tenantId }, truncate: false });
        }
        clearedTables.push(Model.name);
      }

      rollbackSummary.push({
        tenantId,
        databaseName: dbName,
        clearedTables,
        status: dryRun ? 'DRY_RUN' : 'SUCCESS',
      });

      await tenantDb.close();
    } catch (err: any) {
      console.error(`  ERROR rolling back ${dbName}: ${err.message}`);
      rollbackSummary.push({
        tenantId,
        databaseName: dbName,
        clearedTables,
        status: `FAILED (${err.message})`,
      });
      await tenantDb.close().catch(() => undefined);
    }
  }

  await platformDb.close();

  const logFile = writeOpsLog('rollback-completion-log.json', {
    timestamp,
    dryRun,
    status: dryRun ? 'DRY_RUN' : 'ROLLBACK_EXECUTED',
    summary: rollbackSummary,
  });

  console.log(
    `\n${dryRun ? 'Dry run' : 'Rollback execution'} complete. Log written to: ${logFile}`,
  );
  console.log('Platform database rows were left untouched and active.');

  return rollbackSummary;
}

if (require.main === module) {
  runRollback().catch((err) => {
    console.error('Rollback script failed:', err);
    process.exit(1);
  });
}
