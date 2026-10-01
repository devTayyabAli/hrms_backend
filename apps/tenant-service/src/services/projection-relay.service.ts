import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Op } from 'sequelize';
import { DirectorySourceType, ProjectionEventType } from '@app/database';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DirectoryProjectionService, ProjectionEvent } from './directory-projection.service';
import { TenantService } from './tenant.service';

/** Rows drained per tenant per pass. Bounds memory and transaction length. */
const BATCH_SIZE = 500;

/** Attempts before an event is parked rather than retried forever. */
const MAX_ATTEMPTS = 8;

/**
 * Drains each tenant's projection outbox into the central directory.
 *
 * This is the durability half of the design. The synchronous apply that runs
 * right after a write is only an optimisation — if it fails, nothing is lost,
 * because the event is already committed in the tenant's outbox and this
 * relay will pick it up.
 *
 * It deliberately does NOT poll every tenant. A tenant is visited only when
 * the signal table says it has unapplied work, which in steady state is no
 * tenants at all; a slower full sweep catches anything whose signal write
 * also failed. Polling all tenants on a timer would reintroduce, on a
 * schedule, the same fan-out the read model exists to remove.
 */
@Injectable()
export class ProjectionRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectionRelayService.name);
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly projection: DirectoryProjectionService,
    private readonly tenants: TenantService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get('PROJECTION_RELAY_ENABLED', 'true') !== 'true') {
      this.logger.log('Projection relay disabled (PROJECTION_RELAY_ENABLED=false).');
      return;
    }

    const intervalMs = Number(this.config.get('PROJECTION_RELAY_INTERVAL_MS', 15000));
    const sweepMs = Number(this.config.get('PROJECTION_SWEEP_INTERVAL_MS', 3600000));

    this.timer = setInterval(() => {
      this.drainPending().catch((error) =>
        this.logger.error(`Projection relay pass failed: ${error?.message ?? error}`),
      );
    }, intervalMs);
    // Node keeps the process alive for an interval otherwise; this worker
    // must not be the reason the service refuses to shut down.
    this.timer.unref?.();

    this.sweepTimer = setInterval(() => {
      this.fullSweep().catch((error) =>
        this.logger.error(`Projection sweep failed: ${error?.message ?? error}`),
      );
    }, sweepMs);
    this.sweepTimer.unref?.();

    this.logger.log(
      `Projection relay started (every ${intervalMs}ms, full sweep every ${sweepMs}ms).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Visits only the tenants the signal table flags as owing events. */
  async drainPending(): Promise<{ tenants: number; applied: number }> {
    // A slow pass must not overlap with the next tick and double-apply.
    if (this.running) return { tenants: 0, applied: 0 };
    this.running = true;
    try {
      const tenantIds = await this.projection.pendingTenantIds();
      let applied = 0;
      for (const tenantId of tenantIds) {
        applied += await this.drainTenant(tenantId);
      }
      return { tenants: tenantIds.length, applied };
    } finally {
      this.running = false;
    }
  }

  /**
   * Visits every tenant regardless of signal. The backstop for an event whose
   * signal write itself failed — rare, but its absence would be invisible.
   */
  async fullSweep(): Promise<{ tenants: number; applied: number }> {
    if (this.running) return { tenants: 0, applied: 0 };
    this.running = true;
    try {
      const tenants = await this.tenants.getAllTenants();
      const list: any[] = Array.isArray(tenants) ? tenants : ((tenants as any)?.data ?? []);
      let applied = 0;
      for (const tenant of list) {
        applied += await this.drainTenant(tenant.id);
      }
      await this.projection.purgeTombstones();
      return { tenants: list.length, applied };
    } finally {
      this.running = false;
    }
  }

  /** Drains one tenant's outbox. Failure is contained to that tenant. */
  async drainTenant(tenantId: string): Promise<number> {
    let applied = 0;
    try {
      const Outbox = await this.modelProvider.getProjectionOutboxModel(tenantId);
      const organizationName = await this.organizationNameFor(tenantId);

      for (;;) {
        const rows = await Outbox.findAll({
          where: { processedAt: null, attempts: { [Op.lt]: MAX_ATTEMPTS } },
          order: [['occurredAt', 'ASC']],
          limit: BATCH_SIZE,
        });
        if (!rows.length) break;

        const events: ProjectionEvent[] = (rows as any[]).map((row) => ({
          tenantId,
          aggregateType: row.aggregateType as DirectorySourceType,
          aggregateId: row.aggregateId,
          eventType: row.eventType as ProjectionEventType,
          version: row.version,
          payload: row.payload,
          organizationName,
        }));

        try {
          const result = await this.projection.apply(events);
          applied += result.applied;
          await Outbox.update(
            { processedAt: new Date(), lastError: null },
            { where: { id: { [Op.in]: (rows as any[]).map((row) => row.id) } } },
          );
        } catch (error: any) {
          // The batch failed as a unit; count the attempt so a poison event
          // is eventually parked instead of blocking the queue forever.
          await Outbox.increment('attempts', {
            where: { id: { [Op.in]: (rows as any[]).map((row) => row.id) } },
          });
          await Outbox.update(
            { lastError: String(error?.message ?? error).slice(0, 1000) },
            { where: { id: { [Op.in]: (rows as any[]).map((row) => row.id) } } },
          );
          throw error;
        }

        if (rows.length < BATCH_SIZE) break;
      }

      await this.projection.markDrained(tenantId);
    } catch (error: any) {
      this.logger.warn(
        `Could not drain projection outbox for tenant ${tenantId}: ${error?.message ?? error}`,
      );
      await this.projection
        .markPending(tenantId, String(error?.message ?? error))
        .catch(() => undefined);
    }
    return applied;
  }

  private async organizationNameFor(tenantId: string): Promise<string | null> {
    try {
      const tenant: any = await this.tenants.getTenantById(tenantId);
      return tenant?.organizationName || tenant?.name || null;
    } catch {
      // The name is denormalised convenience; a missing one must not stop
      // the person's row reaching the directory.
      return null;
    }
  }

  /** Events waiting and how far behind the oldest is — for monitoring. */
  async lagFor(tenantId: string): Promise<{ pending: number; oldestSeconds: number | null }> {
    const Outbox = await this.modelProvider.getProjectionOutboxModel(tenantId);
    const pending = await Outbox.count({ where: { processedAt: null } });
    const oldest = await Outbox.findOne({
      where: { processedAt: null },
      order: [['occurredAt', 'ASC']],
    });
    return {
      pending,
      oldestSeconds: oldest
        ? Math.round((Date.now() - new Date(oldest.occurredAt).getTime()) / 1000)
        : null,
    };
  }
}
