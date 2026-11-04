import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Tenant, TenantProvisioningStatus } from '../models';
import { PolicyAcknowledgementService } from './policy-acknowledgement.service';

/** Hourly is enough: each notice is stamped per person and version, so it is sent once. */
const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

/** "Acknowledge by" and "overdue" notices for company documents that ask for acknowledgement. */
@Injectable()
export class PolicyAckReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicyAckReminderScheduler.name);
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    private readonly acknowledgements: PolicyAcknowledgementService,
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
          sent += await this.acknowledgements.sendReminders(tenant.id);
        } catch (error: any) {
          this.logger.debug(`Policy reminders skipped for tenant ${tenant.id}: ${error?.message ?? error}`);
        }
      }
      if (sent > 0) this.logger.log(`Sent ${sent} policy acknowledgement notice(s).`);
    } catch (error: any) {
      this.logger.warn(`Policy reminder run failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
    return sent;
  }
}
