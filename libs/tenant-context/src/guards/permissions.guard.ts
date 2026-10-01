import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '@app/common';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
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

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User context not found on request');
    }

    const userRoles: string[] = Array.isArray(user.roles)
      ? user.roles
      : user.role
        ? [user.role]
        : [];

    const userPermissions: string[] = Array.isArray(user.permissions)
      ? user.permissions
      : [];

    // The platform owner is never gated by a tenant's permission catalogue.
    if (user.isSuperAdmin || userRoles.some((r) => String(r).toLowerCase() === 'superadmin')) {
      return true;
    }

    // Explicit Full Access: wildcard '*' permission or explicit isFullAccess capability.
    // An empty permissions list without this explicit capability means NO permissions.
    if (user.isFullAccess || userPermissions.includes('*')) {
      return true;
    }

    // Allow access if user has at least one of the accepted required permissions or permission aliases
    const hasPermission = requiredPermissions.some((perm) => {
      if (userPermissions.includes(perm)) return true;
      // <resource>.manage stands in for any action on that resource
      const separator = perm.lastIndexOf('.');
      if (separator > 0 && userPermissions.includes(`${perm.slice(0, separator)}.manage`)) {
        return true;
      }
      // Check dot/colon equivalencies e.g. 'users:read' <-> 'user_management.view'
      if (perm === 'users:read' && (userPermissions.includes('user_management.view') || userPermissions.includes('user_management.manage'))) return true;
      if (perm === 'users:write' && (userPermissions.includes('user_management.create') || userPermissions.includes('user_management.edit') || userPermissions.includes('user_management.manage'))) return true;
      if (perm === 'roles:read' && (userPermissions.includes('user_management.view') || userPermissions.includes('user_management.manage'))) return true;
      return false;
    });

    if (!hasPermission) {
      throw new ForbiddenException(
        `User missing required permissions: ${requiredPermissions.join(', ')}`,
      );
    }

    return true;
  }
}
