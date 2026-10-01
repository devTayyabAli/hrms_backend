# HRM Platform — Full Module Flowcharts

**Scope:** the complete 12-area module taxonomy for the target product (Organization & Core HR through
Multi-Tenant / Enterprise Administration). Each section below is a self-contained flowchart covering every
module and sub-module listed for that area.

**How to read the status line under each heading** — this document mixes what the platform does today with
the full target design, so every section is graded against the actual `HRMS_Backend` codebase:

- ✅ **Implemented** — a real model/service backs this, with persistence and business logic.
- 🧪 **Stubbed** — the route and its guard chain exist and are wired into the module-access system, but the
  handler returns hardcoded mock data with no database model behind it yet.
- 🔲 **Planned** — no code exists for this yet; the flow below is the target design, not a description of
  running code.

Diagrams use Mermaid (`flowchart TD`/`LR`); any Markdown viewer with Mermaid support (GitHub, GitLab, VS
Code with the Mermaid extension, Obsidian) renders them directly.

---

## 1. 🏢 Organization & Core HR

**Build status:** 🚧 Mixed — `Department`, `Designation`, `WorkingHours`, `LeavePolicy`, `AttendancePolicy`
and the versioned `OrganizationPolicy` engine are ✅ implemented and physically isolated per tenant.
Branches, Teams, Grades, Cost Centers, the org chart view, full employee profile sub-records (family,
education, bank info, emergency contacts), document expiry tracking, HR letters, and policy acknowledgement
are 🔲 planned — today's `User` record only carries identity, credentials, and role assignment.

```mermaid
flowchart TD
  subgraph ORG["Organization Structure"]
    direction TB
    C["Organization / Company"] --> BR["Branches / Locations"]
    BR --> DEPT["Departments"]
    DEPT --> TEAM["Teams"]
    DEPT --> DESIG["Designations / Positions"]
    DESIG --> GRADE["Grades / Levels"]
    DEPT --> CC["Cost Centers"]
    DEPT --> ORGCHART["Reporting Hierarchy / Org Chart"]
  end

  ORG --> PI

  subgraph PROFILE["Employee Profile"]
    direction TB
    PI["Personal Information"] --> EI["Employment Information"]
    EI --> FAM["Family / Dependents"]
    EI --> EDU["Education & Experience"]
    EI --> EMG["Emergency Contacts"]
    EI --> BANK["Bank Information"]
    EI --> HIST["Employee History"]
    EI --> CONT["Contracts"]
    EI --> STAT["Employee Status"]
  end

  STAT --> D1

  subgraph DOCS["Employee Documents"]
    direction LR
    D1["Contracts"] --> D2["CNIC / ID Documents"]
    D2 --> D3["Certificates"]
    D3 --> D4["Policies"]
    D4 --> D5["HR Letters"]
    D5 --> EXP["Document Expiry Tracking"]
  end

  EXP --> P1

  subgraph POLICY["HR Policies"]
    direction LR
    P1["Leave Policy"] --> ACK["Policy Acknowledgement by employee"]
    P2["Attendance Policy"] --> ACK
    P3["Work-from-Home Policy"] --> ACK
    P4["Overtime Policy"] --> ACK
    P5["Payroll Policy"] --> ACK
    P6["Company Policy"] --> ACK
  end
```

---

## 2. 👥 Recruitment & Talent Acquisition

**Build status:** 🔲 The applicant-tracking pipeline (requisitions, postings, candidates, interviews,
offers) is entirely planned. **Onboarding:** admin invitation → activation → role assignment is
✅ implemented for the first organization admin (`OrganizationAdminInvitationService`); general employee
account creation exists at the service layer (`USER.CREATE_USER`) but isn't yet wired through the API
Gateway, and checklists/asset assignment/orientation/probation tracking are 🔲 planned. **Offboarding:**
`USER.DELETE_USER` exists at the service layer 🚧; notice period, clearance, asset return, final
settlement, and relieving letters are 🔲 planned.

```mermaid
flowchart TD
  subgraph REQ["Manpower Planning"]
    direction LR
    MR["Manpower Request"] --> JR["Job Requisition"]
    JR --> JP["Job Posting"]
    JP --> CP["Careers Page"]
  end

  CP --> CDB

  subgraph ATS["Candidate Pipeline / ATS"]
    direction TB
    CDB["Candidate Database"] --> CV["CV / Resume Management"]
    CV --> PIPE["Candidate Pipeline Stages"]
    PIPE --> INT["Interview Scheduling"]
    INT --> FB["Interview Feedback"]
    FB --> EVAL["Candidate Evaluation"]
  end

  EVAL --> OFFER["Job Offer"]
  OFFER --> OA["Offer Approval"]
  OA --> COMM["Candidate Communication"]
  COMM -->|"accepted"| PB

  subgraph ONB["Onboarding"]
    direction TB
    PB["Pre-boarding"] --> JC["Joining Checklist"]
    JC --> DC["Document Collection"]
    DC --> EAC["Employee Account Creation"]
    EAC --> DA["Department Assignment"]
    DA --> AA["Equipment / Asset Assignment"]
    AA --> ORNT["Orientation"]
    ORNT --> PROB["Probation Tracking"]
  end

  PROB -->|"confirmed"| ACTIVE(["Active Employee"])
  ACTIVE -->|"resigns or terminated"| RES

  subgraph OFF["Offboarding / Separation"]
    direction TB
    RES["Resignation / Termination"] --> NP["Notice Period"]
    NP --> EXIT["Exit Interview"]
    EXIT --> CLR["Clearance"]
    CLR --> AR["Asset Return"]
    AR --> FS["Final Settlement"]
    FS --> REL["Experience / Relieving Letter"]
  end
```

---

## 3. ⏰ Time & Workforce Management

**Build status:** 🚧 Mixed — Leave Policy, Attendance Policy, and Working Hours are ✅ implemented as
tenant-scoped configuration. Actual attendance capture (check-in/out, biometric, mobile, GPS, IP), shift
templates, rotations, roster planning, leave requests with balances/accrual/carry-forward, and overtime
requests/calculation are 🔲 planned. A `penalties` route is 🧪 stubbed under the Attendance module (mock
data only).

```mermaid
flowchart TD
  subgraph SHIFT["Shift & Roster Management"]
    direction LR
    ST["Shift Templates"] --> ES["Employee Shifts"]
    ES --> ROT["Rotations"]
    ES --> WO["Weekly Offs"]
    ES --> NS["Night Shifts"]
    ROT --> ROSTER["Roster Planning"]
    WO --> ROSTER
    NS --> ROSTER
  end

  ROSTER --> CIO

  subgraph ATT["Attendance Management"]
    direction TB
    CIO["Check-in / Check-out"] --> METHOD{"Capture method"}
    METHOD --> BIO["Biometric Integration"]
    METHOD --> MOB["Mobile Attendance"]
    METHOD --> GPS["GPS / Geo Attendance"]
    METHOD --> IP["IP Attendance"]
    BIO --> RULES["Late / Early Rules"]
    MOB --> RULES
    GPS --> RULES
    IP --> RULES
    RULES --> MISS["Missing Punches"]
    MISS --> CORR["Attendance Corrections"]
  end

  subgraph LEAVE["Leave Management"]
    direction TB
    LT["Leave Types"] --> LP["Leave Policies"]
    LP --> LB["Leave Balances"]
    LB --> ACCR["Leave Accrual"]
    LB --> CF["Carry Forward"]
    LB --> ENC["Leave Encashment"]
    LREQ["Leave Requests"] --> APPR["Approval Workflow"]
    APPR -->|"approved"| LB
    HOL["Holiday Calendar"] -.->|"blocks weekends/holidays"| LREQ
  end

  subgraph OT["Overtime Management"]
    direction LR
    OTR["Overtime Requests"] --> OTA["Approval"]
    OTA --> OTRULE["Overtime Rules"]
    OTRULE --> OTCALC["Overtime Calculation"]
    OTCALC --> PAYINT["Payroll Integration"]
  end

  CORR --> LREQ
  ENC --> OTR
```

---

## 4. 💰 Payroll & Finance

**Build status:** 🔲 Entirely planned. `PAYROLL` exists only as one of seven `PolicyType` values in the
dynamic organization-policy engine — a policy record, not a calculation engine. `pos/transactions` and
`expenses` routes are 🧪 stubbed (mock data, gated by real guards, no persistence).

```mermaid
flowchart TD
  subgraph STRUCT["Salary Structure"]
    direction LR
    BS["Basic Salary"] --> ALW["Allowances"]
    ALW --> DED["Deductions"]
    DED --> BON["Bonuses"]
    BON --> OT2["Overtime"]
    OT2 --> TAX["Tax"]
    TAX --> LOAN["Loan Recovery"]
    LOAN --> ADV["Advance Recovery"]
  end

  ADV --> RUN["Payroll Processing Run"]
  RUN --> SLIP["Payslips"]
  SLIP --> HIST2["Payroll History"]
  HIST2 --> REP["Payroll Reports"]

  subgraph COMP["Compensation Management"]
    direction LR
    SG["Salary Grades"] --> SS2["Salary Structures"]
    SS2 --> SR["Salary Revision"]
    SR --> INC["Annual Increment"]
    SR --> BONUS2["Bonus"]
    SR --> INCV["Incentives"]
    INC --> CPLAN["Compensation Planning"]
    BONUS2 --> CPLAN
    INCV --> CPLAN
  end

  subgraph BEN["Benefits Management"]
    direction LR
    MED["Medical"] --> ELIG["Benefit Eligibility"]
    INS["Insurance"] --> ELIG
    ALWB["Employee Benefits / Allowances"] --> ELIG
    ELIG --> CLAIM["Benefit Claims"]
  end

  subgraph LOANS["Loans & Advances"]
    direction LR
    LREQ2["Employee Loan / Salary Advance Request"] --> LAPPR["Approval"]
    LAPPR --> INST["Installments"]
    INST --> REC["Recovery"]
    REC --> OB["Outstanding Balance"]
  end

  subgraph EXP2["Expense & Reimbursement"]
    direction LR
    ECLAIM["Expense Claim — Travel / Medical"] --> EAPPR["Approval"]
    EAPPR --> REIMB["Reimbursement"]
    REIMB --> PT["Payment Tracking"]
  end

  CPLAN --> STRUCT
  REC --> LOAN
  CLAIM --> ALW
  PT --> DED
```

---

## 5. 📈 Performance & Development

**Build status:** 🔲 Entirely planned. `surveys` and `web3/nft-rewards` routes are 🧪 stubbed under the
Performance module (mock data only, no assessment/rating model exists).

```mermaid
flowchart TD
  subgraph PERF["Performance Management"]
    direction TB
    GOAL["Goals / KPIs / OKRs"] --> CYCLE["Appraisal Cycle Opens"]
    CYCLE --> SELF3["Self Assessment"]
    CYCLE --> MGR["Manager Assessment"]
    CYCLE --> F360["360-Degree Feedback"]
    SELF3 --> REVIEW["Performance Review"]
    MGR --> REVIEW
    F360 --> REVIEW
    REVIEW --> RATING["Performance Rating"]
    RATING -->|"below target"| PIP["Improvement Plan"]
    RATING -->|"meets or exceeds"| GROW
  end

  PIP --> NEED

  subgraph LEARN["Learning & Development"]
    direction TB
    NEED["Training Need Identified"] --> PROG["Training Programs / Courses"]
    PROG --> CAL["Training Calendar"]
    CAL --> TRAIN["Trainers Assigned"]
    TRAIN --> ENROLL["Employee Enrollment"]
    ENROLL --> CERT["Certifications"]
    ENROLL --> TFB["Training Feedback"]
    TFB --> THIST["Training History"]
  end

  subgraph TALENT["Career & Talent Management"]
    direction TB
    GROW["Career Paths"] --> SKILL["Skills / Competencies"]
    SKILL --> POOL["Talent Pool"]
    POOL --> HIPO["High-Potential Employees"]
    HIPO --> SUCC["Succession Planning"]
    SUCC --> PROMO["Promotion Planning"]
  end

  RATING --> GROW
  CERT --> SKILL
```

---

## 6. 📋 Work & Productivity

**Build status:** 🔲 Entirely planned — no project, task, or timesheet model exists in the current
codebase.

```mermaid
flowchart TD
  subgraph PROJ["Project Management"]
    direction LR
    P1b["Projects"] --> PT2["Project Teams"]
    PT2 --> PA["Project Assignments"]
    P1b --> PB2["Project Budgets"]
    PA --> PP["Project Progress"]
  end

  PP --> T1

  subgraph TASK["Task Management"]
    direction LR
    T1["Tasks"] --> ST2["Subtasks"]
    T1 --> PRI["Priorities"]
    T1 --> ASSIGN2["Assignments"]
    T1 --> DL["Deadlines"]
    PRI --> TS["Task Status"]
    ASSIGN2 --> TS
    DL --> TS
  end

  TS --> ETS

  subgraph TIME2["Timesheets / Time Tracking"]
    direction LR
    ETS["Employee Timesheets"] --> PH["Project Hours"]
    PH --> BH["Billable Hours"]
    BH --> TAPPR["Approval"]
    TAPPR --> PROD["Productivity Reports"]
  end

  subgraph WF["Workflows & Approvals"]
    direction LR
    CHAIN["Approval Chains"] --> MULTI["Multi-Level Approval"]
    MULTI --> COND["Conditional Approval"]
    MULTI --> DELEG["Delegation"]
    COND --> ESC["Escalation"]
    DELEG --> ESC
    ESC --> BUILDER["Workflow Builder"]
  end

  TAPPR -.->|"routes through"| CHAIN
  PA -.->|"routes through"| CHAIN
```

---

## 7. 🧑‍💼 Employee Experience

**Build status:** 🚧 Mixed — profile, avatar, security (password/2FA/sessions/login activity), and
notification-preference self-service are ✅ implemented (`auth-service` profile endpoints). Payslips,
leave, and expense self-service have no backing feature yet. `announcements`, `surveys`, and
`community/posts` are 🧪 stubbed; `tickets` (Helpdesk) is 🧪 stubbed. Manager Self-Service and formal
Grievance case management are 🔲 planned.

```mermaid
flowchart TD
  subgraph ESS["Employee Self-Service"]
    direction LR
    E1["Profile"] --> E9["Notifications"]
    E2["Attendance"] --> E9
    E3["Leave"] --> E9
    E4["Payslips"] --> E9
    E5["Documents"] --> E9
    E6["Expenses"] --> E9
    E7["Requests"] --> E9
    E8["Benefits"] --> E9
  end

  E9 -->|"approvals route up to"| M1

  subgraph MSS["Manager Self-Service"]
    direction TB
    M1["Team Dashboard"] --> M2["Team Attendance"]
    M1 --> M3["Leave Approvals"]
    M1 --> M4["Expense Approvals"]
    M1 --> M5["Performance"]
    M1 --> M6["Team Documents"]
    M1 --> M7["Team Reports"]
  end

  E9 --> SUR

  subgraph ENG["Employee Engagement"]
    direction LR
    SUR["Surveys"] --> FBK["Feedback"]
    FBK --> POLL["Polls"]
    POLL --> REC2["Recognition"]
    REC2 --> ANN["Announcements"]
    ANN --> BDAY["Birthdays / Work Anniversaries"]
  end

  E9 --> Q

  subgraph HELP["Helpdesk / HR Tickets"]
    direction LR
    Q["HR Query"] --> TIX["Ticket Created"]
    TIX --> CAT["Categorized"]
    CAT --> PRIO["Priority Set"]
    PRIO --> ASSIGN3["Assigned"]
    ASSIGN3 --> SLA["SLA Timer"]
    SLA --> RES2["Resolution"]
  end

  RES2 -.->|"escalates if unresolved"| COMP

  subgraph GRIEV["Grievances"]
    direction LR
    COMP["Complaint / Grievance"] --> INV["Investigation"]
    INV --> CASE["Case Management"]
    CASE --> RESG["Resolution"]
  end
```

---

## 8. 💻 Assets, Documents & Communication

**Build status:** 🚧 Mixed — generic file upload/download/metadata/delete (S3 or local disk, tenant-scoped
access checks) and transactional email (`MAIL.SEND_EMAIL`/`SEND_TEMPLATE_EMAIL`) are ✅ implemented. An
`assets` route is 🧪 stubbed (mock list, not backed by the real file/asset model). HR letter templates,
SMS/push/internal chat, and document versioning/expiry alerts are 🔲 planned.

```mermaid
flowchart TD
  subgraph ASSET["Asset Management"]
    direction LR
    AT["Laptops / Phones / Equipment"] --> AASSIGN["Asset Assignment"]
    AASSIGN --> ARET["Asset Return"]
    AASSIGN --> MAINT["Maintenance"]
    ARET --> AHIST["Asset History"]
    MAINT --> AHIST
  end

  AHIST --> HD

  subgraph DOC2["Document Management"]
    direction LR
    HD["HR Documents"] --> TMPL["Templates"]
    ED2["Employee Documents"] --> TMPL
    TMPL --> VER["Versioning"]
    VER --> EXPD["Expiry Alerts"]
    EXPD --> STORE["Digital Storage"]
  end

  STORE --> OL

  subgraph LETTER["HR Letters"]
    direction LR
    OL["Offer Letter"] --> APL["Appointment Letter"]
    APL --> EL["Experience Letter"]
    EL --> PL["Promotion Letter"]
    PL --> WL["Warning Letter"]
    WL --> SRL["Salary Revision Letter"]
    SRL --> RL["Relieving Letter"]
  end

  subgraph COMM2["Communication"]
    direction LR
    ANNC["Announcements"] --> ENOTIF["Employee Notifications"]
    MAIL["Email"] --> ENOTIF
    SMS2["SMS"] --> ENOTIF
    PUSH["Push Notifications"] --> ENOTIF
    CHAT["Internal Chat"] --> ENOTIF
  end

  RL --> ENOTIF
```

---

## 9. 📊 Reports, Analytics & Intelligence

**Build status:** 🔲 Mostly planned. A real entity-change audit trail (`AUDIT.QUERY_ENTITY_LOGS`) exists
✅ for Users/Roles/Permissions. A `dashboard` route and a separate `audit-logs` route under the Modules
controller are 🧪 stubbed (hardcoded numbers, not the real audit trail). Headcount/attrition/recruitment
reports, analytics, role-scoped dashboards, and the AI assistant are 🔲 planned.

```mermaid
flowchart TD
  subgraph REP2["HR Reports"]
    direction LR
    R1["Headcount"] --> R6["Turnover"]
    R2["Attendance"] --> R6
    R3["Leave"] --> R6
    R4["Payroll"] --> R6
    R5["Recruitment"] --> R6
    R6 --> R7["Performance"]
    R7 --> R8["Training"]
    R8 --> R9["Expenses"]
  end

  R9 --> A1

  subgraph ANLY["HR Analytics"]
    direction LR
    A1["Workforce Analytics"] --> A2["Attrition Analytics"]
    A2 --> A3["Recruitment Analytics"]
    A3 --> A4["Salary Analytics"]
    A4 --> A5["Attendance Analytics"]
    A5 --> A6["Performance Analytics"]
    A6 --> A7["Department Analytics"]
  end

  A7 --> DA1

  subgraph DASH["Dashboards — role-scoped"]
    direction LR
    DA1["Super Admin Dashboard"] --> DA2["HR Dashboard"]
    DA2 --> DA3["Manager Dashboard"]
    DA3 --> DA4["Employee Dashboard"]
    DA4 --> DA5["Executive Dashboard"]
  end

  DA5 --> AIQ

  subgraph AI["AI HR Assistant"]
    direction LR
    AIQ["HR Q&A"] --> AIREC["HR Recommendations"]
    AII["Employee Insights"] --> AIREC
    AICV["CV Screening"] --> AIREC
    AIAT["Attendance Anomaly Detection"] --> AIREC
    AIAP["Attrition Prediction"] --> AIREC
    AIPA["Payroll Analysis"] --> AIREC
  end
```

---

## 10. 🔐 Administration, Security & Platform

**Build status:** ✅ Mostly implemented — Roles, Permissions, module/action-level access, Users,
Invitations, Account Activation, 2FA, Sessions, Login History, and Audit Logs are all real and enforced by
the JWT → Tenant → Roles → Permissions → Module guard chain. System Settings (localization, currency, time
zone, custom fields), notification templates, and third-party Integrations (biometric devices, banking,
accounting, SMS, WhatsApp, calendar, webhooks) are 🔲 planned — a signed REST API between the gateway and
microservices already exists as the platform's own internal integration layer.

```mermaid
flowchart TD
  subgraph RBAC["Roles & Permissions"]
    direction LR
    ROLE2["Roles"] --> PERM2["Permissions"]
    PERM2 --> MODA["Module Access"]
    MODA --> ACTA["Action Permissions"]
    ACTA --> ORGA["Organization-Level Access"]
    ACTA --> DEPTA["Department-Level Access"]
    ACTA --> BRA["Branch-Level Access"]
  end

  ORGA --> USR2

  subgraph USERADM["User & Account Management"]
    direction LR
    USR2["Users"] --> INV2["Invitations"]
    INV2 --> ACTIV["Account Activation"]
    USR2 --> PWD["Password Management"]
    USR2 --> TFA2["2FA"]
    USR2 --> SESS["Sessions"]
    USR2 --> LOGH["Login History"]
  end

  ACTIV --> LL

  subgraph AUDIT3["Audit Logs"]
    direction LR
    LL["Login Logs"] --> AH["Approval History"]
    DCH["Data Changes"] --> AH
    AA2["Admin Actions"] --> AH
    SE["Security Events"] --> AH
  end

  AH --> ETMPL

  subgraph NOTIF["Notifications Management"]
    direction LR
    ETMPL["Email Templates"] --> AALERT["Automated Alerts"]
    STMPL["SMS Templates"] --> AALERT
    PTMPL["Push Notifications"] --> AALERT
    NPREF["Notification Preferences"] --> AALERT
  end

  AALERT --> GEN

  subgraph SETT["System Settings"]
    direction LR
    GEN["General Settings"] --> LOC["Localization"]
    LOC --> CUR["Currency"]
    LOC --> TZ["Time Zone"]
    LOC --> DFMT["Date Formats"]
    LOC --> NFMT["Number Formats"]
    GEN --> CF["Custom Fields"]
  end

  SETT --> BIO2

  subgraph INTEG["Integrations"]
    direction LR
    BIO2["Biometric Devices"] --> API2["REST APIs"]
    BANKI["Banking"] --> API2
    ACC["Accounting"] --> API2
    MAILI["Email"] --> API2
    SMSI["SMS"] --> API2
    WA["WhatsApp"] --> API2
    CAL["Calendar"] --> API2
    API2 --> WH["Webhooks"]
  end
```

---

## 11. 🌍 Compliance

**Build status:** 🔲 Entirely planned — no statutory-compliance or health-and-safety model exists in the
current codebase.

```mermaid
flowchart TD
  subgraph STAT["Statutory & Compliance"]
    direction LR
    TAX2["Tax"] --> CREP["Compliance Reports"]
    EOBI["EOBI"] --> CREP
    SS2b["Social Security"] --> CREP
    PF["Provident Fund"] --> CREP
    GRAT["Gratuity"] --> CREP
    LAB["Labor Compliance"] --> CREP
  end

  CREP --> CDOC["Compliance Documents"]
  CDOC --> INC2

  subgraph SAFE["Health & Safety"]
    direction LR
    INC2["Workplace Incidents"] --> SREC["Safety Records"]
    SREC --> MREC["Medical Records"]
    SREC --> STRN["Safety Training"]
  end
```

---

## 12. 🏢 Multi-Tenant / Enterprise Administration

**Build status:** ✅ Implemented — this is the most mature area of the platform today. Organization
onboarding, tenant provisioning (one physical database per tenant), organization admins, platform
users/roles, subscriptions/plans/payments/invoices, usage limits, module entitlements, and tenant
configuration (settings, enabled modules, policies, departments, designations) are all real. Platform
monitoring (system health, service monitoring, tenant usage, API usage, error logs) is 🔲 planned beyond a
basic health-check endpoint per service.

```mermaid
flowchart TD
  subgraph SAORG["Super Admin — Organizations"]
    direction LR
    ONB2["Organization Onboarding"] --> OST["Organization Status"]
    OST --> TPROV["Tenant Provisioning"]
    TPROV --> OADM["Organization Admins"]
  end

  OADM --> PU

  subgraph PLATU["Platform Users"]
    direction LR
    PU["Platform Users"] --> PROLE["Platform Roles"]
    PROLE --> PPERM["Platform Permissions"]
  end

  PPERM --> PLAN2

  subgraph SUBB["Subscription & Billing"]
    direction LR
    PLAN2["Plans"] --> SUB2["Subscriptions"]
    SUB2 --> PAY2["Payments"]
    PAY2 --> INV3["Invoices"]
    SUB2 --> LIM["Usage Limits"]
    SUB2 --> ENT["Module Entitlements"]
    PAY2 --> BHIST["Billing History"]
    INV3 --> BHIST
  end

  BHIST --> OS2

  subgraph TCFG["Tenant Configuration"]
    direction LR
    OS2["Organization Settings"] --> EM2["Enabled Modules"]
    OS2 --> POL2["Policies"]
    OS2 --> DEP2["Departments"]
    OS2 --> DES2["Designations"]
    OS2 --> AR2["Approval Rules"]
    OS2 --> CF2["Custom Fields"]
    OS2 --> BRAND["Branding"]
  end

  TCFG --> SH

  subgraph MON["Platform Monitoring"]
    direction LR
    SH["System Health"] --> AUDL["Audit Logs"]
    SVCM["Service Monitoring"] --> AUDL
    TU["Tenant Usage"] --> AUDL
    APIU["API Usage"] --> AUDL
    ERRL["Error Logs"] --> AUDL
  end
```

---

## Appendix — mapping to a 12-row product sidebar

If these 12 detailed areas get collapsed into a simpler product sidebar, they map onto a 12-row structure
like this (Learning splits out of Performance & Development; Compliance and Multi-Tenant Administration
fold into a broader Administration row):

| # | Sidebar area | Detailed sections above |
|---|---|---|
| 1 | Core HR | §1 Organization & Core HR |
| 2 | Recruitment | §2 Recruitment (ATS portion) |
| 3 | Onboarding | §2 Recruitment (Onboarding/Offboarding portion) |
| 4 | Time & Attendance | §3 Time & Workforce Management |
| 5 | Payroll & Finance | §4 Payroll & Finance |
| 6 | Performance & Talent | §5 Performance & Development (Performance + Talent) |
| 7 | Learning | §5 Performance & Development (L&D portion) |
| 8 | Work Management | §6 Work & Productivity |
| 9 | Employee Experience | §7 Employee Experience |
| 10 | Assets & Communication | §8 Assets, Documents & Communication |
| 11 | Reports & AI | §9 Reports, Analytics & Intelligence |
| 12 | Administration | §10 Administration, §11 Compliance, §12 Multi-Tenant Administration |
