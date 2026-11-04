import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Tenant, TenantProvisioningStatus } from '../models';
import { LearningNotificationService } from './learning-notification.service';

/** Hourly is enough: each notice is stamped on the assignment, so it is sent once. */
const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 45 * 1000;

/**
 * Upcoming deadline and overdue notices for assigned courses.
 * Each organization can switch a kind off in Learning settings.
 */
@Injectable()
export class LearningReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearningReminderScheduler.name);
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    private readonly notifications: LearningNotificationService,
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

  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const tenants = await this.tenantModel.findAll({
        where: { provisioningStatus: TenantProvisioningStatus.READY },
        attributes: ['id'],
      });
      for (const tenant of tenants) {
        try {
          sent += await this.notifications.sendReminders(tenant.id);
        } catch (error: any) {
          this.logger.debug(`Learning reminders skipped for tenant ${tenant.id}: ${error?.message ?? error}`);
        }
      }
      if (sent > 0) this.logger.log(`Sent ${sent} learning notice(s).`);
    } catch (error: any) {
      this.logger.warn(`Learning reminder run failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
    return sent;
  }
}
