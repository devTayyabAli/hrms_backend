import {
  DirectoryRoleCategory,
  DirectorySourceType,
  ProjectionEventType,
  categorizeRoleName,
} from '@app/database';
import { DirectoryProjectionService } from './directory-projection.service';

/**
 * The projection is fed by an at-least-once outbox, so every guarantee that
 * keeps it honest lives here: an event may arrive twice, out of order, or
 * after the person was deleted, and none of those may corrupt a row.
 */
describe('DirectoryProjectionService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const SOURCE = '22222222-2222-4222-8222-222222222222';

  let directory: any;
  let counters: any;
  let signal: any;
  let service: DirectoryProjectionService;

  const existingRow = (over: Record<string, any> = {}) => ({
    id: 'row-1',
    tenantId: TENANT,
    sourceType: DirectorySourceType.USER,
    sourceId: SOURCE,
    version: '100',
    deletedAt: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  const event = (over: Record<string, any> = {}) => ({
    tenantId: TENANT,
    aggregateType: DirectorySourceType.USER,
    aggregateId: SOURCE,
    eventType: ProjectionEventType.UPDATED,
    version: '200',
    payload: { name: 'Meera Nair', email: 'meera@technova.com', isActive: true },
    ...over,
  });

  beforeEach(() => {
    directory = {
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue([1]),
      destroy: jest.fn().mockResolvedValue(0),
      count: jest.fn().mockResolvedValue(0),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
    };
    counters = {
      findByPk: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      findAll: jest.fn().mockResolvedValue([]),
      destroy: jest.fn().mockResolvedValue(0),
      count: jest.fn().mockResolvedValue(0),
    };
    signal = {
      findByPk: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      findAll: jest.fn().mockResolvedValue([]),
      destroy: jest.fn().mockResolvedValue(0),
    };

    service = new DirectoryProjectionService(directory, counters, signal);
  });

  describe('role categorisation', () => {
    /** The writer and any remaining direct reader must agree, or a person is
     *  filed under one category and searched for under another. */
    it('matches the categories the Clients screen already uses', () => {
      expect(categorizeRoleName('ORGANIZATION_ADMIN')).toBe(DirectoryRoleCategory.ADMIN);
      expect(categorizeRoleName('HR_MANAGER')).toBe(DirectoryRoleCategory.HR);
      expect(categorizeRoleName('EMPLOYEE')).toBe(DirectoryRoleCategory.EMPLOYEE);
      expect(categorizeRoleName('Something Else')).toBe(DirectoryRoleCategory.OTHER);
      expect(categorizeRoleName(null)).toBe(DirectoryRoleCategory.OTHER);
    });
  });

  describe('applying events', () => {
    it('creates a row the first time it sees a person', async () => {
      const result = await service.apply([event({ eventType: ProjectionEventType.CREATED })]);

      expect(directory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          sourceType: DirectorySourceType.USER,
          sourceId: SOURCE,
          name: 'Meera Nair',
          version: '200',
        }),
      );
      expect(result.applied).toBe(1);
    });

    it('updates in place rather than inserting a duplicate', async () => {
      const row = existingRow();
      directory.findOne.mockResolvedValue(row);

      await service.apply([event()]);

      expect(directory.create).not.toHaveBeenCalled();
      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Meera Nair', version: '200' }),
      );
    });

    /** At-least-once delivery means the same event can arrive twice. */
    it('ignores a replay of an event it already applied', async () => {
      const row = existingRow({ version: '200' });
      directory.findOne.mockResolvedValue(row);

      const result = await service.apply([event({ version: '200' })]);

      expect(row.update).not.toHaveBeenCalled();
      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('ignores an event older than the row it holds', async () => {
      const row = existingRow({ version: '500' });
      directory.findOne.mockResolvedValue(row);

      await service.apply([event({ version: '300' })]);

      expect(row.update).not.toHaveBeenCalled();
    });

    it('applies only the fields the payload carried', async () => {
      const row = existingRow();
      directory.findOne.mockResolvedValue(row);

      await service.apply([event({ payload: { isActive: false } })]);

      const patch = row.update.mock.calls[0][0];
      expect(patch).toHaveProperty('isActive', false);
      // A partial event must not blank the name it said nothing about.
      expect(patch).not.toHaveProperty('name');
      expect(patch).not.toHaveProperty('email');
    });

    it('stamps the organization name the relay resolved', async () => {
      await service.apply([
        event({ eventType: ProjectionEventType.CREATED, organizationName: 'TechNova' }),
      ]);

      expect(directory.create).toHaveBeenCalledWith(
        expect.objectContaining({ organizationName: 'TechNova' }),
      );
    });
  });

  describe('deletion', () => {
    it('tombstones the row rather than leaving it listed', async () => {
      directory.update.mockResolvedValue([1]);

      const result = await service.apply([
        event({ eventType: ProjectionEventType.DELETED, payload: null }),
      ]);

      expect(directory.update).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT,
            sourceId: SOURCE,
            deletedAt: null,
          }),
        }),
      );
      expect(result.applied).toBe(1);
    });

    /**
     * A DELETE and a late UPDATE can race. If the update won, a deleted
     * person would reappear on the SuperAdmin directory.
     */
    it('does not let a late update resurrect a deleted person', async () => {
      const row = existingRow({ deletedAt: new Date(), version: '100' });
      directory.findOne.mockResolvedValue(row);

      const result = await service.apply([
        event({ eventType: ProjectionEventType.UPDATED, version: '300' }),
      ]);

      expect(row.update).not.toHaveBeenCalled();
      expect(result.applied).toBe(0);
    });

    /** Re-adding the same id is a genuine create and must clear the tombstone. */
    it('revives the row when the same id is created again', async () => {
      const row = existingRow({ deletedAt: new Date(), version: '100' });
      directory.findOne.mockResolvedValue(row);

      await service.apply([event({ eventType: ProjectionEventType.CREATED, version: '300' })]);

      expect(row.update).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: null }));
    });

    it('reports a delete for a person it never had as no-op', async () => {
      directory.update.mockResolvedValue([0]);

      const result = await service.apply([
        event({ eventType: ProjectionEventType.DELETED, payload: null }),
      ]);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('drops everything belonging to a deprovisioned tenant', async () => {
      await service.dropTenant(TENANT);

      expect(directory.destroy).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
      expect(counters.destroy).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
      expect(signal.destroy).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
    });
  });

  describe('counters', () => {
    it('recomputes from the directory rather than incrementing', async () => {
      directory.findAll.mockResolvedValue([
        { roleCategory: 'ADMIN', total: '2', active: '2' },
        { roleCategory: 'HR', total: '3', active: '1' },
        { roleCategory: 'EMPLOYEE', total: '10', active: '9' },
      ]);

      await service.refreshCounters(TENANT);

      expect(counters.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          totalUsers: 15,
          activeUsers: 12,
          admins: 2,
          hrs: 3,
          employees: 10,
        }),
      );
    });

    it('refreshes each touched tenant once, not once per event', async () => {
      const other = '33333333-3333-4333-8333-333333333333';
      await service.apply([
        event({ eventType: ProjectionEventType.CREATED }),
        event({ eventType: ProjectionEventType.CREATED, aggregateId: 'b' }),
        event({ eventType: ProjectionEventType.CREATED, tenantId: other, aggregateId: 'c' }),
      ]);

      // Three events, two tenants.
      expect(directory.findAll).toHaveBeenCalledTimes(2);
    });
  });

  describe('listing', () => {
    it('hides tombstoned rows', async () => {
      await service.queryDirectory({});

      const where = directory.findAndCountAll.mock.calls[0][0].where;
      expect(where.deletedAt).toBeNull();
    });

    it('excludes plain employees from the contacts directory by default', async () => {
      await service.queryDirectory({ excludeEmployees: true });

      const where = directory.findAndCountAll.mock.calls[0][0].where;
      expect(where.roleCategory).toBeDefined();
      expect(where.roleCategory).not.toBe(DirectoryRoleCategory.EMPLOYEE);
    });

    it('filters to one category when asked', async () => {
      await service.queryDirectory({
        roleCategory: DirectoryRoleCategory.HR,
        excludeEmployees: true,
      });

      const where = directory.findAndCountAll.mock.calls[0][0].where;
      expect(where.roleCategory).toBe(DirectoryRoleCategory.HR);
    });

    /** sortBy arrives from a query string and must not reach ORDER BY raw. */
    it('ignores a sort column that is not whitelisted', async () => {
      await service.queryDirectory({ sortBy: 'passwordHash; DROP TABLE users' });

      const order = directory.findAndCountAll.mock.calls[0][0].order;
      expect(order[0][0]).toBe('sourceCreatedAt');
    });

    it('breaks ties on id so paging cannot repeat a row', async () => {
      await service.queryDirectory({ sortBy: 'name', sortOrder: 'ASC' });

      const order = directory.findAndCountAll.mock.calls[0][0].order;
      expect(order).toEqual([
        ['name', 'ASC'],
        ['id', 'ASC'],
      ]);
    });

    it('caps the page size however large a limit is asked for', async () => {
      await service.queryDirectory({ limit: 100000 });

      expect(directory.findAndCountAll.mock.calls[0][0].limit).toBe(200);
    });

    it('pages with an offset derived from the page number', async () => {
      await service.queryDirectory({ page: 3, limit: 25 });

      expect(directory.findAndCountAll.mock.calls[0][0].offset).toBe(50);
    });
  });

  describe('signal', () => {
    it('flags a tenant whose inline apply failed', async () => {
      await service.markPending(TENANT, 'tenant-service unreachable');

      expect(signal.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, pendingSince: expect.any(Date) }),
      );
    });

    it('keeps the original pendingSince across repeated failures', async () => {
      const first = new Date('2026-09-01T00:00:00Z');
      const row = { pendingSince: first, consecutiveFailures: 2, update: jest.fn() };
      signal.findByPk.mockResolvedValue(row);

      await service.markPending(TENANT, 'still down');

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ pendingSince: first, consecutiveFailures: 3 }),
      );
    });

    /**
     * Drift is invisible without this: a stalled relay looks exactly like a
     * quiet platform until someone notices the Clients list is wrong.
     */
    it('reports healthy when no tenant is behind', async () => {
      const health = await service.health();

      expect(health.healthy).toBe(true);
      expect(health.pendingTenants).toBe(0);
      expect(health.oldestPendingSeconds).toBeNull();
      expect(health.failingTenants).toEqual([]);
    });

    it('reports unhealthy and how far behind the oldest tenant is', async () => {
      signal.findAll.mockResolvedValue([
        {
          tenantId: TENANT,
          pendingSince: new Date(Date.now() - 120_000),
          consecutiveFailures: 3,
          lastError: 'platform db down',
        },
      ]);

      const health = await service.health();

      expect(health.healthy).toBe(false);
      expect(health.pendingTenants).toBe(1);
      expect(health.oldestPendingSeconds).toBeGreaterThanOrEqual(119);
      expect(health.failingTenants[0]).toMatchObject({
        tenantId: TENANT,
        consecutiveFailures: 3,
      });
    });

    it('clears the flag once a tenant drains', async () => {
      const row = { pendingSince: new Date(), update: jest.fn() };
      signal.findByPk.mockResolvedValue(row);

      await service.markDrained(TENANT);

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ pendingSince: null, consecutiveFailures: 0 }),
      );
    });
  });
});
