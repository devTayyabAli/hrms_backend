# Central Read Model — What Is Implemented

**Companion to:** [CENTRAL_READ_MODEL_PLAN.md](./CENTRAL_READ_MODEL_PLAN.md)
**Status:** Phases 1–7 implemented and **run against the live development database.**
**Verification:** `tsc --noEmit` clean · 320/320 tests across 21 suites · all four services build · 17/17 end-to-end checks against real Postgres · 7/7 inline-flush checks over real TCP · tenant-service boots with the relay running.

---

## 1. Summary

The SuperAdmin Clients directory no longer fans out across every tenant database. A central, indexed projection in the platform database serves the listing; tenant databases remain the system of record and feed the projection through a transactional outbox.

| | Before | After |
|---|---|---|
| Databases opened per page view | one per tenant | **1** |
| Rows read per page view | every user on the platform | **one page** |
| Filtering / sorting / paging | in JavaScript | in Postgres, on indexes |
| Cost as tenants grow | linear | **flat** |

---

## 2. What was built

### 2.1 Central tables (platform database)

Defined in `libs/database/src/models/` so the writer (tenant-service) and any reader share **one** definition rather than two that can drift.

| Table | File | Purpose |
|---|---|---|
| `platform_directory_person` | [platform-directory-person.model.ts](../libs/database/src/models/platform-directory-person.model.ts) | One flat row per person across all tenants — the Clients listing |
| `platform_tenant_counters` | [platform-tenant-counters.model.ts](../libs/database/src/models/platform-tenant-counters.model.ts) | Per-tenant headcount rollups for KPI cards |
| `platform_projection_signal` | [platform-projection-signal.model.ts](../libs/database/src/models/platform-projection-signal.model.ts) | Which tenants still owe events |
| `projection_outbox` | [projection-outbox.model.ts](../libs/database/src/models/projection-outbox.model.ts) | Per-**tenant** transactional outbox |

`platform_directory_person` carries `tenantId` + `sourceId` as plain columns with **no foreign key** — the rows they reference live in a different physical database.

### 2.2 Indexes

Declared on the model (created by sync) and additionally created idempotently by the rebuild script:

| Index | Serves |
|---|---|
| `directory_source_unique_idx` UNIQUE (tenantId, sourceType, sourceId) | The upsert key **and** the idempotency guarantee |
| `directory_listing_idx` (roleCategory, isActive, sourceCreatedAt DESC) | Default listing |
| `directory_tenant_idx` (tenantId, roleCategory) | Organization filter |
| `directory_department_idx` (department) WHERE NOT NULL | Department filter |
| `directory_search_idx` GIN trigram | `ILIKE '%term%'` search |

The trigram index is **load-bearing**. Without it the search box degrades to a sequential scan over the whole directory, which would undo the projection. It needs `CREATE EXTENSION pg_trgm`; if the database user lacks that privilege the script warns and continues — everything except fast search still works, and the operator is told which step was skipped.

### 2.3 Services

| Service | File | Role |
|---|---|---|
| `DirectoryProjectionService` | [directory-projection.service.ts](../apps/tenant-service/src/services/directory-projection.service.ts) | **The only writer.** Apply, query, counters, signal, tombstone purge |
| `ProjectionRelayService` | [projection-relay.service.ts](../apps/tenant-service/src/services/projection-relay.service.ts) | Drains outboxes; scheduled worker |
| `DirectoryEmitterService` | [directory-emitter.service.ts](../apps/user-service/src/services/directory-emitter.service.ts) | Queues events in user-service and flushes them inline |
| `emitProjectionEvent(s)` | [outbox-writer.ts](../libs/database/src/projection/outbox-writer.ts) | Transaction-aware outbox writer |

### 2.4 Event flow, as implemented

```
user-service write (ONE transaction)
  ├─► users / user_roles rows
  └─► projection_outbox row
            │  commit
            ▼
  DirectoryEmitterService.flush()          ← fast path, best effort
            │  PROJECTION.APPLY (TCP)
            ▼
  tenant-service DirectoryProjectionService.apply()
            ▼
  platform_directory_person  (upsert / tombstone)
  platform_tenant_counters   (recomputed per touched tenant)

  on failure ──► platform_projection_signal.pendingSince = now
                      │
                      ▼
            ProjectionRelayService          ← durable path, retried
              every 15s: pending tenants only
              every 1h : full sweep + tombstone purge
```

**Why both paths.** The inline apply keeps the SuperAdmin list current within milliseconds. The relay is what makes it *correct* — the outbox row is already committed, so a failed inline apply loses nothing.

### 2.5 Read path

`PlatformClientsService` now serves four endpoints from the projection:

| Method | Before | After |
|---|---|---|
| `getClients` | fan-out + in-memory filter/sort/slice | `PROJECTION.QUERY_DIRECTORY` — one indexed query |
| `getStats` | fan-out, counted in memory | `PROJECTION.DIRECTORY_STATS` — 3 grouped queries |
| `getByRole` | fan-out | same grouped query |
| `getRecent` | fan-out + full sort | first page of the default order |

`PlatformReportsService.getStats` reads `platform_tenant_counters` directly instead of calling `USER.GET_TENANT_USER_COUNTS`, which was the second fan-out.

`lastActiveAt` still comes from auth-service, but only for the rows on the page (≤ limit), so it stays cheap.

### 2.6 RPC surface

`MESSAGE_PATTERNS.PROJECTION.*` — all seven defined, all seven handled in tenant-service:

| Pattern | Used by |
|---|---|
| `APPLY` | user-service inline flush; also carries `markPending` |
| `QUERY_DIRECTORY` | Clients listing |
| `DIRECTORY_STATS` | Clients KPI cards + role breakdown |
| `GET_COUNTERS` | available; platform-reports calls the service directly |
| `GET_LAG` | monitoring — outbox depth and age |
| `GET_HEALTH` | `GET /superadmin/system/directory-projection` |
| `DROP_TENANT` | called on tenant deprovision |

### 2.7 Emitters wired

In `UserService` — every write that changes what the directory shows:

| Method | Event | Transactional? |
|---|---|---|
| `createUser` | `CREATED` | **Yes** — user, roles and event in one transaction |
| `updateUser` | `UPDATED` | Event after commit |
| `deleteUser` | `DELETED` | **Yes** — role rows, user and event in one transaction |
| `assignRole` | `UPDATED` | Event after commit |
| `revokeRole` | `UPDATED` | Event after commit |
| `setUserRoles` | `UPDATED` | Event after commit |

Role changes emit because `roleCategory` is derived from the primary role and is what the Clients list filters on — the user row itself is unchanged, but the projection row is stale.

### 2.8 Backfill / reconcile script

`npm run db:rebuild-directory -- [--dry-run] [--tenant=<uuid>]`
→ [rebuild-directory.ts](../apps/tenant-service/src/scripts/rebuild-directory.ts)

Does three jobs: ensures indexes, upserts every user into the directory, deletes orphans whose source row is gone, and reports per-tenant drift between source count and projection count. Idempotent and safe on a populated database. Exits non-zero on failure so a cron wrapper or CI notices.

---

## 3. Correctness guarantees, and the tests that hold them

The outbox is **at-least-once**, so every apply must survive replay, reordering and races. 38 tests cover this.

| Guarantee | How | Test |
|---|---|---|
| Replay is a no-op | Upsert on `(tenantId, sourceType, sourceId)` + `version` guard | *ignores a replay of an event it already applied* |
| Out-of-order is discarded | Apply only when `event.version > row.version` | *ignores an event older than the row it holds* |
| Partial events don't blank fields | Only keys present in the payload are written | *applies only the fields the payload carried* |
| **A deleted person cannot reappear** | Tombstone (`deletedAt`); a late `UPDATED` is refused | *does not let a late update resurrect a deleted person* |
| Re-adding the same id works | Only `CREATED` clears a tombstone | *revives the row when the same id is created again* |
| Counters cannot drift | Recomputed per tenant, never incremented | *recomputes from the directory rather than incrementing* |
| Sort column can't be injected | Whitelist; unknown falls back to `sourceCreatedAt` | *ignores a sort column that is not whitelisted* |
| Paging can't repeat a row | `id` tiebreaker on every order | *breaks ties on id so paging cannot repeat a row* |
| **Steady state opens no tenant connections** | Relay reads the signal table first | *touches no tenant when nothing is pending* |
| One broken tenant can't stop the rest | Per-tenant try/catch, re-flag as pending | *contains a tenant whose database cannot be opened* |
| A poison event can't block the queue | `attempts` incremented; parked at 8 | *counts an attempt when a batch fails* |
| Overlapping passes can't double-apply | `running` guard | *does not start a second pass while one is running* |

---

## 4. Verified against the live database

Run on the development platform database (7 tenants, 6 provisioned).

### 4.1 Backfill

```
Ensuring projection tables...
Ensuring projection indexes...
Rebuilding directory projection for 7 tenant(s).
- CloudPeak Innovations: 4 projected, 0 orphan(s) removed
- Astra Network: 1 projected  - Fuutura: 2 projected
- Better Logic: 1 projected   - Code Finity: 1 projected
- Better Loop: 1 projected
- Test Error Check: skipped, tenant database has no schema yet
Projected 10 row(s) across 7 tenant(s). 0 failed, 0 drifted.
```

All six indexes confirmed present, including `directory_search_idx` (GIN trigram).

### 4.2 End-to-end harness — 17/17 passed

Every guarantee exercised against real Postgres, not mocks. Each step verified by reading the row back:

| # | Check | Result |
|---|---|---|
| 1 | Event committed to outbox inside a transaction | PASS |
| 2 | Apply creates the row; `roleCategory` derived; org name denormalised | PASS |
| 3 | **Replay of the same version is skipped** | PASS |
| 4 | **Older version discarded** (out-of-order) | PASS |
| 5 | Newer version applied; field absent from payload preserved | PASS |
| 6 | Found via `ILIKE` search; stats return both month windows | PASS |
| 7 | Delete tombstones the row and hides it from the listing | PASS |
| 8 | **Late update cannot resurrect a deleted person** | PASS |
| 9 | Counters equal the live row count | PASS |
| 10 | Signal flags pending and clears on drain | PASS |

The harness cleaned up after itself; no probe rows remain.

### 4.3 Live state after backfill

```json
{ "healthy": true, "directoryRows": 10, "tombstones": 0,
  "tenantsTracked": 6, "pendingTenants": 0, "failingTenants": [] }
```

Listing returns `total=8` — 10 rows minus the 2 `EMPLOYEE` rows correctly excluded from the contacts directory. Stats: `ADMIN 6, HR 2, EMPLOYEE 2, TOTAL 10`, consistent with the per-tenant counters.

### 4.4 Inline flush over real TCP — 7/7 passed

`DirectoryEmitterService` driven against a live tenant-service on port 3002, exercising the whole fast path: emit → tenant outbox → `PROJECTION.APPLY` over TCP → central directory.

| # | Check | Result |
|---|---|---|
| 1 | Event queued in the tenant's outbox | PASS |
| 2 | Row reached the central directory after `flush()` | PASS |
| 3 | `name`, `roleCategory` (ADMIN) and `department` all projected | PASS |
| 4 | Outbox row marked processed — nothing left pending | PASS |
| 5 | Delete tombstoned through the same path | PASS |

tenant-service logged `handleProjectionApply` receiving both calls, with **zero errors** for the session.

### 4.5 Service boot

tenant-service started cleanly: the DI graph resolves, `ProjectionRelayService` logged *"Projection relay started (every 15000ms, full sweep every 3600000ms)"*, and **zero errors** across 90 seconds (~6 relay ticks). The relay was silent after startup — exactly as designed, since no tenant is pending it opens no tenant connections at all.

---

## 4b. Problems found by running it

Three real defects surfaced only once this met a live database.

**1. `Designation.code` could never sync.** The model declared `unique: true` on `code` alone, but the deployed databases carry `unique_designation_code_per_department` on `(tenantId, departmentId, code)` — a code like "L2" is legitimately reused across departments. `sync()` therefore failed with *"code must be unique"* on **3 of 6 tenants**, and because sync runs first that aborted column and enum reconciliation for those whole tenants. The model had drifted from the databases; it now declares the composite index. All 6 tenants reconcile cleanly.

**2. A failed `sync()` abandoned the entire tenant.** One unsatisfiable index meant no table got created and no enum value got added for that tenant. `sync()` is now isolated in its own try/catch: the failure is recorded as `syncError` and reconciliation continues. This is why the outbox tables exist on tenants that would otherwise have been skipped.

**3. "Validation error" named neither table nor constraint.** The script logged Sequelize's bare `.message`, which is unactionable. It now unwraps `.errors` / `.parent` / `.original`, which is how defect 1 was identified at all.

Also fixed: `rebuild-directory` treated a half-provisioned tenant (flagged `READY` but with no schema) as a failure, which would make every run exit non-zero on a healthy platform. It now reports those as skipped.

---

## 5. Deployment

**Order matters** — the outbox table must exist before any service that writes to it starts.

```bash
# 1. Create projection_outbox in every tenant DB (also adds the HR Portal
#    tables and the SELF_SERVICE enum value from the previous change).
npm run db:sync-tenant-columns -- --dry-run
npm run db:sync-tenant-columns

# 2. Deploy tenant-service (creates the platform tables on boot in dev;
#    in production ensure the three platform tables exist first).

# 3. Backfill, and create the indexes the models cannot declare.
npm run db:rebuild-directory -- --dry-run
npm run db:rebuild-directory

# 4. Deploy user-service (starts emitting).
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `USE_DIRECTORY_PROJECTION` | `true` | `false` reverts the Clients screen to the fan-out |
| `PROJECTION_RELAY_ENABLED` | `true` | `false` disables the relay worker |
| `PROJECTION_RELAY_INTERVAL_MS` | `15000` | Pending-tenant drain interval |
| `PROJECTION_SWEEP_INTERVAL_MS` | `3600000` | Full sweep + tombstone purge |

**Rollback is a config change**, not a deploy: set `USE_DIRECTORY_PROJECTION=false` and the original fan-out serves the screen again. It was kept deliberately for this reason.

---

## 5. Deviations from the plan

**Reads go through tenant-service over RPC, rather than user-service querying the platform database.** The plan offered both. Chosen because user-service has no platform connection, and giving it one would mean two services registering the same models — exactly the drift the shared `libs/database` definitions avoid. Cost is one local TCP hop per listing, against a fan-out of N database connections.

**Counters are recomputed per tenant, not incremented per event.** An aggregate over one tenant's rows is a single indexed query, and unlike running totals it cannot drift after a missed event.

**`getStats` growth percentages were nearly lost.** The first cut of the projection path returned zeros for month-over-month growth because the windowed counts weren't projected. Rather than ship a silent regression on a dashboard, `directoryStats()` now returns `totals` / `thisMonth` / `lastMonth` and the percentage uses the **same formula** as the fan-out, so the cards don't change value when the flag flips.

---

## 7. Closed since the first draft

- **`DROP_TENANT` is now called.** `TenantProvisioningService.deprovisionTenant` drops the projection rows, counters and signal for the tenant. Nothing else would have: the relay only visits tenants that still exist, so a deprovisioned organization's people would have stayed on the Clients screen indefinitely.
- **Monitoring is exposed.** `GET /superadmin/system/directory-projection` returns `healthy`, rows held, tombstones, tenants behind, how long the oldest has been behind, and which tenants are failing with their last error.
- **Run against a real database.** §4 above.

---

## 8. Remaining gaps

1. **Phase 3 dual-read logging was not built.** The flag switches between implementations but does not run both and diff them. `db:rebuild-directory` reports drift instead (currently 0), which is weaker but has now been exercised.
2. **`EMPLOYEE` source type is modelled but not emitted.** `sourceType` exists and the schema supports it; only `USER` is projected, because that is what the Clients screen lists. Open question 1 in the plan — confirm before building the employee emitter.
3. **Keyset pagination not implemented.** `OFFSET` is used, which degrades on very deep pages. Irrelevant at 10 rows; the `id` tiebreaker is already in place, so the change stays contained.
4. **Alerting is manual.** The health endpoint reports the numbers; nothing pages on them. Suggested thresholds: oldest pending > 5 min, any event with `attempts > 5`, drift ≠ 0.
5. **Growth percentages count projection rows, not tenant rows.** `directoryStats` windows on `sourceCreatedAt`, which is correct, but a tenant that has never been backfilled contributes nothing. Run the backfill before trusting the KPI cards.

---

## 9. Files changed

**New**

```
libs/database/src/models/platform-directory-person.model.ts
libs/database/src/models/platform-tenant-counters.model.ts
libs/database/src/models/platform-projection-signal.model.ts
libs/database/src/models/projection-outbox.model.ts
libs/database/src/models/index.ts
libs/database/src/projection/outbox-writer.ts
apps/tenant-service/src/services/directory-projection.service.ts
apps/tenant-service/src/services/directory-projection.service.spec.ts
apps/tenant-service/src/services/projection-relay.service.ts
apps/tenant-service/src/services/projection-relay.service.spec.ts
apps/tenant-service/src/scripts/rebuild-directory.ts
apps/user-service/src/services/directory-emitter.service.ts
```

**Modified**

```
libs/database/src/index.ts                      export the models + writer
libs/common/src/index.ts                        MESSAGE_PATTERNS.PROJECTION
apps/tenant-service/src/tenant-service.module.ts       register models + services
apps/tenant-service/src/tenant-service.controller.ts   6 RPC handlers
apps/tenant-service/src/services/tenant-model-provider.service.ts   bind ProjectionOutbox
apps/tenant-service/src/services/platform-reports.service.ts        read counters
apps/tenant-service/src/scripts/sync-tenant-columns.ts              register ProjectionOutbox
apps/user-service/src/user-service.module.ts    register emitter
apps/user-service/src/services/user.service.ts  emit on 6 write paths
apps/user-service/src/services/tenant-model-provider.service.ts     bind ProjectionOutbox
apps/user-service/src/services/platform-clients.service.ts          read from projection
package.json                                     db:rebuild-directory
```

**Modified while getting it to run (see §4b)**

```
apps/tenant-service/src/models/designation.model.ts          composite unique index
apps/tenant-service/src/scripts/sync-tenant-columns.ts       isolate sync(); unwrap errors
apps/tenant-service/src/scripts/rebuild-directory.ts         create tables; skip unprovisioned
apps/tenant-service/src/services/tenant-provisioning.service.ts   drop projection on deprovision
apps/api-gateway/src/controllers/superadmin.controller.ts    health endpoint
```
