import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '@app/common';

/**
 * Restricts a route to SuperAdmin users only. Unlike RolesGuard (which checks
 * a route's declared @Roles(...) list), this guard hard-codes the superadmin
 * check so a superadmin-only endpoint can never be widened by an incidental
 * change to a @Roles(...) list elsewhere.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if ((context.getType() as string) === 'rpc') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const userRoles: string[] = Array.isArray(user?.roles)
      ? user.roles
      : user?.role
        ? [user.role]
        : [];

    if (!user || !userRoles.includes('superadmin')) {
      throw new ForbiddenException('SuperAdmin access required');
    }

    return true;
  }
}
