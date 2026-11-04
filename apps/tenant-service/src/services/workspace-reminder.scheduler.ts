import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Tenant, TenantProvisioningStatus } from '../models';
import { WorkspaceTaskService } from './workspace-task.service';

/** Hourly is enough: each notice is stamped on the task, so it is sent once. */
const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 45 * 1000;

/**
 * Upcoming deadline, overdue, and still-waiting-for-review notices.
 * Each organization can switch a kind off in workspace settings.
 */
@Injectable()
export class WorkspaceReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceReminderScheduler.name);
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    private readonly tasks: WorkspaceTaskService,
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
          sent += await this.tasks.sendReminders(tenant.id);
        } catch (error: any) {
          this.logger.debug(`Workspace reminders skipped for tenant ${tenant.id}: ${error?.message ?? error}`);
        }
      }
      if (sent > 0) this.logger.log(`Sent ${sent} workspace reminder(s).`);
    } catch (error: any) {
      this.logger.warn(`Workspace reminder run failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
    return sent;
  }
}
