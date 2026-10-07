/**
 * Central Swagger tag taxonomy for the API Gateway.
 *
 * One tag per SCREEN, grouped by portal (SuperAdmin platform console vs.
 * Organization tenant app). A screen's tabs and actions all share its single
 * heading — "SuperAdmin: System Management" holds the General, Security,
 * Domains, Maintenance and Backup endpoints together rather than splitting
 * them into sub-sections. Every operation carries exactly one of these tags.
 *
 * Within a screen, operations appear in source declaration order (the gateway
 * deliberately sets no operationsSorter), so keep related handlers next to
 * each other in the controller and the docs will read tab by tab.
 *
 * Adding an endpoint? Tag it with the screen it renders. Adding a screen?
 * Add the tag here and register it in SWAGGER_TAG_GROUPS so it takes its
 * place in the sidebar.
 */
export const TAGS = {
  // --- SuperAdmin portal ---------------------------------------------
  SA_AUTH: 'SuperAdmin: Login & Authentication',
  SA_DASHBOARD: 'SuperAdmin: Dashboard',
  SA_ORGANIZATIONS: 'SuperAdmin: Organizations',
  SA_CLIENTS: 'SuperAdmin: Clients',
  SA_SUBSCRIPTIONS: 'SuperAdmin: Subscriptions',
  SA_REPORTS: 'SuperAdmin: Reports',
  SA_AUDIT_LOGS: 'SuperAdmin: Audit Logs',
  SA_SYSTEM: 'SuperAdmin: System Management',
  SA_PROFILE: 'SuperAdmin: Profile',
  SA_HELP: 'SuperAdmin: Help & Support',

  // --- Organization portal -------------------------------------------
  ORG_ACTIVATION: 'Organization: Admin Activation',
  ORG_AUTH: 'Organization: Login & Authentication',
  ORG_SETUP: 'Organization: Setup Wizard',
  ORG_EMPLOYEES: 'Organization: Employees',
  ORG_EMPLOYEE_PORTAL: 'Organization: Employee Portal',
  ORG_HR_PORTAL: 'Organization: HR Portal',
  ORG_HR_REPORTS: 'Organization: HR Reports',
  ORG_DEPARTMENTS: 'Organization: Departments',
  ORG_ATTENDANCE: 'Organization: Attendance',
  ORG_LEAVE: 'Organization: Leave Management',
  ORG_RECRUITMENT: 'Organization: Recruitment',
  ORG_WORKSPACE: 'Organization: Workspace (Tasks, Projects, Calendar)',
  ORG_ONBOARDING: 'Organization: Onboarding',
  ORG_PERFORMANCE: 'Organization: Performance',
  ORG_PAYROLL: 'Organization: Payroll',
  ORG_ROLES: 'Organization: Roles & Permissions',
  ORG_AUDIT_LOGS: 'Organization: Audit Logs',
  ORG_POLICIES: 'Organization: Policy Engine',
  ORG_BILLING: 'Organization: Billing & Subscription',
  ORG_MODULES: 'Organization: HRMS Feature Modules',

  // --- Platform-wide / shared ----------------------------------------
  PLATFORM_FILES: 'Platform: File Storage',
  PLATFORM_HEALTH: 'Platform: Health',
} as const;

export type SwaggerTag = (typeof TAGS)[keyof typeof TAGS];

/**
 * Sidebar order + per-screen blurbs. SwaggerModule renders root-level tags in
 * the order they are registered on the DocumentBuilder, so this array is what
 * gives /api/docs its screen-by-screen reading order. Each description names
 * the tabs folded into that screen so a reader knows what to expect inside.
 */
export const SWAGGER_TAG_GROUPS: ReadonlyArray<{
  name: SwaggerTag;
  description: string;
}> = [
  // SuperAdmin portal
  {
    name: TAGS.SA_AUTH,
    description:
      'Platform console sign-in. Rate limited and exempt from the SuperAdmin guard chain.',
  },
  {
    name: TAGS.SA_DASHBOARD,
    description:
      'Dashboard screen widgets: platform status, system health and storage utilisation.',
  },
  {
    name: TAGS.SA_ORGANIZATIONS,
    description:
      'Organizations screen. KPI cards, the paginated directory table, org detail and activate/deactivate; the Add Organization wizard (per-step validation, review summary, creation, isolated-database provisioning and retry); per-org module entitlements; and organization admin invitations.',
  },
  {
    name: TAGS.SA_CLIENTS,
    description:
      'Clients screen: cross-tenant Admin/HR directory, KPI cards, role breakdown, recent additions, status changes and removal.',
  },
  {
    name: TAGS.SA_SUBSCRIPTIONS,
    description:
      'Subscriptions screen. The billing plan catalog and its create/update actions; platform billing metrics; every tenant subscription with its invoices and payments; renewals, overdue and suspended queues; and manual lifecycle actions (suspend, reactivate, mark past due, extend grace period, activate, void invoice).',
  },
  {
    name: TAGS.SA_REPORTS,
    description:
      'Reports screen. KPI cards, platform growth chart, top-organizations leaderboard, predefined templates, report generation and CSV export; plus the Custom Reports table with full CRUD, run/execute and its own CSV export.',
  },
  {
    name: TAGS.SA_AUDIT_LOGS,
    description:
      'Audit Logs screen: KPI statistics, searchable/filterable platform audit trail, single-entry before/after diff and CSV export.',
  },
  {
    name: TAGS.SA_SYSTEM,
    description:
      'System Management screen, every tab. Overview (recent activity feed); General (branding, formats, feature toggles); Security (password/session policy and the IP & CIDR allowlist); Custom Domains; Maintenance mode and system updates; Backup & Restore (schedule, retention, on-demand dumps of the platform and every tenant database, recent-backups table); and the per-microservice service health breakdown.',
  },
  {
    name: TAGS.SA_PROFILE,
    description:
      'Profile screen, every tab. Personal Information (details and avatar); Security (overview, login activity, recovery contacts, password change, TOTP two-factor setup); Notifications (channel preferences and quiet hours); and Active Sessions with single and bulk revoke.',
  },
  {
    name: TAGS.SA_HELP,
    description:
      'Help & Support screen. Landing page (categories, trending content, resource links); Knowledge Base articles and Video Tutorials, both full CRUD with view tracking; and Support Tickets, with status tallies, creation and status/priority/resolution updates.',
  },

  // Organization portal
  {
    name: TAGS.ORG_ACTIVATION,
    description:
      'Invitation landing screen: validate an invite token and activate the organization admin account.',
  },
  {
    name: TAGS.ORG_AUTH,
    description:
      'Tenant sign-in: login, 2FA challenge, token refresh, logout and tenant self-registration.',
  },
  {
    name: TAGS.ORG_SETUP,
    description:
      'Setup Wizard, every step. Completion checklist and organization profile; Departments and Designations (CRUD); Working Hours and shift configuration; Leave Policies (CRUD); Attendance Policy; and the final step that activates the tenant.',
  },
  {
    name: TAGS.ORG_EMPLOYEES,
    description:
      'Employees screen. KPI cards (Total / Active / On Leave / Resigned with month-over-month growth), the All Employees table with search and department/designation/status filters, add, edit, status change, single and bulk delete, a lightweight directory for pickers, and CSV export. Creating an employee is gated by the plan seat limit.',
  },
  {
    name: TAGS.ORG_EMPLOYEE_PORTAL,
    description:
      'Employee portal, every tab. My Dashboard, My Profile, Attendance, My Leave (balances and upcoming leave, a preview of what an application will cost, apply including half days, history, detail, edit and cancel of pending requests), My Documents (category tabs with counts, one-step upload, view and download, edit or replace until verified, expiry dates), My Requests (attendance correction, work from home, overtime, general), and Notifications. HR reviews every employee’s documents (verification queue, expiring documents, download, verify or reject with a note) and decides requests on the same tag.',
  },
  {
    name: TAGS.ORG_HR_PORTAL,
    description:
      'HR Portal. The HR Dashboard in one call — Total Employees, New Joiners (Month), Pending Onboarding, Present Today and Pending Leave, plus the Leave Approvals Pending panel where leave starting within three days is flagged Urgent and anything already started reads Overdue. Also the Onboarding Checklist Matrix (tasks as rows, new hires as columns) and employee invitations: HR invites someone by email, the link creates their login and binds it to their employee record, and resending issues a fresh token so the previous link stops working.',
  },
  {
    name: TAGS.ORG_HR_REPORTS,
    description:
      'Reports screen. The six template cards (Employee, Attendance, Leave, Onboarding, Department Summary, Custom) each showing when they were last generated, and the Generate dialog: a date range preset or a custom from/to, an optional department, and JSON for the client to render or CSV as a download.',
  },
  {
    name: TAGS.ORG_WORKSPACE,
    description:
      'Workspace screens. Tasks: KPI cards, the team task list (search, status tabs, project/assignee/priority/overdue filters), create/edit/delete with an assignment notification, and CSV export. Projects: cards with computed progress and task counts, status KPIs, create/edit/delete (tasks are kept), CSV export. Company Calendar: one month of events and holidays plus birthdays and work anniversaries from employee records. Tasks and Projects need the `projects` module; the calendar needs `calendar`.',
  },
  {
    name: TAGS.ORG_DEPARTMENTS,
    description:
      'Departments screen. KPI cards (Total Departments, Total Employees, Avg Department Size, Top Department), the table enriched with per-row headcount and manager, department manager assignment, and CSV export. Add / edit / delete reuse the Setup Wizard department endpoints.',
  },
  {
    name: TAGS.ORG_ATTENDANCE,
    description:
      "Attendance screen. KPI cards (Present / Late / Absent / On Leave today), the Attendance Overview trend chart, the Department Wise Attendance breakdown, Today's Attendance table, CSV export, and admin manual entry — single record create/correct/delete plus whole-day bulk marking. For HR: the whole screen in one call, the All Employees Attendance register (per-employee monthly summary, with CSV export), one employee's attendance calendar, and the list of employees still unmarked for a day. Present vs Late is derived from the tenant's attendance policy grace period against its configured working hours.",
  },
  {
    name: TAGS.ORG_LEAVE,
    description:
      'Leave Management screen. KPI cards (Total Requests / Approved / Pending / Rejected with month-over-month growth), the Leave Requests table behind the All Requests / Pending / Approved / Rejected tabs, CSV export, Add Leave Request, and the approve / reject / cancel / delete row actions. Leave types are the Setup Wizard leave policies; overlapping leave for one employee is refused.',
  },
  {
    name: TAGS.ORG_RECRUITMENT,
    description:
      'Recruitment screen. KPI cards (Total Open Positions / Total Applications / Shortlisted / Interviews Scheduled / Hired with month-over-month growth); the Job Openings table with full requisition CRUD, status lifecycle and CSV export; the Application Sources donut; the Recruitment Pipeline funnel, which counts how far each candidate ever got so a rejection never shrinks the upper funnel; the Top Hiring Goal widget; the Candidate Pipeline board plus candidate CRUD, stage moves and CSV export; Upcoming Interviews with scheduling, rescheduling, feedback and cancellation; and the Recent Activities feed. Moving a candidate to HIRED opens their onboarding record and seeds its checklist.',
  },
  {
    name: TAGS.ORG_ONBOARDING,
    description:
      'Onboarding screen. KPI cards (Total New Hires / Completed Onboarding / In Progress / Pending Tasks with month-over-month growth); the Onboarding Progress donut measured across checklist items; the Upcoming Tasks panel, which always surfaces overdue items; the New Hires table with CRUD and CSV export; and the per-hire checklist with add, edit, tick/untick and delete. A hire status is always derived from their checklist, so there is no endpoint that sets it directly.',
  },
  {
    name: TAGS.ORG_PERFORMANCE,
    description:
      'Performance screen. KPI cards (Total Employees, Avg Rating, Completed Reviews, Pending Reviews); the Performance Trend line; the Performance Metrics bars (Professionalism, Communication, Quality of Work, Teamwork, Leadership); the Top Performers table; and review and goal create, update and delete. Charts read completed reviews only.',
  },
  {
    name: TAGS.ORG_PAYROLL,
    description:
      'Payroll screen and Payroll Process. KPI cards (Total Payroll, Employees, Deductions, Net Pay); the Payroll Breakdown donut; the Payroll History bars; the Employee Payroll table; and the process stepper (Review, Approval, Payment, Completed). Starting a run snapshots active and on-leave employees. Line edits are allowed only in Review.',
  },
  {
    name: TAGS.ORG_ROLES,
    description:
      'Roles & Permissions screen. The permission catalog grouped by module and filtered to the tenant’s entitlements; role list/read/create/rename/delete; the role permission matrix; and per-user role assignment.',
  },
  {
    name: TAGS.ORG_AUDIT_LOGS,
    description:
      'Organization audit trail: change history for roles, permissions and users within the tenant.',
  },
  {
    name: TAGS.ORG_POLICIES,
    description:
      'Policy Engine screen. Policy CRUD and resolving the active policy for a type; the activate/deactivate/archive lifecycle; and version history plus creating a new version.',
  },
  {
    name: TAGS.ORG_BILLING,
    description:
      'Organization Billing screen, every tab. Current subscription, plan snapshot, billing summary, entitlement status, usage vs. limits, renewal, history and billing events, plus cancel/reactivate/change-plan; Invoices (history and detail); and Payments (initiate, history, detail, status polling, gateway simulation).',
  },
  {
    name: TAGS.ORG_MODULES,
    description:
      'Module-gated HRMS feature screens (dashboard, attendance geofencing, POS, announcements, surveys, Web3 rewards, community, penalties, assets, expenses, helpdesk, audit logs).',
  },

  // Platform-wide / shared
  {
    name: TAGS.PLATFORM_FILES,
    description:
      'Shared centralized file storage used by both portals: upload, metadata, download, signed URLs, query and delete.',
  },
  {
    name: TAGS.PLATFORM_HEALTH,
    description:
      'Unauthenticated liveness probe for load balancers and uptime checks.',
  },
];

/**
 * Per-portal API documentation.
 *
 * The combined document at /api/docs lists every route in the gateway, which
 * is the right reference for someone working on the platform and the wrong
 * one for someone building a single portal: a frontend team shipping the
 * employee app should not have to scroll past SuperAdmin billing to find
 * "apply for leave". Each entry below is served as its own Swagger page
 * containing only the screens that portal actually calls.
 *
 * `tags` is the portal's own screens. SHARED_TAGS are appended to every
 * portal, because login, file upload and the health probe are reachable from
 * all of them and a portal document that omitted them would be unusable on
 * its own.
 *
 * A tag may appear in more than one portal — Employees is an HR screen and an
 * Org Admin one — and the split is by audience, not by ownership.
 */
export const SHARED_TAGS: ReadonlyArray<SwaggerTag> = [
  TAGS.ORG_AUTH,
  TAGS.PLATFORM_FILES,
  TAGS.PLATFORM_HEALTH,
];

export const SWAGGER_PORTALS: ReadonlyArray<{
  slug: string;
  title: string;
  description: string;
  tags: ReadonlyArray<SwaggerTag>;
}> = [
  {
    slug: 'employee',
    title: 'HRMS Employee Portal API',
    description:
      'Employee self-service. Every route resolves to the employee record linked to the signed-in user and returns only that person’s data — My Dashboard, My Profile, Attendance (including check-in and check-out), My Leave, My Documents, My Requests and Notifications. Also the activation pages an invited employee lands on before they have a login.',
    tags: [TAGS.ORG_EMPLOYEE_PORTAL, TAGS.ORG_ACTIVATION],
  },
  {
    slug: 'hr',
    title: 'HRMS HR Portal API',
    description:
      'The HR Manager’s desk: the HR Dashboard aggregate, the employee directory and records, onboarding, attendance, leave approvals, policies and the report builder, plus the invitations that give an employee portal access.',
    tags: [
      TAGS.ORG_HR_PORTAL,
      TAGS.ORG_HR_REPORTS,
      TAGS.ORG_EMPLOYEES,
      TAGS.ORG_ONBOARDING,
      TAGS.ORG_ATTENDANCE,
      TAGS.ORG_LEAVE,
      TAGS.ORG_POLICIES,
      TAGS.ORG_DEPARTMENTS,
      TAGS.ORG_RECRUITMENT,
      TAGS.ORG_PERFORMANCE,
      TAGS.ORG_PAYROLL,
      TAGS.ORG_WORKSPACE,
    ],
  },
  {
    slug: 'org-admin',
    title: 'HRMS Organization Admin API',
    description:
      'Running the organization itself rather than its people: the setup wizard, departments and designations, roles and permissions, feature modules, billing and subscription, and the tenant audit log.',
    tags: [
      TAGS.ORG_SETUP,
      TAGS.ORG_DEPARTMENTS,
      TAGS.ORG_ROLES,
      TAGS.ORG_MODULES,
      TAGS.ORG_BILLING,
      TAGS.ORG_AUDIT_LOGS,
      TAGS.ORG_ACTIVATION,
    ],
  },
  {
    slug: 'superadmin',
    title: 'HRMS SuperAdmin Platform API',
    description:
      'The cross-tenant platform console: organizations and clients, subscriptions, platform reports, audit logs, system management and backups.',
    tags: [
      TAGS.SA_AUTH,
      TAGS.SA_DASHBOARD,
      TAGS.SA_ORGANIZATIONS,
      TAGS.SA_CLIENTS,
      TAGS.SA_SUBSCRIPTIONS,
      TAGS.SA_REPORTS,
      TAGS.SA_AUDIT_LOGS,
      TAGS.SA_SYSTEM,
      TAGS.SA_PROFILE,
      TAGS.SA_HELP,
    ],
  },
];
