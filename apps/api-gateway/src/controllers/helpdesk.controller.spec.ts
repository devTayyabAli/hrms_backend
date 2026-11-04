import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { HelpdeskController, MyTicketsController } from './helpdesk.controller';

describe('Helpdesk routes', () => {
  const staff = HelpdeskController.prototype as unknown as Record<string, any>;
  const mine = MyTicketsController.prototype as unknown as Record<string, any>;
  const meta = (proto: Record<string, any>, name: string) => ({
    route: `${RequestMethod[Reflect.getMetadata('method', proto[name])]} ${Reflect.getMetadata('path', proto[name])}`,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[] | undefined,
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, proto[name]) as { moduleKey: string; action: string } | undefined,
  });

  it('lets people with tickets.view read the queue, on the Tickets module', () => {
    for (const name of ['list', 'get']) {
      expect(meta(staff, name).permissions).toEqual(['tickets.view', 'tickets.manage']);
    }
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, HelpdeskController)).toMatchObject({ moduleKey: HRMSModuleKey.TICKETS });
  });

  it('keeps working a ticket for tickets.manage, as an edit of the module', () => {
    for (const name of ['update', 'comment']) {
      const m = meta(staff, name);
      expect(m.permissions).toEqual(['tickets.manage']);
      expect(m.module).toMatchObject({ moduleKey: HRMSModuleKey.TICKETS, action: ModuleAction.EDIT });
    }
    expect([meta(staff, 'update').route, meta(staff, 'comment').route]).toEqual(['PATCH :id', 'POST :id/comments']);
  });

  it('asks the employee routes for no permission: a ticket is the caller\'s own', () => {
    for (const name of ['list', 'create', 'get', 'comment', 'reopen', 'close']) {
      expect(meta(mine, name).permissions).toBeUndefined();
    }
    expect(Reflect.getMetadata('path', MyTicketsController)).toBe('organization/me/tickets');
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, MyTicketsController)).toMatchObject({ moduleKey: HRMSModuleKey.TICKETS });
  });
});
