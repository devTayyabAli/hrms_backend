import { SetMetadata } from '@nestjs/common';

export const REQUIRE_SERVICE_ROLES_KEY = 'requireServiceRoles';

/**
 * Re-validates the caller's role, server-side, against the roles the gateway
 * forwarded in a SignedMicroservicePayload's context (see ServiceRolesGuard).
 * Use on message patterns whose gateway caller signs its payload via
 * MicroserviceSigningService — must run alongside SignedPayloadGuard, since
 * unsigned payloads carry no trustworthy role context.
 */
export const RequireServiceRoles = (...roles: string[]) =>
  SetMetadata(REQUIRE_SERVICE_ROLES_KEY, roles);
