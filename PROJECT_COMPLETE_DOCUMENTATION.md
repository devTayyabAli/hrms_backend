# HRMS Multi-Tenant Platform — Complete Project Documentation

> **Version**: 1.0.0 | **Stack**: NestJS 11 · TypeScript · Sequelize ORM · PostgreSQL · TCP Microservices  
> **Pattern**: NestJS Monorepo | **Auth**: JWT + bcrypt | **API Docs**: Swagger/OpenAPI  
> **Last Updated**: August 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Technology Stack](#2-technology-stack)
3. [Project Folder Structure](#3-project-folder-structure)
4. [Architecture Overview](#4-architecture-overview)
5. [Environment Configuration](#5-environment-configuration)
6. [Microservices Deep Dive](#6-microservices-deep-dive)
   - 6.1 [API Gateway](#61-api-gateway-port-3000)
   - 6.2 [Auth Service](#62-auth-service-port-3001)
   - 6.3 [Tenant Service](#63-tenant-service-port-3002)
   - 6.4 [User Service](#64-user-service-port-3003)
7. [Shared Libraries](#7-shared-libraries)
   - 7.1 [@app/common](#71-appcommon)
   - 7.2 [@app/database](#72-appdatabase)
   - 7.3 [@app/tenant-context](#73-apptenant-context)
8. [Database Architecture](#8-database-architecture)
9. [Data Models Reference](#9-data-models-reference)
10. [API Endpoints Reference](#10-api-endpoints-reference)
11. [Application Flow — End to End](#11-application-flow--end-to-end)
12. [RBAC — Roles, Guards & Permissions](#12-rbac--roles-guards--permissions)
13. [Tenant Isolation Strategy](#13-tenant-isolation-strategy)
14. [Build, Run & Scripts](#14-build-run--scripts)
15. [Future Services & Planned Models](#15-future-services--planned-models)

---

## 1. Executive Summary

The **HRMS Multi-Tenant Platform** is a production-grade Human Resource Management System built as a NestJS Monorepo of independent microservices. Each organization (tenant) gets its own isolated PostgreSQL database, provisioned automatically on registration. Communication between services uses NestJS TCP transport with typed message patterns. The API Gateway is the single HTTP entry point, proxying requests to downstream services.

### Core Design Pillars

- **Strict Multi-Tenancy**: Every request carries an `x-tenant-id` header. Middleware resolves this to a dedicated database connection. No data leaks between tenants.
- **Database-per-Tenant Isolation**: On onboarding, a new PostgreSQL database (`hrms_<tenant_id>`) is created, schema-synced, and its credentials stored in the platform database.
- **Dynamic Connection Pooling**: `TenantConnectionManager` caches live Sequelize instances in memory (`Map<tenantId, Sequelize>`). No reconnection overhead per request.
- **RBAC with Guards**: Three layered guards — `TenantGuard` → `RolesGuard` → `PermissionsGuard` — protect every tenant-scoped endpoint.
- **Extensible Microservice Registry**: 8 services are planned (4 implemented, 4 future). All share the common library for service tokens and message patterns.

---

## 2. Technology Stack

| Category | Technology | Version |
|---|---|---|
| Runtime | Node.js | Latest LTS |
| Framework | NestJS | ^11.0.1 |
| Language | TypeScript | ^5.7.3 |
| ORM | Sequelize + sequelize-typescript | ^6.37.8 / ^2.1.6 |
| Database | PostgreSQL | Any modern version |
| PG Driver | pg + pg-hstore | ^8.23.0 |
| Auth | @nestjs/jwt + passport-jwt | ^11.0.2 / ^4.0.1 |
| Password Hashing | bcrypt | ^6.0.0 |
| Validation | class-validator + class-transformer | ^0.15.1 / ^0.5.1 |
| API Documentation | @nestjs/swagger | ^11.4.6 |
| Transport | @nestjs/microservices (TCP) | ^11.1.29 |
| Config | @nestjs/config | ^4.0.4 |
| Build Tool | @nestjs/cli | ^11.0.0 |
| Testing | Jest + ts-jest | ^30.0.0 / ^29.2.5 |
| Linting | ESLint + Prettier | ^9.18.0 / ^3.4.2 |

---

## 3. Project Folder Structure

```
HRMS-Multi-Tenant/
│
├── apps/                                      # Microservice Applications
│   ├── api-gateway/                           # HTTP entry point (Port 3000)
│   │   └── src/
│   │       ├── main.ts                        # Bootstrap: HTTP server, Swagger, ValidationPipe
│   │       ├── api-gateway.module.ts          # Root module, TCP client registration
│   │       └── controllers/
│   │           ├── auth.controller.ts         # POST /auth/* → auth-service TCP proxy
│   │           ├── superadmin.controller.ts   # POST /superadmin/* → auth-service TCP proxy
│   │           └── organization-modules.controller.ts  # GET|POST /org/* stub endpoints
│   │
│   ├── auth-service/                          # Auth TCP Microservice (Port 3001)
│   │   └── src/
│   │       ├── main.ts                        # Bootstrap: TCP microservice
│   │       ├── auth-service.module.ts         # Module: DB, JWT, models
│   │       ├── controllers/
│   │       │   └── auth.controller.ts         # @MessagePattern handlers
│   │       ├── dto/
│   │       │   └── auth.dto.ts                # Local DTOs (mirrors @app/common)
│   │       ├── models/
│   │       │   ├── auth-credential.model.ts   # Platform: auth_credentials table
│   │       │   ├── super-admin.model.ts       # Platform: super_admins table
│   │       │   └── index.ts
│   │       └── services/
│   │           ├── auth.service.ts            # Core auth logic, JWT signing, OTP
│   │           └── otp.service.ts             # OTP generation & verification
│   │
│   ├── tenant-service/                        # Tenant TCP Microservice (Port 3002)
│   │   └── src/
│   │       ├── main.ts                        # Bootstrap: TCP microservice
│   │       ├── tenant-service.module.ts       # Module: platform DB, models
│   │       ├── tenant-service.controller.ts   # HTTP REST controller (provision, CRUD)
│   │       ├── models/
│   │       │   ├── tenant.model.ts            # Platform: tenants table
│   │       │   ├── tenant-database-config.model.ts  # Platform: tenant_database_configs
│   │       │   ├── department.model.ts        # Platform: departments table
│   │       │   ├── designation.model.ts       # Platform: designations table
│   │       │   └── index.ts
│   │       └── services/
│   │           ├── tenant.service.ts          # CRUD for Tenant model
│   │           ├── tenant-database-config.service.ts  # CRUD for DB configs
│   │           └── tenant-provisioning.service.ts     # CREATE/DROP DATABASE + migrations
│   │
│   └── user-service/                          # User TCP Microservice (Port 3003)
│       └── src/
│           ├── main.ts                        # Bootstrap: TCP microservice
│           ├── user-service.module.ts         # Module: TenantContextModule only
│           ├── user-service.controller.ts     # HTTP REST controller (users, roles)
│           ├── models/
│           │   ├── user.model.ts              # Tenant DB: users table
│           │   ├── role.model.ts              # Tenant DB: roles table
│           │   ├── permission.model.ts        # Tenant DB: permissions table
│           │   ├── user-role.model.ts         # Tenant DB: user_roles junction
│           │   ├── role-permission.model.ts   # Tenant DB: role_permissions junction
│           │   └── index.ts
│           └── services/
│               ├── user.service.ts            # CRUD for User + role assignments
│               ├── role.service.ts            # CRUD for Role + permission assignments
│               └── tenant-model-provider.service.ts  # Dynamic tenant DB model resolver
│
├── libs/                                      # Shared Libraries
│   ├── common/                                # @app/common
│   │   └── src/
│   │       ├── index.ts                       # SERVICES, MESSAGE_PATTERNS, re-exports
│   │       ├── dto/
│   │       │   └── auth.dto.ts                # Shared DTOs (RegisterTenantDto, LoginDto, etc.)
│   │       ├── guards/index.ts                # (stub)
│   │       ├── interceptors/index.ts          # (stub)
│   │       ├── filters/index.ts               # (stub)
│   │       ├── exceptions/index.ts            # (stub)
│   │       ├── pipes/index.ts                 # (stub)
│   │       └── utils/index.ts                 # (stub)
│   │
│   ├── database/                              # @app/database
│   │   └── src/
│   │       ├── index.ts                       # Re-exports
│   │       ├── database.module.ts             # Dynamic DatabaseModule.forRoot()
│   │       ├── database.types.ts              # TypeScript interfaces for DB config
│   │       └── config/
│   │           └── database.config.ts         # getDatabaseConfig(isPlatform)
│   │
│   └── tenant-context/                        # @app/tenant-context
│       └── src/
│           ├── index.ts                       # Re-exports everything
│           ├── tenant-context.module.ts       # @Global() module
│           ├── context/
│           │   ├── tenant-context.service.ts         # AsyncLocalStorage wrapper
│           │   ├── tenant-request-context.service.ts # REQUEST-scoped per-request context
│           │   └── tenant-connection.manager.ts      # In-memory Sequelize pool cache
│           ├── middleware/
│           │   └── tenant-resolver.middleware.ts     # x-tenant-id → DB options
│           ├── guards/
│           │   ├── tenant.guard.ts            # Validates tenant header
│           │   ├── roles.guard.ts             # Checks @Roles() metadata
│           │   └── permissions.guard.ts       # Checks @RequirePermissions() metadata
│           └── decorators/
│               ├── current-tenant.decorator.ts  # @CurrentTenant()
│               ├── current-user.decorator.ts    # @CurrentUser()
│               ├── roles.decorator.ts           # @Roles()
│               └── permissions.decorator.ts     # @RequirePermissions()
│
├── docs/
│   ├── ORGANIZATION_FLOW.md                   # Detailed tenant lifecycle flow doc
│   └── schemas/
│       └── future-domain-models.ts            # All 30+ future Sequelize models
│
├── dist/                                      # Compiled output (gitignored)
├── .env.development                           # Dev environment variables
├── .env.production                            # Prod environment variables
├── .env.example                               # Env variable template
├── package.json                               # Monorepo root package.json
├── nest-cli.json                              # NestJS monorepo project config
├── tsconfig.json                              # Root TypeScript config + path aliases
├── eslint.config.mjs                          # ESLint flat config
├── .prettierrc                                # Prettier config
├── .gitignore
└── HRMS_MICROSERVICES_ARCHITECTURE.md         # Architecture reference document
```

---

## 4. Architecture Overview

```
                        ┌──────────────────────────────┐
                        │    Web App / Mobile Client   │
                        └──────────────┬───────────────┘
                                       │ HTTP REST
                                       │ Headers: Authorization: Bearer <JWT>
                                       │          x-tenant-id: tenant-acme
                                       ▼
                        ┌──────────────────────────────┐
                        │        API Gateway           │
                        │  Port: 3000                  │
                        │  Swagger: /api/docs          │
                        │  Global Prefix: /api/v1      │
                        │  ValidationPipe (whitelist)  │
                        └──────┬───────────────────────┘
                               │ TCP (NestJS ClientProxy)
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
   ┌─────────────────┐  ┌────────────┐  ┌─────────────┐
   │  Auth Service   │  │  Tenant    │  │    User     │
   │  Port: 3001     │  │  Service   │  │   Service   │
   │  TCP Listener   │  │  Port:3002 │  │  Port:3003  │
   └────────┬────────┘  └─────┬──────┘  └──────┬──────┘
            │                 │                │
            ▼                 ▼                ▼
   ┌─────────────────────────────────────────────────┐
   │               PostgreSQL Server                 │
   │                                                 │
   │  hrms_platform (Platform DB)                    │
   │   - super_admins                                │
   │   - auth_credentials                            │
   │   - tenants                                     │
   │   - tenant_database_configs                     │
   │   - departments, designations                   │
   │                                                 │
   │  hrms_tenant_acme (Tenant DB — per org)         │
   │   - users, roles, permissions                   │
   │   - user_roles, role_permissions                │
   │   - [future: employees, attendance, payroll...] │
   │                                                 │
   │  hrms_tenant_globex (another Tenant DB)         │
   │   - users, roles, permissions ...               │
   └─────────────────────────────────────────────────┘
```

### Inter-Service Communication

All backend microservices communicate with the API Gateway via **NestJS TCP transport**. The gateway registers `ClientProxy` instances for each service using `ClientsModule.registerAsync()`. Requests are sent as typed message patterns (strings like `auth.login`) with a payload DTO.

```
API Gateway --[TCP]--> Auth Service      (auth.*)
API Gateway --[TCP]--> Tenant Service    (tenant.*)  [planned]
API Gateway --[TCP]--> User Service      (user.*)    [planned]
```

> Currently only the Auth Service TCP client is wired in the API Gateway module. Tenant and User services have REST-style HTTP controllers but are bootstrapped as TCP microservices, anticipating future gateway proxy wiring.

---

## 5. Environment Configuration

Copy `.env.example` to `.env.development` or `.env.production` and fill in values.

```env
# ── Platform Database ─────────────────────────────
PLATFORM_DB_HOST=localhost
PLATFORM_DB_PORT=5432
PLATFORM_DB_NAME=hrms_platform
PLATFORM_DB_USER=postgres
PLATFORM_DB_PASSWORD=password
PLATFORM_DB_DIALECT=postgres

# ── Tenant Databases (shared credentials) ─────────
TENANT_DB_HOST=localhost
TENANT_DB_PORT=5432
TENANT_DB_USER=postgres
TENANT_DB_PASSWORD=password
TENANT_DB_DIALECT=postgres

# ── Service Ports ──────────────────────────────────
API_GATEWAY_PORT=3000
AUTH_SERVICE_PORT=3001
TENANT_SERVICE_PORT=3002
USER_SERVICE_PORT=3003

# ── Security ───────────────────────────────────────
JWT_SECRET=your-secret-key
JWT_EXPIRY=24h

# ── Environment ────────────────────────────────────
NODE_ENV=development
```

**Important notes**:
- `PLATFORM_DB_NAME` must be an existing database before starting services.
- `TENANT_DB_*` credentials are used by the provisioning service to connect to PostgreSQL and run `CREATE DATABASE`.
- `JWT_SECRET` must be identical across all services that validate tokens.
- In development (`NODE_ENV=development`), Sequelize logs SQL queries and `synchronize: true` auto-creates tables.

---

## 6. Microservices Deep Dive

### 6.1 API Gateway (Port 3000)

The only HTTP-facing service. It is not a microservice — it is a regular NestJS HTTP application.

**Bootstrap (`main.ts`)**:
- Creates HTTP server via `NestFactory.create()`
- Sets global URL prefix: `/api/v1`
- Registers global `ValidationPipe` with `whitelist: true`, `transform: true`, `forbidNonWhitelisted: true`
- Builds Swagger document with Bearer auth + `x-tenant-id` API key header
- Exposes Swagger UI at `/api/docs`
- Listens on `process.env.PORT || 3000`

**Module (`api-gateway.module.ts`)**:
- Imports `ConfigModule` (global)
- Registers `ClientsModule.registerAsync` for `AUTH_SERVICE` with TCP transport to `AUTH_SERVICE_HOST:AUTH_SERVICE_PORT`
- Declares 3 controllers

**Controllers**:

| Controller | Route Prefix | Backend |
|---|---|---|
| `ApiGatewayAuthController` | `/auth` | Auth Service (TCP) |
| `SuperAdminController` | `/superadmin` | Auth Service (TCP) |
| `OrganizationModulesController` | `/org` | Stub (no backend yet) |

---

### 6.2 Auth Service (Port 3001)

TCP microservice. Handles all authentication, authorization credential management, and OTP flows.

**Bootstrap (`main.ts`)**:
- Creates TCP microservice via `NestFactory.createMicroservice()`
- Binds to `0.0.0.0:3001` (configurable via `AUTH_SERVICE_PORT`)

**Module (`auth-service.module.ts`)**:
- `DatabaseModule.forRoot({ isPlatform: true })` — connects to `hrms_platform`
- `SequelizeModule.forFeature([SuperAdmin, AuthCredential])` — registers models
- `JwtModule.registerAsync()` — uses `JWT_SECRET` from config, `24h` expiry
- `TenantContextModule` — imported globally
- Providers: `AuthService`, `OtpService`

**Message Patterns handled**:

| TCP Pattern | DTO | Handler Method |
|---|---|---|
| `auth.register_tenant` | `RegisterTenantDto` | `registerTenant()` |
| `auth.login` | `LoginDto` | `login()` |
| `auth.superadmin_login` | `SuperAdminLoginDto` | `superAdminLogin()` |
| `auth.onboard_organization` | `OnboardOrganizationDto` | `onboardOrganization()` |
| `auth.forgot_password` | `ForgotPasswordDto` | `forgotPassword()` |
| `auth.verify_otp` | `VerifyOtpDto` | `verifyOtp()` |
| `auth.reset_password` | `ResetPasswordDto` | `resetPassword()` |

**`AuthService` — Method Details**:

`onModuleInit()` — Auto-seeds default SuperAdmin on first boot:
- Email: `superadmin@system.com`
- Password: `SuperAdmin123!` (bcrypt hashed, rounds: 10)

`superAdminLogin(dto)`:
1. Find `SuperAdmin` by email
2. `bcrypt.compare(dto.password, admin.passwordHash)`
3. Sign JWT: `{ sub, email, isSuperAdmin: true, role: 'SuperAdmin' }`
4. Return `{ message, accessToken, user: { id, email, name, role } }`

`onboardOrganization(dto)`:
1. Check email uniqueness in `AuthCredential`
2. `bcrypt.hash(dto.password, 10)`
3. Generate `tenantId = tenant-<domain>` (lowercased, non-alphanumeric → `-`)
4. Create `AuthCredential` record
5. Sign JWT: `{ sub, email, tenantId, role: 'Admin' }`
6. Return `{ message, tenantId, domain, adminEmail, accessToken }`

`registerTenant(dto)` — delegates to `onboardOrganization()` with mapped fields.

`login(dto)`:
1. Find `AuthCredential` by email
2. `bcrypt.compare(dto.password, credential.passwordHash)`
3. Check `credential.isActive === true`
4. Sign JWT: `{ sub, email, tenantId, role }`
5. Return `{ accessToken, user: { id, email, tenantId, tenantName, role } }`

`forgotPassword(dto)`:
1. Look up email in both `AuthCredential` and `SuperAdmin`
2. If neither found — return generic message (security: don't reveal existence)
3. Generate OTP via `OtpService.generateOtp()` (6 digits, bcrypt-hashed, 10min TTL)
4. Store `hashedCode` and `expiresAt` on the record
5. Return `{ message, email, demoOtpCode }` *(OTP returned in response for dev/demo only)*

`verifyOtp(dto)`:
1. Find target account by email
2. Call `OtpService.verifyOtp(dto.otp, storedHash, expiresAt)`
3. Return confirmation message

`resetPassword(dto)`:
1. Validate `newPassword === confirmPassword`
2. Find target account
3. Verify OTP (via `OtpService.verifyOtp`)
4. `bcrypt.compare(newPassword, currentHash)` — reject if same as current
5. `bcrypt.hash(newPassword, 10)`
6. Append new hash to `passwordHistory[]`
7. Update record: `passwordHash`, clear `resetOtp`/`resetOtpExpiresAt`, save history
8. Return success message

**`OtpService`**:
- `generateOtp()`: `Math.floor(100000 + Math.random() * 900000)` → bcrypt-hash → 10min expiry
- `verifyOtp(provided, storedHash, expiresAt)`: checks expiry, then `bcrypt.compare`

---

### 6.3 Tenant Service (Port 3002)

TCP microservice managing tenant lifecycle: database provisioning, schema migration, and deprovisioning.

**Bootstrap**: TCP on `0.0.0.0:3002`

**Module**: Platform `DatabaseModule`, models: `Tenant`, `TenantDatabaseConfig`, `Department`, `Designation`

**Controller (`TenantServiceController`)**:

| Method | Route | Description |
|---|---|---|
| `POST` | `/tenants/provision` | Provision a new tenant with dedicated DB |
| `GET` | `/tenants` | List all tenants |
| `GET` | `/tenants/:id` | Get tenant by ID |
| `DELETE` | `/tenants/:id` | Deprovision tenant (drop DB + delete records) |

**`TenantProvisioningService` — Provisioning Flow**:

```
provisionNewTenant(tenantName, orgName, email, planType)
  │
  ├─ 1. tenantService.createTenant()
  │       → INSERT into platform.tenants
  │
  ├─ 2. databaseName = "hrms_" + tenant.id.replace(/-/g, '_')
  │
  ├─ 3. createTenantDatabase(databaseName)
  │       → Opens raw Sequelize connection (no DB specified)
  │       → Executes: CREATE DATABASE "<databaseName>";
  │       → Closes connection
  │
  ├─ 4. runMigrationsForTenant(databaseName)
  │       → Opens Sequelize connection to new tenant DB
  │       → Calls sequelize.authenticate()
  │       → Calls sequelize.sync({ force: false })
  │       → Closes connection
  │
  ├─ 5. tenantDbConfigService.createTenantDatabaseConfig()
  │       → INSERT into platform.tenant_database_configs
  │
  └─ Returns { tenantId, databaseName, message }

  ON FAILURE (any step):
    → dropTenantDatabase(databaseName) [if created]
    → tenantService.deleteTenant(tenant.id)
    → Throws BadRequestException
```

**`TenantProvisioningService` — Deprovisioning Flow**:

```
deprovisionTenant(tenantId)
  │
  ├─ 1. Get DB config from tenant_database_configs
  ├─ 2. tenantConnectionManager.closeConnection(tenantId)
  │       → Closes cached Sequelize pool, removes from Map
  ├─ 3. dropTenantDatabase(dbConfig.databaseName)
  │       → pg_terminate_backend (kill active connections)
  │       → DROP DATABASE IF EXISTS "<databaseName>"
  ├─ 4. tenantDbConfigService.deleteTenantDatabaseConfig(tenantId)
  └─ 5. tenantService.deleteTenant(tenantId)
```

---

### 6.4 User Service (Port 3003)

TCP microservice for tenant-isolated user and RBAC management. Does NOT use the platform database — all queries go to the resolved tenant database.

**Bootstrap**: TCP on `0.0.0.0:3003`

**Module**: Imports `TenantContextModule` only. Applies `TenantResolverMiddleware` to all routes via `NestModule.configure()`.

**Controller (`UserServiceController`)** — all routes guarded by `TenantGuard + RolesGuard + PermissionsGuard`:

**Users endpoints**:

| Method | Route | Required Permission |
|---|---|---|
| `POST` | `/users` | `users:write` |
| `GET` | `/users` | `users:read` |
| `GET` | `/users/:id` | `users:read` |
| `PATCH` | `/users/:id` | `users:write` |
| `DELETE` | `/users/:id` | `users:write` |
| `POST` | `/users/:id/roles` | `users:write` |
| `DELETE` | `/users/:id/roles/:roleId` | `users:write` |

**Roles endpoints**:

| Method | Route | Guard |
|---|---|---|
| `POST` | `/roles` | `@Roles('admin')` |
| `GET` | `/roles` | `roles:read` |
| `GET` | `/roles/:id` | `roles:read` |
| `PATCH` | `/roles/:id` | `@Roles('admin')` |
| `DELETE` | `/roles/:id` | `@Roles('admin')` |
| `POST` | `/roles/:id/permissions` | `@Roles('admin')` |
| `DELETE` | `/roles/:id/permissions/:permissionId` | `@Roles('admin')` |

**`TenantModelProviderService`** (REQUEST-scoped):
1. `getConnection()` — retrieves `TenantConnectionOptions` from `TenantRequestContextService`; calls `TenantConnectionManager.getConnection(options)` to get/create a Sequelize instance; registers all 5 tenant models
2. `getUserModel()` — returns `connection.models.User as typeof User`
3. `getRoleModel()` — returns `connection.models.Role as typeof Role`
4. `getPermissionModel()` — returns `connection.models.Permission as typeof Permission`
5. `getUserRoleModel()` — returns `connection.models.UserRole as typeof UserRole`
6. `getRolePermissionModel()` — returns `connection.models.RolePermission as typeof RolePermission`

**`UserService`** — tenant-scoped:
- `createUser(data)`: checks email uniqueness, creates user, assigns roles via `UserRole` junction
- `getUserById(id)`: includes associated `Role` models (through `UserRole`)
- `getAllUsers()`: includes roles
- `updateUser(id, data)`: updates user fields
- `deleteUser(id)`: cascades `UserRole` deletion, then destroys user
- `assignRole(userId, roleId)`: validates both exist, creates `UserRole` if not duplicate
- `revokeRole(userId, roleId)`: destroys `UserRole` entry

**`RoleService`** — tenant-scoped:
- `createRole(data)`: checks name uniqueness, creates role, assigns `permissionIds` via `RolePermission`
- `getRoleById(id)`: includes associated `Permission` models
- `getAllRoles()`: includes permissions
- `updateRole(id, data)`: rejects `isSystemRole` roles
- `deleteRole(id)`: rejects system roles; cascades `RolePermission` and `UserRole`, then destroys
- `assignPermission(roleId, permissionId)`: validates both exist, creates `RolePermission` if not duplicate
- `revokePermission(roleId, permissionId)`: destroys `RolePermission` entry

---

## 7. Shared Libraries

### 7.1 `@app/common`

Path: `libs/common/src/index.ts`

**Service Name Constants**:
```typescript
export const SERVICES = {
  AUTH_SERVICE: 'AUTH_SERVICE',
  TENANT_SERVICE: 'TENANT_SERVICE',
  USER_SERVICE: 'USER_SERVICE',
  ORGANIZATION_SERVICE: 'ORGANIZATION_SERVICE',
  ATTENDANCE_LEAVE_SERVICE: 'ATTENDANCE_LEAVE_SERVICE',
  PAYROLL_SERVICE: 'PAYROLL_SERVICE',
  PERFORMANCE_WORK_SERVICE: 'PERFORMANCE_WORK_SERVICE',
  RECRUITMENT_SERVICE: 'RECRUITMENT_SERVICE',
  LMS_SERVICE: 'LMS_SERVICE',
};
```

**TCP Message Pattern Constants**:
```typescript
export const MESSAGE_PATTERNS = {
  AUTH: {
    REGISTER_TENANT: 'auth.register_tenant',
    LOGIN: 'auth.login',
    SUPERADMIN_LOGIN: 'auth.superadmin_login',
    ONBOARD_ORGANIZATION: 'auth.onboard_organization',
    FORGOT_PASSWORD: 'auth.forgot_password',
    VERIFY_OTP: 'auth.verify_otp',
    RESET_PASSWORD: 'auth.reset_password',
  },
  TENANT: {
    GET_TENANT: 'tenant.get',
    CREATE_TENANT: 'tenant.create',
  },
  USER: {
    GET_USER: 'user.get',
    CREATE_USER: 'user.create',
  },
  ORGANIZATION: { GET_EMPLOYEES: 'org.get_employees' },
  PERFORMANCE_WORK: {
    CREATE_PROJECT: 'work.create_project',
    LINK_OUTPUT: 'work.link_output',
  },
};
```

**Shared DTOs** (class-validator + Swagger decorated):

| DTO Class | Fields |
|---|---|
| `RegisterTenantDto` | `companyName`, `domain`, `adminEmail`, `password (min:6)`, `firstName`, `lastName` |
| `LoginDto` | `email`, `password` |
| `SuperAdminLoginDto` | `email`, `password` |
| `OnboardOrganizationDto` | All of `RegisterTenantDto` + optional: `dbHost`, `dbPort`, `dbName`, `dbUsername`, `dbPassword` |
| `ForgotPasswordDto` | `email` |
| `VerifyOtpDto` | `email`, `otp` |
| `ResetPasswordDto` | `email`, `otp`, `newPassword (min:6)`, `confirmPassword (min:6)` |

**Stub exports** (scaffolded, not yet implemented): `guards`, `interceptors`, `filters`, `exceptions`, `pipes`, `utils`

---

### 7.2 `@app/database`

Path: `libs/database/src/`

**`DatabaseModule`** (Dynamic NestJS Module):

```typescript
// Platform DB (hrms_platform)
DatabaseModule.forRoot({ isPlatform: true })

// Tenant template config (used by provisioning)
DatabaseModule.forRoot({ isPlatform: false })

// Register Sequelize models for a feature
DatabaseModule.forFeature([ModelClass, ...])
```

**`getDatabaseConfig(isPlatform: boolean)`**:

| Setting | Platform | Tenant |
|---|---|---|
| Host | `PLATFORM_DB_HOST` | `TENANT_DB_HOST` |
| Database | `PLATFORM_DB_NAME` | `tenant_template` |
| Pool max | 10 | 5 |
| Pool min | 2 | 1 |
| Synchronize | `true` in dev | `true` in dev |
| Logging | `console.log` in dev | `console.log` in dev |

**Type Interfaces**:
```typescript
interface DatabaseConfig { host, port, username, password, database, dialect, logging, synchronize, autoLoadEntities, pool }
interface DatabaseModuleOptions { isPlatform: boolean; autoLoadEntities?: boolean }
interface TenantConnectionOptions { tenantId, databaseName, host, port, username, password, dialect }
interface TenantDatabaseConnection { tenantId, host, port, database, username, password, dialect }
```

---

### 7.3 `@app/tenant-context`

Path: `libs/tenant-context/src/`

This is the most critical shared library. It contains all tenant resolution, connection management, and security infrastructure.

**`TenantContextModule`** — `@Global()` module. Provides and exports all services, middleware, and guards.

---

#### `TenantContextService`
Uses Node.js `AsyncLocalStorage` to propagate `tenantId` through async call chains without passing it explicitly.

```typescript
export const tenantStorage = new AsyncLocalStorage<{ tenantId: string }>();

class TenantContextService {
  getTenantId(): string | undefined    // reads from AsyncLocalStorage store
  setTenantId(tenantId: string): void  // enters AsyncLocalStorage context
}
```

---

#### `TenantRequestContextService` (REQUEST-scoped)
Per-request store for tenant identity and database connection options.

```typescript
class TenantRequestContextService {
  setTenantId(tenantId: string): void
  getTenantId(): string | undefined
  setConnectionOptions(options: TenantConnectionOptions): void
  getConnectionOptions(): TenantConnectionOptions | undefined
}
```

---

#### `TenantConnectionManager`
Singleton in-memory pool of Sequelize connections, keyed by `tenantId`.

```typescript
class TenantConnectionManager {
  private tenantConnections: Map<string, Sequelize> = new Map();

  async getConnection(options: TenantConnectionOptions): Promise<Sequelize>
  // If cached → return existing connection
  // Else → new Sequelize({ host, port, username, password, database, dialect, pool: {max:5, min:1, idle:10000} })
  //      → authenticate() → cache → return

  async closeConnection(tenantId: string): Promise<void>
  // close() + delete from Map

  async closeAllConnections(): Promise<void>

  getActiveConnections(): Map<string, Sequelize>
}
```

---

#### `TenantResolverMiddleware`
Runs before every request in services that apply it. Resolves tenant identity from:
1. `x-tenant-id` HTTP header (primary)
2. Subdomain extraction from `Host` header (fallback): `acme.hrms.local` → `acme`

```typescript
use(req, res, next) {
  tenantId = req.headers['x-tenant-id']          // or from Host subdomain
  req.tenantId = tenantId
  requestContext.setConnectionOptions({
    tenantId,
    databaseName: `hrms_${tenantId.replace(/-/g, '_')}`,
    host: TENANT_DB_HOST, port: TENANT_DB_PORT,
    username: TENANT_DB_USER, password: TENANT_DB_PASSWORD,
    dialect: 'postgres',
  })
  tenantStorage.enterWith({ tenantId })
  next()
}
```

---

#### Guards

**`TenantGuard`**:
- Reads `x-tenant-id` header or `request.user.tenantId`
- Sets `request.tenantId` and enters AsyncLocalStorage
- Throws `401 UnauthorizedException` if missing

**`RolesGuard`**:
- Reads `@Roles(...roles)` metadata from handler/class
- Extracts user roles from `request.user.roles[]` or `request.user.role`
- `admin` / `superadmin` always bypass
- Throws `403 ForbiddenException` if required role not found

**`PermissionsGuard`**:
- Reads `@RequirePermissions(...perms)` metadata
- `admin` / `superadmin` bypass all permission checks
- Checks `request.user.permissions[]` includes all required permissions
- Throws `403 ForbiddenException` if any permission missing

---

#### Decorators

| Decorator | Usage | Returns |
|---|---|---|
| `@CurrentTenant()` | Controller parameter | `request.tenantId` (string) |
| `@CurrentUser()` | Controller parameter | `request.user` (object) |
| `@Roles(...roles)` | Controller/handler | Sets metadata key `roles` |
| `@RequirePermissions(...perms)` | Controller/handler | Sets metadata key `permissions` |

---

## 8. Database Architecture

### Strategy: Database-per-Tenant

```
PostgreSQL Server
│
├── hrms_platform              ← Shared platform database
│   ├── super_admins           ← System administrators
│   ├── auth_credentials       ← Login credentials for all tenants
│   ├── tenants                ← Tenant registry
│   ├── tenant_database_configs← Per-tenant DB connection details
│   ├── departments            ← (platform-level org structure)
│   └── designations           ← (platform-level job titles)
│
├── hrms_tenant_acme           ← Tenant "acme" isolated database
│   ├── users
│   ├── roles
│   ├── permissions
│   ├── user_roles
│   └── role_permissions
│
├── hrms_tenant_globex         ← Tenant "globex" isolated database
│   ├── users
│   ├── roles
│   └── ...
│
└── hrms_tenant_initech        ← Another tenant...
```

### Connection Flow

```
Incoming Request (x-tenant-id: tenant-acme)
         │
         ▼
TenantResolverMiddleware
  → databaseName = "hrms_tenant_acme"
  → stores TenantConnectionOptions on request context
         │
         ▼
TenantModelProviderService.getConnection()
  → TenantConnectionManager.getConnection({ tenantId: 'tenant-acme', databaseName: 'hrms_tenant_acme', ... })
         │
         ├─ Cache HIT  → return existing Sequelize instance
         │
         └─ Cache MISS → new Sequelize(...)
                       → authenticate()
                       → cache in Map
                       → return instance
         │
         ▼
connection.addModels([User, Role, Permission, UserRole, RolePermission])
         │
         ▼
Queries execute against hrms_tenant_acme only
```

### Pool Configuration

| Database Type | Max Connections | Min Connections | Idle Timeout |
|---|---|---|---|
| Platform DB | 10 | 2 | 10,000ms |
| Tenant DB (cached) | 5 | 1 | 10,000ms |

---

## 9. Data Models Reference

### Platform Database Models

#### `super_admins`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, UUIDv4 default |
| `email` | STRING | NOT NULL, UNIQUE |
| `passwordHash` | STRING | NOT NULL |
| `name` | STRING | - |
| `resetOtp` | STRING | nullable |
| `resetOtpExpiresAt` | DATE | nullable |
| `passwordHistory` | ARRAY(STRING) | - |
| `status` | STRING | default: `'active'` |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |

#### `auth_credentials`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, UUIDv4 default |
| `email` | STRING | NOT NULL, UNIQUE |
| `passwordHash` | STRING | NOT NULL |
| `tenantId` | STRING | NOT NULL |
| `tenantName` | STRING | nullable |
| `role` | STRING | default: `'Admin'` |
| `isActive` | BOOLEAN | default: `true` |
| `resetOtp` | STRING | nullable |
| `resetOtpExpiresAt` | DATE | nullable |
| `passwordHistory` | ARRAY(STRING) | - |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |

#### `tenants`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, UUIDv4 default |
| `name` | STRING | NOT NULL |
| `organizationName` | STRING | nullable |
| `email` | STRING | nullable |
| `planType` | STRING | default: `'standard'` |
| `domain` | STRING | UNIQUE, nullable |
| `isActive` | BOOLEAN | default: `true` |
| `status` | STRING | default: `'active'` |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |

#### `tenant_database_configs`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, UUIDv4 default |
| `tenantId` | UUID | FK → tenants, UNIQUE |
| `databaseName` | STRING | NOT NULL |
| `host` | STRING | NOT NULL |
| `port` | INTEGER | NOT NULL |
| `username` | STRING | NOT NULL |
| `password` | STRING | NOT NULL |
| `dialect` | ENUM | `'postgres'` \| `'mysql'`, default: `'postgres'` |
| `isActive` | BOOLEAN | default: `false` |
| `poolConfig` | JSON | `{ max, min, idle }` |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |

#### `departments`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `tenantId` | UUID | FK → tenants |
| `name` | STRING | NOT NULL |

#### `designations`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `tenantId` | UUID | FK → tenants |
| `title` | STRING | NOT NULL |

---

### Tenant Database Models

#### `users`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, UUIDv4 default |
| `email` | STRING | NOT NULL, UNIQUE |
| `passwordHash` | STRING | nullable |
| `firstName` | STRING | nullable |
| `lastName` | STRING | nullable |
| `isActive` | BOOLEAN | default: `true` |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |
| `roles` | Role[] | BelongsToMany through `user_roles` |

#### `roles`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, UUIDv4 default |
| `name` | STRING | NOT NULL, UNIQUE |
| `description` | STRING | nullable |
| `isSystemRole` | BOOLEAN | default: `false` |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |
| `users` | User[] | BelongsToMany through `user_roles` |
| `permissions` | Permission[] | BelongsToMany through `role_permissions` |

#### `permissions`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, UUIDv4 default |
| `resource` | STRING | NOT NULL |
| `action` | STRING | NOT NULL |
| `description` | STRING | nullable |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |
| `roles` | Role[] | BelongsToMany through `role_permissions` |

#### `user_roles` (Junction)
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `userId` | UUID | FK → users |
| `roleId` | UUID | FK → roles |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |

#### `role_permissions` (Junction)
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `roleId` | UUID | FK → roles |
| `permissionId` | UUID | FK → permissions |
| `createdAt` | DATE | auto |
| `updatedAt` | DATE | auto |

---

## 10. API Endpoints Reference

Base URL: `http://localhost:3000/api/v1`  
Swagger UI: `http://localhost:3000/api/docs`

### Auth Endpoints

#### `POST /auth/register-tenant`
Register a new organization (self-service onboarding).

**Request Body** (`RegisterTenantDto`):
```json
{
  "companyName": "Acme Corp",
  "domain": "acme",
  "adminEmail": "admin@acme.com",
  "password": "Password123!",
  "firstName": "John",
  "lastName": "Doe"
}
```
**Response 201**:
```json
{
  "message": "Organization credentials created successfully",
  "tenantId": "tenant-acme",
  "domain": "acme",
  "adminEmail": "admin@acme.com",
  "accessToken": "eyJhbGci..."
}
```

---

#### `POST /auth/login`
Authenticate a tenant user.

**Request Body** (`LoginDto`):
```json
{
  "email": "admin@acme.com",
  "password": "Password123!"
}
```
**Response 200**:
```json
{
  "accessToken": "eyJhbGci...",
  "user": {
    "id": "uuid",
    "email": "admin@acme.com",
    "tenantId": "tenant-acme",
    "tenantName": "Acme Corp",
    "role": "Admin"
  }
}
```

---

### SuperAdmin Endpoints

#### `POST /superadmin/login`
Authenticate the system SuperAdmin.

**Request Body** (`SuperAdminLoginDto`):
```json
{
  "email": "superadmin@system.com",
  "password": "SuperAdmin123!"
}
```
**Response 200**:
```json
{
  "message": "SuperAdmin login successful",
  "accessToken": "eyJhbGci...",
  "user": { "id": "uuid", "email": "...", "name": "...", "role": "SuperAdmin" }
}
```

---

#### `POST /superadmin/organizations/onboard`
Onboard a new organization as SuperAdmin with optional custom DB settings.

**Request Body** (`OnboardOrganizationDto`):
```json
{
  "companyName": "Globex Corp",
  "domain": "globex",
  "adminEmail": "admin@globex.com",
  "password": "AdminPass123!",
  "firstName": "Alice",
  "lastName": "Smith",
  "dbHost": "localhost",
  "dbPort": 5432,
  "dbName": "hrms_globex_db",
  "dbUsername": "postgres",
  "dbPassword": "postgres"
}
```

---

### Organization Module Endpoints (Stub)

All require `x-tenant-id` header.

| Method | Endpoint | Summary |
|---|---|---|
| `GET` | `/org/dashboard` | Dashboard stats (employees, projects, payroll) |
| `GET` | `/org/geofence/locations` | Geofencing attendance boundaries |
| `POST` | `/org/pos/transactions` | Record POS transaction |
| `GET` | `/org/announcements` | Notice board and announcements |
| `GET` | `/org/surveys` | Employee surveys and feedback |
| `GET` | `/org/web3/nft-rewards` | NFT & Web3 HR achievement badges |
| `GET` | `/org/community/posts` | HR community discussions |
| `GET` | `/org/penalties` | Communication penalties log |
| `GET` | `/org/assets` | Asset management list |
| `GET` | `/org/expenses` | Expense claims & approvals |
| `GET` | `/org/tickets` | Helpdesk & ticket management |
| `GET` | `/org/audit-logs` | Audit trail and system activity logs |

---

### User Service Endpoints

> These are served by User Service on port 3003. In production, they'd be accessed via API Gateway proxy.

All endpoints require: `x-tenant-id` header + valid JWT with appropriate role/permission.

**Users**:

| Method | Endpoint | Permission Required |
|---|---|---|
| `POST` | `/users` | `users:write` |
| `GET` | `/users` | `users:read` |
| `GET` | `/users/:id` | `users:read` |
| `PATCH` | `/users/:id` | `users:write` |
| `DELETE` | `/users/:id` | `users:write` |
| `POST` | `/users/:id/roles` | `users:write` |
| `DELETE` | `/users/:id/roles/:roleId` | `users:write` |

**Roles**:

| Method | Endpoint | Guard |
|---|---|---|
| `POST` | `/roles` | Role: `admin` |
| `GET` | `/roles` | Permission: `roles:read` |
| `GET` | `/roles/:id` | Permission: `roles:read` |
| `PATCH` | `/roles/:id` | Role: `admin` |
| `DELETE` | `/roles/:id` | Role: `admin` |
| `POST` | `/roles/:id/permissions` | Role: `admin` |
| `DELETE` | `/roles/:id/permissions/:permissionId` | Role: `admin` |

---

### Tenant Service Endpoints

> Served by Tenant Service on port 3002. Direct HTTP access (not yet proxied through gateway).

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tenants/provision` | Provision new tenant with dedicated DB |
| `GET` | `/tenants` | List all tenants |
| `GET` | `/tenants/:id` | Get tenant by ID |
| `DELETE` | `/tenants/:id` | Deprovision tenant (drop DB + delete records) |

---

## 11. Application Flow — End to End

### Flow 1: Tenant Self-Registration (New Organization Signup)

```
Client
  │
  │  POST /api/v1/auth/register-tenant
  │  Body: { companyName, domain, adminEmail, password, firstName, lastName }
  │
  ▼
API Gateway
  │  ValidationPipe validates RegisterTenantDto
  │  authClient.send('auth.register_tenant', dto)  [TCP]
  │
  ▼
Auth Service (TCP)
  │
  ├── 1. credentialModel.findOne({ where: { email } })
  │       → Throw BadRequest if email exists
  │
  ├── 2. bcrypt.hash(password, 10) → passwordHash
  │
  ├── 3. tenantId = "tenant-" + domain.toLowerCase().replace(/[^a-z0-9]/g, '-')
  │
  ├── 4. credentialModel.create({
  │         email, passwordHash, tenantId, tenantName: companyName, role: 'Admin'
  │       })
  │
  ├── 5. jwtService.sign({ sub: id, email, tenantId, role: 'Admin' })
  │
  └── Returns { message, tenantId, domain, adminEmail, accessToken }
  │
  ▼
API Gateway → HTTP 201 to Client

NOTE: Database provisioning (CREATE DATABASE) is a SEPARATE step via TenantService.
The Auth Service only creates the credential record and a tenant entry in auth_credentials.
```

---

### Flow 2: SuperAdmin Onboards Organization

```
SuperAdmin
  │
  │  POST /api/v1/superadmin/organizations/onboard
  │  Body: { companyName, domain, adminEmail, password, ... optional dbConfig }
  │
  ▼
API Gateway → SuperAdminController
  │  authClient.send('auth.onboard_organization', dto)  [TCP]
  │
  ▼
Auth Service
  │  Same as registerTenant flow but from SuperAdmin context
  └── Returns { message, tenantId, domain, adminEmail, accessToken }
```

---

### Flow 3: User Login

```
Client
  │
  │  POST /api/v1/auth/login
  │  Body: { email, password }
  │
  ▼
API Gateway → ApiGatewayAuthController
  │  authClient.send('auth.login', dto)  [TCP]
  │
  ▼
Auth Service → AuthService.login(dto)
  │
  ├── 1. credentialModel.findOne({ where: { email } })
  │       → Throw 401 if not found
  │
  ├── 2. bcrypt.compare(password, credential.passwordHash)
  │       → Throw 401 if mismatch
  │
  ├── 3. Check credential.isActive === true
  │       → Throw 401 if inactive
  │
  ├── 4. jwtService.sign({ sub, email, tenantId, role })
  │
  └── Returns { accessToken, user: { id, email, tenantId, tenantName, role } }
  │
  ▼
Client stores accessToken for subsequent requests
```

---

### Flow 4: Tenant Database Provisioning

```
Admin or System
  │
  │  POST /tenants/provision   (Tenant Service direct)
  │  Body: { tenantName, organizationName, email, planType }
  │
  ▼
TenantServiceController → TenantProvisioningService.provisionNewTenant()
  │
  ├── Step 1: tenantService.createTenant() → INSERT into platform.tenants
  │
  ├── Step 2: databaseName = "hrms_" + tenant.id.replace(/-/g, '_')
  │
  ├── Step 3: createTenantDatabase(databaseName)
  │     → new Sequelize(host, port, user, pass, { no DB })
  │     → query: CREATE DATABASE "hrms_uuid_with_underscores";
  │     → close connection
  │
  ├── Step 4: runMigrationsForTenant(databaseName)
  │     → new Sequelize({ database: databaseName, ... })
  │     → authenticate()
  │     → sequelize.sync({ force: false })   ← creates all tables
  │     → close connection
  │
  ├── Step 5: tenantDbConfigService.createTenantDatabaseConfig(...)
  │     → INSERT into platform.tenant_database_configs
  │
  └── Returns { tenantId, databaseName, message: "Tenant provisioned successfully" }

  ON ERROR at any step:
    → dropTenantDatabase(databaseName)    [if it was created]
    → tenantService.deleteTenant(id)
    → throw BadRequestException
```

---

### Flow 5: Tenant-Isolated Authenticated Request

```
Client
  │
  │  GET /users
  │  Headers:
  │    Authorization: Bearer eyJhbGci...
  │    x-tenant-id: tenant-acme
  │
  ▼
User Service (port 3003)
  │
  ├─ [1] TenantResolverMiddleware (applied to all routes)
  │       → reads x-tenant-id header → "tenant-acme"
  │       → databaseName = "hrms_tenant_acme"
  │       → requestContext.setConnectionOptions({ tenantId, databaseName, host, port, user, pass, dialect })
  │       → tenantStorage.enterWith({ tenantId: 'tenant-acme' })
  │
  ├─ [2] TenantGuard (applied to controller class)
  │       → reads x-tenant-id header
  │       → sets request.tenantId = "tenant-acme"
  │       → throws 401 if missing
  │
  ├─ [3] RolesGuard
  │       → reads @Roles() metadata (none set for GET /users)
  │       → passes through
  │
  ├─ [4] PermissionsGuard
  │       → reads @RequirePermissions('users:read') metadata
  │       → reads request.user.permissions[]
  │       → admin/superadmin bypass automatically
  │       → throws 403 if permission missing
  │
  ├─ [5] Controller: UserServiceController.getAllUsers()
  │       → calls userService.getAllUsers()
  │
  ├─ [6] UserService.getAllUsers()
  │       → calls modelProvider.getUserModel()
  │
  ├─ [7] TenantModelProviderService.getUserModel()
  │       → getConnection()
  │       → requestContext.getConnectionOptions()  ← { tenantId, databaseName, ... }
  │       → tenantConnectionManager.getConnection(options)
  │           ├─ CACHE HIT: return existing Sequelize(hrms_tenant_acme)
  │           └─ CACHE MISS: new Sequelize({ database: 'hrms_tenant_acme', ... })
  │                          → authenticate()
  │                          → cache in Map<'tenant-acme', Sequelize>
  │       → connection.addModels([User, Role, Permission, UserRole, RolePermission])
  │       → return connection.models.User
  │
  └─ [8] UserModel.findAll({ include: [Role] })
           → SQL: SELECT * FROM users LEFT JOIN user_roles JOIN roles
           → Executes against hrms_tenant_acme database ONLY
           → Returns User[] with nested roles

  ▼
HTTP 200 OK — Array of users with their roles
```

---

### Flow 6: Forgot Password / OTP Reset

```
Client
  │  POST /auth/* (via gateway TCP)
  │
  ├── Step 1: POST /auth/forgot-password  { email }
  │     → AuthService.forgotPassword()
  │     → Looks up email in auth_credentials OR super_admins
  │     → If not found → returns generic message (security)
  │     → OtpService.generateOtp():
  │         code = random 6-digit number (string)
  │         hashedCode = bcrypt.hash(code, 10)
  │         expiresAt = now + 10 minutes
  │     → Stores hashedCode + expiresAt on record
  │     → Returns { message, email, demoOtpCode: code }  ← dev only
  │
  ├── Step 2: POST /auth/verify-otp  { email, otp }
  │     → AuthService.verifyOtp()
  │     → OtpService.verifyOtp(provided, storedHash, expiresAt):
  │         if (new Date() > expiresAt) → throw BadRequest "OTP expired"
  │         bcrypt.compare(provided, storedHash) → throw if mismatch
  │     → Returns { message: "OTP verified. Enter new password." }
  │
  └── Step 3: POST /auth/reset-password  { email, otp, newPassword, confirmPassword }
        → Validates newPassword === confirmPassword
        → Verifies OTP again
        → bcrypt.compare(newPassword, currentHash) → reject if same
        → bcrypt.hash(newPassword, 10)
        → Appends to passwordHistory[]
        → Clears resetOtp + resetOtpExpiresAt
        → Returns { message: "Password saved successfully." }
```

---

### Flow 7: Tenant Deprovisioning

```
SuperAdmin
  │  DELETE /tenants/:tenantId  (Tenant Service direct)
  │
  ▼
TenantProvisioningService.deprovisionTenant(tenantId)
  │
  ├── 1. getTenantDatabaseConfig(tenantId) → get databaseName
  │
  ├── 2. tenantConnectionManager.closeConnection(tenantId)
  │       → connection.close()
  │       → Map.delete('tenant-id')
  │
  ├── 3. dropTenantDatabase(databaseName)
  │       → new Sequelize(host, port, user, pass, { no DB })
  │       → SELECT pg_terminate_backend FROM pg_stat_activity
  │           WHERE datname = 'hrms_...' AND pid <> pg_backend_pid()
  │       → DROP DATABASE IF EXISTS "hrms_...";
  │       → close connection
  │
  ├── 4. tenantDbConfigService.deleteTenantDatabaseConfig(tenantId)
  │       → DELETE FROM platform.tenant_database_configs
  │
  └── 5. tenantService.deleteTenant(tenantId)
          → DELETE FROM platform.tenants
  │
  ▼
HTTP 200 OK { message: "Tenant deprovisioned" }
```

---

## 12. RBAC — Roles, Guards & Permissions

### Guard Execution Order

Every request to the User Service passes through all three guards in sequence:

```
Request
  │
  ▼
[1] TenantGuard
    → Validates x-tenant-id header is present
    → Sets request.tenantId
    → FAIL: 401 UnauthorizedException
  │
  ▼
[2] RolesGuard
    → Reads @Roles('admin', 'manager') metadata
    → Checks request.user.role or request.user.roles[]
    → admin/superadmin always bypass
    → FAIL: 403 ForbiddenException
  │
  ▼
[3] PermissionsGuard
    → Reads @RequirePermissions('resource:action') metadata
    → admin/superadmin bypass
    → Checks request.user.permissions[]
    → FAIL: 403 ForbiddenException
  │
  ▼
Controller Handler Executes
```

### Permission Naming Convention

Permissions follow the `resource:action` format:

| Permission Key | Scope |
|---|---|
| `users:read` | View users in tenant |
| `users:write` | Create/update/delete users in tenant |
| `roles:read` | View roles in tenant |
| `roles:write` | Create/update/delete roles in tenant |
| *(extensible)* | `attendance:read`, `payroll:process`, etc. |

### System Roles

Roles with `isSystemRole: true` in the tenant DB are protected:
- Cannot be updated via `PATCH /roles/:id`
- Cannot be deleted via `DELETE /roles/:id`
- Service throws `BadRequestException` for both operations

### Admin Bypass

Both `RolesGuard` and `PermissionsGuard` implement an admin bypass:
```typescript
if (userRoles.includes('admin') || userRoles.includes('superadmin')) {
  return true;  // bypass all checks
}
```

---

## 13. Tenant Isolation Strategy

### Isolation Layers

| Layer | Mechanism | Where |
|---|---|---|
| Network | `x-tenant-id` header required | `TenantGuard` |
| Request | Per-request context stored in `TenantRequestContextService` (REQUEST-scoped) | Middleware |
| Async | `AsyncLocalStorage` propagates tenantId through async call chain | `TenantContextService` |
| Database | Separate PostgreSQL database per tenant | `TenantConnectionManager` |
| Connection | Sequelize models bound to tenant-specific Sequelize instance | `TenantModelProviderService` |
| Pool | Connection pool cached per tenantId in memory Map | `TenantConnectionManager` |

### Key Isolation Guarantee

Because `TenantModelProviderService` is **REQUEST-scoped**, a new instance is created for every HTTP request. It retrieves connection options from `TenantRequestContextService` (also REQUEST-scoped), which was populated by `TenantResolverMiddleware` at the start of the request. This means:
- Models are always bound to the correct tenant's Sequelize instance
- There is zero risk of cross-tenant query contamination at the ORM layer

### Database Name Derivation

```
tenantId = "tenant-acme-corp"
            ↓
databaseName = "hrms_" + tenantId.replace(/-/g, '_')
             = "hrms_tenant_acme_corp"
```

This is computed both at:
1. **Provisioning time** (`TenantProvisioningService`) — when creating the DB
2. **Request time** (`TenantResolverMiddleware`) — when resolving the connection

---

## 14. Build, Run & Scripts

### Prerequisites
- Node.js (LTS)
- PostgreSQL running locally (or via Docker)
- Create platform database: `CREATE DATABASE hrms_platform;`

### Install Dependencies
```bash
npm install
```

### Environment Setup
```bash
cp .env.example .env.development
# Edit .env.development with your database credentials and secrets
```

### Running Services

Each service must be started in a separate terminal:

```bash
# API Gateway (HTTP, Port 3000)
npm run start:api-gateway
# or: npx nest start api-gateway --watch

# Auth Service (TCP, Port 3001)
npm run start:auth-service
# or: npx nest start auth-service --watch

# Tenant Service (TCP, Port 3002)
npm run start:tenant-service
# or: npx nest start tenant-service --watch

# User Service (TCP, Port 3003)
npm run start:user-service
# or: npx nest start user-service --watch
```

### Build Scripts

```bash
# Build individual service
npm run build:api-gateway
npm run build:auth-service
npm run build:tenant-service
npm run build:user-service

# Build all services
npm run build:all

# Run production build
npm run start:prod    # starts api-gateway from dist/
```

### Testing

```bash
# Run all tests (single pass)
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:cov

# E2E tests
npm run test:e2e
```

### Code Quality

```bash
# Lint and auto-fix
npm run lint

# Format with Prettier
npm run format
```

### Swagger / API Docs

After starting the API Gateway, navigate to:
```
http://localhost:3000/api/docs
```

Use the **Authorize** button to set:
1. Bearer token: JWT from login response
2. `x-tenant-id` API key: your tenant ID (e.g., `tenant-acme`)

### TypeScript Path Aliases

Defined in `tsconfig.json`:

| Alias | Resolves To |
|---|---|
| `@app/common` | `libs/common/src` |
| `@app/database` | `libs/database/src` |
| `@app/tenant-context` | `libs/tenant-context/src` |

### NestJS Monorepo Projects (`nest-cli.json`)

| Project Key | Type | Entry |
|---|---|---|
| `api-gateway` | application | `apps/api-gateway/src/main.ts` |
| `auth-service` | application | `apps/auth-service/src/main.ts` |
| `tenant-service` | application | `apps/tenant-service/src/main.ts` |
| `user-service` | application | `apps/user-service/src/main.ts` |
| `common` | library | `libs/common/src/index.ts` |
| `database` | library | `libs/database/src/index.ts` |
| `tenant-context` | library | `libs/tenant-context/src/index.ts` |

### Quick Integration Test

```bash
# 1. Register a new organization
curl -X POST http://localhost:3000/api/v1/auth/register-tenant \
  -H "Content-Type: application/json" \
  -d '{"companyName":"Acme Corp","domain":"acme","adminEmail":"admin@acme.com","password":"Password123!","firstName":"John","lastName":"Doe"}'

# 2. Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acme.com","password":"Password123!"}'

# 3. Access tenant dashboard
curl -X GET http://localhost:3000/api/v1/org/dashboard \
  -H "x-tenant-id: tenant-acme" \
  -H "Authorization: Bearer <accessToken>"

# 4. SuperAdmin login (default seeded credentials)
curl -X POST http://localhost:3000/api/v1/superadmin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"superadmin@system.com","password":"SuperAdmin123!"}'
```

---

## 15. Future Services & Planned Models

The architecture doc and `docs/schemas/future-domain-models.ts` define the full roadmap. Six additional microservices are planned:

| Service | Port | Status | Domain |
|---|---|---|---|
| **Organization/Employee Service** | 3002* | Planned | `Department`, `Designation`, `EmployeeProfile` |
| **Attendance & Leave Service** | 3003* | Planned | `Attendance`, `LeaveRequest` |
| **Payroll Service** | 3004 | Planned | `SalaryStructure`, `PayrollRecord` |
| **Performance & Work Service** | 3005 | Planned | `Project`, `Task`, `EmployeeOutput`, `Goal`, `PerformanceReview` |
| **Recruitment Service** | 3006 | Planned | `CandidateProfile`, `JobPosting`, `JobApplication` |
| **LMS Service** | 3007 | Planned | `Course`, `CourseEnrollment` |

> *Note: Architecture doc port numbers differ from current implementation. Current tenant-service is on 3002 and user-service on 3003.*

### All Future Domain Models (from `docs/schemas/future-domain-models.ts`)

**Employee Core**:
- `EmployeeProfile` — `id`, `tenantId`, `userId`, `firstName`, `lastName`, `employeeCode`, `departmentId`, `designationId`, `managerId`, `joiningDate`, `employmentStatus`

**Attendance & Leave**:
- `Attendance` — `id`, `tenantId`, `employeeId`, `date`, `checkInTime`, `checkOutTime`, `status`
- `LeaveRequest` — `id`, `tenantId`, `employeeId`, `leaveType`, `startDate`, `endDate`, `status`

**Payroll**:
- `SalaryStructure` — `id`, `tenantId`, `employeeId`, `baseSalary`, `allowances (JSONB)`, `deductions (JSONB)`
- `PayrollRecord` — `id`, `tenantId`, `employeeId`, `payPeriod`, `netPay`, `status`

**Performance & Work** (Core Linkage: Project → Task → EmployeeOutput → Goal → PerformanceReview):
- `Goal` — `id`, `tenantId`, `employeeId`, `title`, `targetMetric`, `status`
- `Project` — `id`, `tenantId`, `name`, `status`
- `Task` — `id`, `tenantId`, `projectId`, `assigneeId`, `title`, `status`
- `EmployeeOutput` — `id`, `tenantId`, `employeeId`, `taskId`, `goalId`, `outputSummary`, `qualityScore`
- `PerformanceReview` — `id`, `tenantId`, `employeeId`, `reviewerId`, `reviewPeriod`, `selfAssessment (JSONB)`, `managerAssessment (JSONB)`, `status`

**Recruitment**:
- `CandidateProfile` — `id`, `firstName`, `lastName`, `email (unique, no tenantId)`, `cvUrl`, `skills[]` ← cross-tenant
- `JobPosting` — `id`, `tenantId`, `title`, `description`, `status`
- `JobApplication` — `id`, `tenantId`, `jobPostingId`, `candidateId`, `stage`

**LMS**:
- `Course` — `id`, `tenantId`, `title`, `description`
- `CourseEnrollment` — `id`, `tenantId`, `courseId`, `employeeId`, `progressPercentage`, `status`

**Operations & Modules**:
- `GeofenceLocation` — `id`, `tenantId`, `name`, `latitude`, `longitude`, `radiusMeters`
- `POSTransaction` — `id`, `tenantId`, `cashierEmployeeId`, `totalAmount`, `paymentMethod`, `status`
- `Announcement` — `id`, `tenantId`, `title`, `content`, `category`
- `Survey` — `id`, `tenantId`, `title`, `questions (JSONB)`, `status`
- `HRCommunityPost` — `id`, `tenantId`, `authorEmployeeId`, `title`, `content`

**Web3 / NFT**:
- `NFTReward` — `id`, `tenantId`, `recipientEmployeeId`, `badgeTitle`, `tokenId`, `contractAddress`, `transactionHash`

**HR Operations**:
- `CommunicationPenalty` — `id`, `tenantId`, `employeeId`, `reason`, `penaltyAmount`, `status`
- `Asset` — `id`, `tenantId`, `name`, `assetTag`, `assignedEmployeeId`, `status`
- `ExpenseClaim` — `id`, `tenantId`, `employeeId`, `amount`, `category`, `description`, `status`
- `Ticket` — `id`, `tenantId`, `requesterEmployeeId`, `subject`, `description`, `status`
- `AuditLog` — `id`, `tenantId`, `action`, `performedBy`, `details (JSONB)`

### Core Performance & Work Linkage (Key Differentiator)

```
Project (container)
    │
    └── Task (work item)
          │
          └── EmployeeOutput (deliverable, with quality score)
                │
                ├── linked to Goal (quantifiable KPI)
                │
                └── feeds into PerformanceReview
                      (self-assessment + manager-assessment)
```

This data model enables objective, evidence-based performance reviews rooted in actual task output and goal achievement — rather than subjective manager ratings alone.

---

## Implementation Notes & Known Behaviors

1. **SuperAdmin auto-seeded**: `AuthService.onModuleInit()` creates `superadmin@system.com` / `SuperAdmin123!` if the `super_admins` table is empty. This runs on every service start.

2. **OTP returned in response**: `forgotPassword()` returns `demoOtpCode` in the response body. This is clearly a dev/demo convenience. In production this must be removed and delivered via email.

3. **Auth Service does not provision DB**: `registerTenant()` / `onboardOrganization()` only create an `AuthCredential` record. The actual `CREATE DATABASE` is done separately by `TenantProvisioningService`. These two flows are not yet wired together — a manual call to `POST /tenants/provision` (Tenant Service) is needed after registration.

4. **DB name derivation is deterministic**: `TenantResolverMiddleware` derives `databaseName = hrms_<tenantId_with_underscores>` from the header value. This must match the name used during provisioning. As long as the middleware and provisioning service use the same formula, they stay in sync.

5. **No JWT validation in User Service**: The guards check `request.user.*` fields, but there is no JWT decoding middleware on the User Service. In practice, the API Gateway (or a future JWT guard) would decode the token and populate `request.user` before tenant-scoped requests reach the service.

6. **TypeScript strictness is relaxed**: `tsconfig.json` has `strictNullChecks: false` and `noImplicitAny: false`. This was likely done for faster development iteration.

7. **Common lib stubs**: `guards`, `interceptors`, `filters`, `exceptions`, `pipes`, `utils` in `@app/common` are all empty re-export files. Actual implementations live in `@app/tenant-context`.

8. **Password history prevents reuse**: Both `AuthCredential` and `SuperAdmin` track `passwordHistory: string[]` (array of bcrypt hashes). Reset password checks only against the current hash — not the full history. Full history enforcement can be added by iterating all history entries.

---

*End of Documentation — HRMS Multi-Tenant Platform*
