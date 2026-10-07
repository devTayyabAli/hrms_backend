import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
  Optional,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  TenantException,
  TenantErrorCode,
  IS_PUBLIC_KEY,
  IS_PLATFORM_ROUTE_KEY,
} from '@app/common';
import { REQUIRE_MODULE_KEY, RequiredModuleMetadata } from '../decorators/require-module.decorator';

interface ModuleAccessResult {
  enabled?: boolean;
  allowed?: boolean;
  reason?: string;
}

@Injectable()
export class OrganizationModuleGuard implements CanActivate {
  private readonly logger = new Logger(OrganizationModuleGuard.name);

  /**
   * Cached entitlement decisions, keyed by tenant + module + action.
   *
   * This guard sits on the great majority of tenant-facing routes, so before
   * caching it put a synchronous TCP round trip to tenant-service — which in
   * turn opens or reuses a per-tenant database connection — in front of
   * nearly every HTTP request the platform serves. That made tenant-service
   * latency the floor for all traffic and multiplied its connection load by
   * the gateway's entire request rate, to answer a question whose answer
   * changes when a subscription is bought, cancelled or downgraded.
   *
   * Only positive decisions are cached. A denial is a cheap path already (it
   * short-circuits to a 403), and not caching it means a tenant who has just
   * paid regains access immediately instead of after the TTL. The reverse
   * direction — access being revoked — is the one that tolerates lag. 60s
   * keeps that lag to a minute; at 15s most page loads paid a TCP hop and a
   * database query here before the handler even started.
   */
  private readonly cache = new Map<string, number>();

  private readonly ttlMs = parseInt(
    process.env.MODULE_ACCESS_TTL_MS || '60000',
    10,
  );

  /**
   * De-duplicates concurrent checks for the same key, so a burst on a cold
   * cache does not fan out into one lookup per request against exactly the
   * dependency the cache exists to protect.
   */
  private readonly inFlight = new Map<string, Promise<ModuleAccessResult>>();

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient?: ClientProxy,
  ) { }

  /** Drops cached grants, e.g. after a subscription change. */
  invalidate(tenantId?: string): void {
    if (!tenantId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}::`)) {
        this.cache.delete(key);
      }
    }
  }

  private isGrantCached(key: string): boolean {
    const grantedAt = this.cache.get(key);
    if (grantedAt === undefined) {
      return false;
    }
    if (Date.now() - grantedAt >= this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const isPlatformRoute = this.reflector.getAllAndOverride<boolean>(
      IS_PLATFORM_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic || isPlatformRoute) {
      return true;
    }

    const requiredModule = this.reflector.getAllAndOverride<RequiredModuleMetadata>(
      REQUIRE_MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredModule) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const url = request.url || request.originalUrl || '';

    // ALWAYS allow Organization Billing & Subscription management routes regardless of subscription status
    if (url.includes('/organization/billing/') || requiredModule.moduleKey === 'billing') {
      return true;
    }

    const tenantId =
      request.tenantId ||
      request.user?.tenantId ||
      request.headers?.['x-tenant-id'];

    if (!tenantId) {
      throw new TenantException(
        TenantErrorCode.TENANT_REQUIRED,
        'Tenant context is required to verify module access.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Check module entitlement & subscription status via tenantClient microservice if present
    if (this.tenantClient) {
      const cacheKey = `${tenantId}::${requiredModule.moduleKey}::${requiredModule.action ?? ''}`;
      if (this.isGrantCached(cacheKey)) {
        return true;
      }

      try {
        // No `.pipe(timeout(...))` here on purpose: the injected client owns
        // timeout/retry policy (see ResilientClientProxy, registered for
        // SERVICES.TENANT_SERVICE in api-gateway.module.ts). A hardcoded
        // timeout here silently overrode that longer, deliberately chosen
        // budget and cut every module check off early — long enough for a
        // warm request, but not for the first request against a freshly
        // provisioned tenant, whose per-tenant database connection has to be
        // opened and synced before the check can answer.
        let lookup = this.inFlight.get(cacheKey);
        if (!lookup) {
          lookup = firstValueFrom(
            this.tenantClient.send<ModuleAccessResult>(
              MESSAGE_PATTERNS.ORGANIZATION.CHECK_MODULE_ACCESS,
              {
                tenantId,
                moduleKey: requiredModule.moduleKey,
                action: requiredModule.action,
              },
            ),
          ).finally(() => {
            this.inFlight.delete(cacheKey);
          });
          this.inFlight.set(cacheKey, lookup);
        }

        const checkResult = await lookup;

        if (checkResult && checkResult.enabled && checkResult.allowed) {
          this.cache.set(cacheKey, Date.now());
        }

        if (!checkResult || !checkResult.enabled || !checkResult.allowed) {
          throw new TenantException(
            TenantErrorCode.MODULE_NOT_ENABLED,
            checkResult?.reason ||
            `Module '${requiredModule.moduleKey}' is not enabled for this organization.`,
            HttpStatus.FORBIDDEN,
          );
        }
      } catch (err: any) {
        if (err instanceof TenantException) {
          throw err;
        }
        // The entitlement check could not be completed — a timeout, a
        // transport error, an open circuit breaker, a bug in the tenant
        // service. That is NOT an authorization decision: reporting it as
        // MODULE_NOT_ENABLED/403 tells the caller their organization lacks
        // the module (which may be false) and throws away the only
        // description of what actually broke. Log the cause and answer with
        // a distinct, honest "could not verify" failure instead.
        this.logger.error(
          `Module access check failed for tenant ${tenantId}, module '${requiredModule.moduleKey}'` +
            `${requiredModule.action ? ` (action '${requiredModule.action}')` : ''}: ${err?.message || err}`,
          err?.stack,
        );
        throw new TenantException(
          TenantErrorCode.MODULE_ACCESS_CHECK_FAILED,
          `Unable to verify module access for '${requiredModule.moduleKey}'. Please try again.`,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }

    return true;
  }
}
