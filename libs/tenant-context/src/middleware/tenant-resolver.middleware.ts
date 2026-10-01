import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { tenantStorage, TenantContext } from '../context/tenant-context.service';
import { TenantRequestContextService } from '../context/tenant-request-context.service';
import { TenantException, TenantErrorCode } from '@app/common';
import { resolveDbCredentials } from '@app/database';

export interface TenantRequest extends Request {
  tenantId?: string;
  requestId?: string;
  user?: any;
}

@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  private readonly logger = new Logger('IncomingRequest');

  constructor(private readonly tenantRequestContext: TenantRequestContextService) {}

  use(req: TenantRequest, res: Response, next: NextFunction): void {
    // 1. Request ID Correlation (Phase L) — also accept the more conventional
    // x-correlation-id header name; either one, if present, is honored so a
    // caller/load-balancer supplied ID is preserved end-to-end.
    const rawReqId = req.headers['x-correlation-id'] || req.headers['x-request-id'];
    const requestId =
      (Array.isArray(rawReqId) ? rawReqId[0] : rawReqId) || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('x-correlation-id', requestId);
    res.setHeader('x-request-id', requestId);

    const startedAt = Date.now();

    /**
     * Two lines per request at `log` level is an access log, and an access
     * log belongs at `debug` in production.
     *
     * At `log` it doubles the platform's log volume for information the load
     * balancer already records, and — because Nest's logger writes
     * synchronously to stdout — puts two blocking writes on the hot path of
     * every request. The completion line stays informative where it matters:
     * failures are logged at `warn` regardless of level, so a 4xx/5xx is
     * still visible in production without the successes burying it.
     */
    const isProduction = process.env.NODE_ENV === 'production';
    const trace = isProduction
      ? (message: string) => this.logger.debug(message)
      : (message: string) => this.logger.log(message);

    trace(`[${requestId}] --> ${req.method} ${req.originalUrl || req.path}`);
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const line = `[${requestId}] <-- ${req.method} ${req.originalUrl || req.path} ${res.statusCode} (${durationMs}ms)`;
      if (res.statusCode >= 400) {
        this.logger.warn(line);
      } else {
        trace(line);
      }
    });

    // 2. Tenant Resolution Priority (Phase F)
    // Priority 1: JWT tenantId (Primary source of truth for authenticated requests)
    let tenantId: string | undefined = req.user?.tenantId;

    const rawHeader = req.headers['x-tenant-id'];
    const headerTenantId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    // Defence in depth only — NOT the control that enforces this.
    //
    // Nest runs middleware BEFORE guards, and `req.user` is populated by the
    // passport JWT guard, so on a normal authenticated request there is no
    // user here yet and this branch cannot fire. The check that actually
    // binds the header to the caller's token is in TenantGuard, which runs
    // after JwtAuthGuard; see libs/tenant-context/src/guards/tenant.guard.ts
    // and the tenant-header-binding spec beside it. Kept because it costs
    // nothing and does fire if a user is ever resolved earlier in the chain.
    if (req.user?.tenantId && headerTenantId && headerTenantId !== req.user.tenantId) {
      throw new TenantException(
        TenantErrorCode.TENANT_ACCESS_DENIED,
        'Access denied: JWT tenant context does not match requested tenant header.',
      );
    }

    // Priority 2: Explicit x-tenant-id header (for unauthenticated / system onboarding calls)
    if (!tenantId && headerTenantId) {
      tenantId = headerTenantId;
    }

    // Priority 3: Subdomain extraction fallback (e.g. acme.hrms.local)
    if (!tenantId && req.headers.host) {
      const host = req.headers.host;
      const parts = host.split('.');
      if (parts.length > 2 && parts[0] !== 'www' && parts[0] !== 'api') {
        tenantId = parts[0];
      }
    }

    const userId = req.user?.id || req.user?.sub;
    const roles = req.user?.roles || (req.user?.role ? [req.user.role] : []);

    const contextPayload: TenantContext = {
      tenantId,
      requestId,
      userId,
      roles,
    };

    if (tenantId) {
      req.tenantId = tenantId;
      this.tenantRequestContext.setTenantId(tenantId);

      const databaseName = `hrms_${tenantId.replace(/-/g, '_')}`;
      // Credentials (and SSL policy) always come from env vars via
      // resolveDbCredentials() — never a hardcoded fallback password. Throws
      // if TENANT_DB_PASSWORD is unset, so a misconfigured deployment fails
      // loudly here instead of silently authenticating with 'password'.
      const creds = resolveDbCredentials('tenant');
      this.tenantRequestContext.setConnectionOptions({
        tenantId,
        databaseName,
        host: creds.host,
        port: creds.port,
        username: creds.username,
        password: creds.password,
        dialect: 'postgres',
        dialectOptions: creds.dialectOptions,
      });
    }

    // Wrap execution inside AsyncLocalStorage.run() boundary (Phase E)
    tenantStorage.run(contextPayload, () => {
      next();
    });
  }
}
