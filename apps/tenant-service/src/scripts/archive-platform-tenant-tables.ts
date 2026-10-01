/**
 * Post-Verification Platform Table Archiving & Removal Script
 *
 * After the verification window has elapsed and tenant database isolation is
 * confirmed, this script archives (renames) legacy operational tables in the
 * platform database (`hrms_platform`), recording the outcome — including any
 * per-table failures — to `ops-logs/archive-completion-log.json`.
 *
 * The overall `status` only reports `COMPLETED` when every table archived
 * successfully; a partial failure is reported as `COMPLETED_WITH_ERRORS`
 * with the failing tables listed, and the process exits non-zero, so a
 * partial failure here can never be mistaken for a clean run downstream
 * (in particular, `rollback-tenant-data-isolation.ts` treats a non-empty
 * `archivedTables` list here as "no longer safe to roll back").
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/archive-platform-tenant-tables.ts
 */
import 'reflect-metadata';
import {
  createPlatformConnection,
  assertKnownIdentifier,
  writeOpsLog,
} from './lib/tenant-script-utils';

const LEGACY_PLATFORM_TABLES = [
  'departments',
  'designations',
  'working_hours',
  'leave_policies',
  'attendance_policies',
  'organization_policies',
  'organization_module_access',
] as const;

interface TableArchiveResult {
  table: string;
  status: 'ARCHIVED' | 'SKIPPED (not found)' | 'FAILED';
  archivedAs?: string;
  error?: string;
}

export async function archivePlatformTables() {
  const timestamp = new Date().toISOString();
  console.log(
    `=== Starting Platform Table Archiving & Removal Procedure [${timestamp}] ===`,
  );

  const platformDb = createPlatformConnection();
  await platformDb.authenticate();
  console.log('Connected to platform database for table archiving.');

  const results: TableArchiveResult[] = [];

  for (const tableName of LEGACY_PLATFORM_TABLES) {
    // Defensive even though tableName always comes from the constant array
    // above — enforces the "only ever operate on a known table" invariant
    // in code rather than by convention, so raw-SQL identifier interpolation
    // below can't be exploited if this list is ever made configurable.
    assertKnownIdentifier(tableName, LEGACY_PLATFORM_TABLES);
    const archiveTableName = `archive_${tableName}_${timestamp.replace(/[^a-zA-Z0-9]/g, '_')}`;

    try {
      const [rows] = await platformDb.query(
        'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = :tableName);',
        { replacements: { tableName } },
      );
      const exists = (rows as any)[0]?.exists;

      if (!exists) {
        console.log(
          `  Table "${tableName}" does not exist in platform database (already archived/removed).`,
        );
        results.push({ table: tableName, status: 'SKIPPED (not found)' });
        continue;
      }

      await platformDb.query(
        `ALTER TABLE "${tableName}" RENAME TO "${archiveTableName}";`,
      );
      console.log(`  Archived table: "${tableName}" to "${archiveTableName}"`);
      results.push({
        table: tableName,
        status: 'ARCHIVED',
        archivedAs: archiveTableName,
      });
    } catch (err: any) {
      console.error(`  Error archiving table "${tableName}": ${err.message}`);
      results.push({ table: tableName, status: 'FAILED', error: err.message });
    }
  }

  await platformDb.close();

  const failed = results.filter((r) => r.status === 'FAILED');
  const archivedTables = results
    .filter((r) => r.status === 'ARCHIVED')
    .map((r) => `${r.table} -> ${r.archivedAs}`);
  const status = failed.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';

  const completionData = {
    timestamp,
    results,
    archivedTables,
    status,
  };

  const completionLogPath = writeOpsLog(
    'archive-completion-log.json',
    completionData,
  );

  console.log(
    `\nPlatform table archiving finished with status: ${status}${failed.length > 0 ? ` (${failed.length} table(s) failed)` : ''}.`,
  );
  console.log(`Completion log written to: ${completionLogPath}`);

  return completionData;
}

if (require.main === module) {
  archivePlatformTables()
    .then((result) => {
      if (result.status !== 'COMPLETED') {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Platform table archiving failed:', err);
      process.exit(1);
    });
}
