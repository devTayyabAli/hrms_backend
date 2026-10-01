# HRMS Microservices Architecture & Engineering Specification

> **Version**: 1.1.0 | **Pattern**: NestJS Monorepo Microservices | **Stack**: TypeScript, NestJS 11, Sequelize ORM, PostgreSQL

---

## 1. Executive Summary

This document specifies the **Microservices Architecture** for the multi-tenant HRMS Platform. Designed as a NestJS Monorepo, the platform decouples administrative HR operations from performance, work management, recruitment, and learning management to enable independent service scaling, strong tenant data security, and long-term ecosystem growth.

### Strategic Architectural Pillars
- **Strict Multi-Tenancy (Single DB Per Tenant)**: Organization context isolation (`tenantId`) is enforced at the API gateway layer and propagated asynchronously across backend microservices without context leakage. `TenantConnectionManager` resolves **one isolated database per tenant organization** (`hrms_<tenant_id>`). Domain microservices access this database via validated `TenantContext`. This architecture does **not** create a separate physical database for every microservice per tenant.
- **Core Performance & Work Linkage (PRD Section 8.3)**: Direct relational linkage connecting `Project → Task → Employee Output → Goal/KPI → Performance Review`.
- **Talent Ecosystem Preparedness**: Candidate profiles exist independently of employer tenants, allowing candidates to reuse a single profile across multiple hiring companies in Phase 2.

---

## 2. High-Level System Architecture

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
│    Auth Service    │       │  Tenant Service    │       │    User Service    │
│    (Port 3001)     │       │    (Port 3002)     │       │    (Port 3003)     │
└──────────┬─────────┘       └──────────┬─────────┘       └──────────┬─────────┘
           │                            │                            │
           └────────────────────────────┼────────────────────────────┘
                                        │ TenantContext & Connection Pool
                                        ▼
                             ┌────────────────────┐
                             │ PostgreSQL Database│  (Platform DB + hrms_<tenant_id>)
                             └────────────────────┘
```

---

## 3. Microservice Registry & Domain Breakdown

| Service Name | Port | Transport | Primary Responsibilities | Core Entities Managed |
| :--- | :--- | :--- | :--- | :--- |
| **API Gateway** | `3000` | HTTP / REST | Request routing, JWT validation, TenantGuard context extraction, Swagger UI (`/api/docs`). | N/A (Gateway Proxy) |
| **Auth Service** | `3001` | TCP | Tenant registration credentials, user authentication login, password hashing, JWT generation, OTP service. | `SuperAdmin`, `AuthCredential` |
| **Tenant Service** | `3002` | TCP | Company onboarding, database provisioning (`CREATE DATABASE hrms_<tenant_id>`), DB config management, deprovisioning. | `Tenant`, `TenantDatabaseConfig`, `Department`, `Designation` |
| **User Service** | `3003` | TCP | User management, RBAC permission roles, user-role & role-permission mappings. | `User`, `Role`, `Permission`, `UserRole`, `RolePermission` |
| **Attendance & Leave** | `3004` | TCP | Check-in/check-out tracking, working hours calculation, leave policies & approval workflows. | `Attendance`, `LeaveRequest` |
| **Payroll Service** | `3005` | TCP | Configurable salary structures, tax allowances, deductions, payslips, payroll run calculations. | `SalaryStructure`, `PayrollRecord` |
| **Performance & Work** | `3006` | TCP | Projects, tasks, work output logs, goals/KPIs, periodic performance reviews (**Core Differentiator**). | `Project`, `Task`, `EmployeeOutput`, `Goal`, `PerformanceReview` |
| **Recruitment Service**| `3007` | TCP | Job postings, candidate profiles, applicant pipeline tracking, candidate-to-employee conversion. | `CandidateProfile`, `JobPosting`, `JobApplication` |
| **LMS Service** | `3008` | TCP | Course catalogs, structured learning paths, employee training progress, internal certifications. | `Course`, `CourseEnrollment` |

---

## 4. Key Data Models & Inter-Service Relationships

### 4.1 Work & Performance Relational Linkage (PRD Section 8.3)
Work data feeds directly into objective performance reviews:
- `Project`: Project container owned by a tenant.
- `Task`: Individual work assignment linked to a `Project` and assigned to an `EmployeeProfile`.
- `EmployeeOutput`: Output submission linked to completed `Task` and target `Goal` with a quality score.
- `Goal`: Quantifiable goal/KPI assigned to an employee.
- `PerformanceReview`: Structured review pulling accumulated factual output records.

### 4.2 Candidate Profile Model (Talent Marketplace Ready)
- `CandidateProfile`: Stores candidate `firstName`, `lastName`, `email`, `cvUrl`, and `skills[]`. Decoupled from `tenantId` to allow seamless multi-company applications in post-MVP phases.

---

## 5. API Gateway Specification & Endpoint Contracts

### 5.1 Onboard Organization (`POST /api/v1/auth/register-tenant`)
Registers a new tenant organization, provisions default Admin role, creates the initial User account, and sets up the primary Employee Profile.

### 5.2 User Authentication (`POST /api/v1/auth/login`)
Authenticates user credentials against the Auth Microservice via TCP message patterns and issues signed JWT tokens.

---

## 6. Shared Monorepo Infrastructure (`libs/`)

```
libs/
├── common/                             # Shared utilities across all services
│   ├── dto/                            # Shared Data Transfer Objects (Auth, Onboarding)
│   ├── exceptions/                     # Custom exceptions (TenantException, TenantErrorCode)
│   ├── decorators/                     # Metadata decorators (@Public, @PlatformRoute, @TenantOptional)
│   ├── utils/                          # AES-256-GCM CryptoUtils for credential encryption
│   └── context/                        # RequestContextPayload & CurrentUserPayload
│
├── database/                           # Centralized generic database infrastructure
│   ├── database.module.ts              # Sequelize NestJS Module wrapper
│   └── database.types.ts               # Connection options interfaces
│
└── tenant-context/                     # Multi-Tenant isolation & resolution
    ├── context/                        # TenantConnectionManager, TenantContextService (AsyncLocalStorage)
    ├── middleware/                     # TenantResolverMiddleware (x-request-id & JWT priority resolution)
    ├── guards/                         # TenantGuard, RolesGuard, PermissionsGuard
    └── decorators/                     # @CurrentTenant(), @CurrentUser(), @RequirePermissions()
```

---

## 7. Operational Setup & Local Execution

### 7.1 Running Services Locally
```bash
# 1. Start Auth Microservice (TCP Port 3001)
npm run start:auth-service

# 2. Start Tenant Microservice (TCP Port 3002)
npm run start:tenant-service

# 3. Start User Microservice (TCP Port 3003)
npm run start:user-service

# 4. Start API Gateway (HTTP Port 3000)
npm run start:api-gateway
```

### 7.2 Accessing OpenAPI Specs
- Navigate to `http://localhost:3000/api/docs` in your browser for interactive Swagger UI documentation.
