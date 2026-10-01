# HRMS Multi-Tenant Platform — Complete System Documentation

> **Version**: 2.0.0 | **Date**: August 2026
> **Platform**: NestJS Monorepo Microservices | **Stack**: TypeScript · NestJS 11 · Sequelize ORM · PostgreSQL
> **Target Audience**: Software Engineers · System Architects · DevOps Engineers · New Module Developers

---

# PAGE 1 — EXECUTIVE SUMMARY & SYSTEM ARCHITECTURE

## 1.1 Executive Summary

The HRMS Multi-Tenant Platform is a cloud-native, microservices-based Human Resource Management System designed to serve multiple independent organizations (tenants) from a single deployment. Each organization receives its own fully isolated PostgreSQL database, ensuring data security, compliance, and independent scalability.

The platform follows a strict separation of concerns across NestJS microservices communicating via TCP message patterns, exposed to clients through a single HTTP API Gateway with full OpenAPI (Swagger) documentation.

### Core Architectural Pillars

- **Strict Multi-Tenancy (One DB Per Organization)**: Every organization gets a dedicated PostgreSQL database (`hrms_<tenant_uuid>`). No tenant can ever access another tenant's data. Context isolation is enforced at the middleware level using Node.js `AsyncLocalStorage`, propagated across all service boundaries without leakage.
- **Platform Database Separation**: A separate `hrms_platform` database holds cross-tenant administrative data (SuperAdmin, AuthCredentials, Tenants, invitations, and policies).
- **Dynamic Connection Pooling**: `TenantConnectionManager` maintains a cached in-memory pool of Sequelize connections, creating new isolated connections on-demand and reusing them efficiently for all subsequent requests.
- **Full Lifecycle Management**: Organizations transition through a well-defined state machine from `DRAFT` creation through database provisioning, admin activation, setup wizard completion, to `ACTIVE` operational status.

---

## 1.2 High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Web / Mobile Clients                         │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │  HTTP REST  (x-tenant-id header)
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  API Gateway  (HTTP · Port 3000)                    │
│           Swagger UI · JWT Guard · Tenant Resolver Middleware       │
│                      Global prefix: /api/v1                         │
└──────────────────┬───────────────────┬──────────────────────────────┘
                   │  TCP              │  TCP                │  TCP
         ┌─────────▼──────┐  ┌────────▼───────┐  ┌─────────▼────────┐
         │  Auth Service  │  │ Tenant Service │  │  User Service    │
         │  Port TCP 3001 │  │  Port TCP 3002 │  │  Port TCP 3003   │
         └────────┬───────┘  └───────┬────────┘  └─────────┬────────┘
                  │                  │                      │
                  └──────────────────┼──────────────────────┘
                                     │  Sequelize ORM
                     ┌───────────────▼──────────────────────┐
                     │          PostgreSQL Server            │
                     │                                       │
                     │  ┌─────────────────────────────────┐ │
                     │  │  Platform DB: hrms_platform      │ │
                     │  │  (SuperAdmins, Tenants, Auth)    │ │
                     │  └─────────────────────────────────┘ │
                     │                                       │
                     │  ┌──────────────┐  ┌──────────────┐  │
                     │  │ hrms_tenant_ │  │ hrms_tenant_ │  │
                     │  │   <uuid_1>   │  │   <uuid_2>   │  │
                     │  └──────────────┘  └──────────────┘  │
                     └───────────────────────────────────────┘
```

---

## 1.3 Service Registry

| Service | Port | Transport | Primary Responsibility |
| :--- | :--- | :--- | :--- |
| **API Gateway** | 3000 | HTTP/REST | Request routing, JWT validation, Swagger UI |
| **Auth Service** | 3001 | TCP | Credentials, JWT generation, OTP, password management |
| **Tenant Service** | 3002 | TCP | Organization onboarding, DB provisioning, setup wizard, policies |
| **User Service** | 3003 | TCP | Per-tenant user management, RBAC Roles & Permissions |
| **Attendance & Leave** | 3004 | TCP | *(Planned)* Attendance tracking, leave workflows |
| **Payroll Service** | 3005 | TCP | *(Planned)* Salary structures, payslips, payroll runs |
| **Performance & Work** | 3006 | TCP | *(Planned)* Projects, Tasks, Goals, Performance Reviews |
| **Recruitment Service** | 3007 | TCP | *(Planned)* Job postings, candidate pipeline |
| **LMS Service** | 3008 | TCP | *(Planned)* Courses, training paths, certifications |

---

# PAGE 2 — DATABASE ARCHITECTURE & MULTI-TENANCY MODEL

## 2.1 Two-Database Strategy

The platform uses a split-database architecture to keep platform-level administrative data completely separate from per-organization operational data.

### Platform Database (`hrms_platform`)

Holds system-wide data shared or managed by the platform operator (SuperAdmin). No employee or HR operational data lives here.

| Table | Description |
| :--- | :--- |
| `super_admins` | Platform operator accounts (seeded on first boot) |
| `auth_credentials` | Login credentials for all org admins and users, keyed by `tenantId` |
| `tenants` | Organization registry with lifecycle status |
| `tenant_database_configs` | Encrypted DB connection details per tenant |
| `departments` | Organization department definitions |
| `designations` | Job title/designation definitions |
| `organization_admin_invitations` | Token-based admin onboarding invitations |
| `working_hours` | Shift and working hours configurations |
| `leave_policies` | Leave policy definitions per tenant |
| `attendance_policies` | Attendance tracking configurations per tenant |
| `organization_policies` | Dynamic JSONB-based policy engine records |

### Tenant Databases (`hrms_<tenant_uuid>`)

One isolated database per organization, created at onboarding time. Contains all operational HR data for that organization.

| Table | Description |
| :--- | :--- |
| `users` | Employee user accounts |
| `roles` | Organization-defined roles (e.g., Admin, HR Manager) |
| `permissions` | Fine-grained resource:action permissions |
| `user_roles` | Many-to-many: users ↔ roles |
| `role_permissions` | Many-to-many: roles ↔ permissions |
| `tenant_schema_migrations` | Migration version tracking per tenant DB |
| *(future)* `employee_profiles` | Full employee records with manager hierarchy |
| *(future)* `attendances`, `leave_requests` | Time & attendance domain |
| *(future)* `salary_structures`, `payroll_records` | Payroll domain |
| *(future)* `projects`, `tasks`, `goals`, `employee_outputs`, `performance_reviews` | Performance domain |
| *(future)* `courses`, `course_enrollments` | LMS domain |

---

## 2.2 Tenant Context Isolation Flow

Every HTTP request passes through a multi-stage isolation pipeline:

```
Incoming HTTP Request
        │
        ▼
TenantResolverMiddleware
  ├─ Assign/propagate x-request-id
  ├─ Resolve tenantId (priority order):
  │    1. JWT token claim: user.tenantId  ← Primary (authenticated requests)
  │    2. x-tenant-id header             ← Unauthenticated setup calls
  │    3. Subdomain extraction           ← e.g., acme.hrms.local
  ├─ Security: JWT tenantId ≠ header tenantId → 403 TENANT_ACCESS_DENIED
  ├─ Set TenantRequestContextService.connectionOptions
  └─ Wrap next() in AsyncLocalStorage.run(tenantContext, next)
        │
        ▼
TenantConnectionManager.getConnection(tenantId)
  ├─ Cache HIT  → Return existing Sequelize pool
  └─ Cache MISS → Create new Sequelize(databaseName) → authenticate → cache → return
        │
        ▼
TenantModelProviderService (REQUEST-scoped)
  ├─ Adds models to tenant connection: [User, Role, Permission, UserRole, RolePermission]
  └─ Provides typed model getters for services
        │
        ▼
Business Logic (UserService, RoleService, etc.)
  └─ All queries are scoped to that tenant's database automatically
```

---

## 2.3 Tenant Lifecycle State Machine

```
         ┌──────────────────────────────────────────────┐
         │              TENANT STATUS FLOW              │
         └──────────────────────────────────────────────┘

  [SuperAdmin: POST /superadmin/organizations]
                    │
                    ▼
                  DRAFT ──── provisionTenantDatabase() ────►  PENDING_ADMIN_ACTIVATION
                                                                          │
                             [Admin accepts invitation]                   │
                             [sets password + activates]                  ▼
                                                                SETUP_IN_PROGRESS
                                                                          │
                             [All 6 setup modules complete]               │
                             [POST /organization/setup/complete]          ▼
                                                                        ACTIVE
                                                                       ╱      ╲
                                                              SUSPENDED      EXPIRED
                                                                       ╲      ╱
                                                              [Deprovisioning: DROP DATABASE]
```

**Provisioning Status** (parallel to tenant status):
`PENDING` → `PROVISIONING` → `READY` (success) or `FAILED` (retryable)

**Setup Status**:
`NOT_STARTED` → `IN_PROGRESS` → `COMPLETED`

---

# PAGE 3 — ORGANIZATION ONBOARDING FLOW (COMPLETE)

## 3.1 End-to-End Organization Onboarding

The full journey from creating an organization to it going ACTIVE spans 5 stages. Here is the complete detailed flow:

---

### Stage 1 — Organization Creation & Database Provisioning

**Trigger**: `POST /api/v1/superadmin/organizations`
**Actor**: SuperAdmin (authenticated, JWT with `isSuperAdmin: true`)

```
SuperAdmin
    │
    │  POST /api/v1/superadmin/organizations
    │  Body: { organizationName, adminEmail, domain?, teamStrength? }
    │
    ▼
API Gateway (SuperAdminController)
    │  TCP: org.create_organization
    ▼
Tenant Service (TenantServiceController → TenantProvisioningService)
    │
    ├─ 1. generateSlug(organizationName, domain)
    │       → sanitize → lowercase → replace non-alphanumeric with hyphens
    │
    ├─ 2. Check duplicate: getTenantByDomainOrSlug(slug) → 409 if exists
    │
    ├─ 3. createTenant() → Tenant record in Platform DB
    │       status: DRAFT | provisioningStatus: PENDING | setupStatus: NOT_STARTED
    │
    ├─ 4. generateDatabaseName(tenant.id)
    │       → "hrms_" + uuid with hyphens replaced by underscores
    │
    ├─ 5. Update Tenant: provisioningStatus = PROVISIONING
    │
    ├─ 6. checkDatabaseExists(databaseName) via pg_database query
    │       (Idempotent — safe to retry)
    │
    ├─ 7. CREATE DATABASE "hrms_<uuid>" (if not exists)
    │
    ├─ 8. Connect to new database & initialize:
    │       CREATE TABLE IF NOT EXISTS tenant_schema_migrations (...)
    │       INSERT version '1.0.0' ON CONFLICT DO NOTHING
    │       sequelize.sync({ force: false })
    │
    ├─ 9. saveOrUpdateTenantDatabaseConfig()
    │       Encrypts DB password with AES-256-GCM → stored in platform DB
    │
    └─ 10. Update Tenant:
            provisioningStatus = READY
            status = PENDING_ADMIN_ACTIVATION
            setupStatus = NOT_STARTED

Response: { tenantId, organizationName, slug, databaseName, status, provisioningStatus, message }
```

---

### Stage 2 — Admin Invitation Generation

**Trigger**: `POST /api/v1/superadmin/organizations/:tenantId/invitation`
**Actor**: SuperAdmin

```
SuperAdmin
    │  POST /superadmin/organizations/:tenantId/invitation
    │  Body: { adminEmail?, adminName? }
    ▼
Tenant Service (OrganizationAdminInvitationService.createAdminInvitation)
    │
    ├─ Validate: tenant.provisioningStatus === READY (else 400)
    ├─ Resolve target email: dto.adminEmail || tenant.adminEmail || tenant.email
    ├─ Cancel all PENDING invitations for this tenant (idempotent re-send)
    ├─ Generate secure token: crypto.randomBytes(32).toString('hex')
    ├─ Store SHA-256(token) only — raw token never persisted
    ├─ Create OrganizationAdminInvitation record:
    │     expiresAt = now + 7 days | status = PENDING
    └─ Build activationUrl: /api/v1/organization-admin/activate?token=<rawToken>

Response: { invitationId, tenantId, adminEmail, rawToken, activationUrl, expiresAt }
Note: rawToken is sent once here (e.g., via email in production). Not stored anywhere.
```

---

### Stage 3 — Admin Account Activation

**Trigger**: `POST /api/v1/organization-admin/activate`
**Actor**: Organization Admin (using email invitation link)

```
Admin
    │  POST /organization-admin/activate
    │  Body: { token, password, confirmPassword, firstName?, lastName? }
    ▼
Tenant Service (OrganizationAdminInvitationService.activateAdminAccount)
    │
    ├─ validateInvitationToken(rawToken):
    │     SHA-256(rawToken) → lookup tokenHash in DB
    │     Check: status === PENDING, now < expiresAt, tenant.provisioningStatus === READY
    │
    ├─ [TCP] → User Service: user.create_organization_admin
    │     Creates User record in TENANT database (not platform)
    │     Ensures ORGANIZATION_ADMIN role exists + assigns it idempotently
    │
    ├─ [TCP] → Auth Service: auth.create_admin_credential
    │     Hashes password with bcrypt (10 rounds)
    │     Creates/updates AuthCredential in platform DB
    │     Links: email, passwordHash, tenantId, tenantName, role='Admin', isActive=true
    │
    ├─ Update Invitation: status = ACCEPTED, acceptedAt = now
    │
    └─ Update Tenant:
          status = SETUP_IN_PROGRESS
          setupStatus = IN_PROGRESS
          provisioningStatus = READY

Response: { message, tenantId, adminEmail, status: SETUP_IN_PROGRESS }
```

---

### Stage 4 — Organization Setup Wizard

**Trigger**: Various `PUT/POST /api/v1/organization/*` endpoints
**Actor**: Organization Admin (JWT: role='Admin', tenantId scoped)

The admin must configure 6 mandatory modules (tracked as a percentage):

```
Setup Progress Checklist (OrganizationSetupService.getSetupProgress):

  ✅ Profile       — tenant.organizationName + (country || address || timezone) set
  ✅ Departments   — At least 1 department created
  ✅ Designations  — At least 1 designation created
  ✅ Working Hours — WorkingHours record exists for tenant
  ✅ Leave Policy  — At least 1 leave policy created
  ✅ Attendance    — AttendancePolicy record exists for tenant

  GET /api/v1/organization/setup/progress
  → { percentage: 0–100, modules: {...}, missingModules: [...], isComplete: bool }
```

Each module has dedicated CRUD endpoints proxied through API Gateway → Tenant Service via TCP.

---

### Stage 5 — Setup Completion & Activation

**Trigger**: `POST /api/v1/organization/setup/complete`
**Actor**: Organization Admin

```
Admin
    │  POST /organization/setup/complete
    ▼
Tenant Service (OrganizationSetupService.completeSetup)
    │
    ├─ Idempotency check: if already COMPLETED + ACTIVE → return success
    ├─ getSetupProgress() → validate isComplete === true
    │     If not complete: 400 with list of missing modules
    └─ Update Tenant:
          status = ACTIVE
          setupStatus = COMPLETED
          provisioningStatus = READY (unchanged)

Response: { message, tenantId, organizationName, status: ACTIVE }
Organization is now fully operational.
```

---

# PAGE 4 — AUTHENTICATION & AUTHORIZATION FLOW

## 4.1 Authentication Flows

### SuperAdmin Login

```
POST /api/v1/superadmin/login
Body: { email, password }
    │
    ▼  AUTH SERVICE (auth.superadmin_login)
    │
    ├─ Find SuperAdmin by email in platform DB
    ├─ bcrypt.compare(password, admin.passwordHash)
    └─ jwtService.sign({ sub, email, isSuperAdmin: true, role: 'SuperAdmin' })

Response: { accessToken, user: { id, email, name, role: 'SuperAdmin' } }
JWT Claims: { sub, email, isSuperAdmin, role }
```

### Organization User Login

```
POST /api/v1/auth/login
Body: { email, password }
    │
    ▼  AUTH SERVICE (auth.login)
    │
    ├─ Find AuthCredential by email in platform DB
    ├─ bcrypt.compare(password, credential.passwordHash)
    ├─ Check: credential.isActive === true (else 401)
    └─ jwtService.sign({ sub, email, tenantId, role })

Response: { accessToken, user: { id, email, tenantId, tenantName, role } }
JWT Claims: { sub, email, tenantId, role }
```

### Password Reset (OTP Flow)

```
Step 1: POST /auth/forgot-password  { email }
        → Generates 6-digit OTP → bcrypt-hashed → stored → 10 min expiry

Step 2: POST /auth/verify-otp  { email, otp }
        → bcrypt.compare(otp, storedHash) + check expiry

Step 3: POST /auth/reset-password  { email, otp, newPassword, confirmPassword }
        → Re-verify OTP → check newPassword !== current → update hash + clear OTP
```

---

## 4.2 Authorization Guard Pipeline

Every authenticated request flows through a 4-layer guard chain after the middleware:

```
HTTP Request with Authorization: Bearer <JWT>
          │
          ▼
  ┌──────────────────────────┐
  │   JwtAuthGuard           │  Validates JWT signature, expiry, extracts claims
  │                          │  Sets request.user = { sub, email, tenantId, role, ... }
  └────────────┬─────────────┘
               │  VALID ✓
               ▼
  ┌──────────────────────────┐
  │   TenantGuard            │  Bypassed if @Public() or @PlatformRoute()
  │                          │  Requires tenantId (JWT || header || subdomain)
  │                          │  Rejects SUSPENDED / EXPIRED tenants
  └────────────┬─────────────┘
               │  VALID ✓
               ▼
  ┌──────────────────────────┐
  │   RolesGuard             │  Checks @Roles(...) decorator metadata
  │                          │  Superadmin/Admin always pass
  └────────────┬─────────────┘
               │  VALID ✓
               ▼
  ┌──────────────────────────┐
  │   PermissionsGuard       │  Checks @RequirePermissions(...) metadata
  │                          │  Format: 'resource:action' (e.g., 'users:write')
  │                          │  Admins bypass this check entirely
  └────────────┬─────────────┘
               │  VALID ✓
               ▼
          Controller Handler
```

### Permission Model

Permissions follow a `resource:action` naming convention stored per-tenant:

| Resource | Actions |
| :--- | :--- |
| `users` | `read`, `write` |
| `roles` | `read`, `write` |
| `attendance` | `read`, `write` |
| `payroll` | `read`, `write` |
| `reports` | `read` |

Roles aggregate permissions via the `role_permissions` join table in the tenant database.

---

## 4.3 Route Decorator Reference

| Decorator | Effect |
| :--- | :--- |
| `@Public()` | Bypasses JWT + Tenant + Role + Permission guards entirely |
| `@PlatformRoute()` | Bypasses tenant validation (for SuperAdmin endpoints) |
| `@TenantOptional()` | Tenant context is not required but accepted if provided |
| `@Roles('admin', 'manager')` | Restricts to specified roles |
| `@RequirePermissions('users:read')` | Requires specific fine-grained permission |

---

# PAGE 5 — DYNAMIC POLICY ENGINE

## 5.1 Policy Engine Overview

The Dynamic Policy Engine allows each organization to configure their HR operational policies via a structured JSONB-based model with full lifecycle management and version history. It lives in the Tenant Service and is fully tenant-scoped.

---

## 5.2 Policy Types & Configuration Schemas

| PolicyType | Required Config Fields | Key Optional Fields |
| :--- | :--- | :--- |
| `LEAVE` | `annualAllocation` (int ≥ 0) | `isPaid`, `carryForward`, `maximumCarryForward`, `requiresApproval`, `noticePeriodDays` |
| `ATTENDANCE` | `trackingMode` (enum) | `gracePeriodMinutes`, `lateThresholdMinutes`, `allowOvertime`, `requireBiometric`, `enforceGeofence` |
| `WORKING_HOURS` | `startTime` (HH:MM), `endTime` (HH:MM), `workingDays` (array) | `breakDurationMinutes`, `timezone`, `isFlexible` |
| `OVERTIME` | `enabled` (boolean) | `minimumMinutes`, `maximumHoursPerDay`, `multiplier`, `requiresApproval` |
| `REMOTE_WORK` | *(none required)* | `allowedDaysPerWeek` (≤ 7), `requiresApproval`, `eligibleAfterDays`, `allowedRoles` |
| `PAYROLL` | `payFrequency` (MONTHLY/BIWEEKLY/WEEKLY) | `currency` (3-char ISO), `taxRegion`, `overtimeMultiplier` |
| `GENERAL` | Any JSON (< 32KB, no `__proto__`/`eval`) | *(flexible)* |

Valid `trackingMode` values: `WEB_CLOCK_IN`, `BIOMETRIC`, `GEOFENCE`, `MANUAL`, `QR_CODE`

---

## 5.3 Policy Lifecycle State Machine

```
           ┌─────────────────────────────────────────────┐
           │            POLICY STATUS TRANSITIONS        │
           └─────────────────────────────────────────────┘

   [createPolicy()]
         │
         ▼
       DRAFT ──── activate() ────► ACTIVE ──── deactivate() ────► INACTIVE
         │                           │                                 │
         │                           └──────── archive() ─────────────┤
         │                                                             │
         └──────────────────── archive() ──────────────────────────── ▼
                                                                   ARCHIVED
                                                               (immutable, no exit)

   DELETE only allowed from DRAFT status.
   All other deletions must use archive() instead.
```

---

## 5.4 Policy Exclusivity Rules

For certain policy types, only ONE active policy is allowed per tenant at a time. Activating a new policy of an exclusive type automatically deactivates the previously active one (executed in a database transaction):

**Exclusive Policy Types**: `ATTENDANCE`, `OVERTIME`, `REMOTE_WORK`, `PAYROLL`

**Non-Exclusive Types** (multiple ACTIVE allowed): `LEAVE`, `WORKING_HOURS`, `GENERAL`

---

## 5.5 Policy Versioning

When an active policy needs to change, create a new version rather than modifying in-place:

```
POST /api/v1/organization/policies/:id/new-version
Body: { name, description, configuration, effectiveFrom? }
    │
    ▼
Creates new OrganizationPolicy record:
  - version = existing.version + 1
  - previousVersionId = existing.id    (builds a linked chain)
  - status = DRAFT
  - configuration = dto.configuration || existing.configuration

The existing policy remains unchanged in its current state.
Walk chain: GET /policies/:id/versions → follows previousVersionId backwards to v1
```

---

## 5.6 Policy API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/organization/policies` | List all policies (filter: policyType, status, source) |
| `POST` | `/organization/policies` | Create new policy (starts as DRAFT) |
| `GET` | `/organization/policies/active/:policyType` | Get current effective active policy |
| `GET` | `/organization/policies/:id` | Get policy by ID |
| `PATCH` | `/organization/policies/:id` | Update DRAFT or INACTIVE policy |
| `DELETE` | `/organization/policies/:id` | Delete DRAFT policy only |
| `POST` | `/organization/policies/:id/activate` | Transition to ACTIVE |
| `POST` | `/organization/policies/:id/deactivate` | Transition to INACTIVE |
| `POST` | `/organization/policies/:id/archive` | Permanently archive |
| `GET` | `/organization/policies/:id/versions` | Get full version history chain |
| `POST` | `/organization/policies/:id/new-version` | Create next version as DRAFT |

All endpoints require `x-tenant-id` header and Bearer JWT authentication.

---

# PAGE 6 — MICROSERVICE INTERNALS & COMMUNICATION

## 6.1 TCP Message Pattern Registry

All inter-service communication uses NestJS TCP transport with typed `@MessagePattern` handlers. Here is the complete registry:

### Auth Service Patterns

| Pattern | Description |
| :--- | :--- |
| `health.check` | Service health check |
| `auth.register_tenant` | Register new tenant (delegates to onboard) |
| `auth.login` | Organization user login |
| `auth.superadmin_login` | SuperAdmin login |
| `auth.onboard_organization` | Create auth credentials + return JWT |
| `auth.create_admin_credential` | Create/update org admin credentials (called by Tenant Service) |
| `auth.forgot_password` | Generate OTP, store hashed |
| `auth.verify_otp` | Validate OTP code |
| `auth.reset_password` | Verify OTP + update password |

### Tenant Service Patterns

| Pattern | Description |
| :--- | :--- |
| `org.create_organization` | Full org creation + DB provisioning |
| `tenant.provision` | Provision existing tenant's database |
| `tenant.retry_provision` | Retry failed provisioning |
| `invitation.create` | Create admin invitation token |
| `invitation.resend` | Cancel and recreate invitation |
| `invitation.validate` | Validate raw token |
| `invitation.activate` | Complete admin activation (cross-service) |
| `org_setup.get_progress` | Get setup wizard completion % |
| `org_setup.update_profile` | Update org profile fields |
| `org_setup.{get/create/update/delete}_department` | Departments CRUD |
| `org_setup.{get/create/update/delete}_designation` | Designations CRUD |
| `org_setup.{get/update}_working_hours` | Working hours upsert |
| `org_setup.{get/create/update/delete}_leave_policy` | Leave policies CRUD |
| `org_setup.{get/update}_attendance_policy` | Attendance policy upsert |
| `org_setup.complete_setup` | Finalize setup → status ACTIVE |
| `org_policy.{create/get_all/get_one/update/delete}` | Policy CRUD |
| `org_policy.{activate/deactivate/archive}` | Policy lifecycle |
| `org_policy.get_active` | Get effective active policy by type |
| `org_policy.{get_versions/create_version}` | Versioning |

### User Service Patterns

| Pattern | Description |
| :--- | :--- |
| `health.check` | Service health check |
| `user.create_organization_admin` | Create user + assign ORGANIZATION_ADMIN role in tenant DB |

---

## 6.2 Shared Library Structure (`libs/`)

```
libs/
├── common/                      Shared across ALL services
│   ├── dto/
│   │   ├── auth.dto.ts          RegisterTenantDto, LoginDto, SuperAdminLoginDto,
│   │   │                        OnboardOrganizationDto, ForgotPasswordDto,
│   │   │                        VerifyOtpDto, ResetPasswordDto
│   │   ├── organization.dto.ts  CreateOrganizationDto
│   │   ├── invitation.dto.ts    CreateAdminInvitationDto, ActivateAdminDto
│   │   ├── setup.dto.ts         Organization profile + Dept/Designation/Hours/Policy DTOs
│   │   └── policy.dto.ts        Policy engine DTOs + PolicyType/Status/Source enums
│   ├── exceptions/
│   │   └── tenant.exception.ts  TenantException + TenantErrorCode enum
│   ├── decorators/
│   │   └── metadata.decorators.ts  @Public(), @PlatformRoute(), @TenantOptional()
│   ├── utils/
│   │   └── crypto.utils.ts      AES-256-GCM encrypt/decrypt (iv:authTag:cipher hex)
│   ├── guards/                  (JWT guard and global filters)
│   ├── interceptors/            (Request context interceptors)
│   ├── context/
│   │   └── request-context.interface.ts  RequestContextPayload, CurrentUserPayload
│   └── index.ts                 SERVICES tokens + MESSAGE_PATTERNS registry
│
├── database/                    Database infrastructure
│   ├── database.module.ts       DatabaseModule.forRoot({ isPlatform }) dynamic module
│   ├── database.config.ts       Platform vs. tenant DB config from env vars
│   └── database.types.ts        DatabaseConfig, DatabaseModuleOptions interfaces
│
└── tenant-context/              Multi-tenant isolation infrastructure
    ├── context/
    │   ├── tenant-context.service.ts         AsyncLocalStorage wrapper + run()
    │   ├── tenant-request-context.service.ts REQUEST-scoped per-request state
    │   └── tenant-connection.manager.ts      In-memory Sequelize pool cache
    ├── middleware/
    │   └── tenant-resolver.middleware.ts     Request isolation + context setup
    ├── guards/
    │   ├── tenant.guard.ts                   Tenant required enforcement
    │   ├── roles.guard.ts                    Role-based access control
    │   └── permissions.guard.ts              Fine-grained permission control
    └── decorators/
        ├── roles.decorator.ts               @Roles()
        ├── permissions.decorator.ts         @RequirePermissions()
        ├── current-tenant.decorator.ts      @CurrentTenant()
        └── current-user.decorator.ts        @CurrentUser()
```

---

## 6.3 Security Architecture

### Credential Security
- Passwords: `bcrypt` with 10 salt rounds. Never stored in plain text.
- Password history: Previous hashes stored in array; reset rejected if password reused.
- OTP: 6-digit numeric code. `bcrypt`-hashed in storage. 10-minute expiry.
- DB Passwords: AES-256-GCM encrypted using `CryptoUtils`. Format: `iv:authTag:ciphertext` (hex). Key derived from `ENCRYPTION_KEY` env via SHA-256.
- Invitation tokens: `crypto.randomBytes(32)` raw token. Only SHA-256 hash stored. Raw token returned once on creation (for email delivery).

### JWT Security
- Secret: `JWT_SECRET` environment variable (must be changed in production).
- Expiry: 24 hours (configurable via `JWT_EXPIRY`).
- Claims: `sub` (credential ID), `email`, `tenantId` (for org users), `role`, `isSuperAdmin` (SuperAdmin only).
- Tenant context validation: JWT `tenantId` ≠ `x-tenant-id` header → `403 TENANT_ACCESS_DENIED`.

---

# PAGE 7 — MODULE DEVELOPMENT GUIDE & FUTURE ROADMAP

## 7.1 Adding a New Microservice Module

When adding a new microservice (e.g., `attendance-service`), follow this checklist:

### Step 1 — Define Message Patterns in `libs/common`

```typescript
// libs/common/src/index.ts → MESSAGE_PATTERNS
ATTENDANCE: {
  CHECK_IN: 'attendance.check_in',
  CHECK_OUT: 'attendance.check_out',
  GET_RECORD: 'attendance.get_record',
  GET_SUMMARY: 'attendance.get_summary',
},
```

Also add the service token:
```typescript
// SERVICES constant
ATTENDANCE_LEAVE_SERVICE: 'ATTENDANCE_LEAVE_SERVICE',
```

### Step 2 — Create DTOs in `libs/common/src/dto/`

```typescript
// attendance.dto.ts
export class CheckInDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty()
  @IsDateString()
  timestamp: string;

  @ApiProperty({ example: 'WEB_CLOCK_IN' })
  @IsString()
  method: string;
}
```

### Step 3 — Register the TCP Client in API Gateway

```typescript
// apps/api-gateway/src/api-gateway.module.ts
{
  name: SERVICES.ATTENDANCE_LEAVE_SERVICE,
  useFactory: (config: ConfigService) => ({
    transport: Transport.TCP,
    options: {
      host: config.get('ATTENDANCE_SERVICE_HOST', 'localhost'),
      port: config.get('ATTENDANCE_SERVICE_PORT', 3004),
    },
  }),
}
```

### Step 4 — Create a Gateway Controller

```typescript
// apps/api-gateway/src/controllers/attendance.controller.ts
@ApiTags('Attendance & Leave')
@Controller('attendance')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true })
export class AttendanceGatewayController {
  constructor(
    @Inject(SERVICES.ATTENDANCE_LEAVE_SERVICE)
    private readonly attendanceClient: ClientProxy,
  ) {}

  @Post('check-in')
  checkIn(@Headers('x-tenant-id') tenantId: string, @Body() dto: CheckInDto) {
    return this.attendanceClient.send(
      MESSAGE_PATTERNS.ATTENDANCE.CHECK_IN,
      { tenantId, dto }
    );
  }
}
```

### Step 5 — Create the Microservice App

Create `apps/attendance-service/src/` with:
- `attendance-service.module.ts` — imports `TenantContextModule`, applies `TenantResolverMiddleware`
- `attendance-service.main.ts` — TCP listener on port 3004
- `controllers/attendance.controller.ts` — `@MessagePattern(MESSAGE_PATTERNS.ATTENDANCE.CHECK_IN)`
- `services/attendance.service.ts` — business logic using `TenantModelProviderService`
- `models/attendance.model.ts` — Sequelize model (lives in tenant DB)

### Step 6 — Use Tenant-Isolated Database Access

Always use `TenantModelProviderService` pattern for tenant DB access:

```typescript
@Injectable()
export class AttendanceService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  async checkIn(data: { tenantId: string; employeeId: string; timestamp: string }) {
    const AttendanceModel = await this.modelProvider.getAttendanceModel();
    // All queries automatically scoped to the current tenant's database
    return AttendanceModel.create({
      employeeId: data.employeeId,
      checkInTime: new Date(data.timestamp),
      date: new Date(data.timestamp).toISOString().split('T')[0],
    });
  }
}
```

---

## 7.2 Planned Future Modules

| Module | Service Port | Status | Key Domain Models |
| :--- | :--- | :--- | :--- |
| **Attendance & Leave** | 3004 | Planned (models defined) | `Attendance`, `LeaveRequest` |
| **Payroll** | 3005 | Planned (models defined) | `SalaryStructure`, `PayrollRecord` |
| **Performance & Work** | 3006 | Planned (models defined) | `Project`, `Task`, `Goal`, `EmployeeOutput`, `PerformanceReview` |
| **Recruitment** | 3007 | Planned (models defined) | `CandidateProfile` (cross-tenant), `JobPosting`, `JobApplication` |
| **LMS** | 3008 | Planned (models defined) | `Course`, `CourseEnrollment` |

### Performance & Work Module (Core Differentiator)

The `performance-work-service` implements the platform's core differentiator: direct relational linkage between work output and objective performance reviews.

```
Project ──► Task ──► EmployeeOutput ──► Goal/KPI ──► PerformanceReview
                           │
                      qualityScore
                      outputSummary
```

This ensures performance reviews are backed by factual, recorded work output rather than subjective assessments alone.

### Cross-Tenant Candidate Profiles (Phase 2)

`CandidateProfile` intentionally has no `tenantId`. A single candidate can apply to multiple organizations across different tenants, reusing their profile and CV across the talent marketplace.

---

## 7.3 API Gateway Endpoint Reference

Base URL: `http://localhost:3000/api/v1`  
Swagger UI: `http://localhost:3000/api/docs`

| Tag | Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- | :--- |
| Auth | `POST` | `/auth/register-tenant` | Public | Register new organization |
| Auth | `POST` | `/auth/login` | Public | Organization user login |
| SuperAdmin | `POST` | `/superadmin/login` | Public | SuperAdmin login |
| SuperAdmin | `POST` | `/superadmin/organizations` | Bearer | Create org + provision DB |
| SuperAdmin | `POST` | `/superadmin/organizations/:id/invitation` | Bearer | Generate admin invitation |
| SuperAdmin | `POST` | `/superadmin/organizations/:id/invitation/resend` | Bearer | Resend invitation |
| SuperAdmin | `POST` | `/superadmin/organizations/:id/provision/retry` | Bearer | Retry failed provisioning |
| Activation | `GET` | `/organization-admin/validate?token=` | Public | Validate invitation token |
| Activation | `POST` | `/organization-admin/activate` | Public | Activate admin account |
| Setup | `GET` | `/organization/setup/progress` | Bearer + tenantId | Get setup completion % |
| Setup | `PUT` | `/organization/setup/profile` | Bearer + tenantId | Update org profile |
| Setup | `*` | `/organization/departments` | Bearer + tenantId | Departments CRUD |
| Setup | `*` | `/organization/designations` | Bearer + tenantId | Designations CRUD |
| Setup | `*` | `/organization/working-hours` | Bearer + tenantId | Working hours |
| Setup | `*` | `/organization/leave-policy` | Bearer + tenantId | Leave policies CRUD |
| Setup | `*` | `/organization/attendance-policy` | Bearer + tenantId | Attendance policy |
| Setup | `POST` | `/organization/setup/complete` | Bearer + tenantId | Finalize setup → ACTIVE |
| Policies | `*` | `/organization/policies` | Bearer + tenantId | Full policy engine CRUD |
| Modules | `GET` | `/org/dashboard` | Bearer + tenantId | Dashboard summary |
| Modules | `GET` | `/org/audit-logs` | Bearer + tenantId | Audit trail |
| Modules | `GET` | `/org/assets`, `/expenses`, `/tickets` | Bearer + tenantId | Asset & HR modules |

---

## 7.4 Local Development Setup

```bash
# Prerequisites: Node.js 20+, PostgreSQL 15+

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.development
# Edit .env.development with your PostgreSQL credentials and JWT secret

# 3. Start services (4 separate terminals recommended)
npm run start:auth-service      # TCP Port 3001
npm run start:tenant-service    # TCP Port 3002
npm run start:user-service      # TCP Port 3003
npm run start:api-gateway       # HTTP Port 3000

# 4. Access Swagger UI
# http://localhost:3000/api/docs

# 5. Default SuperAdmin credentials (seeded automatically on first boot)
# Email: superadmin@system.com
# Password: SuperAdmin123!
```

### Key Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PLATFORM_DB_HOST` | localhost | Platform PostgreSQL host |
| `PLATFORM_DB_NAME` | hrms_platform | Platform database name |
| `PLATFORM_DB_USER` | postgres | Platform DB username |
| `PLATFORM_DB_PASSWORD` | password | Platform DB password |
| `TENANT_DB_HOST` | localhost | Host for provisioning tenant DBs |
| `TENANT_DB_USER` | postgres | User for tenant DBs |
| `JWT_SECRET` | *(change in prod)* | JWT signing secret |
| `ENCRYPTION_KEY` | *(change in prod)* | AES-256-GCM key for DB password encryption |
| `AUTH_SERVICE_PORT` | 3001 | Auth Service TCP port |
| `TENANT_SERVICE_PORT` | 3002 | Tenant Service TCP port |
| `USER_SERVICE_PORT` | 3003 | User Service TCP port |
| `API_GATEWAY_PORT` | 3000 | API Gateway HTTP port |

---

## 7.5 Error Codes Reference

All tenant-related errors use the `TenantException` class with structured JSON responses:

| Error Code | HTTP Status | When Thrown |
| :--- | :--- | :--- |
| `TENANT_REQUIRED` | 400 | Request requires tenant context but none found |
| `TENANT_NOT_FOUND` | 400 | Tenant ID does not exist in platform DB |
| `TENANT_ACCESS_DENIED` | 400 | JWT tenant ≠ header tenant (security violation) |
| `TENANT_SUSPENDED` | 400 | Organization account has been suspended |
| `TENANT_EXPIRED` | 400 | Organization subscription has expired |
| `INVALID_TENANT_CONTEXT` | 400 | General validation failure (provisioning, policy, etc.) |

Response shape:
```json
{
  "statusCode": 400,
  "errorCode": "TENANT_NOT_FOUND",
  "message": "Tenant 'xyz' not found.",
  "timestamp": "2026-08-21T10:30:00.000Z"
}
```

---

*Document generated from live codebase analysis — August 2026*
*For updates, regenerate from the project source or modify `/docs/HRMS_COMPLETE_DOCUMENTATION.md`*
