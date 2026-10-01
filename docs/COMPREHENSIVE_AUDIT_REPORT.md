# HRMS Backend Comprehensive Audit Report

**Assessment date:** 2026-09-03  
**Scope:** `apps/`, `libs/`, configuration, dependency metadata, tests, and repository structure  
**Method:** Static source review, configuration review, dependency audit, TypeScript build, and Jest test execution

## Executive summary

The backend has a sound NestJS modular baseline, tenant-aware connection management, DTO validation, authentication/authorization guards, throttling, and meaningful automated coverage. However, it is **not ready for unrestricted production exposure** until tenant database selection and service-boundary controls are verified and the high-priority findings below are addressed.

### Overall score: **68/100 — Needs improvement before production**

| Area | Weight | Score | Weighted result | Assessment |
|---|---:|---:|---:|---|
| Security and data protection | 45% | 61/100 | 27.5 | Good controls exist, but tenant-routing and exposure risks are material |
| Performance and scalability | 30% | 70/100 | 21.0 | Connection caching and pagination are present; several unbounded paths remain |
| Structure and maintainability | 25% | 78/100 | 19.5 | Clear modular structure and tests, but documentation and type strictness need work |
| **Total** | **100%** |  | **68.0** | **Needs improvement** |

### Release gate

**Conditional hold.** Do not approve production rollout until live findings **S-02** and **S-03** are closed or formally risk-accepted. Finding **S-01** should be fixed in the same release because accidental future use would be catastrophic and difficult to detect. Findings **P-01** and **S-04** should also be addressed in the same release if the system will handle large tenants or user-controlled file uploads.

## Findings

### S-01 — Tenant database template uses the platform database name

**Severity:** Medium  
**Evidence:** [`libs/database/src/config/database.config.ts`](../libs/database/src/config/database.config.ts), lines 28–46  
The tenant-template branch sets `database: process.env.PLATFORM_DB_NAME || 'neondb'`, while the tenant connection manager derives tenant database names separately. Current call-site tracing shows `getDatabaseConfig(false)` is not used; actual tenant routing goes through `TenantConnectionManager`. The defect is therefore inactive today but remains a dangerous future landmine and creates a split configuration model.

**Risk:** A future caller could route tenant initialization or queries to the platform database, causing cross-tenant exposure, incorrect writes, or failed provisioning.

**Recommendation:** Remove the unused template branch or require an explicit tenant database name and fail closed when absent. Add an integration test proving tenant A and tenant B resolve to different databases and that platform models never use a tenant connection.

### S-02 — Internal TCP services bind to all interfaces without transport-level authentication

**Severity:** High  
**Evidence:** [`apps/auth-service/src/main.ts`](../apps/auth-service/src/main.ts), [`apps/tenant-service/src/main.ts`](../apps/tenant-service/src/main.ts), and [`apps/user-service/src/main.ts`](../apps/user-service/src/main.ts), lines 8–13; message-pattern controllers in the three services  
Each microservice listens on `0.0.0.0`. HMAC signing infrastructure exists, but handler coverage is inconsistent: approximately 144 of 155 internal TCP handlers have no signing guard (tenant: 86/86 unsigned, auth: 38/38 unsigned, user: 9/20 unsigned).

**Risk:** Any reachable network client may attempt to invoke internal handlers or abuse service resources if network segmentation is misconfigured.

**Recommendation:** Bind services to private interfaces, enforce network policies/security groups, and apply signed envelopes plus verification guards consistently to every internal pattern. Add negative tests for unsigned and replayed messages.

### S-03 — Swagger documentation is enabled without a production gate

**Severity:** High  
**Evidence:** [`apps/api-gateway/src/main.ts`](../apps/api-gateway/src/main.ts), lines 46–55  
`SwaggerModule.setup('api/docs', app, document)` is unconditional.

**Risk:** Endpoint and schema enumeration in production, including disclosure of security-sensitive operations and payload shapes.

**Recommendation:** Disable Swagger by default in production, or protect it with an authenticated administrative guard and a separate allowlist. Do not expose it on the public gateway without an explicit configuration flag.

### S-04 — File upload validation trusts client MIME metadata

**Severity:** Medium  
**Evidence:** [`apps/auth-service/src/services/file-storage.service.ts`](../apps/auth-service/src/services/file-storage.service.ts), lines 89–103  
The service checks the declared MIME type and extension but does not inspect file signatures/magic bytes. It also supports `text/plain`, JSON, office formats, and images.

**Risk:** Content-type spoofing, storage of active or malformed content, and downstream parser vulnerabilities.

**Recommendation:** Detect file type from content, normalize/replace extensions from detected type, reject mismatches, scan uploads where required, and serve downloads with `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff`.

### S-05 — Environment example contains weak default credentials

**Severity:** Medium  
**Evidence:** [`.env.example`](../.env.example), lines 8, 15, 25, and 37  
The example contains literal `PLATFORM_DB_PASSWORD=password` and `TENANT_DB_PASSWORD=password`, as well as seed credentials. Although dotenv files are ignored, examples are frequently copied into deployments. Startup validation checks presence but does not reject weak or placeholder values.

**Risk:** Accidental reuse of weak or predictable credentials.

**Recommendation:** Replace all credential values with explicit placeholders such as `<set-in-secret-manager>` and make startup validation reject placeholders and weak secrets in every non-development environment.

### P-01 — File listing has no pagination or result cap

**Severity:** High  
**Evidence:** [`apps/auth-service/src/services/file-storage.service.ts`](../apps/auth-service/src/services/file-storage.service.ts), lines 226–242  
`findAll({ where })` returns every matching file record.

**Risk:** Memory growth, long response times, database pressure, and denial of service for tenants with large file histories.

**Recommendation:** Require bounded `limit` and `offset`/cursor parameters, cap the maximum page size, select only required columns, and add an index strategy for `(tenantId, category, entityType, entityId, createdAt)`.

### P-02 — User listing loads all users and roles

**Severity:** Medium  
**Evidence:** [`apps/user-service/src/services/user.service.ts`](../apps/user-service/src/services/user.service.ts), lines 150–160  
`getAllUsers` performs an unbounded `findAll` with a role include.

**Risk:** Large tenants can cause expensive joins and oversized responses.

**Recommendation:** Add cursor or page-based pagination, return a response DTO, and make role expansion optional or separately queried.

### P-03 — Tenant connection eviction can close a busy pool

**Severity:** Medium  
**Evidence:** [`libs/tenant-context/src/context/tenant-connection.manager.ts`](../libs/tenant-context/src/context/tenant-connection.manager.ts), lines 191–226  
When every cached connection is busy, the manager force-evicts the oldest connection.

**Risk:** In-flight queries may fail during cache saturation, causing intermittent errors under tenant churn.

**Recommendation:** Prefer backpressure/waiting over force eviction, expose saturation metrics, and validate behavior with a load test that creates more active tenants than the cache limit.

### P-04 — Development SQL logging is enabled by default outside production

**Severity:** Low  
**Evidence:** [`libs/database/src/config/database.config.ts`](../libs/database/src/config/database.config.ts), lines 17 and 38  
SQL logging is enabled whenever `NODE_ENV !== 'production'`.

**Risk:** Excessive I/O and possible disclosure of sensitive query values in shared development/staging logs.

**Recommendation:** Use an explicit `DB_LOGGING=true` flag and ensure parameter values and personally identifiable information are redacted.

### T-01 — TypeScript strictness is relaxed

**Severity:** Medium  
**Evidence:** [`tsconfig.json`](../tsconfig.json), lines 15–19  
`strictNullChecks`, `noImplicitAny`, and related strictness options are disabled.

**Risk:** Runtime defects and unsafe refactors are harder to detect, especially in tenant and authorization code.

**Recommendation:** Enable strict mode incrementally, starting with `strictNullChecks` and `noImplicitAny`, and resolve errors by module.

### T-02 — Root documentation is still the Nest starter README

**Severity:** Low  
**Evidence:** [`README.md`](../README.md)  
The README describes a generic Nest starter and does not document service boundaries, tenant routing, required secrets, deployment topology, health checks, migrations, or operational limits.

**Risk:** Deployment and maintenance errors, inconsistent environment configuration, and slower incident response.

**Recommendation:** Replace the starter content with HRMS-specific setup, architecture, security, migration, backup/restore, and runbook documentation. Link the existing tenant-isolation documents from the root README.

### S-06 — Dependency vulnerabilities and conflicting lockfiles

**Severity:** Medium  
**Evidence:** [`package-lock.json`](../package-lock.json), [`pnpm-lock.yaml`](../pnpm-lock.yaml), and cross-checked `npm audit --omit=dev` / `pnpm audit --prod --json` results  
The repository contains both npm and pnpm lockfiles, with no `packageManager` field pinning the authoritative tool. `pnpm audit --prod` reports one moderate `uuid` advisory (`GHSA-w5hq-g745-h8pq` / `CVE-2026-41907`) through `sequelize`. `npm audit --omit=dev` additionally reports seven vulnerabilities: five moderate and two high, including a high `js-yaml` advisory through the Swagger dependency tree and moderate `qs` advisories through Express.

**Risk:** Inconsistent lockfiles can produce different production dependency graphs. The reported vulnerabilities may expose denial-of-service or integrity risks depending on the package manager and installed graph.

**Recommendation:** Select and enforce one package manager, remove or regenerate the non-authoritative lockfile, and remediate the `js-yaml` and `qs` advisories. `sequelize@6.37.8` directly pins `uuid@8.3.2`, and the audit reports no normal upgrade path; if compatibility testing permits, add a package-manager-supported override (for example npm `overrides`) to force `uuid >=11.1.1`, then smoke-test Sequelize initialization, UUID generation, migrations, and CRUD operations. Rerun the authoritative production audit in CI and block releases on high/critical findings.

## Positive controls observed

- Gateway-wide DTO validation uses `whitelist`, transformation, and rejection of non-whitelisted properties.
- Authentication, tenant, role, permission, and module guards are composed on protected controller surfaces.
- Authentication and activation endpoints have targeted throttles in addition to the global throttler.
- Tenant connection creation deduplicates concurrent misses and maintains a bounded cache with idle eviction.
- File access checks tenant ownership before metadata retrieval, download, URL generation, or deletion.
- The repository contains tenant-isolation migration, rollback, backup-verification, and connection-manager tests.

## Validation results

| Check | Result |
|---|---|
| `pnpm run build` | Passed |
| `pnpm exec jest --runInBand` | Passed — 21 suites, 126 tests |
| `pnpm audit --prod --json` | One moderate transitive advisory |
| `npm audit --omit=dev` | Seven vulnerabilities: five moderate, two high |
| Lockfile consistency | `package-lock.json` and `pnpm-lock.yaml` both present; package manager not pinned |
| Dynamic load test | Not performed |
| External penetration test | Not performed |

## Remediation priority

1. Fix and integration-test tenant database resolution (**S-01**).
2. Restrict internal service network exposure and enforce signed service messages (**S-02**).
3. Gate or protect Swagger in production (**S-03**).
4. Bound file and user listing endpoints (**P-01**, **P-02**).
5. Harden file type validation and deployment secret checks (**S-04**, **S-05**).
6. Upgrade the transitive `uuid` dependency (**S-06**).
7. Improve strict typing, documentation, observability, and load testing (**P-03**, **P-04**, **T-01**, **T-02**).

## Scoring rubric

- **90–100:** Production-ready with only routine maintenance
- **75–89:** Acceptable with minor controlled risk
- **60–74:** Needs improvement; remediation required before broad production use
- **Below 60:** High risk; release should be blocked
