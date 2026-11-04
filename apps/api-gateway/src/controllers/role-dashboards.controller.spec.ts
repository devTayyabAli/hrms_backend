import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { MyManagerDashboardController, RoleDashboardsController } from './role-dashboards.controller';

describe('Role dashboard routes', () => {
  const roles = RoleDashboardsController.prototype as unknown as Record<string, any>;
  const mine = MyManagerDashboardController.prototype as unknown as Record<string, any>;
  const meta = (proto: Record<string, any>, name: string) => ({
    route: `${RequestMethod[Reflect.getMetadata('method', proto[name])]} ${Reflect.getMetadata('path', proto[name])}`,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[] | undefined,
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, proto[name]) as { moduleKey: string; action: string },
  });

  it('shows Finance to people with a payroll grant, on the Payroll module', () => {
    const m = meta(roles, 'getFinance');
    expect(m.route).toBe('GET finance');
    expect(m.module).toMatchObject({ moduleKey: HRMSModuleKey.PAYROLL, action: ModuleAction.VIEW });
    expect(m.permissions).toEqual(expect.arrayContaining(['payroll.view', 'payroll.approve', 'payroll.compensation.approve', 'payroll.manage']));
    // Nothing from HR or IT opens it.
    expect(m.permissions!.every((p) => p.startsWith('payroll.'))).toBe(true);
  });

  it('shows IT to people who work with assets or tickets, on the Assets module', () => {
    const m = meta(roles, 'getIt');
    expect(m.route).toBe('GET it');
    expect(m.module).toMatchObject({ moduleKey: HRMSModuleKey.ASSETS, action: ModuleAction.VIEW });
    expect(m.permissions).toEqual(['assets.view', 'assets.edit', 'assets.manage', 'tickets.view', 'tickets.manage']);
  });

  it('asks the manager dashboard for no permission: it is the caller\'s own', () => {
    expect(meta(mine, 'getManager')).toMatchObject({ route: 'GET manager', permissions: undefined });
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, MyManagerDashboardController)).toMatchObject({ moduleKey: HRMSModuleKey.EMPLOYEE, action: ModuleAction.VIEW });
    expect(Reflect.getMetadata('path', MyManagerDashboardController)).toBe('organization/me/dashboard');
  });
});
