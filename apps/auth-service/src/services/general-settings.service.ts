import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { PlatformSettings } from '../models';
import { UpdateGeneralSettingsDto } from '@app/common';
import { PlatformNotificationCategory } from '../models';
import { PlatformNotificationService } from './platform-notification.service';
import { describeChangedSettings } from './settings-change.util';

@Injectable()
export class GeneralSettingsService {
  constructor(
    @InjectModel(PlatformSettings) private readonly settingsModel: typeof PlatformSettings,
    @Optional() private readonly platformNotifications?: PlatformNotificationService,
  ) {}

  /** Singleton row, created with defaults on first access. */
  private async getOrCreate(): Promise<PlatformSettings> {
    const existing = await this.settingsModel.findOne();
    if (existing) return existing;
    return this.settingsModel.create({});
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
        url: '/system-management',
      });
    }
    return settings;
  }
}
