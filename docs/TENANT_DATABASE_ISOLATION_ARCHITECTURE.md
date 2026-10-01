# Tenant Database Isolation Architecture & Operational Guide

## Overview

The HRMS Multi-Tenant platform enforces physical database isolation for tenant operational data. Platform-owned administration, subscription, billing, and global tenant management entities live in the shared platform database (`hrms_platform`), while all operational entities belonging to an organization are resolved into that tenant's dedicated physical database (`hrms_<tenant_id>`).

---

## 1. Entity Classification & Isolation Boundaries

### Platform-Owned Database (`hrms_platform`)
Registered directly in `TenantServiceModule` / `SequelizeModule.forFeature()`:
- `Tenant`
- `TenantDatabaseConfig`
- `Plan`
- `Subscription`
- `Payment`
- `Invoice`
- `BillingEvent`
- `OrganizationAdminInvitation`

### Per-Tenant Physical Database (`hrms_<tenant_id>`)
Resolved exclusively via `TenantModelProviderService` (`apps/tenant-service/src/services/tenant-model-provider.service.ts`):
- `Department`
- `Designation`
- `WorkingHours`
- `LeavePolicy`
- `AttendancePolicy`
- `OrganizationPolicy`
- `OrganizationModuleAccess`
- `User`, `Role`, `Permission`, `UserRole`, `RolePermission`, `EntityAuditLog` (via `user-service`)

---

## 2. Model & Foreign Key Design Rules

1. **Zero Cross-Database Foreign Keys**:
   No model registered on a tenant database contains `@ForeignKey(() => Tenant)` or `@BelongsTo(() => Tenant)`. Cross-database foreign keys in PostgreSQL/MySQL across separate connections are physically impossible and violate isolation boundaries.

2. **Harmless `tenantId` Audit Column**:
   - `tenantId` is preserved as a plain `DataType.UUID` column on tenant operational models.
   - **Purpose**: Defense-in-depth, event correlation, and query auditing.
   - **Boundary**: The physical database connection resolved for the tenant is the hard isolation boundary. Queries do not depend on `tenantId` predicates for physical isolation.

3. **Natural Key Unique Constraints**:
   Each tenant database enforces natural key unique constraints scoped to that tenant's physical database:
   - `Department`: Unique `name` and `code` (`unique_department_name`, `unique_department_code`).
   - `Designation`: Unique `title` and `code` (`unique_designation_title`, `unique_designation_code`).
   - `WorkingHours`: Unique `name` (`unique_working_hours_name`).
   - `LeavePolicy`: Unique `name` (`unique_leave_policy_name`).
   - `AttendancePolicy`: Unique policy per tenant database.
   - `OrganizationPolicy`: Unique `[policyType, version]` (`unique_org_policy_type_version`).
   - `OrganizationModuleAccess`: Unique `moduleKey` (`unique_module_key`).

---

## 3. Connection Lifecycle Controls (`TenantConnectionManager`)

Dynamically managed by `TenantConnectionManager` (`libs/tenant-context/src/context/tenant-connection.manager.ts`):

- **Maximum Cached Connections (LRU Eviction)**: Controlled by `MAX_TENANT_CONNECTIONS` (default: 50). When capacity is reached, the least recently used connection pool is gracefully evicted and closed.
- **Idle Eviction Sweeps**: Controlled by `TENANT_CONNECTION_IDLE_TIMEOUT_MS` (default: 10 minutes). A background sweep runs every 2 minutes to close connections idle beyond the threshold.
- **Graceful Shutdown**: `onModuleDestroy()` clears sweep timers and closes all active tenant connection pools cleanly.
- **Metrics API (`getMetrics()`)**: Exposes real-time metrics including `cacheSize`, `maxCacheSize`, `activeConnectionsCount`, `activeTenantIds`, `totalConnectionsCreated`, `connectionFailures`, `evictedConnections`, `hitCount`, and `missCount`.

---

## 4. Data Migration, Backup, Verification & Archiving Procedures

### Migration & Cutover Script (`migrate-tenant-data-isolation.ts`)
- **Read-Only Source**: Source platform operational rows are read without modification.
- **Idempotent Migration**: Uses primary key `id` upserting into target tenant databases.
- **Count & Content Verification**: Verifies source vs target row counts per model per tenant.
- **Logging**: Generates `migration-completion-log.json`.

```bash
npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/migrate-tenant-data-isolation.ts
```

### Pre-Migration Backup Verification (`backup-verify-tenant-data-isolation.ts`)
Creates a pre-migration snapshot comparing platform vs tenant database counts.

```bash
npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/backup-verify-tenant-data-isolation.ts
```

### Explicit Rollback Procedure (`rollback-tenant-data-isolation.ts`)
Safely clears tenant database operational tables while leaving platform database tables completely intact.

```bash
npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/rollback-tenant-data-isolation.ts
```

### Post-Verification Table Archiving (`archive-platform-tenant-tables.ts`)
Executed after the verification window to rename/archive legacy operational tables in `hrms_platform`.

```bash
npx ts-node -r tsconfig-paths/register apps/tenant-service/src/scripts/archive-platform-tenant-tables.ts
```

---

## 5. Automated CI Guards & Integration Tests

Automated integration tests (`apps/tenant-service/src/services/tenant-database-isolation.spec.ts`) run in CI to enforce:
1. **Cross-Tenant Data Leakage Guard**: Verifies that queries executed without `tenantId` predicates on Tenant A's connection cannot return Tenant B's rows.
2. **Platform Registration Guard**: Asserts that no tenant operational model is registered on the platform connection.
3. **Foreign Key Dependency Guard**: Asserts that zero foreign keys point to platform tables or the `tenants` table from tenant database models.
