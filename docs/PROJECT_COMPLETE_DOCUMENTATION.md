# HRMS Multi-Tenant Platform — Mukammal Documentation

> **Version**: 3.0.0 | **Tarikh**: August 2026  
> **Stack**: TypeScript · NestJS 11 · Sequelize ORM · PostgreSQL  
> **Architecture**: NestJS Monorepo Microservices (TCP Transport)

---

## FEHRIST (Table of Contents)

1. [Project Overview — Kya Bana Hai?](#1-project-overview)
2. [System Architecture — Poora Dhancha](#2-system-architecture)
3. [Database Architecture — Database ka Tarkib](#3-database-architecture)
4. [Service-by-Service Detail](#4-service-by-service-detail)
5. [Complete Organization Lifecycle Flow](#5-organization-lifecycle-flow)
6. [Authentication & Authorization Flow](#6-authentication--authorization-flow)
7. [Dynamic Policy Engine](#7-dynamic-policy-engine)
8. [Multi-Tenant Isolation — Tenant Isolation Kaise Kaam Karta Hai](#8-multi-tenant-isolation)
9. [Shared Libraries (libs/)](#9-shared-libraries)
10. [API Endpoints Reference](#10-api-endpoints-reference)
11. [Security Architecture](#11-security-architecture)
12. [Future Modules — Kya Banana Baaki Hai](#12-future-modules)
13. [Local Development Setup](#13-local-development-setup)
14. [Error Codes Reference](#14-error-codes-reference)

---

## 1. Project Overview

### Kya Bana Hai?

**HRMS Multi-Tenant Platform** ek cloud-native, microservices-based Human Resource Management System hai jo multiple independent organizations (tenants) ko ek hi deployment se serve karta hai.

### Core Features — Jo Abhi Fully Bane Hain ✅

| Feature | Status | Description |
|---|---|---|
| SuperAdmin Management | ✅ Complete | SuperAdmin login, organization onboarding |
| Organization Provisioning | ✅ Complete | Isolated PostgreSQL database har tenant ke liye |
| Admin Invitation System | ✅ Complete | Secure token-based admin activation |
| Authentication (JWT + OTP) | ✅ Complete | Login, forgot password, OTP reset |
| Organization Setup Wizard | ✅ Complete | 6-module setup progress tracking |
| Dynamic Policy Engine | ✅ Complete | 7 policy types with full lifecycle |
| RBAC (Roles & Permissions) | ✅ Complete | Per-tenant user/role/permission management |
| Multi-Tenant Isolation | ✅ Complete | AsyncLocalStorage + connection pool cache |

### Jo Banana Baaki Hai 🔜

| Service | Port | Status |
|---|---|---|
| Attendance & Leave Service | 3004 | Planned |
| Payroll Service | 3005 | Planned |
| Performance & Work Service | 3006 | Planned |
| Recruitment Service | 3007 | Planned |
| LMS Service | 3008 | Planned |

---

## 2. System Architecture

### High-Level Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════╗
║                     WEB / MOBILE CLIENTS                            ║
╚══════════════════════════════════╦═══════════════════════════════════╝
                                   ║  HTTP REST
                                   ║  Headers: Authorization: Bearer <JWT>
                                   ║           x-tenant-id: <tenant-uuid>
                                   ▼
╔══════════════════════════════════════════════════════════════════════╗
║              API GATEWAY  (HTTP Port 3000)                          ║
║   ┌──────────────────────────────────────────────────────────────┐  ║
║   │  Global Prefix: /api/v1                                      │  ║
║   │  Swagger UI: /api/docs                                       │  ║
║   │  ValidationPipe (whitelist + transform)                      │  ║
║   │  TenantResolverMiddleware → AsyncLocalStorage               │  ║
║   └──────────────────────────────────────────────────────────────┘  ║
╚══════╦═══════════════════════╦════════════════════╦══════════════════╝
       ║ TCP                   ║ TCP                ║ TCP
       ▼                       ▼                    ▼
╔══════════════╗   ╔═══════════════════╗   ╔═══════════════════╗
║ AUTH SERVICE ║   ║  TENANT SERVICE   ║   ║   USER SERVICE    ║
║  Port 3001   ║   ║    Port 3002      ║   ║    Port 3003      ║
║              ║   ║                   ║   ║                   ║
║ SuperAdmin   ║   ║ Organization      ║   ║ Users (tenant DB) ║
║ AuthCred     ║   ║ Departments       ║   ║ Roles             ║
║ JWT + OTP    ║   ║ Designations      ║   ║ Permissions       ║
║              ║   ║ Policies          ║   ║ RBAC              ║
║              ║   ║ DB Provisioning   ║   ║                   ║
╚══════╦═══════╝   ╚═══════╦═══════════╝   ╚════════╦══════════╝
       ║                   ║                         ║
       ╚═══════════════════╬═════════════════════════╝
                           ║  Sequelize ORM (PostgreSQL)
                           ▼
╔══════════════════════════════════════════════════════════════════════╗
║                    POSTGRESQL SERVER                                ║
║   ┌─────────────────────────────────────────────────────────────┐   ║
║   │  hrms_platform (Platform DB)                                │   ║
║   │  → super_admins, auth_credentials, tenants                  │   ║
║   │  → tenant_database_configs, departments, designations       │   ║
║   │  → organization_admin_invitations, working_hours            │   ║
║   │  → leave_policies, attendance_policies, organization_policies│  ║
║   └─────────────────────────────────────────────────────────────┘   ║
║   ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐   ║
║   │ hrms_<tenant_1>  │  │ hrms_<tenant_2>  │  │ hrms_<tenant_N> │  ║
║   │ users, roles,    │  │ users, roles,    │  │ ...             │   ║
║   │ permissions...   │  │ permissions...   │  │                 │   ║
║   └──────────────────┘  └──────────────────┘  └─────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════╝
```

### Monorepo Project Structure

```
HRMS-Multi-Tenant/
│
├── apps/
│   ├── api-gateway/         ← HTTP Entry Point (Port 3000)
│   │   └── src/
│   │       ├── api-gateway.module.ts
│   │       ├── main.ts
│   │       └── controllers/
│   │           ├── auth.controller.ts
│   │           ├── superadmin.controller.ts
│   │           ├── activation.controller.ts
│   │           ├── organization-setup.controller.ts
│   │           ├── organization-policy.controller.ts
│   │           ├── organization-modules.controller.ts
│   │           └── health.controller.ts
│   │
│   ├── auth-service/        ← Authentication (TCP Port 3001)
│   │   └── src/
│   │       ├── controllers/auth.controller.ts
│   │       ├── services/
│   │       │   ├── auth.service.ts
│   │       │   └── otp.service.ts
│   │       └── models/
│   │           ├── super-admin.model.ts
│   │           └── auth-credential.model.ts
│   │
│   ├── tenant-service/      ← Organization Management (TCP Port 3002)
│   │   └── src/
│   │       ├── tenant-service.controller.ts
│   │       ├── models/ (9 models)
│   │       └── services/ (7 services)
│   │
│   └── user-service/        ← User/RBAC Management (TCP Port 3003)
│       └── src/
│           ├── user-service.controller.ts
│           ├── models/ (5 models)
│           └── services/ (3 services)
│
└── libs/
    ├── common/              ← Shared DTOs, Exceptions, Utils, Decorators
    ├── database/            ← Sequelize Module wrapper
    └── tenant-context/      ← Multi-tenant isolation infrastructure
```

---

## 3. Database Architecture

### Do Database Strategy — Platform DB + Tenant DBs

```
┌─────────────────────────────────────────────────────────────────────┐
│                    TWO DATABASE STRATEGY                           │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              PLATFORM DATABASE (hrms_platform)              │   │
│  │                   Cross-Tenant Admin Data                   │   │
│  │                                                             │   │
│  │  super_admins           ← Platform operator accounts        │   │
│  │  auth_credentials       ← Login credentials (ALL users)     │   │
│  │  tenants                ← Organization registry             │   │
│  │  tenant_database_configs ← Encrypted DB connection info     │   │
│  │  departments            ← Org department definitions        │   │
│  │  designations           ← Job title definitions             │   │
│  │  org_admin_invitations  ← Token-based admin invitations     │   │
│  │  working_hours          ← Shift configurations              │   │
│  │  leave_policies         ← Leave policy definitions          │   │
│  │  attendance_policies    ← Attendance configurations         │   │
│  │  organization_policies  ← Dynamic JSONB policy engine       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────┐  ┌──────────────────────┐               │
│  │  hrms_<tenant_uuid1> │  │  hrms_<tenant_uuid2> │  ...          │
│  │  (Org 1 Database)    │  │  (Org 2 Database)    │               │
│  │                      │  │                      │               │
│  │  users               │  │  users               │               │
│  │  roles               │  │  roles               │               │
│  │  permissions         │  │  permissions         │               │
│  │  user_roles          │  │  user_roles          │               │
│  │  role_permissions    │  │  role_permissions    │               │
│  │  tenant_schema_      │  │  tenant_schema_      │               │
│  │    migrations        │  │    migrations        │               │
│  └──────────────────────┘  └──────────────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
```

### Tenant Model — Complete Fields

```
Tenant {
  id: UUID (Primary Key)
  name: string
  organizationName: string
  legalName: string
  industry: string
  phone: string
  website: string
  country, state, city, address: string
  timezone, currency: string
  slug: string (unique)
  email, adminEmail: string
  planType: string (default: 'standard')
  domain: string (unique)
  isActive: boolean

  status: TenantStatus
    DRAFT → PENDING_ADMIN_ACTIVATION → SETUP_IN_PROGRESS → ACTIVE
    → SUSPENDED / EXPIRED

  setupStatus: TenantSetupStatus
    NOT_STARTED → IN_PROGRESS → COMPLETED

  provisioningStatus: TenantProvisioningStatus
    PENDING → PROVISIONING → READY / FAILED

  provisioningError: text (nullable)
}
```

### Tenant Lifecycle State Machine

```
                ┌─────────────────────────────────────────────────────┐
                │          TENANT COMPLETE LIFECYCLE                  │
                └─────────────────────────────────────────────────────┘

[1. SuperAdmin: POST /superadmin/organizations]
                         │
                         ▼
                      DRAFT
                  (provisioningStatus: PENDING)
                  (setupStatus: NOT_STARTED)
                         │
                         │ TenantProvisioningService.createOrganizationAndProvision()
                         │
                         ▼
              PENDING_ADMIN_ACTIVATION
                  (provisioningStatus: READY)
                  (setupStatus: NOT_STARTED)
                  (Database: hrms_<uuid> CREATED ✅)
                         │
                         │ [2. SuperAdmin sends invitation]
                         │ POST /superadmin/organizations/:id/invitation
                         │
                         │ [3. Admin clicks link + sets password]
                         │ POST /organization-admin/activate
                         │
                         ▼
                  SETUP_IN_PROGRESS
                  (setupStatus: IN_PROGRESS)
                         │
                         │ [4. Admin configures 6 modules]
                         │ Profile, Departments, Designations,
                         │ Working Hours, Leave Policy, Attendance Policy
                         │
                         │ [5. POST /organization/setup/complete]
                         │
                         ▼
                        ACTIVE ✅
                  (setupStatus: COMPLETED)
                       ╱     ╲
               SUSPENDED   EXPIRED
                       ╲     ╱
                 [Deprovision: DROP DATABASE]
```

---

## 4. Service-by-Service Detail

### 4.1 API Gateway (Port 3000)

**Kaam kya hai:** Sirf routing aur proxying. Koi business logic nahi.

```
API Gateway Controllers:
│
├── ApiGatewayAuthController      [/auth]
│   ├── POST /auth/register-tenant    → Auth Service TCP
│   └── POST /auth/login              → Auth Service TCP
│
├── SuperAdminController          [/superadmin]  @PlatformRoute()
│   ├── POST /superadmin/login               → Auth Service TCP
│   ├── POST /superadmin/organizations/onboard → Auth Service TCP
│   ├── POST /superadmin/organizations        → Tenant Service TCP
│   ├── POST /superadmin/organizations/:id/provision/retry → Tenant Service TCP
│   ├── POST /superadmin/organizations/:id/invitation      → Tenant Service TCP
│   └── POST /superadmin/organizations/:id/invitation/resend → Tenant Service TCP
│
├── OrganizationAdminActivationController  [/organization-admin]  @Public()
│   ├── GET  /organization-admin/validate?token=  → Tenant Service TCP
│   └── POST /organization-admin/activate         → Tenant Service TCP
│
├── OrganizationSetupController   [/organization]  @ApiBearerAuth()
│   ├── GET/PUT  /organization/setup/progress|complete
│   ├── GET/POST/PATCH/DELETE /organization/departments
│   ├── GET/POST/PATCH/DELETE /organization/designations
│   ├── GET/PUT  /organization/working-hours
│   ├── GET/POST/PATCH/DELETE /organization/leave-policy
│   └── GET/PUT  /organization/attendance-policy
│
├── OrganizationPolicyController  [/organization/policies]
│   └── Full CRUD + activate/deactivate/archive + versioning
│
├── OrganizationModulesController [/org]  (Mock data stubs)
│   └── dashboard, geofence, POS, announcements, surveys,
│       NFT rewards, community, penalties, assets, expenses,
│       tickets, audit-logs
│
└── ApiGatewayHealthController    [/health]
    └── GET /health → polls all 3 services
```

**Module Setup (api-gateway.module.ts):**
- `ClientsModule.registerAsync` → 3 TCP clients configured
- Auth: `TCP { host, port: 3001 }`
- Tenant: `TCP { host, port: 3002 }`
- User: `TCP { host, port: 3003 }`

---

### 4.2 Auth Service (TCP Port 3001)

**Kaam kya hai:** Authentication, JWT generation, OTP management.

**Database:** Platform DB (`hrms_platform`) only.

#### Models

**SuperAdmin Model:**
```
super_admins table:
  id: UUID
  email: string (unique)
  passwordHash: string (bcrypt, 10 rounds)
  name: string
  resetOtp: string (bcrypt-hashed OTP)
  resetOtpExpiresAt: DateTime
  passwordHistory: string[] (previous hashes)
  status: string (default: 'active')
```

**AuthCredential Model:**
```
auth_credentials table:
  id: UUID
  email: string (unique)
  passwordHash: string (bcrypt, 10 rounds)
  tenantId: string
  tenantName: string
  role: string (default: 'Admin')
  isActive: boolean (default: true)
  resetOtp: string (bcrypt-hashed)
  resetOtpExpiresAt: DateTime
  passwordHistory: string[]
```

#### Services

**AuthService — Main Auth Logic:**
```
Methods:
  onModuleInit()          → Default SuperAdmin seed karta hai agar koi nahi
  createAdminCredential() → Org admin ka credential create/update karta hai
  superAdminLogin()       → SuperAdmin login → JWT sign karta hai
  onboardOrganization()   → AuthCredential create + JWT return
  registerTenant()        → onboardOrganization() ko delegate karta hai
  login()                 → Credential find → bcrypt compare → JWT sign
  forgotPassword()        → OTP generate → bcrypt hash → DB mein store
  verifyOtp()             → OTP verify (bcrypt + expiry check)
  resetPassword()         → OTP re-verify → new hash → history update
```

**OtpService:**
```
Methods:
  generateOtp()  → 6-digit random code → bcrypt hash → 10 min expiry
  verifyOtp()    → bcrypt.compare + expiry check
```

#### Message Patterns Handled

```
health.check                  → { service, status, timestamp }
auth.register_tenant          → onboardOrganization()
auth.login                    → Org user login + JWT
auth.superadmin_login         → SuperAdmin login + JWT
auth.onboard_organization     → Create AuthCredential + JWT
auth.create_admin_credential  → Upsert credential (called by Tenant Service)
auth.forgot_password          → Generate + store OTP
auth.verify_otp               → Validate OTP
auth.reset_password           → Reset password with OTP
```

---

### 4.3 Tenant Service (TCP Port 3002)

**Kaam kya hai:** Organization lifecycle management — provisioning, setup, policies.

**Database:** Platform DB — saari config data yahaan hai.

#### Models (9 Total)

```
1. Tenant               → Organization registry + lifecycle status
2. TenantDatabaseConfig → Encrypted DB credentials (AES-256-GCM)
3. Department           → { tenantId, name, code, description, isActive }
4. Designation          → { tenantId, title, code, departmentId, isActive }
5. OrganizationAdminInvitation
   → { tenantId, adminEmail, tokenHash (SHA-256), status, expiresAt }
   → toJSON() strips tokenHash (security)
6. WorkingHours         → { tenantId, workingDays[], startTime, endTime, timezone }
7. LeavePolicy          → { tenantId, name, annualAllocation, isPaid }
8. AttendancePolicy     → { tenantId (unique), gracePeriodMinutes, trackingMode }
9. OrganizationPolicy   → JSONB configuration, versioning, lifecycle
   → Indexes: (tenantId, policyType), (tenantId, policyType, status), (effectiveFrom)
```

#### Services (7 Total)

**1. TenantService** — Basic tenant CRUD

**2. TenantDatabaseConfigService** — Encrypted DB config management

**3. TenantProvisioningService** — Database provisioning engine:
```
createOrganizationAndProvision():
  1. generateSlug(orgName, domain) → lowercase → replace non-alphanumeric → hyphens
  2. Duplicate check (slug)
  3. Tenant record create (DRAFT, PENDING)
  4. provisionTenantDatabase() call

provisionTenantDatabase():
  1. Status → PROVISIONING
  2. checkDatabaseExists() → pg_database query (idempotent)
  3. CREATE DATABASE "hrms_<uuid_underscores>" (if not exists)
  4. runMigrationsAndBaseSchema():
     - CREATE TABLE tenant_schema_migrations
     - INSERT version '1.0.0' ON CONFLICT DO NOTHING
     - sequelize.sync({ force: false })
  5. saveOrUpdateTenantDatabaseConfig() → AES-256-GCM encrypted
  6. Status → READY, PENDING_ADMIN_ACTIVATION

retryProvisioning() → Agar FAILED ho to retry karo
deprovisionTenant() → pg_terminate_backend → DROP DATABASE → delete configs
```

**4. OrganizationAdminInvitationService:**
```
createAdminInvitation():
  1. Tenant provisioningStatus === READY check
  2. Cancel existing PENDING invitations
  3. crypto.randomBytes(32).toString('hex') → rawToken
  4. SHA-256(rawToken) → tokenHash (sirf yahi store hota hai)
  5. expiresAt = now + 7 days
  6. Create invitation record
  7. Return rawToken (sirf ek baar milta hai)

validateInvitationToken(rawToken):
  1. SHA-256(rawToken) → tokenHash lookup
  2. Status === PENDING check
  3. Expiry check → auto-expire if expired
  4. tenant.provisioningStatus === READY check

activateAdminAccount(token, password):
  1. validateInvitationToken()
  2. TCP → User Service: user.create_organization_admin
  3. TCP → Auth Service: auth.create_admin_credential
  4. Invitation status = ACCEPTED
  5. Tenant status = SETUP_IN_PROGRESS
```

**5. OrganizationSetupService:**
```
getSetupProgress(tenantId):
  Checks 6 modules:
  ✓ Profile    → organizationName + (country || address || timezone)
  ✓ Depts      → departmentsCount > 0
  ✓ Designations → designationsCount > 0
  ✓ WorkingHours → workingHours record exists
  ✓ LeavePolicy  → leavePoliciesCount > 0
  ✓ Attendance   → attendancePolicy record exists
  Returns: { percentage, modules, missingModules, isComplete }

completeSetup():
  1. Idempotency check (already COMPLETED + ACTIVE?)
  2. getSetupProgress() → isComplete === true check
  3. tenant.update({ status: ACTIVE, setupStatus: COMPLETED })
```

**6. OrganizationPolicyService:** (Policy Engine — see Section 7)

**7. PolicyConfigurationValidatorService:** (Policy Validators — see Section 7)

---

### 4.4 User Service (TCP Port 3003)

**Kaam kya hai:** Per-tenant user, role, permission management.

**Database:** **Tenant DB** (har request ke saath different database connection).

#### Models (5 per Tenant DB)

```
1. User
   → { email (unique), passwordHash, firstName, lastName, isActive }
   → BelongsToMany Role (via UserRole)

2. Role
   → { name (unique), description, isSystemRole }
   → BelongsToMany User (via UserRole)
   → BelongsToMany Permission (via RolePermission)

3. Permission
   → { resource, action, description }
   → e.g., resource='users', action='read' → 'users:read'

4. UserRole       → join table: { userId, roleId }
5. RolePermission → join table: { roleId, permissionId }
```

#### Services

**UserService:**
```
createOrganizationAdminUser(data):
  → tenantContextService.run({ tenantId }) mein execute hota hai
  → User create/update (idempotent)
  → ORGANIZATION_ADMIN role create/find
  → UserRole assignment (idempotent)

createUser()     → Email unique check → User create → Roles assign
getUserById()    → User + Roles include
getAllUsers()     → All users + roles
updateUser()     → User update
deleteUser()     → UserRole delete → User delete
assignRole()     → Idempotent UserRole create
revokeRole()     → UserRole delete
```

**RoleService:**
```
createRole()          → Duplicate name check → Role create → Permissions assign
getRoleById()         → Role + Permissions include
getAllRoles()          → All roles + permissions
updateRole()          → isSystemRole check → update
deleteRole()          → isSystemRole check → RolePermission + UserRole cleanup → delete
assignPermission()    → Idempotent RolePermission create
revokePermission()    → RolePermission delete
```

**TenantModelProviderService (REQUEST-scoped):**
```
getConnection():
  1. Cached connection check
  2. requestContext.getConnectionOptions() → tenantId + DB credentials
  3. connectionManager.getConnection(options) → Sequelize instance
  4. connection.addModels([User, Role, Permission, UserRole, RolePermission])
  5. Cache and return

getUserModel()        → connection.models.User
getRoleModel()        → connection.models.Role
getPermissionModel()  → connection.models.Permission
getUserRoleModel()    → connection.models.UserRole
getRolePermissionModel() → connection.models.RolePermission
```

---

## 5. Organization Lifecycle Flow

### Complete End-to-End Flow Diagram

```
═══════════════════════════════════════════════════════════════════════
                    STAGE 1: ORGANIZATION CREATION
═══════════════════════════════════════════════════════════════════════

SuperAdmin
    │
    │  POST /api/v1/superadmin/organizations
    │  Body: { organizationName, adminEmail, domain? }
    │  Headers: Authorization: Bearer <superadmin_jwt>
    │
    ▼
API Gateway (SuperAdminController)
    │
    │  TCP: org.create_organization
    ▼
Tenant Service (TenantProvisioningService)
    │
    ├─ [1] generateSlug("Acme Corp") → "acme-corp"
    ├─ [2] Duplicate slug check → 409 if exists
    ├─ [3] Create Tenant record
    │       { status: DRAFT, provisioningStatus: PENDING }
    │
    ├─ [4] generateDatabaseName(tenant.id)
    │       → "hrms_" + uuid.replace(/-/g, '_')
    │       → e.g., "hrms_c4b12f6a_04b3_4f8a_9892_9653d9e21183"
    │
    ├─ [5] Tenant update: provisioningStatus = PROVISIONING
    │
    ├─ [6] checkDatabaseExists("hrms_...") → pg_database query
    │       (Idempotent — safe to retry)
    │
    ├─ [7] CREATE DATABASE "hrms_c4b12f6a_..." (if not exists)
    │
    ├─ [8] Connect to new DB & initialize:
    │       CREATE TABLE tenant_schema_migrations (...)
    │       INSERT version '1.0.0' ON CONFLICT DO NOTHING
    │       sequelize.sync({ force: false })
    │
    ├─ [9] saveOrUpdateTenantDatabaseConfig()
    │       AES-256-GCM encrypt(DB password) → store in platform DB
    │
    └─ [10] Tenant update:
            provisioningStatus = READY
            status = PENDING_ADMIN_ACTIVATION
    │
    └─► Response: { tenantId, organizationName, slug, databaseName,
                    status: PENDING_ADMIN_ACTIVATION, provisioningStatus: READY }

═══════════════════════════════════════════════════════════════════════
                    STAGE 2: ADMIN INVITATION
═══════════════════════════════════════════════════════════════════════

SuperAdmin
    │
    │  POST /api/v1/superadmin/organizations/:tenantId/invitation
    │  Body: { adminEmail?, adminName? }
    │
    ▼
Tenant Service (OrganizationAdminInvitationService)
    │
    ├─ [1] Tenant provisioningStatus === READY check
    ├─ [2] Cancel all PENDING invitations for this tenant
    ├─ [3] rawToken = crypto.randomBytes(32).toString('hex')
    │       e.g., "a3f8b2c1..." (64 hex chars)
    ├─ [4] tokenHash = SHA-256(rawToken)
    │       (SIRF yahi DB mein store hota hai — rawToken kabhi store nahi)
    ├─ [5] expiresAt = now + 7 days
    ├─ [6] Create invitation record (status: PENDING)
    └─ [7] Build activationUrl with rawToken
    │
    └─► Response: { invitationId, tenantId, adminEmail, rawToken,
                    activationUrl, expiresAt }
                  NOTE: rawToken sirf ek baar milta hai — email ke zariye bhejo

═══════════════════════════════════════════════════════════════════════
                    STAGE 3: ADMIN ACCOUNT ACTIVATION
═══════════════════════════════════════════════════════════════════════

Admin (invitation link se)
    │
    │  POST /api/v1/organization-admin/activate
    │  Body: { token, password, confirmPassword, firstName?, lastName? }
    │
    ▼
Tenant Service (OrganizationAdminInvitationService.activateAdminAccount)
    │
    ├─ [1] validateInvitationToken(rawToken)
    │       SHA-256(rawToken) → lookup in DB
    │       Check: status === PENDING
    │       Check: now < expiresAt
    │       Check: tenant.provisioningStatus === READY
    │
    ├─ [2] TCP → User Service (user.create_organization_admin)
    │       timeout: 10 seconds
    │       → User create/update in TENANT DATABASE
    │       → ORGANIZATION_ADMIN role create/assign (idempotent)
    │
    ├─ [3] TCP → Auth Service (auth.create_admin_credential)
    │       timeout: 10 seconds
    │       → bcrypt.hash(password, 10)
    │       → AuthCredential create/update in PLATFORM DATABASE
    │
    ├─ [4] Invitation update: status = ACCEPTED, acceptedAt = now
    │
    └─ [5] Tenant update:
            status = SETUP_IN_PROGRESS
            setupStatus = IN_PROGRESS
    │
    └─► Response: { message, tenantId, adminEmail, status: SETUP_IN_PROGRESS }

═══════════════════════════════════════════════════════════════════════
                    STAGE 4: ORGANIZATION SETUP WIZARD
═══════════════════════════════════════════════════════════════════════

Admin (JWT se authenticated, tenantId in JWT)
    │
    │  Headers: Authorization: Bearer <admin_jwt>
    │           x-tenant-id: <tenantId>
    │
    ▼
Setup Progress (6 Modules — Sab complete hone chahiye):

┌─────────────────────────────────────────────────────────────────┐
│           SETUP WIZARD CHECKLIST                                │
│                                                                 │
│  ✓ Module 1: Profile                                           │
│    PUT /organization/setup/profile                             │
│    Required: organizationName + (country || address || timezone)│
│                                                                 │
│  ✓ Module 2: Departments                                       │
│    POST /organization/departments                              │
│    Required: At least 1 department                             │
│                                                                 │
│  ✓ Module 3: Designations                                      │
│    POST /organization/designations                             │
│    Required: At least 1 designation                            │
│                                                                 │
│  ✓ Module 4: Working Hours                                     │
│    PUT /organization/working-hours                             │
│    Required: WorkingHours record exists                        │
│    Body: { startTime, endTime, workingDays[], breakDuration }  │
│                                                                 │
│  ✓ Module 5: Leave Policy                                      │
│    POST /organization/leave-policy                             │
│    Required: At least 1 leave policy                           │
│                                                                 │
│  ✓ Module 6: Attendance Policy                                 │
│    PUT /organization/attendance-policy                         │
│    Required: AttendancePolicy record exists                    │
│                                                                 │
│  GET /organization/setup/progress                              │
│  → { percentage: 0-100, modules: {...}, missingModules: [...] }│
└─────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════
                    STAGE 5: SETUP COMPLETION
═══════════════════════════════════════════════════════════════════════

Admin
    │
    │  POST /api/v1/organization/setup/complete
    │  Headers: Authorization: Bearer <admin_jwt>
    │           x-tenant-id: <tenantId>
    │
    ▼
Tenant Service (OrganizationSetupService.completeSetup)
    │
    ├─ [1] Idempotency check: already COMPLETED + ACTIVE?
    │       → return success (idempotent)
    │
    ├─ [2] getSetupProgress() → isComplete === true?
    │       If false → 400 with missing modules list
    │
    └─ [3] Tenant update:
            status = ACTIVE ✅
            setupStatus = COMPLETED
    │
    └─► Response: { message, tenantId, organizationName, status: ACTIVE }
                  Organization ab fully operational hai!
```

---

## 6. Authentication & Authorization Flow

### Login Flows

```
═══════════════════════════════════════════════════════════════════════
                    SUPERADMIN LOGIN
═══════════════════════════════════════════════════════════════════════

POST /api/v1/superadmin/login
Body: { email: "superadmin@system.com", password: "SuperAdmin123!" }

API Gateway → TCP → Auth Service
    │
    ├─ SuperAdmin.findOne({ email })
    ├─ bcrypt.compare(password, admin.passwordHash)
    │   └─ Fail → 401 UnauthorizedException
    └─ jwtService.sign({
           sub: admin.id,
           email: admin.email,
           isSuperAdmin: true,
           role: 'SuperAdmin'
       })

Response: {
    accessToken: "eyJhbGc...",
    user: { id, email, name, role: "SuperAdmin" }
}
JWT Claims: { sub, email, isSuperAdmin: true, role: 'SuperAdmin' }

═══════════════════════════════════════════════════════════════════════
                    ORGANIZATION USER LOGIN
═══════════════════════════════════════════════════════════════════════

POST /api/v1/auth/login
Body: { email: "admin@acme.com", password: "Password123!" }

API Gateway → TCP → Auth Service
    │
    ├─ AuthCredential.findOne({ email })
    ├─ bcrypt.compare(password, credential.passwordHash)
    │   └─ Fail → 401 UnauthorizedException
    ├─ credential.isActive check
    │   └─ False → 401 "Account inactive"
    └─ jwtService.sign({
           sub: credential.id,
           email: credential.email,
           tenantId: credential.tenantId,
           role: credential.role
       })

Response: {
    accessToken: "eyJhbGc...",
    user: { id, email, tenantId, tenantName, role }
}
JWT Claims: { sub, email, tenantId, role }

═══════════════════════════════════════════════════════════════════════
                    PASSWORD RESET (OTP FLOW)
═══════════════════════════════════════════════════════════════════════

Step 1: POST /auth/forgot-password
Body: { email }
    │
    ├─ Find AuthCredential or SuperAdmin
    ├─ Generate 6-digit OTP: Math.floor(100000 + Math.random() * 900000)
    ├─ bcrypt.hash(otp, salt)
    ├─ Store hashedOtp + expiresAt (now + 10 min) in DB
    └─► Response: { message, email, demoOtpCode } (prod mein email bhejo)

Step 2: POST /auth/verify-otp
Body: { email, otp }
    │
    ├─ Find credential
    ├─ bcrypt.compare(otp, storedHashedOtp)
    ├─ new Date() > expiresAt → 400 "OTP expired"
    └─► Response: { message, email }

Step 3: POST /auth/reset-password
Body: { email, otp, newPassword, confirmPassword }
    │
    ├─ newPassword === confirmPassword check
    ├─ OTP re-verify (Step 2 repeat)
    ├─ bcrypt.compare(newPassword, currentHash) → same password check
    ├─ bcrypt.hash(newPassword, 10)
    ├─ passwordHistory.push(newHash)
    ├─ Update: passwordHash, clear resetOtp/resetOtpExpiresAt
    └─► Response: { message, email }
```

### Authorization Guard Pipeline

```
HTTP Request with Bearer JWT
        │
        ▼
┌───────────────────────────────────────────────────────────────────┐
│                    GUARD CHAIN                                    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  1. TenantResolverMiddleware (runs BEFORE guards)           │ │
│  │     ├─ x-request-id assign/propagate                        │ │
│  │     ├─ tenantId resolve: JWT → header → subdomain           │ │
│  │     ├─ Security: JWT tenantId ≠ header → 403 ACCESS_DENIED  │ │
│  │     ├─ TenantRequestContextService.setConnectionOptions()   │ │
│  │     └─ AsyncLocalStorage.run(tenantContext, next)           │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                        ▼                                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  2. JwtAuthGuard (not yet wired in gateway)                │ │
│  │     Validates JWT signature + expiry                        │ │
│  │     Sets request.user = { sub, email, tenantId, role }      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                        ▼                                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  3. TenantGuard                                             │ │
│  │     BYPASS: @Public() || @PlatformRoute() || @TenantOptional│ │
│  │     Requires: tenantId present                              │ │
│  │     Rejects: SUSPENDED → 400, EXPIRED → 400                │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                        ▼                                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  4. RolesGuard                                              │ │
│  │     Checks: @Roles('admin', 'manager') metadata             │ │
│  │     Bypass: userRoles includes 'admin' || 'superadmin'      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                        ▼                                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  5. PermissionsGuard                                        │ │
│  │     Checks: @RequirePermissions('users:read') metadata      │ │
│  │     Bypass: roles includes 'admin' || 'superadmin'          │ │
│  │     Format: 'resource:action' (e.g., 'payroll:write')       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                        ▼                                          │
│              Controller Handler Execute                           │
└───────────────────────────────────────────────────────────────────┘

Route Decorators:
  @Public()          → All guards bypass (no auth needed)
  @PlatformRoute()   → TenantGuard bypass (SuperAdmin routes)
  @TenantOptional()  → Tenant not required but accepted
  @Roles('admin')    → RolesGuard requirement
  @RequirePermissions('users:read') → PermissionsGuard requirement
```

### Permission Model

```
resource:action format (per-tenant in role_permissions table):

Resource     Actions
─────────    ─────────────────
users        read, write
roles        read, write
attendance   read, write
payroll      read, write
reports      read

Examples:
  'users:read'    → User list dekh sakta hai
  'users:write'   → User create/update/delete kar sakta hai
  'payroll:read'  → Payroll records dekh sakta hai
  'payroll:write' → Payroll process kar sakta hai

Admin aur Superadmin role ka koi permission check nahi hota — bypass hota hai.
```

---

## 7. Dynamic Policy Engine

### Policy Types aur Unke Schemas

```
PolicyType   Required Fields                Optional Fields
──────────   ──────────────────────────     ──────────────────────────────────
LEAVE        annualAllocation (int ≥ 0)     isPaid, carryForward,
                                            maximumCarryForward,
                                            requiresApproval, noticePeriodDays

ATTENDANCE   trackingMode (enum)            gracePeriodMinutes,
             (WEB_CLOCK_IN|BIOMETRIC|       lateThresholdMinutes,
              GEOFENCE|MANUAL|QR_CODE)      earlyDepartureThresholdMinutes,
                                            allowOvertime, requireBiometric,
                                            enforceGeofence

WORKING_     startTime (HH:MM)             breakDurationMinutes,
HOURS        endTime (HH:MM)               timezone, isFlexible
             workingDays (array of
             MONDAY..SUNDAY)

OVERTIME     enabled (boolean)             minimumMinutes,
                                            maximumHoursPerDay,
                                            maximumHoursPerWeek,
                                            multiplier, requiresApproval,
                                            autoApprove

REMOTE_WORK  (koi required nahi)           allowedDaysPerWeek (≤ 7),
                                            requiresApproval, eligibleAfterDays,
                                            allowedRoles[]

PAYROLL      payFrequency                  currency (3-char ISO),
             (MONTHLY|BIWEEKLY|WEEKLY)     taxRegion, overtimeMultiplier

GENERAL      Any JSON < 32KB,             (flexible)
             no __proto__/eval/constructor
```

### Policy Lifecycle State Machine

```
                    POLICY STATUS TRANSITIONS

  [createPolicy()] → Status: DRAFT
                              │
                              │ activatePolicy()
                              │ ┌─────────────────────────────────────┐
                              │ │ Exclusivity check (atomic):         │
                              │ │ ATTENDANCE, OVERTIME, REMOTE_WORK,  │
                              │ │ PAYROLL → existing ACTIVE policies  │
                              │ │ auto-deactivate (DB Transaction)    │
                              │ └─────────────────────────────────────┘
                              ▼
                           ACTIVE ──────── deactivatePolicy() ──► INACTIVE
                              │                                        │
                              │ archivePolicy()          archivePolicy()│
                              │                                        │
                              └────────────────►  ARCHIVED ◄───────────┘
                                                  (immutable)
                              │
                              │ archivePolicy() (from DRAFT too)
                              ▼
                           ARCHIVED

  deletePolicy() → SIRF DRAFT policy delete ho sakti hai
  Baaki sab archive karo

  Allowed Transitions:
  DRAFT    → ACTIVE, ARCHIVED
  ACTIVE   → INACTIVE, ARCHIVED
  INACTIVE → ACTIVE, ARCHIVED
  ARCHIVED → (koi transition nahi — immutable)
```

### Policy Versioning

```
Existing Policy ko change karna ho to naya version banao:

POST /api/v1/organization/policies/:id/new-version
Body: { name, configuration, effectiveFrom? }
    │
    ▼
New Policy Record:
  version         = existing.version + 1
  previousVersionId = existing.id      ← linked chain
  status          = DRAFT
  configuration   = dto.configuration || existing.configuration

Chain dekhne ke liye:
GET /organization/policies/:id/versions
→ previousVersionId follow karta hai version 1 tak

Example chain:
  Policy v3 (DRAFT) → previousVersionId → Policy v2 (ACTIVE)
                                                ↓ previousVersionId
                                          Policy v1 (ARCHIVED)
```

### Policy Exclusivity Rules

```
Exclusive Types (sirf EK active ek waqt mein):
  ✦ ATTENDANCE
  ✦ OVERTIME
  ✦ REMOTE_WORK
  ✦ PAYROLL

Non-Exclusive (multiple active allowed):
  ✦ LEAVE        → Multiple leave types (annual, sick, casual)
  ✦ WORKING_HOURS → Multiple shifts
  ✦ GENERAL      → Flexible

Jab exclusive policy activate hoti hai:
  BEGIN TRANSACTION;
    UPDATE organization_policies
      SET status = 'INACTIVE'
      WHERE tenantId = X AND policyType = Y
        AND status = 'ACTIVE' AND id != policyId;
    UPDATE organization_policies
      SET status = 'ACTIVE', activatedAt = NOW()
      WHERE id = policyId;
  COMMIT;
```

### Policy API Flow Diagram

```
Client
  │
  │ GET /organization/policies?policyType=LEAVE&status=ACTIVE
  ▼
API Gateway (OrganizationPolicyController)
  │ tenantId from x-tenant-id header
  │ TCP: org_policy.get_all
  ▼
Tenant Service (OrganizationPolicyService.getPolicies)
  │
  ├─ tenantService.getTenantById(tenantId) → verify tenant exists
  ├─ Build where: { tenantId, policyType?, status?, source? }
  └─ policyModel.findAll({ where, order: [policyType ASC, version DESC] })
  │
  └─► Return: [{ id, policyType, name, status, version, configuration, ... }]
```

---

## 8. Multi-Tenant Isolation

### Request Isolation Pipeline

```
Incoming HTTP Request
        │
        ▼
TenantResolverMiddleware
        │
        ├─── x-request-id assign karo (ya generate UUID)
        │    res.setHeader('x-request-id', requestId)
        │
        ├─── tenantId resolve karo (Priority Order):
        │
        │    Priority 1 ←── JWT token: req.user?.tenantId
        │    (authenticated requests ke liye primary source)
        │
        │    Security Check:
        │    if (JWT.tenantId && header.tenantId && JWT.tenantId !== header.tenantId)
        │    → throw TENANT_ACCESS_DENIED (403)
        │    (Cross-tenant hijacking prevent karta hai)
        │
        │    Priority 2 ←── x-tenant-id header
        │    (unauthenticated setup calls ke liye)
        │
        │    Priority 3 ←── Subdomain extraction
        │    host = "acme.hrms.local" → tenantId = "acme"
        │
        ├─── TenantRequestContextService.setConnectionOptions({
        │      tenantId,
        │      databaseName: `hrms_${tenantId.replace(/-/g, '_')}`,
        │      host, port, username, password
        │    })
        │
        └─── AsyncLocalStorage.run(tenantContext, () => next())
             (Saari async operations is context mein run hongi)
        │
        ▼
TenantConnectionManager.getConnection(tenantId)
        │
        ├─── Cache HIT: tenantConnections.get(tenantId) → return
        │
        ├─── Pending check: pendingConnections.get(tenantId) → wait
        │    (Race condition prevent karta hai)
        │
        └─── Cache MISS:
             new Sequelize({
               host, port, username, password,
               database: 'hrms_<tenantId_underscores>',
               pool: { max: 5, min: 1, idle: 10000, acquire: 30000 }
             })
             → authenticate()
             → tenantConnections.set(tenantId, connection)
        │
        ▼
TenantModelProviderService (REQUEST-scoped)
        │
        ├─── connection.addModels([User, Role, Permission, UserRole, RolePermission])
        │
        └─── Typed model getters:
             getUserModel()       → connection.models.User
             getRoleModel()       → connection.models.Role
             getPermissionModel() → connection.models.Permission
        │
        ▼
Business Logic (UserService, RoleService)
        └─── All queries automatically scope hoti hain tenant DB mein
```

### Connection Pool Architecture

```
TenantConnectionManager (Singleton)
│
├── tenantConnections: Map<string, Sequelize>
│   ├── "tenant-uuid-1" → Sequelize({ database: 'hrms_tenant_uuid_1' })
│   ├── "tenant-uuid-2" → Sequelize({ database: 'hrms_tenant_uuid_2' })
│   └── "tenant-uuid-N" → Sequelize({ database: 'hrms_tenant_uuid_N' })
│
├── pendingConnections: Map<string, Promise<Sequelize>>
│   (Race condition prevention)
│
└── onModuleDestroy() → closeAllConnections() (graceful shutdown)

Pool config per tenant:
  max: 5 connections
  min: 1 connection
  idle: 10000ms
  acquire: 30000ms timeout

Platform DB pool:
  max: 10 connections
  min: 2 connections
```

---

## 9. Shared Libraries

### libs/common — Shared Across All Services

```
libs/common/src/
│
├── dto/
│   ├── auth.dto.ts
│   │   RegisterTenantDto, LoginDto, SuperAdminLoginDto,
│   │   OnboardOrganizationDto, ForgotPasswordDto,
│   │   VerifyOtpDto, ResetPasswordDto
│   │
│   ├── organization.dto.ts
│   │   CreateOrganizationDto
│   │
│   ├── invitation.dto.ts
│   │   CreateAdminInvitationDto, ActivateAdminDto
│   │
│   ├── setup.dto.ts
│   │   UpdateOrganizationProfileDto, CreateDepartmentDto,
│   │   UpdateDepartmentDto, CreateDesignationDto,
│   │   UpdateDesignationDto, UpdateWorkingHoursDto,
│   │   CreateLeavePolicyDto, UpdateLeavePolicyDto,
│   │   UpdateAttendancePolicyDto
│   │
│   └── policy.dto.ts
│       CreateOrganizationPolicyDto, UpdateOrganizationPolicyDto,
│       ActivatePolicyDto, CreateNewPolicyVersionDto,
│       GetPoliciesQueryDto
│       Enums: PolicyType, PolicyStatus, PolicySource
│
├── exceptions/
│   └── tenant.exception.ts
│       TenantException(code, message, httpStatus)
│       TenantErrorCode: TENANT_REQUIRED | TENANT_NOT_FOUND |
│                        TENANT_ACCESS_DENIED | TENANT_SUSPENDED |
│                        TENANT_EXPIRED | INVALID_TENANT_CONTEXT
│
├── decorators/
│   └── metadata.decorators.ts
│       @Public()          → IS_PUBLIC_KEY = true
│       @PlatformRoute()   → IS_PLATFORM_ROUTE_KEY = true
│       @TenantOptional()  → IS_TENANT_OPTIONAL_KEY = true
│
├── utils/
│   └── crypto.utils.ts
│       CryptoUtils.encrypt(text)   → AES-256-GCM
│       CryptoUtils.decrypt(cipher) → AES-256-GCM
│       Format: "iv_hex:authTag_hex:cipher_hex"
│       Key: SHA-256(ENCRYPTION_KEY env)
│
└── index.ts
    SERVICES: {
      AUTH_SERVICE, TENANT_SERVICE, USER_SERVICE,
      ORGANIZATION_SERVICE, ATTENDANCE_LEAVE_SERVICE,
      PAYROLL_SERVICE, PERFORMANCE_WORK_SERVICE,
      RECRUITMENT_SERVICE, LMS_SERVICE
    }
    MESSAGE_PATTERNS: {
      HEALTH: { CHECK },
      AUTH: { REGISTER_TENANT, LOGIN, SUPERADMIN_LOGIN,
              ONBOARD_ORGANIZATION, FORGOT_PASSWORD,
              VERIFY_OTP, RESET_PASSWORD, CREATE_ADMIN_CREDENTIAL },
      TENANT: { GET_TENANT, CREATE_TENANT, PROVISION_TENANT, RETRY_PROVISION },
      INVITATION: { CREATE, RESEND, VALIDATE, ACTIVATE },
      USER: { GET_USER, CREATE_USER, CREATE_ORGANIZATION_ADMIN },
      ORGANIZATION: { CREATE_ORGANIZATION, GET_EMPLOYEES },
      ORGANIZATION_SETUP: { GET_PROGRESS, UPDATE_PROFILE,
                            GET/CREATE/UPDATE/DELETE_DEPARTMENT,
                            GET/CREATE/UPDATE/DELETE_DESIGNATION,
                            GET/UPDATE_WORKING_HOURS,
                            GET/CREATE/UPDATE/DELETE_LEAVE_POLICY,
                            GET/UPDATE_ATTENDANCE_POLICY, COMPLETE_SETUP },
      ORGANIZATION_POLICY: { CREATE, GET_ALL, GET_ONE, UPDATE, DELETE,
                             ACTIVATE, DEACTIVATE, ARCHIVE, GET_ACTIVE,
                             GET_VERSIONS, CREATE_VERSION },
      PERFORMANCE_WORK: { CREATE_PROJECT, LINK_OUTPUT }
    }
```

### libs/database — Database Infrastructure

```
DatabaseModule.forRoot({ isPlatform: boolean })
    ↓
getDatabaseConfig(isPlatform):
    if isPlatform:
      host: PLATFORM_DB_HOST (default: localhost)
      port: PLATFORM_DB_PORT (default: 5432)
      username: PLATFORM_DB_USER
      password: PLATFORM_DB_PASSWORD
      database: PLATFORM_DB_NAME (default: hrms_platform)
      pool: { max: 10, min: 2 }
    else:
      (tenant template config — mostly unused directly)

Dev mode: synchronize: true, logging: console.log
Prod mode: synchronize: false, logging: false
```

### libs/tenant-context — Multi-Tenant Infrastructure

```
TenantContextService
  → AsyncLocalStorage<TenantContext> wrapper
  → run(context, callback): T → safe context boundary
  → setContext(), getContext(), getTenantId(), clearContext()

TenantRequestContextService (REQUEST-scoped)
  → Per-request state storage
  → setTenantId(), setConnectionOptions()
  → getConnectionOptions() → TenantConnectionOptions

TenantConnectionManager (Singleton)
  → In-memory Sequelize pool cache
  → getConnection(options) → creates or returns cached Sequelize
  → closeConnection(tenantId) → graceful close
  → onModuleDestroy() → closeAllConnections()

TenantResolverMiddleware
  → tenantId resolution + security check
  → AsyncLocalStorage context setup

Guards:
  TenantGuard    → Tenant required enforcement
  RolesGuard     → @Roles() decorator check
  PermissionsGuard → @RequirePermissions() check

Decorators:
  @CurrentTenant(field?) → AsyncLocalStorage se tenant context
  @CurrentUser(field?)   → request.user se
  @Roles(...roles)       → ROLES_KEY metadata
  @RequirePermissions(...perms) → PERMISSIONS_KEY metadata
```

---

## 10. API Endpoints Reference

### Base URL: `http://localhost:3000/api/v1`
### Swagger UI: `http://localhost:3000/api/docs`

```
════════════════════════════════════════════════════════════════════════
AUTH ENDPOINTS
════════════════════════════════════════════════════════════════════════
POST   /auth/register-tenant     PUBLIC    Org register (auth service)
POST   /auth/login               PUBLIC    Org user login → JWT
POST   /auth/forgot-password     PUBLIC    OTP request
POST   /auth/verify-otp          PUBLIC    OTP verify
POST   /auth/reset-password      PUBLIC    Password reset

════════════════════════════════════════════════════════════════════════
SUPERADMIN ENDPOINTS    (PlatformRoute → no tenant required)
════════════════════════════════════════════════════════════════════════
POST   /superadmin/login                     PUBLIC    SuperAdmin login
POST   /superadmin/organizations/onboard     PUBLIC    Quick onboard
POST   /superadmin/organizations             BEARER    Create org + provision DB
POST   /superadmin/organizations/:id/provision/retry  BEARER  Retry provisioning
POST   /superadmin/organizations/:id/invitation       BEARER  Create invitation
POST   /superadmin/organizations/:id/invitation/resend BEARER Resend invitation

════════════════════════════════════════════════════════════════════════
ORGANIZATION ADMIN ACTIVATION
════════════════════════════════════════════════════════════════════════
GET    /organization-admin/validate?token=   PUBLIC    Token validate
POST   /organization-admin/activate          PUBLIC    Account activate

════════════════════════════════════════════════════════════════════════
ORGANIZATION SETUP WIZARD    (Bearer + x-tenant-id required)
════════════════════════════════════════════════════════════════════════
GET    /organization/setup/progress          Setup % check
PUT    /organization/setup/profile           Profile update
POST   /organization/setup/complete          Setup complete → ACTIVE

GET    /organization/departments             List departments
POST   /organization/departments             Create department
PATCH  /organization/departments/:id         Update department
DELETE /organization/departments/:id         Delete department

GET    /organization/designations            List designations
POST   /organization/designations            Create designation
PATCH  /organization/designations/:id        Update designation
DELETE /organization/designations/:id        Delete designation

GET    /organization/working-hours           Get working hours
PUT    /organization/working-hours           Update working hours

GET    /organization/leave-policy            List leave policies
POST   /organization/leave-policy            Create leave policy
PATCH  /organization/leave-policy/:id        Update leave policy
DELETE /organization/leave-policy/:id        Delete leave policy

GET    /organization/attendance-policy       Get attendance policy
PUT    /organization/attendance-policy       Update attendance policy

════════════════════════════════════════════════════════════════════════
DYNAMIC POLICY ENGINE    (Bearer + x-tenant-id required)
════════════════════════════════════════════════════════════════════════
GET    /organization/policies                   List all (filterable)
POST   /organization/policies                   Create (DRAFT)
GET    /organization/policies/active/:type      Get active policy by type
GET    /organization/policies/:id               Get policy by ID
PATCH  /organization/policies/:id               Update (DRAFT/INACTIVE only)
DELETE /organization/policies/:id               Delete (DRAFT only)
POST   /organization/policies/:id/activate      DRAFT/INACTIVE → ACTIVE
POST   /organization/policies/:id/deactivate    ACTIVE → INACTIVE
POST   /organization/policies/:id/archive       Any → ARCHIVED
GET    /organization/policies/:id/versions      Version chain
POST   /organization/policies/:id/new-version   Create next version

════════════════════════════════════════════════════════════════════════
ORGANIZATION MODULES    (Bearer + x-tenant-id required)  [STUBS]
════════════════════════════════════════════════════════════════════════
GET    /org/dashboard             Dashboard stats
GET    /org/geofence/locations    Geofence boundaries
POST   /org/pos/transactions      POS transaction record
GET    /org/announcements         Notice board
GET    /org/surveys               Employee surveys
GET    /org/web3/nft-rewards      NFT badges
GET    /org/community/posts       HR community
GET    /org/penalties             Communication penalties
GET    /org/assets                Asset management
GET    /org/expenses              Expense claims
GET    /org/tickets               Helpdesk tickets
GET    /org/audit-logs            Audit trail

════════════════════════════════════════════════════════════════════════
HEALTH
════════════════════════════════════════════════════════════════════════
GET    /health                    All services health check
```

---

## 11. Security Architecture

### Security Layers Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SECURITY ARCHITECTURE                            │
│                                                                     │
│  Layer 1: Password Security                                         │
│  ─────────────────────────                                          │
│  • bcrypt(password, saltRounds: 10)                                │
│  • passwordHistory[] → previous passwords stored                   │
│  • Reset rejected if new === any previous                           │
│                                                                     │
│  Layer 2: OTP Security                                              │
│  ────────────────────                                               │
│  • 6-digit: Math.floor(100000 + Math.random() * 900000)            │
│  • bcrypt.hash(otp, salt) → DB mein store                          │
│  • Expiry: 10 minutes                                               │
│  • Verification: bcrypt.compare + expiry check                     │
│                                                                     │
│  Layer 3: JWT Security                                              │
│  ──────────────────────                                             │
│  • Algorithm: HS256                                                 │
│  • Secret: JWT_SECRET env variable                                  │
│  • Expiry: 24 hours (JWT_EXPIRY env)                                │
│  • Claims: sub, email, tenantId?, role, isSuperAdmin?              │
│  • Cross-tenant check: JWT.tenantId ≠ header → 403                 │
│                                                                     │
│  Layer 4: DB Password Encryption                                    │
│  ─────────────────────────────────                                  │
│  • Algorithm: AES-256-GCM (authenticated encryption)               │
│  • Key: SHA-256(ENCRYPTION_KEY env)                                 │
│  • Format: "iv_hex:authTag_hex:ciphertext_hex"                     │
│  • Sequelize getter/setter auto-decrypt/encrypt                     │
│  • TenantDatabaseConfig.toJSON() strips password field             │
│                                                                     │
│  Layer 5: Invitation Token Security                                 │
│  ──────────────────────────────────                                 │
│  • Raw token: crypto.randomBytes(32).toString('hex')               │
│  • SHA-256(rawToken) → tokenHash → sirf yahi DB mein              │
│  • rawToken sirf ek baar response mein milta hai                   │
│  • OrganizationAdminInvitation.toJSON() strips tokenHash           │
│                                                                     │
│  Layer 6: Tenant Isolation                                          │
│  ─────────────────────────                                          │
│  • AsyncLocalStorage → no context leakage between requests         │
│  • Separate PostgreSQL database per tenant                         │
│  • Cross-tenant header spoofing → 403 ACCESS_DENIED               │
│  • TenantDatabaseConfig → encrypted credentials per tenant         │
└─────────────────────────────────────────────────────────────────────┘
```

### Security Headers & Tokens

```
Request Headers:
  Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  x-tenant-id: c4b12f6a-04b3-4f8a-9892-9653d9e21183
  x-request-id: (auto-generated ya client provided)

Response Headers:
  x-request-id: (correlated request ID for tracing)

Default SuperAdmin (auto-seeded on first boot):
  Email: superadmin@system.com
  Password: SuperAdmin123!
  ⚠️  Production mein zaroor change karo!
```

---

## 12. Future Modules

### Jo Banana Baaki Hai — Planned Services

```
┌─────────────────────────────────────────────────────────────────────┐
│                    FUTURE SERVICES ROADMAP                          │
│                                                                     │
│  Service                Port  Models Defined?  Status              │
│  ─────────────────────  ────  ───────────────  ──────────          │
│  Attendance & Leave      3004  ✅ Yes           Planned            │
│  Payroll Service         3005  ✅ Yes           Planned            │
│  Performance & Work      3006  ✅ Yes           Planned (Priority) │
│  Recruitment Service     3007  ✅ Yes           Planned            │
│  LMS Service             3008  ✅ Yes           Planned            │
└─────────────────────────────────────────────────────────────────────┘
```

### Future Domain Models (Already Defined)

```
Employee Domain:
  EmployeeProfile → { userId, departmentId, designationId, managerId,
                      employeeCode, joiningDate, employmentStatus }
                    (Self-referencing manager hierarchy)

Attendance & Leave:
  Attendance    → { employeeId, date, checkInTime, checkOutTime, status }
  LeaveRequest  → { employeeId, leaveType, startDate, endDate, status }

Payroll:
  SalaryStructure → { employeeId, baseSalary, allowances:JSONB, deductions:JSONB }
  PayrollRecord   → { employeeId, payPeriod, netPay, status }

Performance & Work (Core Differentiator):
  Project         → { tenantId, name, status }
  Task            → { projectId, assigneeId, title, status }
  EmployeeOutput  → { employeeId, taskId, goalId, outputSummary, qualityScore }
  Goal            → { employeeId, title, targetMetric, status }
  PerformanceReview → { employeeId, reviewerId, reviewPeriod,
                        selfAssessment:JSONB, managerAssessment:JSONB }

  Work Chain:
  Project → Task → EmployeeOutput → Goal → PerformanceReview
  (Factual output-backed performance reviews)

Recruitment (Cross-Tenant Candidate Profiles):
  CandidateProfile → { firstName, lastName, email (unique), cvUrl, skills[] }
                     (NO tenantId — reusable across organizations)
  JobPosting       → { tenantId, title, description, status }
  JobApplication   → { tenantId, jobPostingId, candidateId, stage }

LMS:
  Course          → { tenantId, title, description }
  CourseEnrollment → { courseId, employeeId, progressPercentage, status }

Other Features:
  GeofenceLocation   → Attendance boundary coordinates
  POSTransaction     → Point of sale transactions
  Announcement       → Notice board
  Survey             → Employee feedback
  HRCommunityPost    → Internal social posts
  NFTReward          → Web3 achievement badges
  CommunicationPenalty → Penalty tracking
  Asset              → Asset assignment management
  ExpenseClaim       → Expense reimbursement
  Ticket             → Helpdesk tickets
  AuditLog           → System activity trail
```

### Naya Service Add Karne Ka Process

```
Step 1: MESSAGE_PATTERNS add karo (libs/common/src/index.ts)
  ATTENDANCE: {
    CHECK_IN: 'attendance.check_in',
    CHECK_OUT: 'attendance.check_out',
  }

Step 2: SERVICES token add karo
  ATTENDANCE_LEAVE_SERVICE: 'ATTENDANCE_LEAVE_SERVICE'

Step 3: DTOs banao (libs/common/src/dto/attendance.dto.ts)

Step 4: API Gateway mein TCP client register karo
  ClientsModule.registerAsync → { host, port: 3004 }

Step 5: API Gateway controller banao
  @Inject(SERVICES.ATTENDANCE_LEAVE_SERVICE) private client: ClientProxy
  @Post('check-in') → client.send(MESSAGE_PATTERNS.ATTENDANCE.CHECK_IN, ...)

Step 6: New service app banao (apps/attendance-service/)
  Module → TenantContextModule + TenantResolverMiddleware
  Main   → NestFactory.createMicroservice TCP port 3004
  Controller → @MessagePattern handlers
  Service    → TenantModelProviderService se tenant DB access

Step 7: TenantModelProviderService extend karo
  getAttendanceModel() → connection.models.Attendance
```

---

## 13. Local Development Setup

### Prerequisites

```
Required Software:
  ✓ Node.js 20+
  ✓ PostgreSQL 15+
  ✓ npm or yarn
```

### Setup Steps

```bash
# 1. Repository clone karo
git clone <repo-url>
cd HRMS-Multi-Tenant

# 2. Dependencies install karo
npm install

# 3. Environment configure karo
cp .env.example .env.development

# 4. .env.development mein fill karo:
PLATFORM_DB_HOST=localhost
PLATFORM_DB_PORT=5432
PLATFORM_DB_NAME=hrms_platform
PLATFORM_DB_USER=postgres
PLATFORM_DB_PASSWORD=your_password

TENANT_DB_HOST=localhost
TENANT_DB_PORT=5432
TENANT_DB_USER=postgres
TENANT_DB_PASSWORD=your_password

JWT_SECRET=change-this-in-production-minimum-32-chars
JWT_EXPIRY=24h
ENCRYPTION_KEY=change-this-aes-key-in-production

NODE_ENV=development

AUTH_SERVICE_PORT=3001
TENANT_SERVICE_PORT=3002
USER_SERVICE_PORT=3003
API_GATEWAY_PORT=3000

# 5. Platform database create karo PostgreSQL mein
createdb hrms_platform

# 6. Har service ko alag terminal mein start karo

# Terminal 1: Auth Service
npm run start:auth-service
# Listening on TCP port 3001

# Terminal 2: Tenant Service
npm run start:tenant-service
# Listening on TCP port 3002

# Terminal 3: User Service
npm run start:user-service
# Listening on TCP port 3003

# Terminal 4: API Gateway
npm run start:api-gateway
# Listening on HTTP port 3000

# 7. Swagger UI
# http://localhost:3000/api/docs
# Swagger mein saari APIs explore karo

# First SuperAdmin credentials (auto-seeded):
# Email: superadmin@system.com
# Password: SuperAdmin123!
```

### Quick Test Flow

```bash
# Step 1: SuperAdmin login
curl -X POST http://localhost:3000/api/v1/superadmin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"superadmin@system.com","password":"SuperAdmin123!"}'

# Step 2: Organization create karo (token use karo)
curl -X POST http://localhost:3000/api/v1/superadmin/organizations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <superadmin_jwt>" \
  -d '{"organizationName":"Acme Corp","adminEmail":"admin@acme.com"}'

# Step 3: Invitation create karo
curl -X POST http://localhost:3000/api/v1/superadmin/organizations/<tenantId>/invitation \
  -H "Authorization: Bearer <superadmin_jwt>" \
  -d '{}'

# Step 4: Account activate karo (rawToken use karo)
curl -X POST http://localhost:3000/api/v1/organization-admin/activate \
  -H "Content-Type: application/json" \
  -d '{"token":"<rawToken>","password":"Admin123!","confirmPassword":"Admin123!"}'

# Step 5: Org login karo
curl -X POST http://localhost:3000/api/v1/auth/login \
  -d '{"email":"admin@acme.com","password":"Admin123!"}'

# Step 6: Setup progress dekho
curl -X GET http://localhost:3000/api/v1/organization/setup/progress \
  -H "Authorization: Bearer <org_jwt>" \
  -H "x-tenant-id: <tenantId>"
```

---

## 14. Error Codes Reference

### TenantException Error Codes

```
┌─────────────────────────────────────────────────────────────────────┐
│  Error Code              HTTP  Description                          │
│  ──────────────────────  ────  ─────────────────────────────────   │
│  TENANT_REQUIRED         400   Request mein tenant context nahi    │
│  TENANT_NOT_FOUND        400   TenantId DB mein nahi mila          │
│  TENANT_ACCESS_DENIED    400   JWT ≠ header tenantId (security)    │
│  TENANT_SUSPENDED        400   Organization suspend hai            │
│  TENANT_EXPIRED          400   Subscription expire ho gayi         │
│  INVALID_TENANT_CONTEXT  400   General validation failure          │
└─────────────────────────────────────────────────────────────────────┘

Error Response Shape:
{
  "statusCode": 400,
  "errorCode": "TENANT_NOT_FOUND",
  "message": "Tenant 'xyz-uuid' not found.",
  "timestamp": "2026-08-31T10:30:00.000Z"
}
```

### Auth Errors

```
UnauthorizedException (401):
  "Invalid email or password."
  "Account is inactive. Please contact your organization administrator."
  "Invalid SuperAdmin credentials."

BadRequestException (400):
  "Admin user email already registered."
  "New password must be different from previous used passwords."
  "Password and confirm password do not match."
  "No active OTP request found"
  "OTP code has expired. Please request a new one."
  "Invalid OTP verification code."
```

### Policy Engine Errors

```
INVALID_TENANT_CONTEXT (400):
  "Policy 'uuid' not found."
  "Invalid policy configuration: <validator errors>"
  "Cannot activate policy: invalid transition from 'ARCHIVED' to 'ACTIVE'."
  "Archived policies cannot be modified."
  "Active policies cannot be directly updated. Deactivate first or create a new version."
  "Only DRAFT policies can be deleted. Current status: ACTIVE. Use 'archive' instead."
```

---

## Summary — Ek Nazar Mein Kya Bana

```
╔═══════════════════════════════════════════════════════════════════════╗
║                PROJECT COMPLETION STATUS                             ║
╠═══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  INFRASTRUCTURE (100% ✅)                                           ║
║  ├─ NestJS Monorepo setup                                           ║
║  ├─ TCP microservice communication                                  ║
║  ├─ Multi-tenant DB isolation (AsyncLocalStorage)                   ║
║  ├─ Dynamic connection pool (TenantConnectionManager)               ║
║  ├─ Shared libs (common, database, tenant-context)                  ║
║  └─ Swagger/OpenAPI documentation                                   ║
║                                                                      ║
║  AUTHENTICATION (100% ✅)                                           ║
║  ├─ SuperAdmin login (bcrypt + JWT)                                 ║
║  ├─ Organization user login (bcrypt + JWT)                          ║
║  ├─ Password reset with OTP (bcrypt-hashed OTP, 10min)             ║
║  ├─ Password history tracking                                        ║
║  └─ Admin credential create/update (on activation)                  ║
║                                                                      ║
║  ORGANIZATION LIFECYCLE (100% ✅)                                   ║
║  ├─ Database provisioning (idempotent CREATE DATABASE)              ║
║  ├─ Admin invitation (SHA-256 token, 7-day expiry)                  ║
║  ├─ Account activation (cross-service TCP calls)                    ║
║  ├─ 6-module setup wizard                                           ║
║  └─ Lifecycle transitions (DRAFT→ACTIVE)                            ║
║                                                                      ║
║  POLICY ENGINE (100% ✅)                                            ║
║  ├─ 7 policy types with validators                                  ║
║  ├─ Full lifecycle (DRAFT→ACTIVE→INACTIVE→ARCHIVED)                ║
║  ├─ Exclusivity enforcement (DB transaction)                        ║
║  ├─ Version chaining (previousVersionId linked list)                ║
║  └─ Effective date range queries                                     ║
║                                                                      ║
║  RBAC (100% ✅)                                                     ║
║  ├─ Per-tenant users, roles, permissions                            ║
║  ├─ Many-to-many: users↔roles, roles↔permissions                   ║
║  ├─ System roles protection                                         ║
║  └─ resource:action permission format                               ║
║                                                                      ║
║  PLANNED (0% 🔜)                                                    ║
║  ├─ Attendance & Leave Service (3004)                               ║
║  ├─ Payroll Service (3005)                                          ║
║  ├─ Performance & Work Service (3006)                               ║
║  ├─ Recruitment Service (3007)                                      ║
║  └─ LMS Service (3008)                                              ║
║                                                                      ║
╚═══════════════════════════════════════════════════════════════════════╝
```

---

*Document generated from live codebase — August 2026*  
*File: docs/PROJECT_COMPLETE_DOCUMENTATION.md*
