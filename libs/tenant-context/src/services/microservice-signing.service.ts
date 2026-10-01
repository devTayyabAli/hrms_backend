import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MicroserviceAuthContext,
  SignedMicroservicePayload,
  signMicroservicePayload,
  attachRpcSignature,
} from '@app/common';
import { TenantContextService } from '../context/tenant-context.service';

/**
 * Wraps an outgoing microservice message with the calling user's identity and
 * an HMAC signature, so the receiving microservice can verify the message
 * genuinely came from the gateway (not a direct connection to its TCP port)
 * and re-validate authorization itself instead of trusting the gateway blindly.
 */
@Injectable()
export class MicroserviceSigningService {
  private readonly secret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly tenantContextService: TenantContextService,
  ) {
    const secret = this.configService.get<string>('MICROSERVICE_SIGNING_SECRET');
    if (!secret) {
      throw new Error(
        'SECURITY CONFIGURATION ERROR: MICROSERVICE_SIGNING_SECRET environment variable is required and must not be empty.',
      );
    }
    this.secret = secret;
  }

  sign<T>(data: T): SignedMicroservicePayload<T> {
    return signMicroservicePayload(data, this.authContext(), this.secret);
  }

  /**
   * Signs `data` in place of wrapping it: the signature and caller context
   * ride along as one extra property and the payload keeps its shape.
   *
   * This is what ResilientClientProxy calls for every outgoing message, which
   * is how signing covers all ~260 message patterns instead of the thirteen
   * whose handlers were rewritten to accept the nested envelope. Handlers
   * that need the caller's identity still use `sign()`; everything else gets
   * authenticated transport without knowing about it.
   */
  signInPlace<T>(data: T): T {
    return attachRpcSignature(data, this.authContext(), this.secret);
  }

  private authContext(): MicroserviceAuthContext {
    const ctx = this.tenantContextService.getContext();
    const roles = ctx?.roles || [];
    return {
      userId: ctx?.userId,
      tenantId: ctx?.tenantId,
      roles,
      isSuperAdmin: roles.includes('superadmin'),
      correlationId: ctx?.requestId,
      // Signed with the rest, so a service can narrow data to the caller's
      // team or department knowing the scope came from their JWT.
      ...(ctx?.email ? { email: ctx.email } : {}),
      ...(ctx?.dataScope ? { dataScope: ctx.dataScope } : {}),
      ...(ctx?.isFullAccess ? { isFullAccess: true } : {}),
      ...(ctx?.permissions?.length ? { permissions: ctx.permissions } : {}),
    };
  }
}
