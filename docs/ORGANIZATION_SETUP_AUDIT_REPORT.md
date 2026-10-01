# Organization Setup Service Audit Report

**Audit date:** 2026-09-02  
**Scope:** `apps/tenant-service/src/services/organization-setup.service.ts` and the directly coupled controller, DTO, model-provider, model, and test files  
**Assessment type:** Performance, security, and structure review

## Executive summary

The service has a clear tenant-scoped CRUD surface and consistently includes `tenantId` in queries. The API gateway also applies JWT, tenant, role, permission, and module guards to the HTTP setup controller. The focused test suite currently passes **10/10 tests**.

The main risks are:

1. Tenant database connections are cached indefinitely and each first connection performs `sync`, creating avoidable latency and unbounded resource growth.
2. `completeSetup` performs a read/check/update sequence without a transaction or conditional update, so concurrent requests can race.
3. Designation department references are not verified as belonging to the same tenant.
4. Circular hierarchy validation has no visited-set or depth limit and can loop indefinitely if corrupted data already contains a cycle.
5. The TCP microservice listens on `0.0.0.0`; security therefore depends on network isolation and the gateway being the only reachable caller.

## Score

Scores use a 0–10 scale, where 10 means production-ready controls are present and verified. The overall score is weighted toward security and reliability:

| Area | Score | Weight | Weighted result |
|---|---:|---:|---:|
| Performance | 5.5/10 | 30% | 1.65 |
| Security and tenant isolation | 6.0/10 | 40% | 2.40 |
| Structure and maintainability | 7.0/10 | 30% | 2.10 |
| **Overall** |  | **100%** | **6.15/10 (61.5%)** |

**Rating: 6.2/10 — conditionally acceptable, remediation required before high-scale or high-risk production use.**

This is a static review score, not a penetration-test or load-test result.

## Findings

### High priority

#### H-01: Setup completion is not atomic

`completeSetup` reads the tenant, calculates progress through multiple queries, then updates the tenant in a separate operation. Two concurrent requests can both observe an incomplete-to-complete transition and both execute the update. A failure between the checks and update can also leave lifecycle state inconsistent.

**Evidence:** `completeSetup` at lines 378–420 and progress reads at lines 63–118 of `organization-setup.service.ts`.

**Recommendation:** Use a transaction where the database topology permits it, or use a conditional update such as `WHERE id = :tenantId AND setupStatus <> COMPLETED`, then verify the affected row count. Add an idempotency/concurrency test.

#### H-02: Cross-tenant designation relationships are not validated

`createDesignation` and `updateDesignation` accept `departmentId` but never verify that the referenced department exists in the same tenant. A caller who knows a department UUID could create an invalid cross-tenant association if the physical connection or migrated data permits it.

**Evidence:** `createDesignation` lines 240–252 and `updateDesignation` lines 255–264.

**Recommendation:** Resolve the tenant-scoped department model and validate `{ id: departmentId, tenantId }` before create/update. Enforce the invariant at the database level where possible.

### Medium priority

#### M-01: Unbounded connection cache

`TenantModelProviderService` stores one Sequelize connection per tenant in a process-global `Map` and never evicts or closes entries. Tenant growth and process restarts can therefore produce connection-pool exhaustion and memory/resource pressure.

**Evidence:** `connectionsMap` and connection creation at lines 30, 65–82 of `tenant-model-provider.service.ts`.

**Recommendation:** Add bounded/LRU caching, idle eviction, explicit close handling, and pool sizing. Track cache size and active connection counts with metrics.

#### M-02: Runtime schema synchronization on first request

Every newly cached tenant connection calls `connection.sync({ force: false })`. This adds first-request latency and makes application traffic responsible for schema changes. It can also create startup stampedes when many tenants receive traffic at once.

**Evidence:** line 80 of `tenant-model-provider.service.ts`.

**Recommendation:** Run versioned migrations during provisioning/deployment. Remove request-path `sync`; if a compatibility fallback is unavoidable, gate it behind an explicit operational setting and serialize initialization per tenant.

#### M-03: Circular hierarchy walk can be unbounded

`validateParentDepartment` walks ancestors with repeated queries but does not track visited IDs or enforce a maximum depth. If existing data already contains a cycle that does not immediately include the edited department, validation can loop indefinitely and consume database connections.

**Evidence:** lines 157–170 of `organization-setup.service.ts`.

**Recommendation:** Maintain a `Set<string>` of visited IDs, fail on repetition, and impose a defensible maximum hierarchy depth. Prefer a recursive query or materialized hierarchy check for large trees.

#### M-04: Duplicate checks rely on read-then-write

Department, designation, and leave-policy creation first query for an existing name/title and then insert. Concurrent requests can bypass the check. Models have unique indexes, but the service does not translate unique-constraint errors into a stable domain response.

**Evidence:** lines 179–196, 240–252, and 314–326 of `organization-setup.service.ts`.

**Recommendation:** Treat database uniqueness as authoritative, catch only the expected unique-constraint error, and return a conflict-domain error. Confirm index semantics match the intended tenant scope.

### Low priority

#### L-01: Progress calculation issues five sequential database reads

`getSetupProgress` resolves five models and performs five independent queries sequentially. This increases latency and database round trips on a frequently polled endpoint.

**Evidence:** lines 66–76 of `organization-setup.service.ts`.

**Recommendation:** Run independent reads with `Promise.all`, use aggregate/count queries where appropriate, and consider a short-lived cache or persisted setup checklist if freshness requirements allow.

#### L-02: Validation constraints are incomplete for operational values

Working-day values, time formats, timezone identifiers, tracking modes, URLs, and email fields are validated only as strings (or arrays of strings). Invalid business values can reach persistence.

**Evidence:** `libs/common/src/dto/setup.dto.ts`, especially lines 18–92 and 193–298.

**Recommendation:** Add enum/format validators, `@IsEmail`, URL validation, array element validation, bounded maximums, and cross-field checks such as end time after start time.

#### L-03: Service responsibility is broad

The class handles progress calculation, profile mutation, three CRUD domains, hierarchy validation, policy defaults, and lifecycle transition. It is readable today, but change risk and test setup complexity will grow with each additional setup module.

**Recommendation:** Split into focused collaborators (for example, `DepartmentSetupService`, `PolicySetupService`, and `SetupLifecycleService`) behind a thin orchestration layer. Share tenant/model validation helpers.

## Positive controls observed

- Tenant-scoped model handles are resolved before tenant operational queries.
- Most reads, updates, and deletes include both resource ID and `tenantId`.
- Self-parenting and the common A → B → A cycle are explicitly tested.
- The gateway setup controller is protected by JWT, tenant, role, permission, and module guards.
- Gateway body validation enables `whitelist`, transformation, and `forbidNonWhitelisted`.
- Completion has an explicit idempotent response for already-active, completed tenants.
- The focused test suite passes: **1 suite, 10 tests**.

## Verification performed

```text
npx jest --runInBand apps/tenant-service/src/services/organization-setup.service.spec.ts
Test Suites: 1 passed
Tests:       10 passed
```

No load test, dependency vulnerability scan, database query-plan analysis, or external penetration test was performed. Those should be completed before treating this score as a release gate.

## Recommended remediation order

1. Make setup completion concurrency-safe and add a regression test.
2. Validate designation-to-department tenant ownership.
3. Replace request-path schema synchronization with migrations.
4. Bound and instrument tenant connection caching.
5. Add cycle detection/depth limits and database-conflict handling.
6. Tighten DTO business validation and split the service as module complexity grows.
