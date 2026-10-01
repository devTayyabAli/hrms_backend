export interface RequestContextPayload {
  requestId: string;
  tenantId?: string;
  tenantSlug?: string;
  userId?: string;
  userType?: 'superadmin' | 'tenant_user';
  roles?: string[];
  permissions?: string[];
}

export interface CurrentUserPayload {
  id: string;
  email: string;
  tenantId?: string;
  role?: string;
  /**
   * Every role on the token. `role` is the primary one, kept for callers that
   * only need a single value; RolesGuard and PermissionsGuard both read this
   * list. Declared here because JwtStrategy has always populated it — it was
   * just casting past the type to do so.
   */
  roles?: string[];
  /**
   * Fine-grained permissions, as read by PermissionsGuard.
   *
   * Nothing mints this claim yet: the only login path is auth-service's
   * AuthCredential, whose holders are admin-tier roles that the guard
   * short-circuits. It is declared so the claim is typed end to end rather
   * than being an untyped property the guard reads and no one can see.
   */
  permissions?: string[];
  /**
   * Whose records the permissions reach — `ORGANIZATION`, `DEPARTMENT`,
   * `TEAM` or `SELF` (see `DataScope`). Absent on older tokens.
   */
  dataScope?: string;
  isSuperAdmin?: boolean;
  isFullAccess?: boolean;
  tenantUserId?: string;
  /** Session id the access token was issued for (see AuthService.issueTokenPair). */
  sid?: string;
}
