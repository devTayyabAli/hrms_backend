import { DirectorySourceType, ProjectionEventType } from '@app/database';
import { ProjectionRelayService } from './projection-relay.service';

/**
 * The relay is the durability guarantee — the inline apply is allowed to
 * fail, so what matters here is that nothing is lost, one broken tenant
 * cannot stop the others, and a poison event cannot block the queue forever.
 */
describe('ProjectionRelayService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  let outbox: any;
  let modelProvider: any;
  let projection: any;
  let tenants: any;
  let service: ProjectionRelayService;

  const outboxRow = (over: Record<string, any> = {}) => ({
    id: 'evt-1',
    aggregateType: DirectorySourceType.USER,
    aggregateId: 'user-1',
    eventType: ProjectionEventType.CREATED,
    version: '100',
    payload: { name: 'Meera Nair' },
    occurredAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    outbox = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue([1]),
      increment: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
    };
    modelProvider = {
      getProjectionOutboxModel: jest.fn().mockResolvedValue(outbox),
    };
    projection = {
      apply: jest.fn().mockResolvedValue({ applied: 1, skipped: 0 }),
      markDrained: jest.fn().mockResolvedValue(undefined),
      markPending: jest.fn().mockResolvedValue(undefined),
      pendingTenantIds: jest.fn().mockResolvedValue([]),
      purgeTombstones: jest.fn().mockResolvedValue(0),
    };
    tenants = {
      getAllTenants: jest.fn().mockResolvedValue([]),
      getTenantById: jest.fn().mockResolvedValue({ organizationName: 'TechNova' }),
    };

    const config = { get: jest.fn((_key: string, fallback: any) => fallback) };

    service = new ProjectionRelayService(
      modelProvider as any,
      projection as any,
      tenants as any,
      config as any,
    );
  });

  describe('drainPending', () => {
    /**
     * The whole point of the signal table: in steady state the relay must
     * open no tenant connections at all, or it becomes the fan-out it exists
     * to replace.
     */
    it('touches no tenant when nothing is pending', async () => {
      const result = await service.drainPending();

      expect(result.tenants).toBe(0);
      expect(modelProvider.getProjectionOutboxModel).not.toHaveBeenCalled();
    });

    it('drains only the tenants the signal flags', async () => {
      projection.pendingTenantIds.mockResolvedValue([TENANT]);
      outbox.findAll.mockResolvedValueOnce([outboxRow()]).mockResolvedValue([]);

      await service.drainPending();

      expect(modelProvider.getProjectionOutboxModel).toHaveBeenCalledWith(TENANT);
      expect(modelProvider.getProjectionOutboxModel).toHaveBeenCalledTimes(1);
    });

    /** A slow pass overlapping the next tick would apply the same batch twice. */
    it('does not start a second pass while one is running', async () => {
      let release: () => void = () => undefined;
      const blocked = new Promise<string[]>((resolve) => {
        release = () => resolve([]);
      });
      // Hold the first pass open at its very first await, then let it finish.
      projection.pendingTenantIds.mockReturnValueOnce(blocked);

      const first = service.drainPending();
      const second = await service.drainPending();

      expect(second).toEqual({ tenants: 0, applied: 0 });
      expect(projection.pendingTenantIds).toHaveBeenCalledTimes(1);

      release();
      await first;
    });
  });

  describe('drainTenant', () => {
    it('marks the batch processed once it is applied', async () => {
      outbox.findAll.mockResolvedValueOnce([outboxRow()]).mockResolvedValue([]);

      const applied = await service.drainTenant(TENANT);

      expect(projection.apply).toHaveBeenCalledWith([
        expect.objectContaining({
          tenantId: TENANT,
          aggregateId: 'user-1',
          organizationName: 'TechNova',
        }),
      ]);
      expect(outbox.update).toHaveBeenCalledWith(
        expect.objectContaining({ processedAt: expect.any(Date) }),
        expect.anything(),
      );
      expect(applied).toBe(1);
    });

    it('asks only for unprocessed events, oldest first', async () => {
      await service.drainTenant(TENANT);

      const query = outbox.findAll.mock.calls[0][0];
      expect(query.where.processedAt).toBeNull();
      expect(query.order).toEqual([['occurredAt', 'ASC']]);
    });

    it('clears the pending flag after a clean drain', async () => {
      await service.drainTenant(TENANT);

      expect(projection.markDrained).toHaveBeenCalledWith(TENANT);
    });

    /** A poison event must not block every later event forever. */
    it('counts an attempt when a batch fails so it can eventually be parked', async () => {
      outbox.findAll.mockResolvedValue([outboxRow()]);
      projection.apply.mockRejectedValue(new Error('platform db down'));

      await service.drainTenant(TENANT);

      expect(outbox.increment).toHaveBeenCalledWith('attempts', expect.anything());
      expect(outbox.update).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: expect.stringContaining('platform db down') }),
        expect.anything(),
      );
    });

    it('re-flags the tenant when its drain fails', async () => {
      outbox.findAll.mockResolvedValue([outboxRow()]);
      projection.apply.mockRejectedValue(new Error('platform db down'));

      await service.drainTenant(TENANT);

      expect(projection.markPending).toHaveBeenCalledWith(
        TENANT,
        expect.stringContaining('platform db down'),
      );
      expect(projection.markDrained).not.toHaveBeenCalled();
    });

    /** One unreachable tenant database must not stop the rest. */
    it('contains a tenant whose database cannot be opened', async () => {
      modelProvider.getProjectionOutboxModel.mockRejectedValue(new Error('no such database'));

      await expect(service.drainTenant(TENANT)).resolves.toBe(0);
      expect(projection.markPending).toHaveBeenCalled();
    });

    it('still projects when the organization name cannot be resolved', async () => {
      tenants.getTenantById.mockRejectedValue(new Error('tenant lookup failed'));
      outbox.findAll.mockResolvedValueOnce([outboxRow()]).mockResolvedValue([]);

      await service.drainTenant(TENANT);

      expect(projection.apply).toHaveBeenCalledWith([
        expect.objectContaining({ organizationName: null }),
      ]);
    });
  });

  describe('fullSweep', () => {
    it('visits every tenant regardless of the signal', async () => {
      tenants.getAllTenants.mockResolvedValue([{ id: TENANT }, { id: OTHER }]);

      const result = await service.fullSweep();

      expect(result.tenants).toBe(2);
      expect(modelProvider.getProjectionOutboxModel).toHaveBeenCalledWith(TENANT);
      expect(modelProvider.getProjectionOutboxModel).toHaveBeenCalledWith(OTHER);
    });

    it('purges expired tombstones while it is there', async () => {
      await service.fullSweep();

      expect(projection.purgeTombstones).toHaveBeenCalled();
    });
  });

  describe('lag', () => {
    it('reports depth and the age of the oldest unapplied event', async () => {
      outbox.count.mockResolvedValue(4);
      outbox.findOne.mockResolvedValue({
        occurredAt: new Date(Date.now() - 90_000),
      });

      const lag = await service.lagFor(TENANT);

      expect(lag.pending).toBe(4);
      expect(lag.oldestSeconds).toBeGreaterThanOrEqual(89);
    });

    it('reports no lag when the outbox is empty', async () => {
      const lag = await service.lagFor(TENANT);

      expect(lag).toEqual({ pending: 0, oldestSeconds: null });
    });
  });
});
