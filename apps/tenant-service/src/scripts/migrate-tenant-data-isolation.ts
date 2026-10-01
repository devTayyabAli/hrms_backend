/**
 * Data Migration & Cutover Script: Tenant Database Isolation
 *
 * Copies tenant operational rows (Department, Designation, WorkingHours,
 * LeavePolicy, AttendancePolicy, OrganizationPolicy, OrganizationModuleAccess)
 * from the platform database into each tenant's isolated physical database.
 *
 * - Operates READ-ONLY on source platform tables.
 * - Idempotent (upserts by primary key `id`), batched via bulkCreate.
 * - Performs post-migration row count verification per table per tenant.
 * - A failure on one tenant is recorded and does not abort the remaining
 *   tenants; the completion log is written after every tenant so a crash
 *   never loses the record of tenants already processed.
 * - Records migration completion timestamp and verification metrics to
 *   `ops-logs/migration-completion-log.json`.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/migrate-tenant-data-isolation.ts [--dry-run]
 *
 *   --dry-run  Read and count source rows per tenant/model without writing
 *              anything to the tenant databases.
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
  tenantDatabaseName,
  writeOpsLog,
} from './lib/tenant-script-utils';

const MODELS = [
  Department,
  Designation,
  WorkingHours,
  LeavePolicy,
  AttendancePolicy,
  OrganizationPolicy,
  OrganizationModuleAccess,
];

const PAGE_SIZE = 500;
const LOG_FILE = 'migration-completion-log.json';

interface TenantMigrationResult {
  tenantId: string;
  name: string;
  status:
    'COMPLETED' | 'WARNING (count mismatch)' | 'FAILED' | 'SKIPPED (no DB)';
  sourceCounts: Record<string, number>;
  destCounts: Record<string, number>;
  verified: boolean;
  error?: string;
}

export async function runMigration() {
  const { dryRun } = parseCliFlags();
  const timestamp = new Date().toISOString();
  console.log(
    `Starting Tenant Database Isolation Migration [${timestamp}]${dryRun ? ' (DRY RUN)' : ''}...`,
  );

  const platformDb = createPlatformConnection();
  bindOperationalModels(platformDb, MODELS);
  await platformDb.authenticate();
  console.log(`Connected to platform database (Read-Only Source).`);

  const tenantRows = await platformDb.query<{
    id: string;
    name: string;
    provisioningStatus: string;
  }>(
    `SELECT id, name, "provisioningStatus" FROM tenants WHERE "provisioningStatus" = 'READY'`,
    { type: QueryTypes.SELECT },
  );

  console.log(`Found ${tenantRows.length} provisioned tenant(s) to process.\n`);

  const summary: TenantMigrationResult[] = [];

  const writeProgress = () =>
    writeOpsLog(LOG_FILE, {
      timestamp,
      dryRun,
      totalTenants: tenantRows.length,
      processedTenants: summary.length,
      summary,
    });

  for (const tenant of tenantRows) {
    const tenantId = tenant.id;
    const databaseName = tenantDatabaseName(tenantId);
    console.log(
      `--- Processing Tenant ${tenantId} (${tenant.name}) -> Target DB: ${databaseName} ---`,
    );

    const tenantDb = createTenantConnection(databaseName);
    const sourceCounts: Record<string, number> = {};
    const destCounts: Record<string, number> = {};
    let connected = false;

    try {
      await tenantDb.authenticate();
      connected = true;
      bindOperationalModels(tenantDb, MODELS);
      if (!dryRun) {
        await tenantDb.sync({ force: false });
      }

      let allVerified = true;

      for (const Model of MODELS) {
        const modelName = Model.name;
        const sourceModel = platformDb.models[modelName];
        const destModel = tenantDb.models[modelName];

        let offset = 0;
        let totalSource = 0;
        for (;;) {
          const rows = await sourceModel.findAll({
            where: { tenantId },
            raw: true,
            limit: PAGE_SIZE,
            offset,
            order: [['id', 'ASC']],
          });
          if (rows.length === 0) break;
          totalSource += rows.length;

          if (!dryRun) {
            const updateFields = Object.keys(rows[0] as object).filter(
              (f) => f !== 'id',
            );
            await destModel.bulkCreate(rows as any[], {
              updateOnDuplicate: updateFields as any,
            });
          }

          offset += rows.length;
          if (rows.length < PAGE_SIZE) break;
        }
        sourceCounts[modelName] = totalSource;

        if (dryRun) {
          destCounts[modelName] = totalSource; // nothing written yet; report intended count
          console.log(
            `  [dry-run] ${modelName}: ${totalSource} row(s) would be migrated`,
          );
          continue;
        }

        const destRowCount = await destModel.count({ where: { tenantId } });
        destCounts[modelName] = destRowCount;

        if (totalSource !== destRowCount) {
          console.warn(
            `  WARNING: Count mismatch for ${modelName}! Source: ${totalSource}, Dest: ${destRowCount}`,
          );
          allVerified = false;
        } else {
          console.log(
            `  ${modelName}: ${totalSource} row(s) migrated & verified (${destRowCount} total in tenant DB)`,
          );
        }
      }

      summary.push({
        tenantId,
        name: tenant.name,
        status: dryRun
          ? 'COMPLETED'
          : allVerified
            ? 'COMPLETED'
            : 'WARNING (count mismatch)',
        sourceCounts,
        destCounts,
        verified: dryRun ? true : allVerified,
      });
    } catch (err: any) {
      console.error(`  ERROR migrating tenant ${tenantId}: ${err.message}`);
      summary.push({
        tenantId,
        name: tenant.name,
        status: connected ? 'FAILED' : 'SKIPPED (no DB)',
        sourceCounts,
        destCounts,
        verified: false,
        error: err.message,
      });
    } finally {
      await tenantDb
        .close()
        .catch((err: any) =>
          console.error(
            `  Error closing connection for tenant ${tenantId}: ${err.message}`,
          ),
        );
      // Persist progress after every tenant so a crash never loses the
      // record of tenants already processed (previously the log was only
      // written once, after the entire batch completed).
      writeProgress();
      console.log('');
    }
  }

  await platformDb.close();

  const logPath = writeProgress();

  console.log('=== Tenant Isolation Migration Summary ===');
  for (const s of summary) {
    console.log(
      `${s.name} (${s.tenantId}): ${s.status} — Verified: ${s.verified} | Source Counts: ${JSON.stringify(
        s.sourceCounts,
      )} | Dest Counts: ${JSON.stringify(s.destCounts)}${s.error ? ` | Error: ${s.error}` : ''}`,
    );
  }
  console.log(`\nMigration log written to: ${logPath}`);
  if (dryRun) {
    console.log('Dry run complete. No tenant database rows were written.');
  } else {
    console.log(
      'Old platform-DB rows remain intact (Read-Only cutover complete). Proceed to verification & archiving.',
    );
  }

  return {
    timestamp,
    dryRun,
    totalTenants: tenantRows.length,
    processedTenants: summary.length,
    summary,
  };
}

if (require.main === module) {
  runMigration()
    .then((report) => {
      if (report.summary.some((s) => s.status === 'FAILED')) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
