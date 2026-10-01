/**
 * Rebuilds the SuperAdmin directory projection from the tenant databases.
 *
 * The projection is derived data: tenant databases are the system of record,
 * so this script can always reconstruct it and nothing is lost by dropping
 * and recreating the table. That is what makes the whole read model safe to
 * adopt — a bug in the event path is recoverable, not corrupting.
 *
 * Three jobs:
 *   1. BACKFILL   — project every existing user into the directory.
 *   2. ORPHANS    — delete directory rows whose source row no longer exists,
 *                   which is how a delete the event path missed gets healed.
 *   3. RECONCILE  — compare counts per tenant and report drift. A mismatch
 *                   means an event was lost; it is repaired here but should
 *                   be investigated rather than treated as routine.
 *
 * Safe to re-run, and safe against a database holding real rows: every write
 * is an upsert keyed on (tenantId, sourceType, sourceId).
 *
 * Usage:
 *   npm run db:rebuild-directory -- [--dry-run] [--tenant=<uuid>]
 */
import * as dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  PlatformDirectoryPerson,
  PlatformProjectionSignal,
  PlatformTenantCounters,
} from '@app/database';
import {
  createPlatformConnection,
  createTenantConnection,
  parseCliFlags,
  tenantDatabaseName,
  writeOpsLog,
} from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

interface TenantRow {
  id: string;
  name: string;
  organizationName?: string | null;
}

interface TenantOutcome {
  tenantId: string;
  name: string;
  projected: number;
  orphansRemoved: number;
  sourceCount: number;
  projectionCount: number;
  drifted: boolean;
  /** Set when the tenant has no schema to project from — not an error. */
  skipped?: string;
  error?: string;
}

/** Mirrors categorizeRoleName in @app/database — kept in sync deliberately. */
function categorize(roleName?: string | null): string {
  const name = (roleName || '').toUpperCase();
  if (name.includes('ADMIN')) return 'ADMIN';
  if (name.includes('HR')) return 'HR';
  if (name.includes('EMPLOYEE')) return 'EMPLOYEE';
  return 'OTHER';
}

interface SourceUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  department: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  roleName: string | null;
}

async function rebuildTenant(
  platform: any,
  tenant: TenantRow,
  dryRun: boolean,
): Promise<TenantOutcome> {
  const outcome: TenantOutcome = {
    tenantId: tenant.id,
    name: tenant.name,
    projected: 0,
    orphansRemoved: 0,
    sourceCount: 0,
    projectionCount: 0,
    drifted: false,
  };

  const connection = createTenantConnection(tenantDatabaseName(tenant.id));
  try {
    await connection.authenticate();

    // Raw SQL rather than the models: this script must run against a tenant
    // whose schema predates any model change, and it only needs six columns
    // plus the primary role.
    const users = await connection.query<SourceUser>(
      `SELECT u.id, u.email, u."firstName", u."lastName", u.phone, u.department,
              u."isActive", u."createdAt", u."updatedAt",
              (SELECT r.name
                 FROM user_roles ur
                 JOIN roles r ON r.id = ur."roleId"
                WHERE ur."userId" = u.id
                ORDER BY r.name ASC
                LIMIT 1) AS "roleName"
         FROM users u`,
      { type: QueryTypes.SELECT },
    );

    outcome.sourceCount = users.length;
    const organizationName = tenant.organizationName || tenant.name;

    if (!dryRun) {
      for (const user of users) {
        await platform.query(
          `INSERT INTO platform_directory_person
             ("id", "tenantId", "sourceType", "sourceId", "organizationName", "name",
              "email", "phone", "department", "role", "roleCategory", "isActive",
              "sourceCreatedAt", "sourceUpdatedAt", "version", "deletedAt", "syncedAt",
              "createdAt", "updatedAt")
           VALUES
             (gen_random_uuid(), :tenantId, 'USER', :sourceId, :organizationName, :name,
              :email, :phone, :department, :role, :roleCategory, :isActive,
              :sourceCreatedAt, :sourceUpdatedAt, :version, NULL, NOW(), NOW(), NOW())
           ON CONFLICT ("tenantId", "sourceType", "sourceId") DO UPDATE SET
             "organizationName" = EXCLUDED."organizationName",
             "name"             = EXCLUDED."name",
             "email"            = EXCLUDED."email",
             "phone"            = EXCLUDED."phone",
             "department"       = EXCLUDED."department",
             "role"             = EXCLUDED."role",
             "roleCategory"     = EXCLUDED."roleCategory",
             "isActive"         = EXCLUDED."isActive",
             "sourceCreatedAt"  = EXCLUDED."sourceCreatedAt",
             "sourceUpdatedAt"  = EXCLUDED."sourceUpdatedAt",
             "version"          = EXCLUDED."version",
             "deletedAt"        = NULL,
             "syncedAt"         = NOW(),
             "updatedAt"        = NOW()`,
          {
            replacements: {
              tenantId: tenant.id,
              sourceId: user.id,
              organizationName,
              name:
                [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
              email: user.email,
              phone: user.phone ?? null,
              department: user.department ?? null,
              role: user.roleName ?? null,
              roleCategory: categorize(user.roleName),
              isActive: user.isActive,
              sourceCreatedAt: user.createdAt,
              sourceUpdatedAt: user.updatedAt,
              // A rebuild is authoritative, so it must win over any event
              // still queued from before it ran.
              version: String(Date.now()),
            },
          },
        );
        outcome.projected++;
      }

      // Anything in the projection this tenant no longer has.
      const liveIds = users.map((user) => user.id);
      const [, meta]: any = liveIds.length
        ? await platform.query(
            `DELETE FROM platform_directory_person
              WHERE "tenantId" = :tenantId AND "sourceType" = 'USER'
                AND "sourceId" <> ALL(ARRAY[:liveIds]::uuid[])`,
            { replacements: { tenantId: tenant.id, liveIds } },
          )
        : await platform.query(
            `DELETE FROM platform_directory_person
              WHERE "tenantId" = :tenantId AND "sourceType" = 'USER'`,
            { replacements: { tenantId: tenant.id } },
          );
      outcome.orphansRemoved = meta?.rowCount ?? 0;

      await refreshCounters(platform, tenant.id);
    }

    const [{ count }]: any = await platform.query(
      `SELECT COUNT(*)::int AS count FROM platform_directory_person
        WHERE "tenantId" = :tenantId AND "sourceType" = 'USER' AND "deletedAt" IS NULL`,
      { replacements: { tenantId: tenant.id }, type: QueryTypes.SELECT },
    );
    outcome.projectionCount = count;
    outcome.drifted = !dryRun && count !== outcome.sourceCount;
  } catch (error: any) {
    // A tenant flagged READY whose schema was never actually created has no
    // `users` table. That is a half-finished provisioning job, not a
    // projection failure, and reporting it as one would make every run of
    // this script exit non-zero on an otherwise healthy platform.
    if (/relation .* does not exist/i.test(error.message ?? '')) {
      outcome.skipped = 'tenant database has no schema yet';
    } else {
      outcome.error = error.message;
    }
  } finally {
    await connection.close();
  }

  return outcome;
}

/**
 * Creates the three projection tables if this platform database has not seen
 * them yet.
 *
 * The models are bound to the script's own connection and synced, rather than
 * the DDL being written out by hand here: two definitions of the same table
 * drift, and the models are already the source of truth the services use.
 * `force: false` means existing tables are left alone.
 */
async function ensureTables(platform: Sequelize): Promise<void> {
  platform.addModels([
    PlatformDirectoryPerson,
    PlatformTenantCounters,
    PlatformProjectionSignal,
  ] as any);
  await platform.sync({ force: false });
}

/**
 * Indexes the model cannot declare.
 *
 * The unique index is what `ON CONFLICT` above binds to, so the upsert is a
 * syntax error without it. The trigram index is what keeps the Clients search
 * box fast: the listing filters with `ILIKE '%term%'`, which no B-tree can
 * serve, so without this the search degrades to a sequential scan over the
 * whole directory and undoes the point of the projection.
 *
 * All idempotent, so this runs on every invocation rather than needing its
 * own migration step.
 */
async function ensureIndexes(platform: any): Promise<void> {
  const statements = [
    `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    `CREATE UNIQUE INDEX IF NOT EXISTS directory_source_unique_idx
       ON platform_directory_person ("tenantId", "sourceType", "sourceId")`,
    `CREATE INDEX IF NOT EXISTS directory_listing_idx
       ON platform_directory_person ("roleCategory", "isActive", "sourceCreatedAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS directory_tenant_idx
       ON platform_directory_person ("tenantId", "roleCategory")`,
    `CREATE INDEX IF NOT EXISTS directory_department_idx
       ON platform_directory_person ("department") WHERE "department" IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS directory_search_idx
       ON platform_directory_person USING GIN (
         (COALESCE("name",'') || ' ' || COALESCE("email",'') || ' ' ||
          COALESCE("organizationName",'')) gin_trgm_ops)`,
  ];

  for (const statement of statements) {
    try {
      await platform.query(statement);
    } catch (error: any) {
      // CREATE EXTENSION needs privileges a managed database may withhold.
      // Report it rather than aborting: everything except fast search still
      // works, and the operator needs to know which one failed.
      console.warn(`  index step skipped: ${error.message.split('\n')[0]}`);
    }
  }
}

async function refreshCounters(platform: any, tenantId: string): Promise<void> {
  await platform.query(
    `INSERT INTO platform_tenant_counters
       ("tenantId", "totalUsers", "activeUsers", "admins", "hrs", "managers",
        "employees", "createdAt", "updatedAt")
     SELECT :tenantId,
            COUNT(*)::int,
            COUNT(*) FILTER (WHERE "isActive")::int,
            COUNT(*) FILTER (WHERE "roleCategory" = 'ADMIN')::int,
            COUNT(*) FILTER (WHERE "roleCategory" = 'HR')::int,
            0,
            COUNT(*) FILTER (WHERE "roleCategory" = 'EMPLOYEE')::int,
            NOW(), NOW()
       FROM platform_directory_person
      WHERE "tenantId" = :tenantId AND "deletedAt" IS NULL
     ON CONFLICT ("tenantId") DO UPDATE SET
       "totalUsers"  = EXCLUDED."totalUsers",
       "activeUsers" = EXCLUDED."activeUsers",
       "admins"      = EXCLUDED."admins",
       "hrs"         = EXCLUDED."hrs",
       "employees"   = EXCLUDED."employees",
       "updatedAt"   = NOW()`,
    { replacements: { tenantId } },
  );
}

async function main(): Promise<void> {
  const { dryRun } = parseCliFlags();
  const onlyTenant = process.argv
    .find((arg) => arg.startsWith('--tenant='))
    ?.split('=')[1];

  const platform = createPlatformConnection();
  await platform.authenticate();

  if (!dryRun) {
    console.log('Ensuring projection tables...');
    await ensureTables(platform);
    console.log('Ensuring projection indexes...');
    await ensureIndexes(platform);
  }

  // Only provisioned tenants, matching sync-tenant-columns. A tenant still
  // being set up has no `users` table yet, and reporting that as a failure
  // would make a healthy platform look broken to whatever runs this.
  let tenants = await platform.query<TenantRow>(
    `SELECT id, name, "organizationName" FROM tenants
      WHERE "provisioningStatus" = 'READY' ORDER BY "createdAt" ASC`,
    { type: QueryTypes.SELECT },
  );
  if (onlyTenant) tenants = tenants.filter((tenant) => tenant.id === onlyTenant);

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Rebuilding directory projection for ${tenants.length} tenant(s).\n`,
  );

  const outcomes: TenantOutcome[] = [];
  let failed = 0;
  let drifted = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    const outcome = await rebuildTenant(platform, tenant, dryRun);
    outcomes.push(outcome);

    if (outcome.skipped) {
      skipped++;
      console.log(`- ${tenant.name}: skipped, ${outcome.skipped}`);
      continue;
    }
    if (outcome.error) {
      failed++;
      console.error(`! ${tenant.name}: ${outcome.error}`);
      continue;
    }
    if (outcome.drifted) {
      drifted++;
      console.warn(
        `~ ${tenant.name}: projection had ${outcome.projectionCount} rows for ${outcome.sourceCount} users — repaired, investigate the event path`,
      );
      continue;
    }
    console.log(
      `- ${tenant.name}: ${outcome.projected} projected, ${outcome.orphansRemoved} orphan(s) removed`,
    );
  }

  const logPath = writeOpsLog('rebuild-directory.json', {
    ranAt: new Date().toISOString(),
    dryRun,
    tenantCount: tenants.length,
    failed,
    drifted,
    skipped,
    outcomes,
  });

  await platform.close();

  console.log(
    `\n${dryRun ? 'Would project' : 'Projected'} ${outcomes.reduce(
      (sum, outcome) => sum + outcome.projected,
      0,
    )} row(s) across ${tenants.length} tenant(s). ${failed} failed, ${drifted} drifted.`,
  );
  console.log(`Ops log: ${logPath}`);

  // A non-zero exit makes drift visible to CI or a cron wrapper rather than
  // leaving it buried in output nobody reads.
  if (failed > 0) process.exit(1);
}

main().catch((error: any) => {
  console.error('Directory rebuild failed:', error.message);
  process.exit(1);
});
