export interface MicroserviceAuthContext {
  userId?: string;
  tenantId?: string;
  roles: string[];
  /** The caller's JWT `permissions` claim, for re-validation at the service. */
  permissions?: string[];
  isSuperAdmin: boolean;
  /** Correlation ID of the originating HTTP request, for cross-service log tracing. */
  correlationId?: string;
  /** Login email — how a service finds the caller's employee record. */
  email?: string;
  /**
   * The JWT's `dataScope` claim (`ORGANIZATION`, `DEPARTMENT`, `TEAM`,
   * `SELF`) — whose records the caller's permissions reach. Absent means
   * organization-wide, as before scopes existed.
   */
  dataScope?: string;
  /** Full-access callers are never narrowed. */
  isFullAccess?: boolean;
}

/**
 * Envelope wrapping a microservice message payload with the caller's identity
 * and an HMAC signature, so the receiving service can verify the message
 * genuinely came from the gateway (not a direct connection to the TCP port)
 * and re-validate authorization itself instead of trusting the gateway blindly.
 */
export interface SignedMicroservicePayload<T = unknown> {
  data: T;
  context: MicroserviceAuthContext;
  timestamp: number;
  signature: string;
}
