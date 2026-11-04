import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { ApprovalPoliciesController } from './approval-policies.controller';

describe('Approval policy routes', () => {
  const proto = ApprovalPoliciesController.prototype as unknown as Record<string, any>;
  const meta = (name: string) => ({
    route: `${RequestMethod[Reflect.getMetadata('method', proto[name])]} ${Reflect.getMetadata('path', proto[name])}`,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[],
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, proto[name]),
  });

  it('is read with a workflows or settings view grant', () => {
    expect(meta('list')).toMatchObject({
      route: 'GET /',
      permissions: ['workflows.view', 'workflows.manage', 'settings.view', 'settings.manage'],
      module: { moduleKey: HRMSModuleKey.SETTINGS, action: ModuleAction.VIEW },
    });
  });

  it('is changed only with workflows.manage or settings.manage', () => {
    for (const name of ['update', 'reset']) {
      expect(meta(name).permissions).toEqual(['workflows.manage', 'settings.manage']);
      expect(meta(name).module).toMatchObject({ moduleKey: HRMSModuleKey.SETTINGS, action: ModuleAction.EDIT });
    }
    expect(meta('update').route).toBe('PUT :requestType');
    expect(meta('reset').route).toBe('DELETE :requestType');
  });
});
