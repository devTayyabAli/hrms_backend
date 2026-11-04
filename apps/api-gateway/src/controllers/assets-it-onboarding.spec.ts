import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { of } from 'rxjs';
import { HRMSModuleKey, MESSAGE_PATTERNS, ModuleAction, OnboardingTaskCategory } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { AssetsController } from './assets.controller';

/**
 * The IT desk reaches the IT setup items on onboarding checklists through the
 * Assets routes, with an Assets permission, and nothing else of onboarding.
 */
describe('AssetsController: IT onboarding items', () => {
  const prototype = AssetsController.prototype as unknown as Record<string, any>;
  const metadata = (name: string) => ({
    method: RequestMethod[Reflect.getMetadata('method', prototype[name])],
    path: Reflect.getMetadata('path', prototype[name]),
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, prototype[name]) as string[],
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, prototype[name]) as { moduleKey: string; action?: string },
  });

  it('is read with an Assets view permission and changed with an Assets edit permission', () => {
    expect(metadata('getItOnboarding')).toMatchObject({
      method: 'GET',
      path: 'it-onboarding',
      permissions: ['assets.view', 'assets.manage'],
      module: { moduleKey: HRMSModuleKey.ASSETS, action: ModuleAction.VIEW },
    });
    expect(metadata('setItOnboardingStatus')).toMatchObject({
      method: 'PATCH',
      path: 'it-onboarding/:taskId/status',
      permissions: ['assets.edit', 'assets.manage'],
      module: { moduleKey: HRMSModuleKey.ASSETS, action: ModuleAction.EDIT },
    });
  });

  it('is declared before the routes that read an asset by id', () => {
    const order = Object.getOwnPropertyNames(prototype);
    expect(order.indexOf('getItOnboarding')).toBeLessThan(order.indexOf('getAsset'));
  });

  describe('what is sent to the tenant service', () => {
    const send = jest.fn(() => of({}));
    const controller = new AssetsController({ send } as any);

    beforeEach(() => send.mockClear());

    it('always asks for the IT setup category, whatever the caller put in the query', () => {
      controller.getItOnboarding('t1', { category: OnboardingTaskCategory.DOCUMENTATION, newHireId: 'h1', page: 2 } as any);

      expect(send).toHaveBeenCalledWith(MESSAGE_PATTERNS.ONBOARDING_TASK.GET_ALL, {
        tenantId: 't1',
        query: { category: OnboardingTaskCategory.IT_SETUP, newHireId: 'h1', page: 2 },
      });
    });

    it('ticks through the IT-only pattern', () => {
      controller.setItOnboardingStatus('t1', 'task-1', { completed: true } as any, 'user-1');

      expect(send).toHaveBeenCalledWith(MESSAGE_PATTERNS.ONBOARDING_TASK.SET_IT_STATUS, {
        tenantId: 't1',
        taskId: 'task-1',
        dto: { completed: true },
        actorUserId: 'user-1',
      });
    });
  });
});
