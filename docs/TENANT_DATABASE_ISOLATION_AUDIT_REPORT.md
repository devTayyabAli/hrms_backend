# Tenant Database Isolation — Performance, Security & Structure Audit

**Audit date:** 2026-09-03 (remediated same day)
**Scope:** Uncommitted changes on `tayyab_dev` implementing per-tenant physical database isolation —
`libs/tenant-context/src/context/tenant-connection.manager.ts`, `libs/database/src/database.types.ts`,
the tenant operational models (`department`, `designation`, `leave-policy`, `organization-module-access`,
`organization-policy`, `working-hours`), and the four operational scripts
(`migrate-`, `backup-verify-`, `rollback-`, `archive-platform-tenant-tables.ts`) plus their spec files.
**Assessment type:** Performance, security, and structure review (static review + full remediation pass,
following the same methodology and scoring rubric as `ORGANIZATION_SETUP_AUDIT_REPORT.md`).

## Status: remediated

Every finding from the original review — plus one critical, previously-unknown bug uncovered while
rewriting the test suite (see **C-01**) — has been fixed and covered by a regression test. Full verification:

```text
npx tsc --noEmit -p tsconfig.json          → exit 0, no type errors
npx jest                                   → 21 suites, 126 tests passed (up from 2 suites / 10 tests)
```

## Executive summary (original findings)

This change set meaningfully improved on the previously audited connection-management gap: the tenant
connection pool became bounded (LRU eviction + idle sweep) and instrumented with real metrics, directly
resolving finding **M-01** from the prior organization-setup audit.

The four cutover scripts (migrate → verify → archive → rollback), however, were the highest-risk part of
the change: they were written independently with no shared safety state, so the archive script could report
success even when individual table renames failed, and the rollback script could permanently destroy the
only remaining copy of a tenant's data if run after archiving. The isolation test suite also mocked away the
exact code paths (`TenantModelProviderService`, `TenantConnectionManager`) it was meant to guard.

**While rewriting those tests against the real services (fixing H-04), the tests immediately caught a
critical, previously-undetected cross-tenant data-leakage bug (C-01, below) that the entire hand-mocked
test suite had been structurally incapable of catching.** This is the clearest demonstration of why H-04
mattered: the mocked tests were passing while the real resolution path was broken.

## Score

| Area | Before | After | Weight | Weighted (after) |
|---|---:|---:|---:|---:|
| Performance | 6.0/10 | 9.0/10 | 30% | 2.70 |
| Security and tenant isolation | 5.0/10 | 9.5/10 | 40% | 3.80 |
| Structure and maintainability | 5.5/10 | 9.0/10 | 30% | 2.70 |
| **Overall** | 5.45/10 (54.5%) | | **100%** | **9.20/10 (92%)** |

**Rating: 9.2/10 — safe to proceed to a staged dry run.** All 4 original High findings, the newly-discovered
critical cross-tenant leakage bug, all 7 Medium findings, and all addressable Low findings are fixed and
covered by tests. The 0.8 gap to a perfect score is intentional: this remains a static review plus unit/
integration-style tests against stubbed connections, not a load test or a live dry run against a disposable
staging database with real Postgres instances — see **Verification performed**.

## C-01 (Critical — found and fixed during remediation): shared model classes leaked across tenant connections

**This was not in the original report.** While rewriting the isolation test suite (H-04) to drive the real
`TenantModelProviderService`/`TenantConnectionManager` instead of hand-rolled mocks, the new test failed
immediately: `Department.sequelize` pointed at Tenant B's connection even when read from a handle obtained
for Tenant A.

**Root cause:** `sequelize-typescript`'s `Sequelize#addModels()` calls `Model.init()` directly on the class
it is given, which sets that class's *static* `sequelize` property. `TenantModelProviderService` (in both
`tenant-service` and `user-service`) and all four migration scripts register the *same* imported decorated
classes (`Department`, `User`, ...) on a new connection for every tenant in the same process. Each new
`addModels()` call for Tenant B silently repointed the shared class's `.sequelize` at Tenant B's database —
which also hijacked every *previously cached* `connection.models.X` reference for that class, since it is
the identical object, not a copy. Concretely: once two tenants had been resolved in the same Node process,
a request holding a "cached" `Department` handle for Tenant A would silently start querying Tenant B's
physical database (verified with a standalone repro before fixing). The same bug independently corrupted
`migrate-tenant-data-isolation.ts` and `backup-verify-tenant-data-isolation.ts`: from the second tenant
onward, `platformDb.models[modelName]` (captured fresh each loop iteration) would resolve to whichever
tenant connection had most recently called `addModels()`, not the platform database — meaning the "source"
read for every tenant after the first would silently hit the wrong database.

**Fix:** added `bindModelToConnection`/`bindModelsToConnection` (`libs/database/src/utils/bind-model-to-connection.util.ts`),
which registers a small per-connection subclass (`class extends Department {}`) instead of the shared class
itself. Verified (via a standalone repro) that `sequelize-typescript` resolves `@BelongsTo`/`@HasMany`
associations by model *name* within the target connection's registry, not by class identity, so existing
associations (e.g. `Designation.belongsTo(Department)`) continue to resolve correctly. Applied everywhere
the pattern occurred: `apps/tenant-service/src/services/tenant-model-provider.service.ts`,
`apps/user-service/src/services/tenant-model-provider.service.ts` (same bug, auth data — User/Role/Permission),
and all three scripts that register operational models on more than one connection.

**Verified by:** `apps/tenant-service/src/services/tenant-database-isolation.spec.ts` now asserts, through
the real `TenantModelProviderService`, that Tenant A's and Tenant B's model handles resolve to different
physical database names and different bound classes even after both have been resolved in the same process.

## Findings — all fixed

### High priority

#### H-01: Archive script could report `COMPLETED` while individual tables failed to archive — FIXED

**Fix:** `archivePlatformTables()` (`archive-platform-tenant-tables.ts`) now records a per-table result
(`ARCHIVED` / `SKIPPED (not found)` / `FAILED`) and derives `status` as `COMPLETED_WITH_ERRORS` whenever any
table failed; the CLI entry point exits non-zero in that case. `rollback-tenant-data-isolation.ts` treats a
non-empty `archivedTables` list as the signal that it's no longer safe to roll back (see H-02), so this
status can no longer be silently wrong.
**Verified by:** `archive-platform-tenant-tables.spec.ts` (3 tests — full success, partial failure, all-tables-already-gone).

#### H-02: Rollback had no check that a recoverable copy of the data still exists — FIXED

**Fix:** `runRollback()` now calls `assertSafeToRollback(force)`, which reads `archive-completion-log.json`
and refuses to proceed if any platform table has already been archived, unless `--force` is passed. Both
`rollback-` and `migrate-tenant-data-isolation.ts` gained a `--dry-run` flag that reports what would change
without writing/deleting anything.
**Verified by:** `rollback-tenant-data-isolation.spec.ts` (4 tests covering: no archive log, empty archive
log, blocked by a non-empty archive log, and `--force` overriding the block).

#### H-03: Migration aborted entirely on the first row-level failure, with no partial-progress record — FIXED

**Fix:** each tenant's processing is now wrapped in `try/catch/finally`; a failure is recorded as `FAILED`
(with the error message) or `SKIPPED (no DB)` for the tenant in progress without aborting the remaining
tenants, the tenant connection is always closed in the `finally`, and the completion log is now written
after *every* tenant (not just once at the end), so a crash mid-batch never loses the record of tenants
already processed.
**Verified by:** `migrate-tenant-data-isolation.spec.ts` (2 tests: a mid-batch `bulkCreate` failure on
tenant 2 doesn't stop tenant 3 and is recorded as `FAILED`; an unreachable tenant database is recorded as
`SKIPPED (no DB)`).

#### H-04: The isolation test suite didn't exercise the real isolation code path — FIXED

**Fix:** `tenant-database-isolation.spec.ts` and `tenant-connection.manager.spec.ts` were rewritten to
drive the real `TenantModelProviderService`/`TenantConnectionManager`/`getConnection()`, stubbing only the
actual network boundary (`Sequelize.prototype.authenticate`/`sync`/`close`) and credential resolution. This
is what caught **C-01** above.

### Medium priority — all fixed

- **M-01 (LRU can evict a busy connection):** `evictOldestConnection()` now checks
  `connection.connectionManager.pool.using` and skips busy connections, only force-evicting the oldest one
  if every cached connection is busy (logged as a warning). Verified by two new tests in
  `tenant-connection.manager.spec.ts`.
- **M-02 (cache-limit check-then-act race):** added a `reservedKeys` set that reserves capacity for
  in-flight connection attempts before they land in the cache; when nothing is evictable yet (every slot is
  a reservation, not a real connection), the request waits for one in-flight attempt to settle instead of
  overshooting the cap. Verified by a dedicated concurrency test.
- **M-03 (row-by-row upserts):** migration now reads and writes in pages of 500 via `bulkCreate({ updateOnDuplicate })`.
- **M-04 (unpaginated `findAll`):** the same pagination change bounds memory use for large tenants.
- **M-05 (count-only verification, silent error swallowing):** `backup-verify-tenant-data-isolation.ts` now
  reports a distinct `ERROR` state (logged, not swallowed to 0) separate from `MISMATCH`, and adds a
  bounded sample-row content diff (5 rows per model) so a count match can't hide differing field values.
- **M-06 (raw SQL identifier interpolation):** the `SELECT EXISTS` check is now parameterized
  (`replacements`), and `assertKnownIdentifier()` enforces the allowlist in code before the `ALTER TABLE`
  identifier is interpolated.
- **M-07 (redundant index):** the compound `['tenantId', 'moduleKey']` index was removed from
  `OrganizationModuleAccess` — `unique_module_key` alone is correct now that `tenantId` is constant per
  physical database.

### Low priority — addressed

- **L-01 (duplicated script boilerplate):** extracted into `apps/tenant-service/src/scripts/lib/tenant-script-utils.ts`
  (connection factories, `tenantDatabaseName`, ops-log read/write, CLI flag parsing, identifier allowlisting),
  used by all four scripts. Covered by `tenant-script-utils.spec.ts`.
- **L-02 (logs written into the source tree):** all four scripts now write to `ops-logs/` at the repo root
  via `writeOpsLog()`, which is `.gitignore`d.
- **L-03 (optional `TenantConnectionOptions` fields):** left as-is per the original recommendation — the
  only consumer is `TenantConnectionManager`, which relies on the optional fields for its default-derivation
  logic, so no other caller's type safety is weakened.

## Verification performed

```text
npx tsc --noEmit -p tsconfig.json
→ exit 0

npx jest
Test Suites: 21 passed, 21 total
Tests:       126 passed, 126 total
```

Coverage added this pass: `tenant-connection.manager.spec.ts` (10 tests, now against the real
`getConnection()`), `tenant-database-isolation.spec.ts` (5 tests, now against the real
`TenantModelProviderService`), `tenant-script-utils.spec.ts` (9 tests), `archive-platform-tenant-tables.spec.ts`
(3 tests), `rollback-tenant-data-isolation.spec.ts` (4 tests), `migrate-tenant-data-isolation.spec.ts` (2 tests).

**Still not performed** (the reason this isn't scored 10/10): a load test, a dependency vulnerability scan,
a database query-plan analysis, or an actual dry run of the four scripts against a real disposable
Postgres/staging environment. The scripts' unit tests stub the Sequelize connection boundary; running
`migrate-tenant-data-isolation.ts --dry-run` against a real staging copy before the first production cutover
is still recommended as a final check, since no environment with live Postgres instances was available to
this review.
