import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { LearningController } from './learning.controller';

/**
 * Who may do what in Learning. The permission each route asks for is part of
 * the API's contract, so it is pinned here.
 */
describe('LearningController: permissions', () => {
  const prototype = LearningController.prototype as unknown as Record<string, unknown>;

  /** Route handlers only: helpers like `actor` have no HTTP method. */
  const isRoute = (name: string) =>
    typeof prototype[name] === 'function' && Reflect.getMetadata('method', prototype[name] as object) !== undefined;

  const routes = () =>
    Object.getOwnPropertyNames(prototype)
      .filter(isRoute)
      .map((name) => {
        const handler = prototype[name] as object;
        return {
          route: `${RequestMethod[Reflect.getMetadata('method', handler)].toUpperCase()} ${Reflect.getMetadata('path', handler)}`,
          permissions: (Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? []) as string[],
          module: Reflect.getMetadata(REQUIRE_MODULE_KEY, handler) as { moduleKey: string; action?: string } | undefined,
        };
      });

  const VIEW = ['learning.view', 'learning.manage'];
  const CREATE = ['learning.create', 'learning.manage'];
  const EDIT = ['learning.edit', 'learning.manage'];
  const DELETE = ['learning.delete', 'learning.manage'];
  const ASSIGN = ['learning.assign', 'learning.manage'];

  const EXPECTED: Record<string, { permissions: string[]; action: ModuleAction }> = {
    'GET courses': { permissions: VIEW, action: ModuleAction.VIEW },
    'GET courses/categories': { permissions: VIEW, action: ModuleAction.VIEW },
    'POST courses': { permissions: CREATE, action: ModuleAction.CREATE },
    'GET courses/:courseId': { permissions: VIEW, action: ModuleAction.VIEW },
    'PATCH courses/:courseId': { permissions: EDIT, action: ModuleAction.EDIT },
    'DELETE courses/:courseId': { permissions: DELETE, action: ModuleAction.DELETE },
    'POST courses/:courseId/publish': { permissions: EDIT, action: ModuleAction.EDIT },
    'POST courses/:courseId/archive': { permissions: EDIT, action: ModuleAction.EDIT },
    'POST courses/:courseId/unarchive': { permissions: EDIT, action: ModuleAction.EDIT },
    'POST courses/:courseId/duplicate': { permissions: CREATE, action: ModuleAction.CREATE },
    'POST courses/:courseId/materials': { permissions: EDIT, action: ModuleAction.EDIT },
    'PUT courses/:courseId/materials/order': { permissions: EDIT, action: ModuleAction.EDIT },
    'PATCH courses/:courseId/materials/:materialId': { permissions: EDIT, action: ModuleAction.EDIT },
    'DELETE courses/:courseId/materials/:materialId': { permissions: EDIT, action: ModuleAction.EDIT },
    'GET courses/:courseId/materials/:materialId/download': { permissions: VIEW, action: ModuleAction.VIEW },
    'GET dashboard': { permissions: VIEW, action: ModuleAction.VIEW },
    'GET reports/courses': { permissions: VIEW, action: ModuleAction.VIEW },
    'GET reports/departments': { permissions: VIEW, action: ModuleAction.VIEW },
    'GET assignments/export': { permissions: ['learning.export', 'learning.manage'], action: ModuleAction.VIEW },
    'GET alerts': { permissions: VIEW, action: ModuleAction.VIEW },
    'GET employees/:employeeId': { permissions: VIEW, action: ModuleAction.VIEW },
    'POST recommendations': { permissions: ['learning.assign', 'learning.manage', 'performance.edit', 'performance.manage'], action: ModuleAction.VIEW },
    'GET recommendations': { permissions: VIEW, action: ModuleAction.VIEW },
    'POST recommendations/:recommendationId/approve': { permissions: ASSIGN, action: ModuleAction.EDIT },
    'POST recommendations/:recommendationId/dismiss': { permissions: ASSIGN, action: ModuleAction.EDIT },
    'GET settings': { permissions: VIEW, action: ModuleAction.VIEW },
    'PATCH settings': { permissions: EDIT, action: ModuleAction.EDIT },
    'POST assignments': { permissions: ASSIGN, action: ModuleAction.EDIT },
    'GET assignments': { permissions: VIEW, action: ModuleAction.VIEW },
    'GET assignments/:assignmentId': { permissions: VIEW, action: ModuleAction.VIEW },
    'PATCH assignments/:assignmentId': { permissions: ASSIGN, action: ModuleAction.EDIT },
    'POST assignments/:assignmentId/cancel': { permissions: ASSIGN, action: ModuleAction.EDIT },
  };

  it('has exactly these routes, and no others', () => {
    expect(routes().map((route) => route.route).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s asks for the right permissions and module action', (route, expected) => {
    const found = routes().find((candidate) => candidate.route === route)!;

    expect([...found.permissions].sort()).toEqual([...expected.permissions].sort());
    expect(found.module).toMatchObject({ moduleKey: HRMSModuleKey.LEARNING, action: expected.action });
  });

  it('declares the categories route before the one that reads a course by id', () => {
    const order = Object.getOwnPropertyNames(prototype).filter(isRoute);
    const pathOf = (name: string) => Reflect.getMetadata('path', prototype[name] as object);

    const categories = order.findIndex((name) => pathOf(name) === 'courses/categories');
    const byId = order.findIndex((name) => pathOf(name) === 'courses/:courseId' && Reflect.getMetadata('method', prototype[name] as object) === RequestMethod.GET);

    expect(categories).toBeGreaterThan(-1);
    expect(categories).toBeLessThan(byId);
  });
});
