# Central Read Model for SuperAdmin Listings — Implementation Plan

**Status:** Proposal, not yet implemented
**Audience:** Backend engineers on this repo
**Problem:** SuperAdmin list screens fan out to every tenant database on every page view.

---

## 1. The problem, measured

`PlatformClientsService.getClients()` ([apps/user-service/src/services/platform-clients.service.ts](../apps/user-service/src/services/platform-clients.service.ts)) renders one page of the SuperAdmin **Clients** table like this:

1. Fetch every tenant (`TENANT.GET_ALL_TENANTS`).
2. For each tenant, open its database and `findAll()` **every user** with their roles joined — `collectAllClientRows`, line 123.
3. Concatenate into one in-memory array.
4. Filter by role, department, status and search **in JavaScript** (lines 182–204).
5. Sort **in JavaScript** (line 212).
6. `slice()` the page out of the array (line 218).

So displaying 10 rows reads every user row in the entire platform. Cost per page view:

| Tenants | Users/tenant | Rows read | DB connections touched |
|--------:|-------------:|----------:|-----------------------:|
| 10      | 200          | 2,000     | 10                     |
| 100     | 200          | 20,000    | 100                    |
| 500     | 200          | 100,000   | 500                    |

Three things break as tenant count grows:

- **Connection thrashing.** `TenantConnectionManager` caps cached connections at `MAX_TENANT_CONNECTIONS` (default **50**, [libs/tenant-context/src/context/tenant-connection.manager.ts:25](../libs/tenant-context/src/context/tenant-connection.manager.ts#L25)). Past 50 tenants, one page view evicts and reopens connections continuously — each reopen is a TCP connect plus Postgres auth.
- **Latency is O(tenants), serial in batches.** `chunkedForEach` runs `TENANT_ITERATION_CONCURRENCY` at a time; wall-clock grows linearly.
- **Memory.** Every user row for the whole platform is materialised per request.

The same fan-out repeats in `getUserCountsByTenant`, `getStats`, `getByRole` and `getRecent` — so the Clients screen pays it several times over.

**Also affected:** `PlatformReportsService.getStats()` ([apps/tenant-service/src/services/platform-reports.service.ts:47](../apps/tenant-service/src/services/platform-reports.service.ts#L47)) calls `USER.GET_TENANT_USER_COUNTS`, which fans out the same way.

---

## 2. The approach

A **read model** (CQRS projection): tenant databases stay the system of record; the platform database gains flat, denormalised, indexed tables holding **only the fields SuperAdmin lists**. Writes go to the tenant DB as they do today and additionally emit an event that updates the central table.

Reads become one indexed query against one database.

### Design constraints specific to this codebase

| Constraint | Consequence |
|---|---|
| **No message broker.** No Redis, Kafka, RabbitMQ, Bull or NATS in `package.json` — only Nest TCP microservices. | "Events" must be a **transactional outbox** in the tenant DB, not a queue. Adding a broker is a separate decision; this plan does not require one. |
| **Tenant DBs are separate physical databases.** | No cross-database joins and no foreign keys from the central table to tenant rows. The projection stores `tenantId` + `sourceId` as plain columns. |
| **user-service has no platform DB connection.** Only tenant-service and auth-service call `DatabaseModule.forRoot({ isPlatform: true })`. | user-service **must not** write the projection directly. It writes the outbox (tenant-local, transactional); tenant-service owns and applies the projection. One writer, no write conflicts. |
| **A dropped event silently corrupts a list.** | Reconciliation and full rebuild are mandatory parts of the design, not optional extras. |

---

## 3. Central tables (platform DB)

### 3.1 `platform_directory_person`

One row per person visible to SuperAdmin, across all tenants.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Projection row id |
| `tenantId` | uuid | Plain column — **no FK**, different database |
| `sourceType` | enum | `USER` \| `EMPLOYEE` |
| `sourceId` | uuid | `users.id` / `employees.id` in the tenant DB |
| `organizationName` | varchar(255) | Denormalised from `Tenant` so listing needs no join |
| `name` | varchar(255) | Pre-joined `firstName + lastName` |
| `email` | varchar(255) | |
| `phone` | varchar(32) | nullable |
| `department` | varchar(255) | Denormalised **name**, not id |
| `role` | varchar(100) | Primary role name |
| `roleCategory` | enum | `ADMIN` \| `HR` \| `MANAGER` \| `EMPLOYEE` — precomputed by `categorizeRole` |
| `employeeCode` | varchar(64) | nullable |
| `isActive` | boolean | |
| `sourceCreatedAt` | timestamptz | The tenant row's `createdAt`, not the projection's |
| `sourceUpdatedAt` | timestamptz | |
| `version` | bigint | Monotonic per source row — drops stale out-of-order events |
| `syncedAt` | timestamptz | When the projection last applied an event |

**Uniqueness:** `UNIQUE (tenantId, sourceType, sourceId)` — the upsert key and the idempotency guarantee.

### 3.2 `platform_tenant_counters`

KPI cards must not scan the directory. One row per tenant, maintained incrementally.

| Column | Type |
|---|---|
| `tenantId` | uuid PK |
| `totalUsers`, `activeUsers` | int |
| `totalEmployees`, `activeEmployees` | int |
| `admins`, `hrs`, `managers` | int |
| `updatedAt` | timestamptz |

`GET_TENANT_USER_COUNTS` becomes `SELECT * FROM platform_tenant_counters` — one query, no fan-out.

### 3.3 Indexes

Index the **access paths the screen actually uses**, not every column:

```sql
-- Default listing: non-employee contacts, newest first
CREATE INDEX idx_directory_listing
  ON platform_directory_person ("roleCategory", "isActive", "sourceCreatedAt" DESC);

-- "Filter by organization" dropdown
CREATE INDEX idx_directory_tenant
  ON platform_directory_person ("tenantId", "roleCategory");

-- Upsert target + reconciliation
CREATE UNIQUE INDEX idx_directory_source
  ON platform_directory_person ("tenantId", "sourceType", "sourceId");

-- Department filter, only where set
CREATE INDEX idx_directory_department
  ON platform_directory_person ("department")
  WHERE "department" IS NOT NULL;

-- Search across name / email / organization
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_directory_search
  ON platform_directory_person
  USING GIN (("name" || ' ' || "email" || ' ' || "organizationName") gin_trgm_ops);
```

A trigram GIN index is what makes the current `ILIKE '%term%'` behaviour fast. Without it, search degrades to a sequential scan and undoes the whole exercise. If you prefer ranked search over substring matching, use a `tsvector` column with a GIN index instead — but note that changes matching semantics (`meer` stops matching `meera`), so it is a product decision, not a swap.

### 3.4 Keyset pagination (recommended)

`OFFSET` degrades linearly — page 500 still walks 5,000 rows. Prefer:

```sql
WHERE ("sourceCreatedAt", "id") < ($lastCreatedAt, $lastId)
ORDER BY "sourceCreatedAt" DESC, "id" DESC
LIMIT $limit
```

Keep `OFFSET` for the numbered pager if the UI needs one, but return a cursor so "next page" is O(limit).

---

## 4. Event flow

### 4.1 Outbox table (every tenant DB)

```
projection_outbox
  id            uuid PK
  aggregateType varchar(64)    -- 'USER' | 'EMPLOYEE'
  aggregateId   uuid
  eventType     varchar(32)    -- 'CREATED' | 'UPDATED' | 'DELETED'
  payload       jsonb          -- the projection fields, already flattened
  version       bigint
  occurredAt    timestamptz
  processedAt   timestamptz    NULL
  attempts      int DEFAULT 0
  lastError     text           NULL

INDEX (processedAt, occurredAt)  WHERE processedAt IS NULL
```

**The row is written in the same transaction as the domain write.** This is the whole point — either the employee exists and the event exists, or neither does. A dual-write without a transaction can lose events on a crash between the two statements.

```ts
await sequelize.transaction(async (tx) => {
  const employee = await Employee.create({ ...dto }, { transaction: tx });
  await ProjectionOutbox.create({
    aggregateType: 'EMPLOYEE',
    aggregateId: employee.id,
    eventType: 'CREATED',
    version: Date.now(),
    payload: toDirectoryPayload(employee),
  }, { transaction: tx });
});
```

### 4.2 Two delivery paths

**Fast path (synchronous).** After the transaction commits, the writing service asks tenant-service to apply the projection immediately (`PROJECTION.APPLY` over TCP). Typical case: the central table is current within milliseconds, so a newly created employee appears on the SuperAdmin list right away. If this call fails, it is **logged and swallowed** — the outbox row is already durable.

**Durable path (relay).** A scheduled worker in tenant-service drains unprocessed outbox rows and applies them. This is what makes the system correct: the fast path is an optimisation, the relay is the guarantee.

```
Tenant write (tx) ──┬─► tenant DB row
                    └─► projection_outbox row
                              │
        ┌─────────────────────┴──────────────────┐
        ▼ (fast, best-effort)                    ▼ (durable, retried)
  PROJECTION.APPLY  ───────────────────────►  Relay poller
        │                                        │
        └──────────────┬─────────────────────────┘
                       ▼
        platform_directory_person  (UPSERT / DELETE)
        platform_tenant_counters   (incremental)
```

### 4.3 Avoiding "poll every tenant"

Polling all tenant outboxes reintroduces the fan-out on a timer. Keep a signal row in the platform DB:

```
platform_projection_signal (tenantId uuid PK, pendingSince timestamptz, lastDrainedAt timestamptz)
```

The fast path sets `pendingSince` when it cannot apply. The relay visits **only tenants with `pendingSince IS NOT NULL`** — normally zero. A slower full sweep (hourly) catches tenants whose signal write itself failed.

### 4.4 Idempotency and ordering

At-least-once delivery means every apply must be safe to repeat:

- **Upsert on** `(tenantId, sourceType, sourceId)` — never blind `INSERT`.
- **Guard with `version`:** `WHERE EXCLUDED.version > platform_directory_person.version`. An out-of-order or replayed `UPDATED` is discarded rather than resurrecting stale values.
- **`DELETED` wins:** deletes are applied unconditionally and a tombstone is kept briefly (`deletedAt`) so a late `UPDATED` cannot recreate the row. Purge tombstones after the retention window (24h is ample).

### 4.5 Deletion

The user explicitly called this out, and it is the easiest half to get wrong.

- **Hard delete** in tenant → `DELETED` event → `DELETE FROM platform_directory_person WHERE tenantId=? AND sourceType=? AND sourceId=?`.
- **Soft delete / status change** → `UPDATED` with `isActive=false`. The row stays listable, which is what "Inactive" filters expect.
- **Bulk delete** (`EMPLOYEE.BULK_DELETE` exists today) must emit **one event per id**, inside the same transaction as the bulk delete.
- **Tenant deleted or deprovisioned** → `DELETE FROM platform_directory_person WHERE tenantId=?` plus its counters and signal row. Hook this into the existing tenant lifecycle in `TenantProvisioningService`.

Reconciliation (§6) is the safety net for every delete the event path misses.

---

## 5. Read path rewrite

`PlatformClientsService.getClients()` collapses from ~60 lines of fan-out to one query:

```sql
SELECT * FROM platform_directory_person
WHERE "deletedAt" IS NULL
  AND ($roleCategory::text IS NULL OR "roleCategory" = $roleCategory)
  AND ($roleCategory::text IS NOT NULL OR "roleCategory" <> 'EMPLOYEE')
  AND ($tenantId::uuid  IS NULL OR "tenantId"   = $tenantId)
  AND ($department::text IS NULL OR "department" = $department)
  AND ($isActive::bool  IS NULL OR "isActive"   = $isActive)
  AND ($search::text    IS NULL OR
       ("name" || ' ' || "email" || ' ' || "organizationName") ILIKE '%' || $search || '%')
ORDER BY "sourceCreatedAt" DESC, "id" DESC
LIMIT $limit OFFSET $offset;
```

Expected: **hundreds of milliseconds to seconds → single-digit milliseconds**, and flat as tenant count grows.

**Ownership note.** The projection lives in the platform DB, which user-service cannot reach. Either move these read endpoints to tenant-service, or give user-service a platform connection. **Recommendation: move the read to tenant-service** — it already owns `Tenant`, `Plan` and `Subscription`, and keeping one service as the projection's sole reader and writer avoids a second service caching a schema it does not own.

`lastActiveAt` still comes from auth-service (`AUTH.GET_LAST_LOGINS`) for the **page only** (≤ limit rows), which is already cheap. Fold it into the projection later if it becomes hot.

---

## 6. Correctness: backfill, reconciliation, rebuild

A projection without these is a liability — silent drift shows up as wrong numbers on an executive dashboard.

**Backfill** (`npm run db:rebuild-directory`, new script beside [sync-tenant-columns.ts](../apps/tenant-service/src/scripts/sync-tenant-columns.ts)):
for each tenant, read all users/employees, upsert, then delete projection rows whose `sourceId` no longer exists. Idempotent, re-runnable, supports `--tenant=<id>` and `--dry-run`. This is also the disaster-recovery path: the projection is always rebuildable from tenant DBs, so it can be dropped and recreated without data loss.

**Reconciliation** (scheduled, off-peak): per tenant compare `COUNT(*)` in the tenant DB against the projection. On mismatch, rebuild that tenant and log it as a defect — a mismatch means an event was lost, and the cause deserves investigation rather than silent repair.

**Monitoring** — three signals worth alerting on:
1. Oldest unprocessed outbox row (replication lag). Alert > 5 min.
2. Outbox rows with `attempts > 5` (poison events).
3. Reconciliation mismatch count. Should be 0.

---

## 7. Phased rollout

| Phase | Work | Ships |
|---|---|---|
| **1** | Migration: create both platform tables + indexes. Models + `HrReportRun`-style registration. | Nothing user-visible |
| **2** | `db:rebuild-directory` backfill script. Run it; verify counts match fan-out. | Nothing user-visible |
| **3** | **Dual-read behind `USE_DIRECTORY_PROJECTION`.** Serve from fan-out, also query the projection, log differences. Run until diffs are zero. | Nothing user-visible |
| **4** | Outbox table + emit on create/update/delete/bulk-delete in employee and user writes. | Projection stays current |
| **5** | Relay worker + signal table + fast path. | Durability |
| **6** | Flip the flag. Delete `collectAllClientRows`. | **The speedup** |
| **7** | Reconciliation job + monitoring. | Safety net |

Phase 3 is the one to not skip. It is the only cheap way to prove the projection is correct before anything depends on it, and it makes the cutover a config change rather than a deploy.

---

## 8. Trade-offs to accept deliberately

**Eventual consistency.** A SuperAdmin list can be milliseconds-to-seconds stale. Acceptable for a directory; **not** acceptable for anything transactional — never read permissions, billing entitlements or seat limits from the projection. Those must keep reading the tenant DB.

**Write amplification.** Every employee/user write gains one local insert plus one async apply. Negligible against the read saving, but it means tenant writes now depend on the outbox table existing — the sync script must create it before the emitting code deploys.

**Duplicated field definitions.** `department` and `organizationName` are denormalised copies. A department rename must emit `UPDATED` for its employees, or the projection shows the old name. Decide whether renames re-emit or wait for nightly reconciliation; re-emitting is correct, reconciliation is cheaper.

**Schema coupling.** The projection's columns are a contract. Adding a listing column means: migration, payload change, backfill. Keep the projection to what SuperAdmin **lists** — resist adding fields "just in case", or it drifts into a replica of the tenant DB.

---

## 9. Files this touches

| File | Change |
|---|---|
| `apps/tenant-service/src/models/platform-directory-person.model.ts` | **new** |
| `apps/tenant-service/src/models/platform-tenant-counters.model.ts` | **new** |
| `apps/tenant-service/src/models/projection-outbox.model.ts` | **new** (tenant-scoped; add to `OPERATIONAL_MODELS`) |
| `apps/tenant-service/src/services/directory-projection.service.ts` | **new** — apply/upsert/delete |
| `apps/tenant-service/src/services/projection-relay.service.ts` | **new** — scheduled drain |
| `apps/tenant-service/src/scripts/rebuild-directory.ts` | **new** — backfill + reconcile |
| `apps/tenant-service/src/scripts/sync-tenant-columns.ts` | register `ProjectionOutbox` |
| `apps/tenant-service/src/services/employee.service.ts` | emit outbox on create/update/delete/bulk-delete |
| `apps/user-service/src/services/user.service.ts` | emit outbox on create/update/delete |
| `apps/user-service/src/services/platform-clients.service.ts` | replace fan-out with projection query (or move to tenant-service) |
| `apps/tenant-service/src/services/platform-reports.service.ts` | read counters instead of `GET_TENANT_USER_COUNTS` |
| `libs/common/src/index.ts` | `PROJECTION.APPLY` message pattern |

---

## 10. Open questions

1. **Employees as well as users?** The Clients screen lists user-service `users`. Does SuperAdmin also need a cross-tenant **employee** directory? The `sourceType` column anticipates it; confirm before building the employee emitter.
2. **Search semantics** — keep `ILIKE '%term%'` (trigram) or move to ranked full-text (`tsvector`)? Changes what matches.
3. **Staleness budget** — is "within 5 seconds" acceptable for the Clients list, or must a newly created admin appear instantly? Determines whether the fast path is mandatory or the relay alone suffices.
4. **Tenant count and growth** — the current fan-out is survivable below ~20 tenants. Knowing the real target sizes whether this is urgent or preventative.
5. **Move reads to tenant-service, or give user-service a platform connection?** §5 recommends the former.
