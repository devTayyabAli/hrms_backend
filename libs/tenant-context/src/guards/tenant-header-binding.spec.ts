import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { TenantException, TenantErrorCode } from '@app/common';
import { TenantGuard } from './tenant.guard';
import { TenantResolverMiddleware } from '../middleware/tenant-resolver.middleware';

/**
 * Pins the binding between the caller's JWT tenant and the `x-tenant-id`
 * header the tenant-scoped controllers actually read.
 *
 * Every admin controller takes its tenant from `@Headers('x-tenant-id')` and
 * forwards it to tenant-service, which opens that tenant's physical database.
 * So the header is not a hint — it selects the database. If a caller holding
 * a token for tenant A can put tenant B's id in that header and be served,
 * the isolation boundary is gone.
 *
 * TenantResolverMiddleware has a check for exactly this, but it is Express
 * middleware: Nest runs middleware BEFORE guards, and `req.user` is populated
 * by the passport JWT guard. At middleware time `req.user` is therefore
 * undefined and the check cannot fire. The first test below pins that gap so
 * it cannot be mistaken for coverage; the rest pin the guard that closes it.
 */
describe('tenant header binding', () => {
  const TENANT_A = '11111111-1111-4111-8111-111111111111';
  const TENANT_B = '22222222-2222-4222-8222-222222222222';

  describe('TenantResolverMiddleware (runs before req.user exists)', () => {
    // The middleware builds tenant DB connection options once it accepts a
    // tenant, which needs this set; without it the test would fail on the
    // credential check before reaching the point being demonstrated.
    beforeAll(() => {
      process.env.TENANT_DB_PASSWORD =
        process.env.TENANT_DB_PASSWORD || 'test-password';
    });

    const buildMiddleware = () =>
      new TenantResolverMiddleware({
        setTenantId: jest.fn(),
        setConnectionOptions: jest.fn(),
      } as any);

    const requestFor = (headerTenantId: string, user?: any) =>
      ({
        method: 'GET',
        path: '/organization/employees',
        originalUrl: '/organization/employees',
        headers: { 'x-tenant-id': headerTenantId },
        user,
      }) as any;

    const response = () => ({ setHeader: jest.fn(), on: jest.fn() }) as any;

    it('cannot catch a foreign header because req.user is not set yet', () => {
      const next = jest.fn();

      // This is the real shape of the request when middleware runs: no user.
      expect(() =>
        buildMiddleware().use(requestFor(TENANT_B), response(), next),
      ).not.toThrow();

      // It ran, and it accepted the header unchallenged.
      expect(next).toHaveBeenCalled();
    });

    it('does reject a mismatch once a user is present (the guard case)', () => {
      expect(() =>
        buildMiddleware().use(
          requestFor(TENANT_B, { tenantId: TENANT_A }),
          response(),
          jest.fn(),
        ),
      ).toThrow(TenantException);
    });
  });


  describe('TenantGuard', () => {
    let guard: TenantGuard;

    const contextFor = (request: any) =>
      ({
        getType: () => 'http',
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      }) as any;

    beforeEach(() => {
      const reflector = new Reflector();
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      guard = new TenantGuard(reflector);
    });

    it('refuses a header naming a tenant other than the caller own', async () => {
      const request = {
        user: { id: 'u1', tenantId: TENANT_A },
        headers: { 'x-tenant-id': TENANT_B },
      };

      await expect(guard.canActivate(contextFor(request))).rejects.toEqual(
        expect.objectContaining({
          code: TenantErrorCode.TENANT_ACCESS_DENIED,
        }),
      );
    });

    it('allows the caller own tenant in the header', async () => {
      const request: any = {
        user: { id: 'u1', tenantId: TENANT_A },
        headers: { 'x-tenant-id': TENANT_A },
      };

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.tenantId).toBe(TENANT_A);
    });

    it('allows a request with no header at all, pinning the JWT tenant', async () => {
      const request: any = {
        user: { id: 'u1', tenantId: TENANT_A },
        headers: {},
      };

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.tenantId).toBe(TENANT_A);
    });

    it('rewrites the header so a controller reading it cannot read the raw value', async () => {
      const request: any = {
        user: { id: 'u1', tenantId: TENANT_A },
        headers: { 'x-tenant-id': TENANT_A },
      };

      await guard.canActivate(contextFor(request));

      // Controllers bind @Headers('x-tenant-id'); the value they see has to be
      // the resolved tenant, not whatever arrived on the wire.
      expect(request.headers['x-tenant-id']).toBe(TENANT_A);
    });

    it('ignores a header array smuggled in by repeating the header', async () => {
      const request: any = {
        user: { id: 'u1', tenantId: TENANT_A },
        headers: { 'x-tenant-id': [TENANT_A, TENANT_B] },
      };

      await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(TenantException);
    });

    it('still requires some tenant context', async () => {
      const request: any = { user: { id: 'u1' }, headers: {} };

      await expect(guard.canActivate(contextFor(request))).rejects.toEqual(
        expect.objectContaining({
          code: TenantErrorCode.TENANT_REQUIRED,
        }),
      );
    });
  });

  describe('TenantGuard organization status', () => {
    const contextFor = (request: any) =>
      ({
        getType: () => 'http',
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      }) as any;

    /** A guard whose tenant-service answers `state` for every lookup. */
    const guardWith = (state: unknown) => {
      const reflector = new Reflector();
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const send = jest.fn(() => of(state));
      return { guard: new TenantGuard(reflector, { send } as any), send };
    };

    const requestFor = (tenantId: string, url = '/api/v1/organization/employees') => ({
      url,
      user: { id: 'u1', tenantId },
      headers: {},
    });

    // Each test uses its own tenant id: the state cache is shared process-wide.
    let n = 0;
    const freshTenant = () => `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`;

    it('allows an active organization', async () => {
      const { guard } = guardWith({ found: true, status: 'ACTIVE', isActive: true });
      await expect(guard.canActivate(contextFor(requestFor(freshTenant())))).resolves.toBe(true);
    });

    it('refuses a suspended organization', async () => {
      const { guard } = guardWith({ found: true, status: 'SUSPENDED', isActive: false });
      await expect(guard.canActivate(contextFor(requestFor(freshTenant())))).rejects.toEqual(
        expect.objectContaining({ code: TenantErrorCode.TENANT_SUSPENDED }),
      );
    });

    it('refuses an expired organization everywhere but billing', async () => {
      const { guard } = guardWith({ found: true, status: 'EXPIRED', isActive: true });
      const tenant = freshTenant();
      await expect(guard.canActivate(contextFor(requestFor(tenant)))).rejects.toEqual(
        expect.objectContaining({ code: TenantErrorCode.TENANT_EXPIRED }),
      );
      await expect(
        guard.canActivate(contextFor(requestFor(tenant, '/api/v1/organization/billing/plan'))),
      ).resolves.toBe(true);
    });

    it('refuses an organization that no longer exists', async () => {
      const { guard } = guardWith({ found: false, status: null, isActive: false });
      await expect(guard.canActivate(contextFor(requestFor(freshTenant())))).rejects.toEqual(
        expect.objectContaining({ code: TenantErrorCode.TENANT_ACCESS_DENIED }),
      );
    });

    it('looks the organization up once and serves repeat requests from cache', async () => {
      const { guard, send } = guardWith({ found: true, status: 'ACTIVE', isActive: true });
      const tenant = freshTenant();
      await guard.canActivate(contextFor(requestFor(tenant)));
      await guard.canActivate(contextFor(requestFor(tenant)));
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('sees a status change at once after forgetTenant', async () => {
      const tenant = freshTenant();
      await guardWith({ found: true, status: 'ACTIVE', isActive: true }).guard.canActivate(
        contextFor(requestFor(tenant)),
      );
      TenantGuard.forgetTenant(tenant);
      const { guard } = guardWith({ found: true, status: 'SUSPENDED', isActive: false });
      await expect(guard.canActivate(contextFor(requestFor(tenant)))).rejects.toEqual(
        expect.objectContaining({ code: TenantErrorCode.TENANT_SUSPENDED }),
      );
    });

    it('lets the request through when tenant-service cannot be reached', async () => {
      const reflector = new Reflector();
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const guard = new TenantGuard(reflector, { send: () => throwError(() => new Error('ECONNREFUSED')) } as any);
      await expect(guard.canActivate(contextFor(requestFor(freshTenant())))).resolves.toBe(true);
    });
  });
});
