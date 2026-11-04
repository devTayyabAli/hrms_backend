import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { OffboardingController } from './offboarding.controller';
import { MyOffboardingController } from './my-offboarding.controller';

describe('Offboarding routes', () => {
  const admin = OffboardingController.prototype as unknown as Record<string, any>;
  const mine = MyOffboardingController.prototype as unknown as Record<string, any>;
  const meta = (proto: Record<string, any>, name: string) => ({
    route: `${RequestMethod[Reflect.getMetadata('method', proto[name])]} ${Reflect.getMetadata('path', proto[name])}`,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[] | undefined,
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, proto[name]) as { moduleKey: string; action: string } | undefined,
  });

  it('keeps starting, changing and cancelling with offboarding.manage', () => {
    for (const [name, route, action] of [
      ['initiate', 'POST cases', ModuleAction.CREATE],
      ['updateCase', 'PATCH cases/:caseId', ModuleAction.EDIT],
      ['cancelCase', 'POST cases/:caseId/cancel', ModuleAction.EDIT],
      ['updateSettings', 'PUT settings', ModuleAction.EDIT],
    ] as const) {
      const m = meta(admin, name);
      expect(m.route).toBe(route);
      expect(m.permissions).toContain('offboarding.manage');
      expect(m.permissions).not.toContain('payroll.adjustments.manage');
      expect(m.module).toMatchObject({ moduleKey: HRMSModuleKey.EMPLOYEE, action });
    }
  });

  it('lets Finance read and clear with its payroll grant, as well as HR with offboarding.manage', () => {
    for (const name of ['getCases', 'getCase']) expect(meta(admin, name).permissions).toEqual(expect.arrayContaining(['offboarding.view', 'offboarding.manage', 'payroll.adjustments.manage']));
    for (const name of ['clearStage', 'reopenStage']) {
      expect(meta(admin, name).permissions).toEqual(['offboarding.manage', 'payroll.adjustments.manage', 'payroll.manage']);
      expect(meta(admin, name).route).toMatch(/^POST cases\/:caseId\/stages\/:stage\/(clear|reopen)$/);
    }
  });

  it('declares settings and the list before the routes that read a case by id', () => {
    const order = Object.getOwnPropertyNames(admin);
    expect(order.indexOf('getSettings')).toBeLessThan(order.indexOf('getCase'));
    expect(order.indexOf('getCases')).toBeLessThan(order.indexOf('getCase'));
  });

  it('asks the manager\'s own routes for no permission, only the Employee module', () => {
    expect(meta(mine, 'getWaiting')).toMatchObject({ route: 'GET /', permissions: undefined });
    expect(meta(mine, 'clear')).toMatchObject({ route: 'POST :caseId/clear', permissions: undefined });
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, MyOffboardingController)).toMatchObject({ moduleKey: HRMSModuleKey.EMPLOYEE, action: ModuleAction.VIEW });
  });
});
