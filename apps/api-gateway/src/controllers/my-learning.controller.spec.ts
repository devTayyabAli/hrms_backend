import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, PermissionsGuard, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { MyLearningController } from './my-learning.controller';

/**
 * My Learning is every employee's own: signed in, an employee profile, and the
 * Learning module on — and nothing else. A permission check here would lock out
 * the very people it is for, so none of these routes may have one.
 */
describe('MyLearningController', () => {
  const prototype = MyLearningController.prototype as unknown as Record<string, unknown>;
  const isRoute = (name: string) =>
    typeof prototype[name] === 'function' && Reflect.getMetadata('method', prototype[name] as object) !== undefined;
  const routes = () =>
    Object.getOwnPropertyNames(prototype)
      .filter(isRoute)
      .map((name) => ({
        route: `${RequestMethod[Reflect.getMetadata('method', prototype[name] as object)].toUpperCase()} ${Reflect.getMetadata('path', prototype[name] as object)}`,
        permissions: Reflect.getMetadata(PERMISSIONS_KEY, prototype[name] as object),
      }));

  it('has exactly these routes', () => {
    expect(routes().map((r) => r.route).sort()).toEqual(
      [
        'GET history',
        'GET /',
        'GET :assignmentId',
        'POST :assignmentId/start',
        'POST :assignmentId/materials/:materialId/open',
        'GET :assignmentId/materials/:materialId/download',
        'POST :assignmentId/complete',
      ].sort(),
    );
  });

  it('asks for no permission on any route, and does not use the permission guard', () => {
    expect(routes().every((r) => r.permissions === undefined)).toBe(true);
    const guards = (Reflect.getMetadata('__guards__', MyLearningController) ?? []) as unknown[];
    expect(guards).not.toContain(PermissionsGuard);
  });

  it('needs the Learning module, so an organization without it is turned away', () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, MyLearningController)).toMatchObject({ moduleKey: HRMSModuleKey.LEARNING, action: ModuleAction.VIEW });
  });

  it('declares history before the route that reads a course by id', () => {
    const order = Object.getOwnPropertyNames(prototype).filter(isRoute);
    const pathOf = (name: string) => Reflect.getMetadata('path', prototype[name] as object);
    const history = order.findIndex((name) => pathOf(name) === 'history');
    const byId = order.findIndex((name) => pathOf(name) === ':assignmentId' && Reflect.getMetadata('method', prototype[name] as object) === RequestMethod.GET);

    expect(history).toBeGreaterThan(-1);
    expect(history).toBeLessThan(byId);
  });
});
