# HRMS Multi-Tenant Microservices Project Report

> **Generated Date**: August 20, 2026  
> **Project Name**: Multi-Tenant Enterprise HRMS Platform  
> **Architecture Pattern**: NestJS Monorepo Microservices  
> **Tech Stack**: NestJS 11, TypeScript, Sequelize ORM (Sequelize-TypeScript), PostgreSQL, Microservices (TCP / REST), Swagger / OpenAPI  

---

## 1. Executive Summary

The **HRMS Multi-Tenant Microservices Platform** is an enterprise-grade Human Resource Management System engineered using NestJS Monorepo architecture. The platform supports **strict multi-tenancy**, where tenant organizations receive separate/isolated databases dynamically managed via `TenantConnectionManager`. 

The system decouples core administrative HR processes from performance, payroll, recruitment, and LMS, allowing independent horizontal scaling and data security across microservices.

---

## 2. Completed & Finalized Modules (Current Status)

### 2.1 API Gateway Service (`apps/api-gateway`)
- **Port**: `3000` (HTTP / REST)
- **Status**: **Completed & Operational**
- **Key Features**:
  - Central HTTP Gateway proxying REST requests to background TCP microservices.
  - Swagger OpenAPI Documentation enabled at `/api/docs`.
  - **Authentication Endpoints**: Tenant Onboarding (`POST /api/v1/auth/register-tenant`), User Login (`POST /api/v1/auth/login`).
  - **SuperAdmin Endpoints**: System administration login and organization management.
  - **Organization & Extension Endpoints**: Dashboard metrics, Geofencing attendance locations, POS transactions, Notice Board Announcements, Surveys, HR Community, NFT Badges, Asset tracking, Expense claims, Ticket helpdesk, Audit logs.

### 2.2 Auth Microservice (`apps/auth-service`)
- **Port**: `3001` (TCP Transport)
- **Status**: **Completed & Operational**
- **Key Features**:
  - **SuperAdmin Initial Seeding**: Automatically seeds default SuperAdmin (`superadmin@system.com`) on startup.
  - **Tenant & Admin Onboarding**: Handles organization registration, password hashing (`bcrypt`), and credential creation.
  - **User Authentication**: Validates credentials and generates signed JWT Access Tokens with tenant contextual claims.
  - **Password Recovery & Security**: Complete OTP generation and verification system (`OtpService`), password reset workflows, and historical password tracking (`passwordHistory`) to prevent password reuse.

### 2.3 Tenant Microservice (`apps/tenant-service`)
- **Port**: `3002` (TCP Transport)
- **Status**: **Completed & Operational**
- **Key Features**:
  - **Dynamic Tenant Database Provisioning**: Automatically creates a dedicated PostgreSQL database (`hrms_<tenant_id>`) upon organization onboarding.
  - **Database Migration & Auto-Sync**: Runs model synchronization (`sequelize.sync()`) for new tenant databases.
  - **Database Configuration Management**: Stores connection credentials and host configurations in platform database.
  - **Tenant Deprovisioning & Cleanup**: Gracefully closes active connections, terminates DB backends (`pg_terminate_backend`), and drops tenant databases on offboarding.

### 2.4 User Microservice (`apps/user-service`)
- **Port**: `3003` (TCP Transport)
- **Status**: **Completed & Operational**
- **Key Features**:
  - **Tenant-Scoped User Management**: CRUD operations for users within specific tenant database contexts via `TenantModelProviderService`.
  - **Role-Based Access Control (RBAC)**: Manage tenant custom Roles, Permissions, User-Role mappings, and Role-Permission assignments.
  - **Permission Enforcement**: Integrates with tenant guards (`PermissionsGuard`, `RolesGuard`) for endpoint protection.

### 2.5 Shared Monorepo Infrastructure (`libs/`)

#### 1. `@app/tenant-context` (`libs/tenant-context`)
- **`TenantConnectionManager`**: Manages and caches active Sequelize connection pools per tenant ID.
- **`TenantResolverMiddleware`**: Resolves `x-tenant-id` header or JWT claims on incoming requests.
- **Guards**: `TenantGuard`, `RolesGuard`, `PermissionsGuard`.
- **Decorators**: `@CurrentTenant()`, `@CurrentUser()`, `@RequirePermissions()`, `@RequireRoles()`.

#### 2. `@app/common` (`libs/common`)
- Data Transfer Objects (DTOs): `RegisterTenantDto`, `LoginDto`, `SuperAdminLoginDto`, `OnboardOrganizationDto`, `ForgotPasswordDto`, `VerifyOtpDto`, `ResetPasswordDto`.
- Constants: Service injection tokens (`AUTH_SERVICE`, `TENANT_SERVICE`, `USER_SERVICE`), TCP message pattern mappings (`MESSAGE_PATTERNS`).
- Interceptors & Filters: Exception filters and response transformation helpers.

#### 3. `@app/database` (`libs/database`)
- Sequelize module setup, connection configuration interfaces, and migration configurations.

---

## 3. Core Database Models & Domain Schemas

All domain models are defined using `sequelize-typescript` decorators.

### 3.1 Tenant & System Administration Boundary
- `Tenant`: Main organization entity (UUID, Name, Domain, Status).
- `TenantDatabaseConfig`: Connection specs for tenant-isolated PostgreSQL databases.
- `SuperAdmin`: Platform administrators managing multi-tenant infrastructure.
- `AuthCredential`: Platform login credentials linking user email to tenant ID and role.

### 3.2 User & Access Control Boundary (Tenant-Isolated)
- `User`: User profile within a tenant organization.
- `Role`: Custom role definitions (`Admin`, `Manager`, `Employee`, etc.).
- `Permission`: Fine-grained permission strings (`user:create`, `leave:approve`, etc.).
- `UserRole` & `RolePermission`: Junction models for RBAC assignment.

### 3.3 HR & Organization Core
- `Department`: Organizational units within a tenant.
- `Designation`: Job titles and positions.
- `EmployeeProfile`: Master employee records linked to `User`, `Department`, `Designation`, and `Manager`.

### 3.4 Work & Performance Core (PRD Section 8.3)
- `Project`: Project containers owned by tenants.
- `Task`: Work tasks linked to projects and assigned to employees.
- `EmployeeOutput`: Recorded output submissions with quality scores.
- `Goal`: Quantifiable targets and KPIs.
- `PerformanceReview`: Structured periodic evaluations aggregating work output logs.

### 3.5 Attendance & Leave Management
- `Attendance`: Check-in/check-out timestamps, location, status tracking.
- `LeaveRequest`: Leave submissions, type, start/end dates, approval status.

### 3.6 Payroll Management
- `SalaryStructure`: Base salary, configurable allowances, and deductions (JSONB).
- `PayrollRecord`: Pay period calculations, tax breakdown, and net pay.

### 3.7 Recruitment & Talent Marketplace (PRD 9 & 24)
- `CandidateProfile`: Tenant-decoupled profiles enabling candidate reuse across hiring companies.
- `JobPosting`: Open requisitions per tenant.
- `JobApplication`: Application tracking pipeline (`applied`, `interview`, `hired`).

### 3.8 Learning Management System (LMS)
- `Course`: Course metadata and materials.
- `CourseEnrollment`: Employee progress percentage and completion status.

### 3.9 Innovative Extensions & Modules
- `GeofenceLocation`: Coordinates and radius boundaries for GPS-based attendance.
- `POSTransaction`: Point-of-sale transaction logs for corporate cafeterias/outlets.
- `Announcement`: Company notice board posts.
- `Survey`: Employee engagement questionnaires.
- `HRCommunityPost`: Internal discussion posts.
- `NFTReward`: Blockchain/Web3 digital achievement badges.
- `AuditLog`: System-wide security and compliance activity log.

---

## 4. System Architecture Diagram

```
                              ┌─────────────────────────┐
                              │   Web / Mobile App      │
                              └────────────┬────────────┘
                                           │ HTTP REST (Header: x-tenant-id)
                                           ▼
                              ┌─────────────────────────┐
                              │       API Gateway       │  (Port 3000 / Swagger UI)
                              └────────────┬────────────┘
                                           │ TCP Message Patterns
              ┌────────────────────────────┼────────────────────────────┐
              ▼                            ▼                            ▼
   ┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
   │    Auth Service    │       │   Tenant Service   │       │    User Service    │
   │    (Port 3001)     │       │    (Port 3002)     │       │    (Port 3003)     │
   └──────────┬─────────┘       └──────────┬─────────┘       └──────────┬─────────┘
              │                            │                            │
              └────────────────────────────┼────────────────────────────┘
                                           │ Dynamic Connection Pool
                                           ▼
                                 ┌────────────────────┐
                                 │ PostgreSQL Database│  (Platform + Tenant DBs)
                                 └────────────────────┘
```

---

## 5. Verification & Build Commands

- **Build All Services**:
  ```bash
  npm run build:all
  ```
- **Start Individual Microservices**:
  ```bash
  npm run start:auth-service    # Auth Microservice on TCP Port 3001
  npm run start:tenant-service  # Tenant Microservice on TCP Port 3002
  npm run start:user-service    # User Microservice on TCP Port 3003
  npm run start:api-gateway     # API Gateway on HTTP Port 3000
  ```
- **Access OpenAPI Swagger Docs**:
  Navigate to `http://localhost:3000/api/docs` when API Gateway is running.

---

## 6. Next Steps & Recommendations

1. **Unit & E2E Testing**: Add Jest `.spec.ts` test suites for `auth-service`, `tenant-service`, `user-service`, and `api-gateway`.
2. **Event Broker Upgrade**: Introduce RabbitMQ or NATS for asynchronous events (e.g., tenant onboarded events).
3. **Redis Context Caching**: Cache tenant database configuration lookups to accelerate connection resolution.
