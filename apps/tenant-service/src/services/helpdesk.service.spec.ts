import { HttpStatus } from '@nestjs/common';
import { HelpdeskCategory, HelpdeskPriority, HelpdeskStatus } from '@app/common';
import { HelpdeskService } from './helpdesk.service';
import { table } from './testing/fake-table';

/**
 * The IT helpdesk: an employee raises and follows a ticket, IT works the
 * queue, and each side is told what the other did.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', ...over });

describe('HelpdeskService', () => {
  let models: Record<string, any>;
  let holders: { tellPermission: jest.Mock };
  let service: HelpdeskService;
  let ayesha: any;
  let ali: any;
  let sara: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Ali', lastName: 'IT', userId: 'u-ali', email: 'ali@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Sara', lastName: 'Other', userId: 'u-sara', email: 'sara@x.com' }),
      ]),
      Ticket: table(),
      Notification: table(),
    };
    [ayesha, ali, sara] = models.Employee.rows;
    // The fake table cannot group, so the counts per status are answered from the rows.
    const count = models.Ticket.count;
    models.Ticket.count = jest.fn(async (options: any = {}) => {
      if (!options.group) return count(options);
      const found = models.Ticket.rows.filter((row: any) => row.tenantId === options.where.tenantId);
      return ['OPEN', 'IN_PROGRESS', 'WAITING_ON_REQUESTER', 'RESOLVED', 'CLOSED'].map((status) => ({ status, count: found.filter((row: any) => row.status === status).length }));
    });
    holders = { tellPermission: jest.fn() };
    const provider: any = {
      getEmployeeModel: async () => models.Employee,
      getHelpdeskTicketModel: async () => models.Ticket,
      getEmployeeNotificationModel: async () => models.Notification,
    };
    service = new HelpdeskService(provider, holders as any);
  });

  const raise = (over: Record<string, unknown> = {}) => service.create(TENANT, 'u-ayesha', undefined, { subject: 'VPN does not connect', description: 'Authentication failed', ...over } as any) as Promise<any>;
  const notes = () => models.Notification.rows.map((n: any) => [n.employeeId, n.title]);

  describe('raising a ticket', () => {
    it('numbers it, opens it, thanks the requester and tells the people who hold tickets.manage', async () => {
      const ticket = await raise({ priority: HelpdeskPriority.HIGH, category: HelpdeskCategory.NETWORK });

      expect(ticket).toMatchObject({ ticketNumber: 'TKT-0001', status: 'OPEN', priority: 'HIGH', category: 'NETWORK', assignedTo: null, requester: { name: 'Ayesha Khan' } });
      expect(notes()).toEqual([[ayesha.id, 'Ticket TKT-0001 raised']]);
      expect(holders.tellPermission).toHaveBeenCalledWith(TENANT, 'tickets.manage', [ayesha.id], 'New ticket TKT-0001', expect.stringContaining('VPN does not connect'));
      expect((await raise()).ticketNumber).toBe('TKT-0002');
    });

    it('defaults to a medium priority in the other category', async () => {
      expect(await raise()).toMatchObject({ priority: 'MEDIUM', category: 'OTHER' });
    });

    it('needs an employee profile', async () => {
      await expect(service.create(TENANT, 'u-nobody', undefined, { subject: 'x', description: 'y' } as any)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('my tickets', () => {
    it('lists only mine, and how many are still open', async () => {
      await raise();
      await service.create(TENANT, 'u-sara', undefined, { subject: 'Printer', description: 'Jammed' } as any);

      const mine: any = await service.listMine(TENANT, 'u-ayesha');

      expect(mine.open).toBe(1);
      expect(mine.data.map((t: any) => t.subject)).toEqual(['VPN does not connect']);
      expect(mine.data[0]).not.toHaveProperty('comments');
    });

    it('does not show somebody else a ticket that is not theirs', async () => {
      const ticket = await raise();
      await expect(service.getMine(TENANT, 'u-sara', undefined, ticket.id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(service.commentMine(TENANT, 'u-sara', undefined, ticket.id, { text: 'hi' } as any)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('hides internal notes from the requester', async () => {
      const ticket = await raise();
      await service.comment(TENANT, ticket.id, { text: 'Looks like a bad token', internal: true } as any, { userId: 'u-ali' });
      await service.comment(TENANT, ticket.id, { text: 'Please restart the client' } as any, { userId: 'u-ali' });

      const mine: any = await service.getMine(TENANT, 'u-ayesha', undefined, ticket.id);
      const staff: any = await service.get(TENANT, ticket.id);

      expect(mine.comments.map((c: any) => c.text)).toEqual(['Please restart the client']);
      expect(staff.comments.map((c: any) => c.text)).toEqual(['Looks like a bad token', 'Please restart the client']);
    });

    it('reopens a resolved ticket, and only a resolved one', async () => {
      const ticket = await raise();
      await expect(service.reopenMine(TENANT, 'u-ayesha', undefined, ticket.id)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

      await service.update(TENANT, ticket.id, { assignedToEmployeeId: ali.id } as any);
      await service.update(TENANT, ticket.id, { status: HelpdeskStatus.RESOLVED, resolutionNote: 'Reset the token' } as any);
      models.Notification.rows.length = 0;

      expect(await service.reopenMine(TENANT, 'u-ayesha', undefined, ticket.id)).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null });
      expect(notes()).toEqual([[ali.id, 'Ticket TKT-0001 reopened']]);
    });

    it('closes its own ticket, and says no to commenting on a closed one', async () => {
      const ticket = await raise();
      expect(await service.closeMine(TENANT, 'u-ayesha', undefined, ticket.id)).toMatchObject({ status: 'CLOSED' });
      await expect(service.commentMine(TENANT, 'u-ayesha', undefined, ticket.id, { text: 'still there' } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(service.closeMine(TENANT, 'u-ayesha', undefined, ticket.id)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('puts a ticket back in work when the requester answers a question', async () => {
      const ticket = await raise();
      await service.update(TENANT, ticket.id, { assignedToEmployeeId: ali.id, status: HelpdeskStatus.WAITING_ON_REQUESTER } as any);
      models.Notification.rows.length = 0;

      const answered: any = await service.commentMine(TENANT, 'u-ayesha', undefined, ticket.id, { text: 'It says error 691' } as any);

      expect(answered.status).toBe('IN_PROGRESS');
      expect(notes()).toEqual([[ali.id, 'Ticket TKT-0001: new reply']]);
    });

    it('tells the tickets.manage people when an unassigned ticket gets a reply', async () => {
      const ticket = await raise();
      holders.tellPermission.mockClear();
      await service.commentMine(TENANT, 'u-ayesha', undefined, ticket.id, { text: 'Any news?' } as any);
      expect(holders.tellPermission).toHaveBeenCalledWith(TENANT, 'tickets.manage', [ayesha.id], 'Ticket TKT-0001: new reply', expect.any(String));
    });
  });

  describe('working the queue', () => {
    it('taking an untouched ticket starts the work and tells the assignee and the requester', async () => {
      const ticket = await raise();
      models.Notification.rows.length = 0;

      const taken: any = await service.update(TENANT, ticket.id, { assignedToEmployeeId: sara.id } as any, { userId: 'u-ali' });

      expect(taken).toMatchObject({ status: 'IN_PROGRESS', assignedTo: { name: 'Sara Other' } });
      expect(notes()).toEqual([[ayesha.id, 'Ticket TKT-0001'], [sara.id, 'Ticket TKT-0001 assigned to you']]);
    });

    it('does not notify someone who took the ticket themselves', async () => {
      const ticket = await raise();
      models.Notification.rows.length = 0;
      await service.update(TENANT, ticket.id, { assignedToEmployeeId: ali.id } as any, { userId: 'u-ali' });
      expect(notes()).toEqual([[ayesha.id, 'Ticket TKT-0001']]);
    });

    it('needs a resolution note to resolve, and records when', async () => {
      const ticket = await raise();
      await expect(service.update(TENANT, ticket.id, { status: HelpdeskStatus.RESOLVED } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });

      const done: any = await service.update(TENANT, ticket.id, { status: HelpdeskStatus.RESOLVED, resolutionNote: 'Token reset' } as any);

      expect(done).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Token reset' });
      expect(done.resolvedAt).toBeInstanceOf(Date);
      expect(models.Notification.rows.at(-1).body).toContain('Token reset');
    });

    it('refuses an assignee who is not on the books', async () => {
      const ticket = await raise();
      ali.status = 'RESIGNED';
      await expect(service.update(TENANT, ticket.id, { assignedToEmployeeId: ali.id } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(service.update(TENANT, ticket.id, { assignedToEmployeeId: '99999999-9999-4999-8999-999999999999' } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('takes a ticket back to the queue', async () => {
      const ticket = await raise();
      await service.update(TENANT, ticket.id, { assignedToEmployeeId: ali.id } as any);
      expect(await service.update(TENANT, ticket.id, { assignedToEmployeeId: null } as any)).toMatchObject({ assignedTo: null });
    });

    it('changes nothing, and tells nobody, when nothing changed', async () => {
      const ticket = await raise();
      models.Notification.rows.length = 0;
      await service.update(TENANT, ticket.id, {} as any);
      expect(notes()).toEqual([]);
    });

    it('lists the queue with counts by status, and filters it', async () => {
      const first = await raise();
      await raise({ subject: 'Laptop fan' });
      await service.update(TENANT, first.id, { assignedToEmployeeId: ali.id } as any);

      const all: any = await service.list(TENANT, {});
      expect(all.total).toBe(2);
      expect(all.summary).toMatchObject({ open: 1, inProgress: 1, resolved: 0 });

      const unassigned: any = await service.list(TENANT, { assigned: 'UNASSIGNED' });
      expect(unassigned.data.map((t: any) => t.subject)).toEqual(['Laptop fan']);

      const mine: any = await service.list(TENANT, { assigned: 'ME' }, { userId: 'u-ali' });
      expect(mine.data.map((t: any) => t.ticketNumber)).toEqual(['TKT-0001']);
    });

    it('does not find a ticket that does not exist', async () => {
      await expect(service.get(TENANT, '99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });
});
