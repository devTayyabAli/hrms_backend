import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { SignedMicroservicePayload } from '@app/common';
import { REQUIRE_SERVICE_ROLES_KEY } from '../decorators/service-roles.decorator';

/**
 * Re-validates the caller's role at the microservice boundary, using the
 * roles carried in a SignedMicroservicePayload — never trusting the gateway's
 * authorization decision alone. Must run after SignedPayloadGuard so the
 * roles being checked are known to be genuine, not attacker-supplied.
 */
@Injectable()
export class ServiceRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if ((context.getType() as string) !== 'rpc') {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(REQUIRE_SERVICE_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const rpcData = context.switchToRpc().getData() as Partial<SignedMicroservicePayload>;
    const roles = rpcData?.context?.roles || [];

    const hasRole = requiredRoles.some((role) => roles.includes(role));
    if (!hasRole) {
      throw new RpcException(`Missing required role for this operation: ${requiredRoles.join(', ')}`);
    }

    return true;
  }
}
