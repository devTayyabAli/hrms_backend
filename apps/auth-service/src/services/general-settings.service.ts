import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { PlatformSetting, PlatformSettings } from '../models';
import { UpdateGeneralSettingsDto } from '@app/common';
import { PlatformNotificationCategory } from '../models';
import { PlatformNotificationService } from './platform-notification.service';
import { describeChangedSettings } from './settings-change.util';

/** Earlier screens saved here (a JSON blob nothing enforced); its values are carried over once. */
const LEGACY_FIELDS: Record<string, keyof PlatformSettings> = {
  platformName: 'platformName',
  platformTagline: 'platformTagline',
  companyName: 'companyName',
  supportEmail: 'supportEmail',
  primaryColor: 'primaryColor',
  secondaryColor: 'secondaryColor',
  sidebarStyle: 'sidebarVariant',
  themeMode: 'defaultTheme',
  allowUserExport: 'allowUsersToExportData',
  enableMaintenanceNotifications: 'enableMaintenanceModeNotifications',
};

@Injectable()
export class GeneralSettingsService {
  private readonly logger = new Logger(GeneralSettingsService.name);

  constructor(
    @InjectModel(PlatformSettings) private readonly settingsModel: typeof PlatformSettings,
    @InjectModel(PlatformSetting) private readonly legacyModel: typeof PlatformSetting,
    @Optional() private readonly platformNotifications?: PlatformNotificationService,
  ) {}

  /** Singleton row, created with defaults on first access — seeded from the old screen's saved values. */
  async getOrCreate(): Promise<PlatformSettings> {
    const existing = await this.settingsModel.findOne();
    if (existing) {
      // A row made by an earlier read but never saved still takes the old
      // screen's values — checked once per process.
      if (!this.legacyChecked) {
        this.legacyChecked = true;
        const neverSaved = Math.abs(new Date(existing.updatedAt).getTime() - new Date(existing.createdAt).getTime()) < 1000;
        if (neverSaved) {
          const seed = await this.legacySeed();
          if (Object.keys(seed).length) await existing.update(seed);
        }
      }
      return existing;
    }
    this.legacyChecked = true;
    return this.settingsModel.create(await this.legacySeed());
  }

  private legacyChecked = false;

  private async legacySeed(): Promise<Record<string, unknown>> {
    const seed: Record<string, unknown> = {};
    try {
      const legacy = await this.legacyModel.findOne({ where: { category: 'general' } });
      for (const [from, to] of Object.entries(LEGACY_FIELDS)) {
        const value = legacy?.values?.[from];
        if (value !== undefined && value !== null && value !== '') seed[to] = value;
      }
    } catch (error: any) {
      this.logger.warn(`Earlier general settings not carried over: ${error?.message ?? error}`);
    }
    return seed;
  }

  async getGeneral(): Promise<PlatformSettings> {
    return this.getOrCreate();
  }

  async updateGeneral(dto: UpdateGeneralSettingsDto): Promise<PlatformSettings> {
    const settings = await this.getOrCreate();
    const changed = describeChangedSettings(settings.get({ plain: true }), dto);
    await settings.update(dto);
    if (changed) {
      void this.platformNotifications?.notify({
        category: PlatformNotificationCategory.SYSTEM,
        title: 'Platform settings updated',
        body: `Updated: ${changed}.`,
        url: '/system-management?tab=general',
      });
    }
    return settings;
  }
}
