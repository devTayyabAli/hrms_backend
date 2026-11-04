/**
 * The system roles every organization starts with.
 *
 * Authorization comes from the tenant database: a user's `user_roles` →
 * `roles` → `role_permissions`. auth-service resolves that into the JWT's
 * `roles` / `permissions` claims at login and on every refresh, and
 * `PermissionsGuard` enforces the permissions on every tenant route.
 * `defaultPermissions` below is only what a system role is seeded with the
 * first time it's set up.
 */

/**
 * The wildcard permission claim a full-access role carries. The Organization
 * Admin has it. The Administration role does not: that role is granted only
 * what is listed on it. An empty `permissions` claim means "no permissions",
 * never "everything".
 */
export const FULL_ACCESS_PERMISSION = '*';

/** Portal roles an employee invitation can mint a credential for. */
export enum EmployeePortalRole {
  HR = 'HR',
  EMPLOYEE = 'Employee',
}

export const ORG_ADMIN_ROLE_NAME = 'ORGANIZATION_ADMIN';

/** Operational admin: the grants we keep off the full-access Organization Admin. */
export const ADMINISTRATION_ROLE_NAME = 'Administration';

/**
 * What Administration can never lose. Without these nobody holding only that
 * role could open Roles & Permissions or Settings again. The Organization
 * Admin is unaffected: that role is full access and is not edited here.
 */
export const ADMIN_REQUIRED_PERMISSIONS: readonly string[] = ['user_management.manage', 'settings.manage'];

/**
 * Whose records a role's permissions reach. Permissions say *what* someone
 * may do (view employees, approve leave); the data scope says *on whom*:
 *
 * - ORGANIZATION — everyone.
 * - BRANCH       — the branch(es) they head, or the branch they work in.
 * - DEPARTMENT   — the department(s) they manage, or their own department.
 * - TEAM         — the people who report to them, directly or further down.
 * - SELF         — only their own record.
 */
export enum DataScope {
  ORGANIZATION = 'ORGANIZATION',
  BRANCH = 'BRANCH',
  DEPARTMENT = 'DEPARTMENT',
  TEAM = 'TEAM',
  SELF = 'SELF',
}

export interface SystemTenantRoleDef {
  /** `roles.name` in the tenant database. */
  name: string;
  /** The `AuthCredential.role` value that signs in as this role. */
  credentialRole: string;
  description: string;
  defaultPermissions: string[];
  /**
   * Full access, never editable. Only the Organization Admin. It signs in
   * with `*` and `isFullAccess`, which PermissionsGuard treats as unrestricted.
   */
  locked?: boolean;
  /**
   * Whose records the role reaches the first time it is seeded. Omitted
   * means the historical default (SELF for Employee, ORGANIZATION otherwise).
   * Written once; an organization can change it later when `scopeEditable`.
   */
  dataScope?: DataScope;
  /**
   * The name stays fixed and the role cannot be deleted, but an admin may
   * change whose records it reaches. Used by the starter roles (Finance,
   * Department Head, Team Lead, IT). HR and Employee stay fixed.
   */
  scopeEditable?: boolean;
}

export const SYSTEM_TENANT_ROLES: SystemTenantRoleDef[] = [
  {
    name: ORG_ADMIN_ROLE_NAME,
    credentialRole: 'Admin',
    description: 'Organization Administrator with full tenant access',
    defaultPermissions: [],
    locked: true,
  },
  {
    name: ADMINISTRATION_ROLE_NAME,
    credentialRole: ADMINISTRATION_ROLE_NAME,
    description:
      'Runs day-to-day administration: settings, structure, users, roles, modules, billing and policies. Payroll, performance reviews and recruitment are not included until granted here.',
    // Not full access. No payroll (any area), no performance, no recruitment
    // or onboarding. Those are granted on the matrix when the organization
    // wants them. Always sees the whole organization.
    defaultPermissions: [
      ...ADMIN_REQUIRED_PERMISSIONS,
      'dashboard.view',
      'departments.manage',
      // Chooses who approves each kind of request.
      'workflows.manage',
      'billing.manage',
      'reports.view',
      'reports.export',
      'employee.view',
      'employee.create',
      'employee.edit',
      'attendance.view',
      'leave_management.view',
      'projects.view',
      'tasks.view',
      'calendar.manage',
      'documents.manage',
      'messages.manage',
      'assets.view',
      'tickets.view',
      // Sees who is leaving, not their clearance or settlement.
      'offboarding.view',
      'learning.manage',
    ],
    dataScope: DataScope.ORGANIZATION,
  },
  {
    name: EmployeePortalRole.HR,
    credentialRole: EmployeePortalRole.HR,
    description: 'Human Resources portal role',
    defaultPermissions: [
      'employee.manage',
      'departments.manage',
      'attendance.manage',
      'leave_management.manage',
      'onboarding.manage',
      // Starts offboarding and clears HR's part of it.
      'offboarding.manage',
      'recruitment.manage',
      'performance.manage',
      // Runs training: builds courses and assigns them. Deleting one stays a separate grant.
      'learning.view',
      'learning.create',
      'learning.edit',
      'learning.assign',
      'learning.export',
      // Prepares payroll; approving it is a separate grant (payroll.approve).
      'payroll.view',
      'payroll.create',
      'payroll.edit',
      // Keeps employees' tax profiles; changing the tax rules themselves is
      // payroll.compliance.manage, which HR doesn't start with.
      'payroll.tax.manage',
      'payroll.compliance.view',
      // Workspace is view-only until an admin grants edit. Organizations that
      // already configured this role keep whatever they saved.
      'tasks.view',
      'projects.view',
      'calendar.manage',
      'documents.manage',
    ],
  },
  {
    name: EmployeePortalRole.EMPLOYEE,
    credentialRole: EmployeePortalRole.EMPLOYEE,
    description: 'Employee self-service portal role',
    defaultPermissions: [],
  },
  {
    name: 'Finance',
    credentialRole: 'Finance',
    description:
      'Payroll, compensation, loans, adjustments and payroll approval. No performance reviews or general HR records. Permissions and data access can be changed.',
    // No payroll.manage: that would also open tax rules and compliance setup.
    // No reports.view: that catalogue includes workforce reports.
    defaultPermissions: [
      'payroll.view',
      'payroll.create',
      'payroll.edit',
      'payroll.approve',
      'payroll.export',
      'payroll.compensation.view',
      'payroll.compensation.manage',
      // Approves proposed salary changes (never its own: the proposer cannot approve).
      'payroll.compensation.approve',
      'payroll.components.view',
      'payroll.components.manage',
      'payroll.loans.view',
      'payroll.loans.manage',
      'payroll.adjustments.view',
      'payroll.adjustments.manage',
    ],
    dataScope: DataScope.ORGANIZATION,
    scopeEditable: true,
  },
  {
    name: 'Department Head',
    credentialRole: 'Department Head',
    description:
      'Sees the department they manage: employee directory, attendance, leave decisions, goals and reviews, projects and tasks. Not payroll or company-wide settings. Permissions and data access can be changed.',
    // leave_management.edit is what approves a request. It is also the grant
    // for editing a leave policy; the policies screen stays hidden unless the
    // role is organization-wide.
    // Performance and projects follow the data scope, so goals, reviews and
    // projects here are the department's own.
    defaultPermissions: [
      'employee.view',
      'attendance.view',
      'leave_management.view',
      'leave_management.edit',
      'performance.view',
      'performance.create',
      'performance.edit',
      'projects.view',
      'projects.create',
      'projects.edit',
      'tasks.view',
      'tasks.create',
      'tasks.edit',
      'learning.view',
    ],
    dataScope: DataScope.DEPARTMENT,
    scopeEditable: true,
  },
  {
    name: 'Team Lead',
    credentialRole: 'Team Lead',
    description:
      'Same actions as a Department Head, limited to people who report to them rather than the whole department. Permissions and data access can be changed.',
    defaultPermissions: [
      'employee.view',
      'attendance.view',
      'leave_management.view',
      'leave_management.edit',
      'performance.view',
      'performance.create',
      'performance.edit',
      'projects.view',
      'tasks.view',
      'tasks.create',
      'tasks.edit',
      'learning.view',
    ],
    dataScope: DataScope.TEAM,
    scopeEditable: true,
  },
  {
    name: 'IT',
    credentialRole: 'IT',
    description:
      'Assets and support tickets for equipment, accounts and clearance. Not employee HR files, payroll or performance. Permissions and data access can be changed.',
    defaultPermissions: [
      'assets.view',
      'assets.create',
      'assets.edit',
      'assets.export',
      'tickets.view',
      'tickets.manage',
    ],
    dataScope: DataScope.ORGANIZATION,
    scopeEditable: true,
  },
];

/**
 * Legacy `AuthCredential.role` values of organization admins. The credential
 * role no longer drives authorization; this only maps legacy credentials onto
 * a `user_roles` row during migration (see backfill-user-roles script).
 */
const ADMIN_TIER_CREDENTIAL_ROLES = ['admin', 'organization_admin'];

export const isAdminTierCredentialRole = (role: string | null | undefined): boolean =>
  ADMIN_TIER_CREDENTIAL_ROLES.includes(String(role ?? '').toLowerCase());

/** The `roles.name` a legacy credential role corresponds to. */
export const roleNameForCredentialRole = (role: string): string =>
  isAdminTierCredentialRole(role) ? ORG_ADMIN_ROLE_NAME : role;

/** Broadest first: a user with several roles gets the widest scope among them. */
export const DATA_SCOPE_ORDER: readonly DataScope[] = [
  DataScope.ORGANIZATION,
  DataScope.BRANCH,
  DataScope.DEPARTMENT,
  DataScope.TEAM,
  DataScope.SELF,
];

/**
 * The scope a role grants. A role without one set means ORGANIZATION —
 * which is how every role behaved before scopes existed, so nothing
 * narrows until an admin chooses to.
 */
export const roleDataScope = (value: string | null | undefined): DataScope =>
  (DATA_SCOPE_ORDER as readonly string[]).includes(String(value)) ? (value as DataScope) : DataScope.ORGANIZATION;

/**
 * A role's effective scope: its own setting, or its default — SELF for the
 * Employee role (their own records are all it is for, and it must not widen
 * a Team Lead who also keeps it), ORGANIZATION for every other role.
 */
export const effectiveRoleScope = (role: { name?: string | null; dataScope?: string | null }): DataScope => {
  if (role.dataScope) return roleDataScope(role.dataScope);
  return role.name === EmployeePortalRole.EMPLOYEE ? DataScope.SELF : DataScope.ORGANIZATION;
};

/** The widest of several scopes (none → organization-wide). */
export const widestDataScope = (scopes: readonly (DataScope | string | null | undefined)[]): DataScope => {
  if (scopes.length === 0) return DataScope.ORGANIZATION;
  const resolved = scopes.map(roleDataScope);
  return DATA_SCOPE_ORDER.find((scope) => resolved.includes(scope)) ?? DataScope.ORGANIZATION;
};

/**
 * A user's effective authorization in one organization, resolved from the
 * tenant database. What goes into the JWT's `roles` / `permissions` claims.
 */
export interface EffectiveAuthorization {
  /** Whose records the user's permissions reach — see `DataScope`. */
  dataScope?: DataScope;
  /** The tenant `users.id`, or null when no user record exists for the login. */
  userId: string | null;
  isActive: boolean;
  /** Role names, for display and for portal selection. */
  roles: string[];
  roleIds: string[];
  /** Deduplicated `resource.action` keys — `['*']` for a full-access role. */
  permissions: string[];
  isFullAccess: boolean;
  primaryRole?: string;
}

/**
 * True when `granted` covers `required`, honouring full access and the rule
 * every API route follows: `<resource>.manage` stands in for any action on
 * that resource.
 */
export const grantsPermission = (granted: readonly string[], required: string): boolean => {
  if (granted.includes(FULL_ACCESS_PERMISSION) || granted.includes(required)) return true;
  const separator = required.lastIndexOf('.');
  return separator > 0 && granted.includes(`${required.slice(0, separator)}.manage`);
};

/**
 * Names a custom role may not take: they would either collide with a system
 * role or be treated as admin-tier by PermissionsGuard.
 */
export const isReservedRoleName = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  return (
    ADMIN_TIER_CREDENTIAL_ROLES.includes(normalized) ||
    normalized === 'superadmin' ||
    SYSTEM_TENANT_ROLES.some(
      (def) =>
        def.name.toLowerCase() === normalized ||
        def.credentialRole.toLowerCase() === normalized,
    )
  );
};
