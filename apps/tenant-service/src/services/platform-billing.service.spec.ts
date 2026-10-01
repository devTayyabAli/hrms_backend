import { HttpStatus } from '@nestjs/common';
import { TenantErrorCode } from '@app/common';
import { PlatformBillingService } from './platform-billing.service';

/**
 * Guards the tenant isolation on `simulatePayment`.
 *
 * This handler used to resolve the payment with `findByPk(dto.paymentId)` — no
 * tenant predicate at all — so a caller holding `billing.manage` in one
 * organization could force any other organization's payment to SUCCESS or
 * FAILED simply by knowing its id. These tests assert the query is scoped and
 * that a foreign payment is indistinguishable from a missing one.
 */
describe('PlatformBillingService.simulatePayment', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const PAYMENT = '33333333-3333-4333-8333-333333333333';

  let paymentModel: { findOne: jest.Mock; findByPk: jest.Mock };
  let service: PlatformBillingService;

  const build = () => {
    paymentModel = { findOne: jest.fn(), findByPk: jest.fn() };
    // Only paymentModel and providerFactory participate in this path; the
    // remaining injected models are untouched here.
    return new PlatformBillingService(
      null as any,
      null as any,
      null as any,
      paymentModel as any,
      null as any,
      null as any,
      null as any,
    );
  };

  beforeEach(() => {
    service = build();
  });

  it('scopes the payment lookup by tenant', async () => {
    paymentModel.findOne.mockResolvedValue(null);

    await expect(
      service.simulatePayment(TENANT, { paymentId: PAYMENT } as any),
    ).rejects.toMatchObject({ code: TenantErrorCode.PAYMENT_NOT_FOUND });

    expect(paymentModel.findOne).toHaveBeenCalledWith({
      where: { id: PAYMENT, tenantId: TENANT },
    });
  });

  it('never resolves a payment by primary key alone', async () => {
    paymentModel.findOne.mockResolvedValue(null);

    await service
      .simulatePayment(TENANT, { paymentId: PAYMENT } as any)
      .catch(() => undefined);

    expect(paymentModel.findByPk).not.toHaveBeenCalled();
  });

  it('reports another tenant’s payment as not found, not forbidden', async () => {
    // findOne with the tenant predicate returns nothing for a foreign row.
    paymentModel.findOne.mockResolvedValue(null);

    await expect(
      service.simulatePayment(TENANT, { paymentId: PAYMENT } as any),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it.each([undefined, null, ''])(
    'refuses to run without a tenant id (%s)',
    async (tenantId) => {
      await expect(
        service.simulatePayment(tenantId as any, { paymentId: PAYMENT } as any),
      ).rejects.toMatchObject({
        code: TenantErrorCode.TENANT_REQUIRED,
        status: HttpStatus.BAD_REQUEST,
      });

      expect(paymentModel.findOne).not.toHaveBeenCalled();
    },
  );
});
