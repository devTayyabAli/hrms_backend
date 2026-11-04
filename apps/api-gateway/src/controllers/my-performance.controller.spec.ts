import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { MyPerformanceController } from './my-performance.controller';
import { PerformanceController } from './performance.controller';

describe('My Performance routes', () => {
  const mine = MyPerformanceController.prototype as unknown as Record<string, any>;
  const admin = PerformanceController.prototype as unknown as Record<string, any>;
  const isRoute = (proto: Record<string, any>, name: string) =>
    typeof proto[name] === 'function' && Reflect.getMetadata('method', proto[name]) !== undefined;

  it('asks for no permission, only the Performance module', () => {
    const names = Object.getOwnPropertyNames(mine).filter((name) => isRoute(mine, name));
    expect(names.map((name) => `${RequestMethod[Reflect.getMetadata('method', mine[name])]} ${Reflect.getMetadata('path', mine[name])}`).sort()).toEqual(
      ['GET goals', 'GET plan', 'GET reviewing', 'GET reviewing/:reviewId', 'GET reviewing/:reviewId/plan', 'GET reviews', 'GET reviews/:reviewId', 'PATCH goals/:goalId/progress', 'POST reviewing/:reviewId/plan/publish', 'PUT reviewing/:reviewId/evaluation', 'PUT reviewing/:reviewId/plan', 'PUT reviews/:reviewId/self-assessment'],
    );
    for (const name of names) expect(Reflect.getMetadata(PERMISSIONS_KEY, mine[name])).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, MyPerformanceController)).toMatchObject({ moduleKey: HRMSModuleKey.PERFORMANCE, action: ModuleAction.VIEW });
  });

  it('keeps publishing with the people who edit reviews', () => {
    for (const name of ['publishReview', 'unpublishReview']) {
      expect(RequestMethod[Reflect.getMetadata('method', admin[name])]).toBe('POST');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, admin[name])).toEqual(['performance.edit', 'performance.manage']);
      expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, admin[name])).toMatchObject({ moduleKey: HRMSModuleKey.PERFORMANCE, action: ModuleAction.EDIT });
    }
  });
});
