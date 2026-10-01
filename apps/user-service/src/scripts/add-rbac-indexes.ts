/**
 * Adds the RBAC uniqueness/lookup indexes to every existing tenant database.
 *
 * The models now declare these (see user-role.model.ts, role-permission.model.ts
 * and permission.model.ts), but a declaration only reaches a database that is
 * created after it: `sync({ force: false })` creates missing tables, never
 * indexes on tables that already exist — and in production `sync()` no longer
 * runs at all (TENANT_DB_AUTO_SYNC). Existing tenants therefore need this
 * one-off pass.
 *
 * Each index is created CONCURRENTLY, so no table is locked against writes
 * while it builds. That is also why each statement runs on its own: Postgres
 * refuses CREATE INDEX CONCURRENTLY inside a transaction block.
 *
 * Duplicates are removed first, because that is what makes the unique indexes
 * creatable at all — and the duplicates are themselves the bug these
 * constraints prevent. A duplicate (userId, roleId) makes a user's role
 * appear twice in every eager-loaded list; a duplicate (resource, action)
 * splits one permission into two ids, so a grant recorded against one is
 * invisible to a check that resolved the other. The oldest row of each group
 * is kept, since that is the one existing grants point at.
 *
 * Safe to re-run: every statement is IF NOT EXISTS or a no-op once clean.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     apps/user-service/src/scripts/add-rbac-indexes.ts [--dry-run]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import {
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  tenantDatabaseName,
  writeOpsLog,
} from '../../../tenant-service/src/scripts/lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

interface TenantRow {
  id: string;
  name: string;
}

/**
 * Deletes all but the earliest row of each duplicate group.
 *
 * `ctid` is Postgres's physical row identifier — used here rather than the
 * `id` column because it is guaranteed distinct even for rows that are
 * otherwise byte-identical, which is exactly the case being cleaned up.
 */
const DEDUPE_TARGETS: Array<{
  label: string;
  table: string;
  columns: [string, string];
}> = [
  { label: 'user_roles', table: 'user_roles', columns: ['userId', 'roleId'] },
  {
    label: 'role_permissions',
    table: 'role_permissions',
    columns: ['roleId', 'permissionId'],
  },
  {
    label: 'permissions',
    table: 'permissions',
    columns: ['resource', 'action'],
  },
];

function dedupeMatch(table: string, columns: [string, string]): string {
  return `FROM ${table} a
      USING ${table} b
      WHERE a.ctid > b.ctid
        AND a."${columns[0]}" = b."${columns[0]}"
        AND a."${columns[1]}" = b."${columns[1]}"`;
}

function dedupeSql(table: string, columns: [string, string]): string {
  return `DELETE ${dedupeMatch(table, columns)}`;
}

/** Same predicate as the DELETE, counted instead of applied, for --dry-run. */
function dedupeCountSql(table: string, columns: [string, string]): string {
  return `SELECT COUNT(*)::int AS count ${dedupeMatch(table, columns)}`;
}

const INDEX_STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: 'unique_user_role',
    sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS unique_user_role ON user_roles ("userId", "roleId")`,
  },
  {
    label: 'idx_user_roles_role_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_roles_role_id ON user_roles ("roleId")`,
  },
  {
    label: 'unique_role_permission',
    sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS unique_role_permission ON role_permissions ("roleId", "permissionId")`,
  },
  {
    label: 'idx_role_permissions_permission_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_role_permissions_permission_id ON role_permissions ("permissionId")`,
  },
  {
    label: 'unique_permission_resource_action',
    sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS unique_permission_resource_action ON permissions ("resource", "action")`,
  },
];

interface TenantOutcome {
  tenantId: string;
  name: string;
  database: string;
  deduped: Record<string, number>;
  created: string[];
  error?: string;
}

async function migrateTenant(
  tenant: TenantRow,
  dryRun: boolean,
): Promise<TenantOutcome> {
  const database = tenantDatabaseName(tenant.id);
  const outcome: TenantOutcome = {
    tenantId: tenant.id,
    name: tenant.name,
    database,
    deduped: {},
    created: [],
  };

  const connection = createTenantConnection(database);
  try {
    await connection.authenticate();

    // A tenant provisioned before these tables existed has nothing to do
    // here; skip rather than fail the whole run on it.
    const present = await connection.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('user_roles', 'role_permissions', 'permissions')`,
      { type: QueryTypes.SELECT },
    );
    const tables = new Set(present.map((row) => row.table_name));
    if (tables.size < 3) {
      outcome.error = `missing table(s): ${[
        'user_roles',
        'role_permissions',
        'permissions',
      ]
        .filter((t) => !tables.has(t))
        .join(', ')}`;
      return outcome;
    }

    for (const target of DEDUPE_TARGETS) {
      if (dryRun) {
        const [row] = await connection.query<{ count: number }>(
          dedupeCountSql(target.table, target.columns),
          { type: QueryTypes.SELECT },
        );
        outcome.deduped[target.label] = row?.count ?? 0;
        continue;
      }
      const [, metadata] = await connection.query(
        dedupeSql(target.table, target.columns),
      );
      outcome.deduped[target.label] = (metadata as any)?.rowCount ?? 0;
    }

    for (const statement of INDEX_STATEMENTS) {
      if (dryRun) {
        outcome.created.push(`${statement.label} (dry-run)`);
        continue;
      }
      await connection.query(statement.sql);
      outcome.created.push(statement.label);
    }
  } catch (err: any) {
    outcome.error = err.message;
  } finally {
    await connection.close();
  }

  return outcome;
}

async function main(): Promise<void> {
  const { dryRun } = parseCliFlags(process.argv.slice(2));

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
    `${dryRun ? '[dry-run] ' : ''}Adding RBAC indexes across ${tenants.length} tenant database(s).`,
  );

  const outcomes: TenantOutcome[] = [];
  let failed = 0;

  for (const tenant of tenants) {
    const outcome = await migrateTenant(tenant, dryRun);
    outcomes.push(outcome);

    if (outcome.error) {
      failed++;
      console.error(`! ${tenant.name} (${outcome.database}): ${outcome.error}`);
      continue;
    }

    const removed = Object.values(outcome.deduped).reduce((a, b) => a + b, 0);
    console.log(
      `- ${tenant.name} (${outcome.database}): ${outcome.created.length} index(es), ${removed} duplicate row(s) removed`,
    );
  }

  const logPath = writeOpsLog('add-rbac-indexes.json', {
    ranAt: new Date().toISOString(),
    dryRun,
    tenantCount: tenants.length,
    failed,
    outcomes,
  });

  console.log(`\nDone across ${tenants.length} tenant(s). ${failed} failed.`);
  console.log(`Ops log: ${logPath}`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('RBAC index migration failed:', error.message);
  process.exit(1);
});
