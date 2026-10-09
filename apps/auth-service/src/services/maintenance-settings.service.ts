import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { AuthCredential, MaintenanceSettings, PlatformSettings } from '../models';
import { UpdateMaintenanceSettingsDto } from '@app/common';
import { PlatformNotificationCategory } from '../models';
import { PlatformNotificationService } from './platform-notification.service';
import { MailService } from './mail.service';

/** Emails sent at once when announcing maintenance to organization admins. */
const MAIL_CONCURRENCY = 5;

@Injectable()
export class MaintenanceSettingsService {
  private readonly logger = new Logger(MaintenanceSettingsService.name);

  constructor(
    @InjectModel(MaintenanceSettings) private readonly settingsModel: typeof MaintenanceSettings,
    @Optional() @InjectModel(AuthCredential) private readonly credentialModel?: typeof AuthCredential,
    @Optional() @InjectModel(PlatformSettings) private readonly generalModel?: typeof PlatformSettings,
    @Optional() private readonly mailService?: MailService,
    @Optional() private readonly platformNotifications?: PlatformNotificationService,
  ) {}

  /** Singleton row, created with defaults on first access. */
  private async getOrCreate(): Promise<MaintenanceSettings> {
    const existing = await this.settingsModel.findOne();
    if (existing) return existing;
    return this.settingsModel.create({});
  }

  async getMaintenance(): Promise<MaintenanceSettings> {
    return this.getOrCreate();
  }

  async updateMaintenance(dto: UpdateMaintenanceSettingsDto): Promise<MaintenanceSettings> {
    const settings = await this.getOrCreate();
    const wasOn = settings.maintenanceModeEnabled;
    await settings.update(dto);
    if (settings.maintenanceModeEnabled !== wasOn) {
      void this.platformNotifications?.notify({
        category: PlatformNotificationCategory.SYSTEM,
        title: settings.maintenanceModeEnabled ? 'Maintenance mode turned on' : 'Maintenance mode turned off',
        body: settings.maintenanceModeEnabled
          ? 'Organizations can no longer use the platform until maintenance mode is turned off.'
          : 'The platform is open to every organization again.',
        url: '/system-management?tab=maintenance',
      });
      void this.emailOrganizationAdmins(settings);
    }
    return settings;
  }

  /**
   * General settings' "Maintenance notifications": every active organization
   * admin hears when the platform closes and when it reopens. Not awaited by
   * the save, and never throws — one bad address must not fail the toggle.
   */
  private async emailOrganizationAdmins(settings: MaintenanceSettings) {
    try {
      if (!this.mailService || !this.credentialModel || !this.generalModel) return;
      const general = await this.generalModel.findOne({
        attributes: ['enableMaintenanceModeNotifications', 'platformName'],
      });
      if (!general?.enableMaintenanceModeNotifications) return;

      const admins = await this.credentialModel.findAll({
        where: { isActive: true, role: { [Op.iLike]: '%admin%' } },
        attributes: ['email'],
      });
      const emails = [...new Set(admins.map((a) => a.email.toLowerCase()))];
      if (!emails.length) return;

      const name = general.platformName || 'The platform';
      const on = settings.maintenanceModeEnabled;
      const subject = on ? `${name} is under maintenance` : `${name} is back online`;
      const message = on
        ? `${settings.message}\n\nYou and your team won't be able to sign in or use the platform until maintenance is complete. We'll email you when it's back.`
        : 'Maintenance is complete. You and your team can sign in and use the platform again.';

      for (let i = 0; i < emails.length; i += MAIL_CONCURRENCY) {
        await Promise.all(
          emails.slice(i, i + MAIL_CONCURRENCY).map((to) =>
            this.mailService!.sendTemplateEmail({
              to,
              subject,
              templateName: 'notice',
              variables: { title: subject, message },
            }),
          ),
        );
      }
      this.logger.log(`Maintenance ${on ? 'start' : 'end'} emailed to ${emails.length} organization admin(s).`);
    } catch (error: any) {
      this.logger.error(`Maintenance emails to organization admins failed: ${error?.message ?? error}`);
    }
  }

  /**
   * Trimmed payload for MaintenanceModeGuard — called on every gated request,
   * so it deliberately returns only what the guard needs to decide.
   */
  async getMaintenanceState(): Promise<{ enabled: boolean; message: string; allowedAdmins: string }> {
    const settings = await this.getOrCreate();
    return { enabled: settings.maintenanceModeEnabled, message: settings.message, allowedAdmins: settings.allowedAdmins };
  }
}
