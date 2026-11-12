import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Tenant, TenantProvisioningStatus } from '../models';
import { PerformanceCycleService } from './performance-cycle.service';

/** Once a day is enough: the sweep is idempotent, so a restart or a second run changes nothing. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

/**
 * Each day, looks at every running review cycle of every organization for
 * people whom time alone has made eligible (tenure reached, probation over) or
 * no longer eligible, and enrols or flags them. See `PerformanceCycleService.sweep`.
 */
@Injectable()
export class PerformanceCycleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PerformanceCycleScheduler.name);
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    private readonly cycles: PerformanceCycleService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.firstRun = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
    this.firstRun.unref?.();
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns how many reviews were made and how many flags were raised or dropped. */
  async run(): Promise<{ enrolled: number; flagged: number; cleared: number }> {
    const total = { enrolled: 0, flagged: 0, cleared: 0 };
    if (this.running) return total;
    this.running = true;
    try {
      const tenants = await this.tenantModel.findAll({ where: { provisioningStatus: TenantProvisioningStatus.READY }, attributes: ['id'] });
      for (const tenant of tenants) {
        try {
          const result = await this.cycles.sweep(tenant.id);
          total.enrolled += result.enrolled;
          total.flagged += result.flagged;
          total.cleared += result.cleared;
        } catch (error: any) {
          this.logger.debug(`Review cycle sweep skipped for tenant ${tenant.id}: ${error?.message ?? error}`);
        }
      }
      if (total.enrolled || total.flagged || total.cleared) {
        this.logger.log(`Review cycle sweep: ${total.enrolled} enrolled, ${total.flagged} flagged, ${total.cleared} flags dropped.`);
      }
    } catch (error: any) {
      this.logger.warn(`Review cycle sweep failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
    return total;
  }
}
