import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { BranchesController } from './branches.controller';

describe('BranchesController: permissions', () => {
  const prototype = BranchesController.prototype as unknown as Record<string, any>;
  const routes = () =>
    Object.getOwnPropertyNames(prototype)
      .filter((name) => typeof prototype[name] === 'function' && Reflect.getMetadata('method', prototype[name]) !== undefined)
      .map((name) => ({
        name,
        route: `${RequestMethod[Reflect.getMetadata('method', prototype[name])]} ${Reflect.getMetadata('path', prototype[name])}`,
        permissions: Reflect.getMetadata(PERMISSIONS_KEY, prototype[name]) as string[],
        module: Reflect.getMetadata(REQUIRE_MODULE_KEY, prototype[name]) as { moduleKey: string; action: string },
      }));

  const VIEW = ['departments.view', 'departments.manage'];
  const CREATE = ['departments.create', 'departments.manage'];
  const EDIT = ['departments.edit', 'departments.manage'];
  const DELETE = ['departments.delete', 'departments.manage'];
  const EXPECTED: Record<string, { permissions: string[]; action: ModuleAction }> = {
    'POST from-locations': { permissions: CREATE, action: ModuleAction.CREATE },
    'GET /': { permissions: VIEW, action: ModuleAction.VIEW },
    'POST /': { permissions: CREATE, action: ModuleAction.CREATE },
    'GET :branchId': { permissions: VIEW, action: ModuleAction.VIEW },
    'PATCH :branchId': { permissions: EDIT, action: ModuleAction.EDIT },
    'DELETE :branchId': { permissions: DELETE, action: ModuleAction.DELETE },
    'POST :branchId/employees': { permissions: EDIT, action: ModuleAction.EDIT },
    'POST :branchId/employees/remove': { permissions: EDIT, action: ModuleAction.EDIT },
  };

  it('asks every route for the permission and module action the structure uses', () => {
    expect(routes().map((r) => r.route).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const route of routes()) {
      expect(route.permissions).toEqual(EXPECTED[route.route].permissions);
      expect(route.module).toMatchObject({ moduleKey: HRMSModuleKey.DEPARTMENTS, action: EXPECTED[route.route].action });
    }
  });

  it('declares from-locations before the routes that read a branch by id', () => {
    const order = Object.getOwnPropertyNames(prototype);
    expect(order.indexOf('fromLocations')).toBeLessThan(order.indexOf('getBranch'));
  });
});
