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
 * The permission claim a full-access role (the Organization Admin) carries.
 * Explicit on purpose: an empty `permissions` claim means "no permissions",
 * never "everything".
 */
export const FULL_ACCESS_PERMISSION = '*';

/** Portal roles an employee invitation can mint a credential for. */
export enum EmployeePortalRole {
  HR = 'HR',
  EMPLOYEE = 'Employee',
}

export const ORG_ADMIN_ROLE_NAME = 'ORGANIZATION_ADMIN';

export interface SystemTenantRoleDef {
  /** `roles.name` in the tenant database. */
  name: string;
  /** The `AuthCredential.role` value that signs in as this role. */
  credentialRole: string;
  description: string;
  defaultPermissions: string[];
  /**
   * Full access, never editable. The admin tier signs in with an empty
   * `permissions` claim, which PermissionsGuard treats as "unrestricted".
   */
  locked: boolean;
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
    name: EmployeePortalRole.HR,
    credentialRole: EmployeePortalRole.HR,
    description: 'Human Resources portal role',
    defaultPermissions: [
      'employee.manage',
      'departments.manage',
      'attendance.manage',
      'leave_management.manage',
      'onboarding.manage',
      'recruitment.manage',
      'performance.manage',
      // Prepares payroll; approving it is a separate grant (payroll.approve).
      'payroll.view',
      'payroll.create',
      'payroll.edit',
      // Keeps employees' tax profiles; changing the tax rules themselves is
      // payroll.compliance.manage, which HR doesn't start with.
      'payroll.tax.manage',
      'payroll.compliance.view',
    ],
    locked: false,
  },
  {
    name: EmployeePortalRole.EMPLOYEE,
    credentialRole: EmployeePortalRole.EMPLOYEE,
    description: 'Employee self-service portal role',
    defaultPermissions: [],
    locked: false,
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

/**
 * Whose records a role's permissions reach. Permissions say *what* someone
 * may do (view employees, approve leave); the data scope says *on whom*:
 *
 * - ORGANIZATION — everyone (Organization Admin, HR).
 * - DEPARTMENT   — the department(s) they manage, or their own department.
 * - TEAM         — the people who report to them, directly or further down.
 * - SELF         — only their own record.
 */
export enum DataScope {
  ORGANIZATION = 'ORGANIZATION',
  DEPARTMENT = 'DEPARTMENT',
  TEAM = 'TEAM',
  SELF = 'SELF',
}

/** Broadest first: a user with several roles gets the widest scope among them. */
export const DATA_SCOPE_ORDER: readonly DataScope[] = [
  DataScope.ORGANIZATION,
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
