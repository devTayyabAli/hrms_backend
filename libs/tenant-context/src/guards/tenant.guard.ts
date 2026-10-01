import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  IS_PLATFORM_ROUTE_KEY,
  IS_TENANT_OPTIONAL_KEY,
  TenantException,
  TenantErrorCode,
} from '@app/common';
import { tenantStorage } from '../context/tenant-context.service';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() === 'rpc') {
      return true;
    }

    // 1. Check bypass metadata decorators
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const isPlatformRoute = this.reflector.getAllAndOverride<boolean>(
      IS_PLATFORM_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const isTenantOptional = this.reflector.getAllAndOverride<boolean>(
      IS_TENANT_OPTIONAL_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Platform routes (e.g. SuperAdmin, health checks) or public routes bypass mandatory tenant validation
    if (isPublic || isPlatformRoute || isTenantOptional) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // The tenant-scoped controllers bind `@Headers('x-tenant-id')` and send
    // that value to tenant-service, which opens that tenant's own physical
    // database with it. The header therefore SELECTS THE DATABASE, and has to
    // be checked against the caller's token before anything downstream sees
    // it — otherwise a user holding a token for one organization reads another
    // organization's data by editing one header.
    //
    // TenantResolverMiddleware has the same comparison, but Nest runs
    // middleware before guards and `request.user` is populated by the passport
    // JWT guard, so at middleware time there is no user to compare against and
    // the check there can never fire. This is the one that runs with a user.
    const rawHeader = request.headers?.['x-tenant-id'];

    // A repeated header arrives as an array. Which element wins would decide
    // which database is opened, so the request is ambiguous by definition and
    // is refused rather than resolved by guesswork.
    if (Array.isArray(rawHeader)) {
      throw new TenantException(
        TenantErrorCode.TENANT_ACCESS_DENIED,
        'Ambiguous tenant context: x-tenant-id was supplied more than once.',
      );
    }

    const jwtTenantId = request.user?.tenantId;
    if (rawHeader && jwtTenantId && rawHeader !== jwtTenantId) {
      throw new TenantException(
        TenantErrorCode.TENANT_ACCESS_DENIED,
        'Access denied: JWT tenant context does not match requested tenant header.',
      );
    }

    // Priority: JWT tenantId first, then header/request property. A caller
    // with no tenant in their token (SuperAdmin acting on an organization,
    // or an unauthenticated onboarding call) still resolves by header — those
    // routes carry their own authorization.
    const tenantId = jwtTenantId || request.tenantId || rawHeader;

    if (!tenantId) {
      throw new TenantException(
        TenantErrorCode.TENANT_REQUIRED,
        'Tenant context is required for this operation. Please provide a valid tenant context or x-tenant-id header.',
      );
    }

    // Tenant Status Validation
    const tenantStatus =
      request.user?.tenantStatus || request.tenantStatus || 'ACTIVE';
    if (tenantStatus === 'SUSPENDED') {
      throw new TenantException(
        TenantErrorCode.TENANT_SUSPENDED,
        'Organization account is suspended. Please contact support.',
      );
    }

    if (tenantStatus === 'EXPIRED') {
      throw new TenantException(
        TenantErrorCode.TENANT_EXPIRED,
        'Organization subscription has expired. Please renew your subscription.',
      );
    }

    request.tenantId = tenantId;

    // Pin the resolved tenant back onto the header the controllers read, so
    // `@Headers('x-tenant-id')` can only ever yield the value this guard
    // authorized — including on a request that sent no header at all but
    // carries a tenant in its token.
    if (request.headers) {
      request.headers['x-tenant-id'] = tenantId;
    }

    const resolved = {
      tenantId,
      userId: request.user?.id || request.user?.sub,
      requestId: request.requestId,
      roles:
        request.user?.roles || (request.user?.role ? [request.user.role] : []),
      email: request.user?.email,
      dataScope: request.user?.dataScope,
      isFullAccess: Boolean(request.user?.isFullAccess),
      // Signed into every RPC, so a service can re-check a permission where
      // the data lives (payroll does) instead of trusting the route alone.
      permissions: Array.isArray(request.user?.permissions) ? request.user.permissions : [],
    };

    // Update the request's context in place. TenantResolverMiddleware opened
    // it with `tenantStorage.run()` before any user was known; every later
    // step of this request — including the controller that signs outgoing
    // RPCs with these roles — holds that same object. `enterWith` would only
    // replace it for this guard's own async continuation (Nest awaits the JWT
    // guard first), so the controller kept signing with no roles and every
    // `@RequireServiceRoles` handler rejected the call.
    const store = tenantStorage.getStore();
    if (store) Object.assign(store, resolved);
    else tenantStorage.enterWith(resolved);

    return true;
  }
}
