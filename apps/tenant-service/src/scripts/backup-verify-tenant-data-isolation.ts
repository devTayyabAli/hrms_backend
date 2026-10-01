/**
 * Pre-Migration Backup & State Verification Script
 *
 * Snapshots row counts across the platform database and each tenant
 * database prior to cutover or archiving, plus a lightweight sample-record
 * content comparison (up to SAMPLE_SIZE rows per model, ordered by id) so a
 * count-only match can't hide rows that migrated with different field
 * values. A connection/query error is recorded as its own 'ERROR' state,
 * distinct from a genuine 'MISMATCH', and logged rather than silently
 * treated as zero rows.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/backup-verify-tenant-data-isolation.ts
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

const SAMPLE_SIZE = 5;
/** Volatile/generated columns excluded from the sample content diff. */
const IGNORED_SAMPLE_FIELDS = new Set(['createdAt', 'updatedAt']);

type ModelVerification =
  | {
      state: 'OK';
      platformRows: number;
      tenantDbRows: number;
      sampleChecked: number;
      sampleMismatches: string[];
    }
  | {
      state: 'MISMATCH';
      platformRows: number;
      tenantDbRows: number;
      sampleChecked: number;
      sampleMismatches: string[];
    }
  | { state: 'ERROR'; error: string };

function diffSampleRows(platformRows: any[], tenantRows: any[]): string[] {
  const tenantById = new Map(tenantRows.map((r) => [r.id, r]));
  const mismatches: string[] = [];

  for (const platformRow of platformRows) {
    const tenantRow = tenantById.get(platformRow.id);
    if (!tenantRow) {
      mismatches.push(`id=${platformRow.id} missing in tenant DB`);
      continue;
    }
    for (const field of Object.keys(platformRow)) {
      if (IGNORED_SAMPLE_FIELDS.has(field)) continue;
      const platformValue = JSON.stringify(platformRow[field]);
      const tenantValue = JSON.stringify(tenantRow[field]);
      if (platformValue !== tenantValue) {
        mismatches.push(
          `id=${platformRow.id} field "${field}" differs (platform=${platformValue}, tenant=${tenantValue})`,
        );
      }
    }
  }
  return mismatches;
}

export async function verifyAndBackup() {
  const timestamp = new Date().toISOString();
  console.log(
    `=== Running Pre-Migration Backup & State Verification [${timestamp}] ===`,
  );

  const platformDb = createPlatformConnection();
  bindOperationalModels(platformDb, OPERATIONAL_MODELS);
  await platformDb.authenticate();

  const tenants = await platformDb.query<{ id: string; name: string }>(
    `SELECT id, name FROM tenants WHERE "provisioningStatus" = 'READY'`,
    { type: QueryTypes.SELECT },
  );

  console.log(`Found ${tenants.length} ready tenant(s) in platform database.`);

  const backupSnapshot: Record<string, any> = {
    timestamp,
    platformTenantsCount: tenants.length,
    tenantsData: {},
  };

  for (const tenant of tenants) {
    const tenantId = tenant.id;
    const dbName = tenantDatabaseName(tenantId);
    const tenantMetrics: Record<string, ModelVerification> = {};

    const tenantDb = createTenantConnection(dbName);

    let connected = false;
    try {
      await tenantDb.authenticate();
      bindOperationalModels(tenantDb, OPERATIONAL_MODELS);
      connected = true;
    } catch (err: any) {
      console.error(
        `  Could not connect to tenant database "${dbName}": ${err.message}`,
      );
    }

    for (const Model of OPERATIONAL_MODELS) {
      const modelName = Model.name;
      try {
        const platformModel = platformDb.models[modelName];
        const platformRows = await platformModel.count({ where: { tenantId } });

        if (!connected) {
          tenantMetrics[modelName] = {
            state: 'ERROR',
            error: `tenant database "${dbName}" unreachable`,
          };
          continue;
        }

        const tenantModel = tenantDb.models[modelName];
        const tenantDbRows = await tenantModel.count({ where: { tenantId } });

        const platformSample = await platformModel.findAll({
          where: { tenantId },
          raw: true,
          limit: SAMPLE_SIZE,
          order: [['id', 'ASC']],
        });
        const tenantSample = await tenantModel.findAll({
          where: { tenantId },
          raw: true,
          limit: SAMPLE_SIZE,
          order: [['id', 'ASC']],
        });
        const sampleMismatches = diffSampleRows(
          platformSample as any[],
          tenantSample as any[],
        );

        const match =
          platformRows === tenantDbRows && sampleMismatches.length === 0;
        tenantMetrics[modelName] = {
          state: match ? 'OK' : 'MISMATCH',
          platformRows,
          tenantDbRows,
          sampleChecked: platformSample.length,
          sampleMismatches,
        };
        if (!match) {
          console.warn(
            `  MISMATCH ${modelName}: platform=${platformRows} tenant=${tenantDbRows} sampleMismatches=${sampleMismatches.length}`,
          );
        }
      } catch (err: any) {
        console.error(
          `  ERROR verifying ${modelName} for tenant ${tenantId}: ${err.message}`,
        );
        tenantMetrics[modelName] = { state: 'ERROR', error: err.message };
      }
    }

    backupSnapshot.tenantsData[tenantId] = {
      name: tenant.name,
      databaseName: dbName,
      connected,
      metrics: tenantMetrics,
    };

    await tenantDb.close().catch(() => undefined);
  }

  await platformDb.close();

  const backupFile = writeOpsLog(
    'backup-verification-snapshot.json',
    backupSnapshot,
  );

  console.log(`\nBackup verification snapshot saved to: ${backupFile}`);
  console.log('=== Pre-Migration Backup Verification Complete ===');

  return backupSnapshot;
}

if (require.main === module) {
  verifyAndBackup().catch((err) => {
    console.error('Backup verification failed:', err);
    process.exit(1);
  });
}
