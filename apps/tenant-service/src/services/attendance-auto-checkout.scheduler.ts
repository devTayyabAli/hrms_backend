import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Tenant, TenantProvisioningStatus } from '../models';
import { AttendanceService } from './attendance.service';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { zonedDateTime } from './attendance-rules';

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;
/** Per tenant per run, so a long backlog drains over a few runs. */
const BATCH_SIZE = 200;
const AUTO_NOTE = 'Auto checked out';

/**
 * Attendance Rules → Auto Check-out Time. Anyone still checked in once the
 * organization's auto check-out time has passed (in the shift's time zone) is
 * checked out at exactly that time. The check-out goes through
 * AttendanceService, so hours, Half Day / Absent thresholds and overtime are
 * worked out the same way as a manual punch.
 */
@Injectable()
export class AttendanceAutoCheckoutScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttendanceAutoCheckoutScheduler.name);
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    private readonly modelProvider: TenantModelProviderService,
    private readonly attendanceService: AttendanceService,
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

  async run(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let closed = 0;
    try {
      const tenants = await this.tenantModel.findAll({
        where: { provisioningStatus: TenantProvisioningStatus.READY },
        attributes: ['id'],
      });
      for (const tenant of tenants) {
        try {
          closed += await this.runForTenant(tenant.id, now);
        } catch (error: any) {
          // A tenant without a database or tables yet shouldn't stop the rest.
          this.logger.debug(`Auto check-out skipped for tenant ${tenant.id}: ${error?.message ?? error}`);
        }
      }
      if (closed > 0) this.logger.log(`Auto checked out ${closed} attendance record(s).`);
    } catch (error: any) {
      this.logger.warn(`Auto check-out run failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
    return closed;
  }

  async runForTenant(tenantId: string, now: Date = new Date()): Promise<number> {
    const rules = await this.attendanceService.getRules(tenantId);
    if (!rules.autoCheckoutTime) return 0;
    const timeZone = rules.shift?.timezone ?? 'UTC';

    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const open = await Attendance.findAll({
      where: {
        tenantId,
        checkInAt: { [Op.ne]: null },
        checkOutAt: null,
        date: { [Op.lte]: now.toISOString().slice(0, 10) },
      },
      order: [['date', 'ASC']],
      limit: BATCH_SIZE,
    });

    let closed = 0;
    for (const record of open) {
      const date = String(record.date).slice(0, 10);
      const cutoff = zonedDateTime(date, rules.autoCheckoutTime, timeZone);
      // Not time yet, or they punched in after the cut-off (a late shift):
      // leave it for them or HR to close.
      if (now.getTime() < cutoff.getTime() || record.checkInAt.getTime() >= cutoff.getTime()) continue;
      try {
        await this.attendanceService.update(tenantId, record.id, {
          checkOutAt: cutoff.toISOString(),
          notes: record.notes ? `${record.notes} · ${AUTO_NOTE}`.slice(0, 500) : AUTO_NOTE,
        } as any);
        closed++;
      } catch (error: any) {
        this.logger.warn(`Could not auto check out record ${record.id}: ${error?.message ?? error}`);
      }
    }
    return closed;
  }
}
