export * from './exceptions';
export * from './filters';
export * from './guards';
export * from './interceptors';
export * from './pipes';
export * from './providers/resilient-client-proxy';
export * from './utils';
export * from './role-permissions';
export * from './dto/auth.dto';
export * from './dto/organization.dto';
export * from './dto/organization-module.dto';
export * from './dto/organization-role.dto';
export * from './dto/invitation.dto';
export * from './dto/setup.dto';
export * from './dto/export-limits';
export * from './dto/employee.dto';
export * from './dto/employee-portal.dto';
export * from './dto/hr-portal.dto';
export * from './dto/attendance.dto';
export * from './dto/leave.dto';
export * from './dto/recruitment.dto';
export * from './dto/onboarding.dto';
export * from './dto/organization-departments.dto';
export * from './dto/policy.dto';
export * from './dto/platform-clients.dto';
export * from './dto/platform-organizations.dto';
export * from './dto/billing.dto';
export * from './dto/profile.dto';
export * from './dto/mail.dto';
export * from './dto/file.dto';
export * from './dto/user-service.dto';
export * from './dto/reports.dto';
export * from './dto/settings.dto';
export * from './dto/backup.dto';
export * from './dto/help-support.dto';
export * from './dto/ai-assistant.dto';
export * from './dto/workspace.dto';
export * from './dto/company-document.dto';
export * from './dto/performance-payroll.dto';
export * from './dto/payroll-compliance.dto';
export * from './dto/payroll-compensation.dto';
export * from './decorators';
export * from './validators';
export * from './interfaces';
export * from './context/request-context.interface';

/**
 * DI tokens for the microservices that actually exist.
 *
 * Six further tokens used to sit here — ORGANIZATION_SERVICE,
 * ATTENDANCE_LEAVE_SERVICE, PAYROLL_SERVICE, PERFORMANCE_WORK_SERVICE,
 * RECRUITMENT_SERVICE and LMS_SERVICE — named after services in the
 * architecture document that were never built. None was injected anywhere,
 * and none had a process listening behind it.
 *
 * They are removed rather than kept as placeholders because a token that
 * resolves to nothing is worse than no token: it reads as a wiring point that
 * exists, so injecting one produced a DI failure at boot rather than a
 * compile error at the point of the mistake. The domains they named are real
 * — attendance, leave and recruitment are live today — but they live inside
 * tenant-service, and a token here implied otherwise.
 *
 * Add one back in the same commit that adds the application it points at.
 */
export const SERVICES = {
  AUTH_SERVICE: 'AUTH_SERVICE',
  TENANT_SERVICE: 'TENANT_SERVICE',
  USER_SERVICE: 'USER_SERVICE',
};

export const MESSAGE_PATTERNS = {
  HEALTH: {
    CHECK: 'health.check',
  },
  AUTH: {
    REGISTER_TENANT: 'auth.register_tenant',
    LOGIN: 'auth.login',
    SUPERADMIN_LOGIN: 'auth.superadmin_login',
    ONBOARD_ORGANIZATION: 'auth.onboard_organization',
    FORGOT_PASSWORD: 'auth.forgot_password',
    VERIFY_OTP: 'auth.verify_otp',
    RESET_PASSWORD: 'auth.reset_password',
    CREATE_ADMIN_CREDENTIAL: 'auth.create_admin_credential',
    /** Whether an email can become a login in this tenant (no login elsewhere). */
    CHECK_EMAIL_AVAILABLE: 'auth.check_email_available',
    DEACTIVATE_TENANT_CREDENTIAL: 'auth.deactivate_tenant_credential',
    VERIFY_2FA: 'auth.verify_2fa',
    REFRESH_TOKEN: 'auth.refresh_token',
    LOGOUT: 'auth.logout',
    GET_LAST_LOGINS: 'auth.get_last_logins',
    /** Whether an access token's session is still live (not logged out, revoked or expired). */
    GET_SESSION_STATE: 'auth.get_session_state',
  },
  TENANT: {
    GET_TENANT: 'tenant.get',
    /** `{ status, isActive }` only — the gateway's per-request organization check. */
    GET_ACCESS_STATE: 'tenant.get_access_state',
    GET_ALL_TENANTS: 'tenant.get_all',
    CREATE_TENANT: 'tenant.create',
    PROVISION_TENANT: 'tenant.provision',
    RETRY_PROVISION: 'tenant.retry_provision',
  },
  INVITATION: {
    CREATE: 'invitation.create',
    RESEND: 'invitation.resend',
    VALIDATE: 'invitation.validate',
    ACTIVATE: 'invitation.activate',
    VALIDATE_EMPLOYEE: 'invitation.validate_employee',
    ACTIVATE_EMPLOYEE: 'invitation.activate_employee',
  },
  USER: {
    GET_USER: 'user.get',
    GET_ALL: 'user.get_all',
    CREATE_USER: 'user.create',
    UPDATE_USER: 'user.update',
    DELETE_USER: 'user.delete',
    ASSIGN_ROLE: 'user.assign_role',
    REVOKE_ROLE: 'user.revoke_role',
    SET_ROLES: 'user.set_roles',
    CREATE_ORGANIZATION_ADMIN: 'user.create_organization_admin',
    CREATE_EMPLOYEE_USER: 'user.create_employee_user',
    GET_TENANT_USER_COUNTS: 'user.get_tenant_user_counts',
  },
  ROLE: {
    GET_ALL: 'role.get_all',
    GET_BY_ID: 'role.get_by_id',
    CREATE: 'role.create',
    UPDATE: 'role.update',
    DELETE: 'role.delete',
    ASSIGN_PERMISSION: 'role.assign_permission',
    REVOKE_PERMISSION: 'role.revoke_permission',
    SET_PERMISSIONS: 'role.set_permissions',
    RESOLVE_CREDENTIAL_PERMISSIONS: 'role.resolve_credential_permissions',
    RESOLVE_EFFECTIVE_AUTHORIZATION: 'role.resolve_effective_authorization',
  },
  PERMISSION: {
    GET_AVAILABLE: 'permission.get_available',
  },
  ORGANIZATION: {
    CREATE_ORGANIZATION: 'org.create_organization',
    VALIDATE_ONBOARDING: 'org.validate_onboarding',
    REVIEW_ONBOARDING: 'org.review_onboarding',
    GET_MODULE_ACCESS: 'org.get_module_access',
    UPDATE_MODULE_ACCESS: 'org.update_module_access',
    CHECK_MODULE_ACCESS: 'org.check_module_access',
    GET_EMPLOYEES: 'org.get_employees',
    GET_INITIAL_METADATA: 'org.get_initial_metadata',
    VALIDATE_INITIAL_STEP: 'org.validate_initial_step',
    REVIEW_INITIAL: 'org.review_initial',
    CREATE_INITIAL: 'org.create_initial',
    GET_CREATION_STATUS: 'org.get_creation_status',
  },
  ORGANIZATION_SETUP: {
    GET_PROGRESS: 'org_setup.get_progress',
    GET_PROFILE: 'org_setup.get_profile',
    GET_BRANDING: 'org_setup.get_branding',
    GET_ADMIN_AVATAR: 'org_setup.get_admin_avatar',
    UPDATE_ADMIN_AVATAR: 'org_setup.update_admin_avatar',
    UPDATE_PROFILE: 'org_setup.update_profile',
    GET_DEPARTMENTS: 'org_setup.get_departments',
    CREATE_DEPARTMENT: 'org_setup.create_department',
    UPDATE_DEPARTMENT: 'org_setup.update_department',
    DELETE_DEPARTMENT: 'org_setup.delete_department',
    GET_DESIGNATIONS: 'org_setup.get_designations',
    CREATE_DESIGNATION: 'org_setup.create_designation',
    UPDATE_DESIGNATION: 'org_setup.update_designation',
    DELETE_DESIGNATION: 'org_setup.delete_designation',
    GET_WORKING_HOURS: 'org_setup.get_working_hours',
    UPDATE_WORKING_HOURS: 'org_setup.update_working_hours',
    GET_LEAVE_POLICIES: 'org_setup.get_leave_policies',
    CREATE_LEAVE_POLICY: 'org_setup.create_leave_policy',
    UPDATE_LEAVE_POLICY: 'org_setup.update_leave_policy',
    DELETE_LEAVE_POLICY: 'org_setup.delete_leave_policy',
    GET_ATTENDANCE_POLICY: 'org_setup.get_attendance_policy',
    UPDATE_ATTENDANCE_POLICY: 'org_setup.update_attendance_policy',
    COMPLETE_SETUP: 'org_setup.complete_setup',
    GET_INDUSTRY_TEMPLATE: 'org_setup.get_industry_template',
    APPLY_INDUSTRY_TEMPLATE: 'org_setup.apply_industry_template',
  },
  /**
   * Admin-side Employees screen (organization portal, tenant-scoped). Distinct
   * from PLATFORM_CLIENTS, which is the SuperAdmin's cross-tenant Admin/HR
   * directory — these operate inside one tenant's own database.
   */
  EMPLOYEE: {
    GET_ALL: 'employee.get_all',
    GET_ONE: 'employee.get_one',
    GET_STATS: 'employee.get_stats',
    CREATE: 'employee.create',
    UPDATE: 'employee.update',
    UPDATE_STATUS: 'employee.update_status',
    DELETE: 'employee.delete',
    BULK_DELETE: 'employee.bulk_delete',
    EXPORT: 'employee.export',
    /** Lightweight id/name/code list used to populate pickers. */
    GET_DIRECTORY: 'employee.get_directory',
    /** The next EMP<n> code — what Create assigns when no code is supplied. */
    GET_NEXT_CODE: 'employee.get_next_code',
    /** Self-service: the signed-in HR/Employee account's own avatar, resolved by email — see organization-profile.controller.ts. */
    GET_MY_AVATAR: 'employee.get_my_avatar',
    UPDATE_MY_AVATAR: 'employee.update_my_avatar',
  },
  /** Admin-side Departments screen: KPI cards, enriched table, manager assignment. */
  ORGANIZATION_DEPARTMENT: {
    GET_OVERVIEW: 'org_department.get_overview',
    GET_STATS: 'org_department.get_stats',
    GET_ONE: 'org_department.get_one',
    ASSIGN_MANAGER: 'org_department.assign_manager',
    EXPORT: 'org_department.export',
  },
  /** Admin-side Leave Management screen: KPI cards, requests table, decisions. */
  LEAVE_REQUEST: {
    GET_ALL: 'leave_request.get_all',
    GET_ONE: 'leave_request.get_one',
    GET_STATS: 'leave_request.get_stats',
    CREATE: 'leave_request.create',
    UPDATE: 'leave_request.update',
    DECIDE: 'leave_request.decide',
    CANCEL: 'leave_request.cancel',
    DELETE: 'leave_request.delete',
    EXPORT: 'leave_request.export',
  },
  /** Recruitment screen: Job Openings table and requisition lifecycle. */
  JOB_OPENING: {
    GET_ALL: 'job_opening.get_all',
    GET_ONE: 'job_opening.get_one',
    CREATE: 'job_opening.create',
    UPDATE: 'job_opening.update',
    UPDATE_STATUS: 'job_opening.update_status',
    DELETE: 'job_opening.delete',
    EXPORT: 'job_opening.export',
  },
  /** Recruitment screen: applications and the Candidate Pipeline board. */
  CANDIDATE: {
    GET_ALL: 'candidate.get_all',
    GET_ONE: 'candidate.get_one',
    GET_PIPELINE: 'candidate.get_pipeline',
    CREATE: 'candidate.create',
    UPDATE: 'candidate.update',
    MOVE_STAGE: 'candidate.move_stage',
    DELETE: 'candidate.delete',
    EXPORT: 'candidate.export',
  },
  /** Recruitment screen: interview scheduling and feedback. */
  INTERVIEW: {
    GET_ALL: 'interview.get_all',
    GET_ONE: 'interview.get_one',
    GET_UPCOMING: 'interview.get_upcoming',
    SCHEDULE: 'interview.schedule',
    UPDATE: 'interview.update',
    RESCHEDULE: 'interview.reschedule',
    SUBMIT_FEEDBACK: 'interview.submit_feedback',
    CANCEL: 'interview.cancel',
    DELETE: 'interview.delete',
  },
  /** Recruitment screen: KPI cards, charts and the activity feed. */
  RECRUITMENT: {
    GET_STATS: 'recruitment.get_stats',
    GET_FUNNEL: 'recruitment.get_funnel',
    GET_APPLICATION_SOURCES: 'recruitment.get_application_sources',
    GET_HIRING_GOAL: 'recruitment.get_hiring_goal',
    GET_ACTIVITY: 'recruitment.get_activity',
  },
  /** Onboarding screen: New Hires table, KPI cards and progress donut. */
  NEW_HIRE: {
    GET_ALL: 'new_hire.get_all',
    GET_ONE: 'new_hire.get_one',
    GET_STATS: 'new_hire.get_stats',
    GET_PROGRESS: 'new_hire.get_progress',
    CREATE: 'new_hire.create',
    UPDATE: 'new_hire.update',
    DELETE: 'new_hire.delete',
    EXPORT: 'new_hire.export',
  },
  /** Onboarding screen: the per-hire checklist and Upcoming Tasks panel. */
  ONBOARDING_TASK: {
    GET_ALL: 'onboarding_task.get_all',
    GET_ONE: 'onboarding_task.get_one',
    GET_UPCOMING: 'onboarding_task.get_upcoming',
    CREATE: 'onboarding_task.create',
    UPDATE: 'onboarding_task.update',
    SET_STATUS: 'onboarding_task.set_status',
    DELETE: 'onboarding_task.delete',
  },
  PERFORMANCE: {
    GET_OVERVIEW: 'performance.get_overview',
    GET_TREND: 'performance.get_trend',
    GET_METRICS: 'performance.get_metrics',
    GET_BY_DEPARTMENT: 'performance.get_by_department',
    GET_TOP_PERFORMERS: 'performance.get_top_performers',
    GET_REVIEWS: 'performance.get_reviews',
    GET_REVIEW: 'performance.get_review',
    CREATE_REVIEW: 'performance.create_review',
    UPDATE_REVIEW: 'performance.update_review',
    DELETE_REVIEW: 'performance.delete_review',
    GET_GOALS: 'performance.get_goals',
    GET_GOAL: 'performance.get_goal',
    CREATE_GOAL: 'performance.create_goal',
    UPDATE_GOAL: 'performance.update_goal',
    DELETE_GOAL: 'performance.delete_goal',
  },
  PAYROLL: {
    GET_OVERVIEW: 'payroll.get_overview',
    GET_BREAKDOWN: 'payroll.get_breakdown',
    GET_HISTORY: 'payroll.get_history',
    GET_RUNS: 'payroll.get_runs',
    GET_RUN: 'payroll.get_run',
    CREATE_RUN: 'payroll.create_run',
    /** Review only: recompute every line from current salary, attendance and leave. */
    RECALCULATE_RUN: 'payroll.recalculate_run',
    /** Review → Approval. */
    SUBMIT_RUN: 'payroll.submit_run',
    /** Approval → Payment. Locks the run. */
    APPROVE_RUN: 'payroll.approve_run',
    /** Approval → Review, with a reason. */
    RETURN_RUN: 'payroll.return_run',
    /** Payment → Completed. */
    PAY_RUN: 'payroll.pay_run',
    GET_RUN_ACTIVITY: 'payroll.get_run_activity',
    GET_RECORDS: 'payroll.get_records',
    /** The Payroll Cycle panel: current period, pay date, next run. */
    GET_CYCLE: 'payroll.get_cycle',
    /** Validation checks, exceptions and progress for one run. */
    GET_PROCESS_CHECKS: 'payroll.get_process_checks',
    /** The Export button on Employee Payroll Summary. */
    EXPORT_RECORDS: 'payroll.export_records',
    /** One line with its full calculation and adjustments. */
    GET_RECORD: 'payroll.get_record',
    ADD_ADJUSTMENT: 'payroll.add_adjustment',
    REMOVE_ADJUSTMENT: 'payroll.remove_adjustment',
    /** Salary and bank details — payroll permissions, never employee ones. */
    GET_EMPLOYEE_PAY: 'payroll.get_employee_pay',
    SET_EMPLOYEE_SALARY: 'payroll.set_employee_salary',
    SET_EMPLOYEE_BANK: 'payroll.set_employee_bank',
    /** Payslips — completed runs only, from the locked snapshot. */
    GET_RUN_PAYSLIPS: 'payroll.get_run_payslips',
    LIST_PAYSLIPS: 'payroll.list_payslips',
    GET_RECORD_PAYSLIP: 'payroll.get_record_payslip',
    GET_RECORD_PAYSLIP_PDF: 'payroll.get_record_payslip_pdf',
    EMAIL_RECORD_PAYSLIP: 'payroll.email_record_payslip',
    EMAIL_RUN_PAYSLIPS: 'payroll.email_run_payslips',
  },
  /**
   * Payroll compliance (Pakistan): effective-dated rules, employee tax
   * profiles, statutory reports, annual summaries and tax certificates.
   */
  PAYROLL_COMPLIANCE: {
    LIST_RULES: 'payroll_compliance.list_rules',
    LIST_TEMPLATES: 'payroll_compliance.list_templates',
    CREATE_RULE: 'payroll_compliance.create_rule',
    UPDATE_RULE: 'payroll_compliance.update_rule',
    ACTIVATE_RULE: 'payroll_compliance.activate_rule',
    RETIRE_RULE: 'payroll_compliance.retire_rule',
    LIST_TAX_PROFILES: 'payroll_compliance.list_tax_profiles',
    GET_TAX_PROFILE: 'payroll_compliance.get_tax_profile',
    SAVE_TAX_PROFILE: 'payroll_compliance.save_tax_profile',
    GET_REPORT: 'payroll_compliance.get_report',
    EXPORT_REPORT: 'payroll_compliance.export_report',
    LIST_TAX_SUMMARIES: 'payroll_compliance.list_tax_summaries',
    GET_TAX_SUMMARY: 'payroll_compliance.get_tax_summary',
    ISSUE_CERTIFICATE: 'payroll_compliance.issue_certificate',
    LIST_CERTIFICATES: 'payroll_compliance.list_certificates',
    GET_CERTIFICATE_PDF: 'payroll_compliance.get_certificate_pdf',
  },
  /**
   * Payroll compensation (Phase 4): components, salary structures,
   * employee compensation, recurring items, loans, reimbursements,
   * one-off entries and the compensation import.
   */
  PAYROLL_COMPENSATION: {
    LIST_COMPONENTS: 'payroll_compensation.list_components',
    CREATE_COMPONENT: 'payroll_compensation.create_component',
    UPDATE_COMPONENT: 'payroll_compensation.update_component',
    SET_COMPONENT_STATUS: 'payroll_compensation.set_component_status',
    COMPONENT_OPTIONS: 'payroll_compensation.component_options',
    LIST_STRUCTURES: 'payroll_compensation.list_structures',
    CREATE_STRUCTURE: 'payroll_compensation.create_structure',
    UPDATE_STRUCTURE: 'payroll_compensation.update_structure',
    LIST_EMPLOYEES: 'payroll_compensation.list_employees',
    GET_COMPENSATION: 'payroll_compensation.get_compensation',
    PREVIEW_COMPENSATION: 'payroll_compensation.preview_compensation',
    SAVE_COMPENSATION: 'payroll_compensation.save_compensation',
    LIST_RECURRING: 'payroll_compensation.list_recurring',
    CREATE_RECURRING: 'payroll_compensation.create_recurring',
    UPDATE_RECURRING: 'payroll_compensation.update_recurring',
    LIST_LOANS: 'payroll_compensation.list_loans',
    CREATE_LOAN: 'payroll_compensation.create_loan',
    UPDATE_LOAN: 'payroll_compensation.update_loan',
    LIST_REIMBURSEMENTS: 'payroll_compensation.list_reimbursements',
    CREATE_REIMBURSEMENT: 'payroll_compensation.create_reimbursement',
    DECIDE_REIMBURSEMENT: 'payroll_compensation.decide_reimbursement',
    LIST_ADJUSTMENTS: 'payroll_compensation.list_adjustments',
    CREATE_ADJUSTMENT: 'payroll_compensation.create_adjustment',
    REMOVE_ADJUSTMENT: 'payroll_compensation.remove_adjustment',
    IMPORT: 'payroll_compensation.import',
  },
  /**
   * Employee portal (self-service). Every read and write is limited to the
   * employee row whose userId matches the signed-in user.
   */
  EMPLOYEE_PORTAL: {
    GET_DASHBOARD: 'employee_portal.get_dashboard',
    GET_PROFILE: 'employee_portal.get_profile',
    UPDATE_PROFILE: 'employee_portal.update_profile',
    GET_ATTENDANCE: 'employee_portal.get_attendance',
    GET_ATTENDANCE_TODAY: 'employee_portal.get_attendance_today',
    CHECK_IN: 'employee_portal.check_in',
    CHECK_OUT: 'employee_portal.check_out',
    GET_LEAVE_SUMMARY: 'employee_portal.get_leave_summary',
    GET_LEAVE_HISTORY: 'employee_portal.get_leave_history',
    APPLY_LEAVE: 'employee_portal.apply_leave',
    CANCEL_LEAVE: 'employee_portal.cancel_leave',
    PREVIEW_LEAVE: 'employee_portal.preview_leave',
    GET_LEAVE: 'employee_portal.get_leave',
    UPDATE_LEAVE: 'employee_portal.update_leave',
    GET_DOCUMENTS: 'employee_portal.get_documents',
    UPLOAD_DOCUMENT: 'employee_portal.upload_document',
    GET_DOCUMENT: 'employee_portal.get_document',
    DELETE_DOCUMENT: 'employee_portal.delete_document',
    UPDATE_DOCUMENT: 'employee_portal.update_document',
    HR_GET_DOCUMENTS: 'employee_portal.hr_get_documents',
    HR_GET_DOCUMENT: 'employee_portal.hr_get_document',
    REVIEW_DOCUMENT: 'employee_portal.review_document',
    GET_REQUESTS: 'employee_portal.get_requests',
    CREATE_REQUEST: 'employee_portal.create_request',
    UPDATE_REQUEST: 'employee_portal.update_request',
    DELETE_REQUEST: 'employee_portal.delete_request',
    CANCEL_REQUEST: 'employee_portal.cancel_request',
    DECIDE_REQUEST: 'employee_portal.decide_request',
    /** HR: every employee's requests, and the counts above them. */
    LIST_ALL_REQUESTS: 'employee_portal.list_all_requests',
    GET_REQUEST_STATS: 'employee_portal.get_request_stats',
    LIST_ALL_DOCUMENTS: 'employee_portal.list_all_documents',
    GET_DOCUMENT_STATS: 'employee_portal.get_document_stats',
    GET_NOTIFICATIONS: 'employee_portal.get_notifications',
    MARK_NOTIFICATION_READ: 'employee_portal.mark_notification_read',
    MARK_ALL_NOTIFICATIONS_READ: 'employee_portal.mark_all_notifications_read',
    /** Reporting line: my manager, peers, reports and headed departments. */
    GET_MY_TEAM: 'employee_portal.get_my_team',
    /** The organization chart. */
    GET_HIERARCHY: 'employee_portal.get_hierarchy',
    /** Whether this person leads anyone — drives the Team section of the sidebar. */
    GET_LEADERSHIP: 'employee_portal.get_leadership',
    /** The caller's own payslips — ownership from the login, not a parameter. */
    GET_MY_PAYSLIPS: 'employee_portal.get_my_payslips',
    GET_MY_PAYSLIP: 'employee_portal.get_my_payslip',
    GET_MY_PAYSLIP_PDF: 'employee_portal.get_my_payslip_pdf',
    EMAIL_MY_PAYSLIP: 'employee_portal.email_my_payslip',
    /** The caller's own annual tax summary and certificates. */
    GET_MY_TAX_SUMMARY: 'employee_portal.get_my_tax_summary',
    GET_MY_TAX_CERTIFICATES: 'employee_portal.get_my_tax_certificates',
    GET_MY_TAX_CERTIFICATE_PDF: 'employee_portal.get_my_tax_certificate_pdf',
    /** The caller's own compensation, loans and reimbursements. */
    GET_MY_COMPENSATION: 'employee_portal.get_my_compensation',
    GET_MY_REIMBURSEMENTS: 'employee_portal.get_my_reimbursements',
    SUBMIT_MY_REIMBURSEMENT: 'employee_portal.submit_my_reimbursement',
  },
  /**
   * HR Portal. The dashboard aggregate, the org-scoped report builder, and
   * the invitations that give an employee a portal login.
   */
  HR_PORTAL: {
    GET_DASHBOARD: 'hr_portal.get_dashboard',
    GET_STATS: 'hr_portal.get_stats',
    GET_INSIGHTS: 'hr_portal.get_insights',
    GET_ADMIN_OVERVIEW: 'hr_portal.get_admin_overview',
    GET_LEAVE_APPROVALS: 'hr_portal.get_leave_approvals',
    GET_ONBOARDING_MATRIX: 'hr_portal.get_onboarding_matrix',
    GET_REPORT_TEMPLATES: 'hr_portal.get_report_templates',
    GENERATE_REPORT: 'hr_portal.generate_report',
    EXPORT_REPORT: 'hr_portal.export_report',
    INVITE_EMPLOYEE: 'hr_portal.invite_employee',
    GET_INVITATIONS: 'hr_portal.get_invitations',
    RESEND_INVITATION: 'hr_portal.resend_invitation',
    REVOKE_INVITATION: 'hr_portal.revoke_invitation',
    VALIDATE_INVITATION: 'hr_portal.validate_invitation',
    ACCEPT_INVITATION: 'hr_portal.accept_invitation',
  },
  /** Admin-side Attendance screen. Reads/aggregates plus manual admin entry. */
  ATTENDANCE: {
    GET_ALL: 'attendance.get_all',
    GET_ONE: 'attendance.get_one',
    GET_STATS: 'attendance.get_stats',
    GET_OVERVIEW: 'attendance.get_overview',
    GET_BY_DEPARTMENT: 'attendance.get_by_department',
    CREATE: 'attendance.create',
    UPDATE: 'attendance.update',
    DELETE: 'attendance.delete',
    BULK_MARK: 'attendance.bulk_mark',
    EXPORT: 'attendance.export',
    GET_DASHBOARD: 'attendance.get_dashboard',
    GET_REGISTER: 'attendance.get_register',
    EXPORT_REGISTER: 'attendance.export_register',
    GET_EMPLOYEE: 'attendance.get_employee',
    GET_UNMARKED: 'attendance.get_unmarked',
  },
  ORGANIZATION_POLICY: {
    CREATE: 'org_policy.create',
    GET_ALL: 'org_policy.get_all',
    GET_ONE: 'org_policy.get_one',
    UPDATE: 'org_policy.update',
    DELETE: 'org_policy.delete',
    ACTIVATE: 'org_policy.activate',
    DEACTIVATE: 'org_policy.deactivate',
    ARCHIVE: 'org_policy.archive',
    GET_ACTIVE: 'org_policy.get_active',
    GET_VERSIONS: 'org_policy.get_versions',
    CREATE_VERSION: 'org_policy.create_version',
  },
  PERFORMANCE_WORK: {
    CREATE_PROJECT: 'work.create_project',
    LINK_OUTPUT: 'work.link_output',
  },
  /**
   * SuperAdmin read model. tenant-service owns the projection tables in the
   * platform database; every other service reaches them through these.
   */
  PROJECTION: {
    /** Apply events immediately after a tenant write — best effort. */
    APPLY: 'projection.apply',
    /** The SuperAdmin Clients listing, filtered and paged in Postgres. */
    QUERY_DIRECTORY: 'projection.query_directory',
    /** Role tallies for the Clients KPI cards. */
    DIRECTORY_STATS: 'projection.directory_stats',
    /** Per-tenant headcount rollups, replacing the user-count fan-out. */
    GET_COUNTERS: 'projection.get_counters',
    /** Outbox depth and age, for monitoring. */
    GET_LAG: 'projection.get_lag',
    /** Projection health: rows, tenants behind, and how far behind. */
    GET_HEALTH: 'projection.get_health',
    /** Remove a deprovisioned tenant's rows. */
    DROP_TENANT: 'projection.drop_tenant',
  },
  PLATFORM_CLIENTS: {
    GET_ALL: 'platform_clients.get_all',
    GET_STATS: 'platform_clients.get_stats',
    GET_BY_ROLE: 'platform_clients.get_by_role',
    GET_RECENT: 'platform_clients.get_recent',
    GET_ONE: 'platform_clients.get_one',
    UPDATE_STATUS: 'platform_clients.update_status',
    DELETE: 'platform_clients.delete',
  },
  PLATFORM_ORGANIZATIONS: {
    GET_ALL: 'platform_organizations.get_all',
    GET_STATS: 'platform_organizations.get_stats',
    GET_OVERVIEW: 'platform_organizations.get_overview',
    GET_PLAN_BREAKDOWN: 'platform_organizations.get_plan_breakdown',
    GET_ALERTS: 'platform_organizations.get_alerts',
    GET_ONE: 'platform_organizations.get_one',
    UPDATE: 'platform_organizations.update',
    UPDATE_STATUS: 'platform_organizations.update_status',
    DELETE: 'platform_organizations.delete',
  },
  PLATFORM_STATUS: {
    GET_STATUS: 'platform_status.get_status',
  },
  SETTINGS: {
    GET_GENERAL: 'settings.get_general',
    UPDATE_GENERAL: 'settings.update_general',
    GET_SECURITY: 'settings.get_security',
    UPDATE_SECURITY: 'settings.update_security',
    LIST_ALLOWED_IPS: 'settings.list_allowed_ips',
    ADD_ALLOWED_IP: 'settings.add_allowed_ip',
    REMOVE_ALLOWED_IP: 'settings.remove_allowed_ip',
    CHECK_IP_ALLOWED: 'settings.check_ip_allowed',
    LIST_DOMAINS: 'settings.list_domains',
    ADD_DOMAIN: 'settings.add_domain',
    UPDATE_DOMAIN: 'settings.update_domain',
    REMOVE_DOMAIN: 'settings.remove_domain',
    GET_MAINTENANCE: 'settings.get_maintenance',
    UPDATE_MAINTENANCE: 'settings.update_maintenance',
    GET_MAINTENANCE_STATE: 'settings.get_maintenance_state',
  },
  HELP: {
    GET_OVERVIEW: 'help.get_overview',
    GET_CATEGORIES: 'help.get_categories',
    GET_RESOURCE_LINKS: 'help.get_resource_links',
    LIST_ARTICLES: 'help.list_articles',
    GET_ARTICLE: 'help.get_article',
    CREATE_ARTICLE: 'help.create_article',
    UPDATE_ARTICLE: 'help.update_article',
    DELETE_ARTICLE: 'help.delete_article',
    LIST_VIDEOS: 'help.list_videos',
    GET_VIDEO: 'help.get_video',
    CREATE_VIDEO: 'help.create_video',
    UPDATE_VIDEO: 'help.update_video',
    DELETE_VIDEO: 'help.delete_video',
    LIST_TICKETS: 'help.list_tickets',
    GET_TICKET: 'help.get_ticket',
    CREATE_TICKET: 'help.create_ticket',
    UPDATE_TICKET: 'help.update_ticket',
  },
  BACKUP: {
    GET_SETTINGS: 'backup.get_settings',
    UPDATE_SETTINGS: 'backup.update_settings',
    CREATE_NOW: 'backup.create_now',
    LIST: 'backup.list',
    GET_ONE: 'backup.get_one',
    DELETE: 'backup.delete',
  },
  BILLING: {
    GET_PLANS: 'billing.get_plans',
    GET_PLAN_BY_ID: 'billing.get_plan_by_id',
    CREATE_PLAN: 'billing.create_plan',
    UPDATE_PLAN: 'billing.update_plan',
    GET_METRICS: 'billing.get_metrics',
    CREATE_SUBSCRIPTION: 'billing.create_subscription',
    GET_SUBSCRIPTION: 'billing.get_subscription',
    UPDATE_SUBSCRIPTION_STATUS: 'billing.update_subscription_status',
    CREATE_PAYMENT: 'billing.create_payment',
    SIMULATE_PAYMENT: 'billing.simulate_payment',
    GET_PAYMENTS: 'billing.get_payments',
    GET_PAYMENT_BY_ID: 'billing.get_payment_by_id',
    GET_PAYMENT_STATUS: 'billing.get_payment_status',
    INVOICE_CREATE: 'billing.invoice_create',
    INVOICE_GET: 'billing.invoice_get',
    INVOICE_LIST: 'billing.invoice_list',
    SUBSCRIPTION_CANCEL: 'billing.subscription_cancel',
    SUBSCRIPTION_SUSPEND: 'billing.subscription_suspend',
    SUBSCRIPTION_REACTIVATE: 'billing.subscription_reactivate',
    SUBSCRIPTION_CHANGE_PLAN: 'billing.subscription_change_plan',
    SUBSCRIPTION_RENEW: 'billing.subscription_renew',
    SUBSCRIPTION_HISTORY: 'billing.subscription_history',
    BILLING_SUMMARY: 'billing.billing_summary',
    SUPERADMIN_GET_SUBSCRIPTIONS: 'billing.superadmin_get_subscriptions',
    SUPERADMIN_GET_SUBSCRIPTION_BY_ID: 'billing.superadmin_get_subscription_by_id',
    SUPERADMIN_GET_SUBSCRIPTION_INVOICES: 'billing.superadmin_get_subscription_invoices',
    SUPERADMIN_GET_SUBSCRIPTION_PAYMENTS: 'billing.superadmin_get_subscription_payments',
    SUPERADMIN_SUSPEND_SUBSCRIPTION: 'billing.superadmin_suspend_subscription',
    SUPERADMIN_REACTIVATE_SUBSCRIPTION: 'billing.superadmin_reactivate_subscription',
    BILLING_STATUS: 'billing.status',
    BILLING_USAGE: 'billing.usage',
    BILLING_EVENTS: 'billing.events',
    UPCOMING_RENEWALS: 'billing.upcoming_renewals',
    OVERDUE_SUBSCRIPTIONS: 'billing.overdue_subscriptions',
    SUSPENDED_SUBSCRIPTIONS: 'billing.suspended_subscriptions',
    PROCESS_RENEWALS: 'billing.process_renewals',
    PROCESS_OVERDUE: 'billing.process_overdue',
    PROCESS_SUSPENSIONS: 'billing.process_suspensions',
    EXTEND_GRACE_PERIOD: 'billing.extend_grace_period',
    MARK_PAST_DUE: 'billing.mark_past_due',
    CHECK_EMPLOYEE_LIMIT: 'billing.check_employee_limit',
    CHECK_HR_USER_LIMIT: 'billing.check_hr_user_limit',
    CHECK_ADMIN_USER_LIMIT: 'billing.check_admin_user_limit',
  },
  PROFILE: {
    GET_PROFILE: 'profile.get',
    UPDATE_PROFILE: 'profile.update',
    UPDATE_AVATAR: 'profile.update_avatar',
    GET_SECURITY: 'profile.get_security',
    GET_LOGIN_ACTIVITY: 'profile.get_login_activity',
    GET_RECOVERY: 'profile.get_recovery',
    CHANGE_PASSWORD: 'profile.change_password',
    UPDATE_RECOVERY: 'profile.update_recovery',
    GENERATE_2FA: 'profile.generate_2fa',
    ENABLE_2FA: 'profile.enable_2fa',
    DISABLE_2FA: 'profile.disable_2fa',
    GET_NOTIFICATIONS: 'profile.get_notifications',
    UPDATE_NOTIFICATIONS: 'profile.update_notifications',
    GET_SESSIONS: 'profile.get_sessions',
    REVOKE_SESSION: 'profile.revoke_session',
    REVOKE_OTHER_SESSIONS: 'profile.revoke_other_sessions',
  },
  /**
   * Self-service account for a tenant user (org admin today; HR/Employee once
   * their own login exists). Backed by `AuthCredential`, not `SuperAdmin` —
   * kept separate from PROFILE above rather than parameterising it, since the
   * two sit on entirely different models with no shared shape.
   */
  TENANT_PROFILE: {
    GET_PROFILE: 'tenant_profile.get',
    UPDATE_PROFILE: 'tenant_profile.update',
    CHANGE_PASSWORD: 'tenant_profile.change_password',
  },
  MAIL: {
    SEND_EMAIL: 'mail.send_email',
    SEND_TEMPLATE_EMAIL: 'mail.send_template_email',
    VERIFY_CONNECTION: 'mail.verify_connection',
  },
  FILE: {
    UPLOAD_FILE: 'file.upload_file',
    GET_METADATA: 'file.get_metadata',
    DOWNLOAD_FILE: 'file.download_file',
    DOWNLOAD_PUBLIC_FILE: 'file.download_public_file',
    DELETE_FILE: 'file.delete_file',
    GET_ACCESS_URL: 'file.get_access_url',
    QUERY_FILES: 'file.query_files',
    GET_STORAGE_BREAKDOWN: 'file.get_storage_breakdown',
    CHECK_HEALTH: 'file.check_health',
  },
  PLATFORM_SETTINGS: {
    GET: 'platform_settings.get',
    UPDATE: 'platform_settings.update',
  },
  WORKSPACE_TASK: {
    GET_ALL: 'workspace_task.get_all',
    GET_STATS: 'workspace_task.get_stats',
    EXPORT: 'workspace_task.export',
    GET_ONE: 'workspace_task.get_one',
    CREATE: 'workspace_task.create',
    UPDATE: 'workspace_task.update',
    DELETE: 'workspace_task.delete',
    GET_PEOPLE: 'workspace_task.get_people',
    GET_MINE: 'workspace_task.get_mine',
    UPDATE_MY_STATUS: 'workspace_task.update_my_status',
  },
  WORKSPACE_PROJECT: {
    GET_ALL: 'workspace_project.get_all',
    GET_OPTIONS: 'workspace_project.get_options',
    EXPORT: 'workspace_project.export',
    CREATE: 'workspace_project.create',
    UPDATE: 'workspace_project.update',
    DELETE: 'workspace_project.delete',
  },
  CALENDAR: {
    GET_MONTH: 'calendar.get_month',
    CREATE_EVENT: 'calendar.create_event',
    UPDATE_EVENT: 'calendar.update_event',
    DELETE_EVENT: 'calendar.delete_event',
    GET_MY_MONTH: 'calendar.get_my_month',
    GET_HOLIDAYS: 'calendar.get_holidays',
    CREATE_HOLIDAY: 'calendar.create_holiday',
    UPDATE_HOLIDAY: 'calendar.update_holiday',
    DELETE_HOLIDAY: 'calendar.delete_holiday',
  },
  COMPANY_DOCUMENT: {
    GET_ALL: 'company_document.get_all',
    GET_PUBLISHED: 'company_document.get_published',
    CREATE: 'company_document.create',
    UPDATE: 'company_document.update',
    DELETE: 'company_document.delete',
  },
  AI_ASSISTANT: {
    GET_CONVERSATION: 'ai_assistant.get_conversation',
    LIST_CONVERSATIONS: 'ai_assistant.list_conversations',
    SAVE_CONVERSATION: 'ai_assistant.save_conversation',
    DELETE_CONVERSATION: 'ai_assistant.delete_conversation',
    LOG_FAILURE: 'ai_assistant.log_failure',
  },
  AUDIT: {
    QUERY_LOGS: 'audit.query_logs',
    GET_LOG_BY_ID: 'audit.get_log_by_id',
    GET_STATS: 'audit.get_stats',
    EXPORT_LOGS: 'audit.export_logs',
    QUERY_ENTITY_LOGS: 'audit.query_entity_logs',
    GET_RECENT_ACTIVITY: 'audit.get_recent_activity',
  },
  REPORTS: {
    GET_STATS: 'reports.get_stats',
    GET_PLATFORM_GROWTH: 'reports.get_platform_growth',
    GET_TOP_ORGANIZATIONS: 'reports.get_top_organizations',
    GET_TEMPLATES: 'reports.get_templates',
    GENERATE: 'reports.generate',
    EXPORT: 'reports.export',
    GET_CUSTOM_REPORTS: 'reports.get_custom_reports',
    GET_CUSTOM_REPORT_BY_ID: 'reports.get_custom_report_by_id',
    CREATE_CUSTOM_REPORT: 'reports.create_custom_report',
    UPDATE_CUSTOM_REPORT: 'reports.update_custom_report',
    DELETE_CUSTOM_REPORT: 'reports.delete_custom_report',
    RUN_CUSTOM_REPORT: 'reports.run_custom_report',
  },
};
