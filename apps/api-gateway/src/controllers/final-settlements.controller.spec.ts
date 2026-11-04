import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { FinalSettlementsController } from './final-settlements.controller';

describe('Final settlement routes', () => {
  const proto = FinalSettlementsController.prototype as unknown as Record<string, any>;
  const meta = (name: string) => ({
    route: `${RequestMethod[Reflect.getMetadata('method', proto[name])]} ${Reflect.getMetadata('path', proto[name])}`,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[],
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, proto[name]) as { moduleKey: string; action: string },
  });

  it('keeps approving apart from preparing', () => {
    for (const name of ['decide', 'markPaid']) {
      expect(meta(name).permissions).toEqual(['payroll.approve', 'payroll.manage']);
    }
    for (const name of ['prepare', 'updateSettlement', 'addLine', 'updateLine', 'removeLine', 'submit', 'cancel']) {
      const { permissions } = meta(name);
      expect(permissions).toEqual(['offboarding.manage', 'payroll.adjustments.manage', 'payroll.manage']);
      // Preparing a settlement is not the right to approve one.
      expect(permissions).not.toContain('payroll.approve');
    }
  });

  it('lets HR, Finance and approvers read', () => {
    for (const name of ['getForCase', 'getSettlements', 'getSettlement']) {
      expect(meta(name).permissions).toEqual(expect.arrayContaining(['offboarding.view', 'offboarding.manage', 'payroll.approve']));
      expect(meta(name).module).toMatchObject({ moduleKey: HRMSModuleKey.PAYROLL, action: ModuleAction.VIEW });
    }
  });

  it('is under the offboarding path, on the Payroll module', () => {
    expect(Reflect.getMetadata('path', FinalSettlementsController)).toBe('organization/offboarding');
    expect(meta('decide')).toMatchObject({ route: 'POST settlements/:settlementId/decision', module: { moduleKey: HRMSModuleKey.PAYROLL, action: ModuleAction.EDIT } });
    expect(meta('prepare').route).toBe('POST cases/:caseId/settlement');
  });
});
