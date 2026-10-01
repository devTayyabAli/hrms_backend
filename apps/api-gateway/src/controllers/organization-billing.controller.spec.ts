import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { MESSAGE_PATTERNS } from '@app/common';
import { OrganizationBillingController } from './organization-billing.controller';

/**
 * Covers the tenant-scoping contract every route on this controller depends
 * on, and the two defects the code review raised against
 * `POST payments/:id/simulate`: a dropped tenant id and an ungated test hook.
 */
describe('OrganizationBillingController', () => {
  let controller: OrganizationBillingController;
  let send: jest.Mock;

  const TENANT = '11111111-1111-4111-8111-111111111111';
  const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
  const PAYMENT = '33333333-3333-4333-8333-333333333333';

  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ ok: true }));
    controller = new OrganizationBillingController({ send } as any);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /** Mimics what JwtAuthGuard leaves on the request. */
  const req = (tenantId?: string, headers: Record<string, string> = {}) => ({
    user: tenantId ? { id: 'user-1', tenantId } : { id: 'user-1' },
    headers,
  });

  describe('tenant resolution', () => {
    it('sends the tenant id from the JWT downstream', () => {
      controller.getSubscription(req(TENANT));

      expect(send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.BILLING.GET_SUBSCRIPTION,
        { tenantId: TENANT },
      );
    });

    it('ignores a conflicting x-tenant-id header and uses the JWT tenant', () => {
      controller.getSubscription(req(TENANT, { 'x-tenant-id': OTHER_TENANT }));

      expect(send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.BILLING.GET_SUBSCRIPTION,
        { tenantId: TENANT },
      );
    });

    it('rejects a token carrying no tenant rather than querying unscoped', () => {
      expect(() => controller.getSubscription(req(undefined))).toThrow(
        UnauthorizedException,
      );
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('POST payments/:id/simulate', () => {
    it('includes the resolved tenant id so the service can scope the lookup', () => {
      process.env.NODE_ENV = 'development';

      controller.simulatePayment(req(TENANT), PAYMENT, {
        result: 'SUCCESS',
      } as any);

      expect(send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.BILLING.SIMULATE_PAYMENT,
        {
          tenantId: TENANT,
          dto: { result: 'SUCCESS', paymentId: PAYMENT },
        },
      );
    });

    it.each(['production', 'staging', 'test', undefined])(
      'refuses to run when NODE_ENV is %s',
      (env) => {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;

        expect(() =>
          controller.simulatePayment(req(TENANT), PAYMENT, {
            result: 'SUCCESS',
          } as any),
        ).toThrow(NotFoundException);
        expect(send).not.toHaveBeenCalled();
      },
    );

    it('still requires a tenant-bearing token in development', () => {
      process.env.NODE_ENV = 'development';

      expect(() =>
        controller.simulatePayment(req(undefined), PAYMENT, {
          result: 'SUCCESS',
        } as any),
      ).toThrow(UnauthorizedException);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
