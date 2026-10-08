import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { MaintenanceSettings } from '../models';
import { UpdateMaintenanceSettingsDto } from '@app/common';
import { PlatformNotificationCategory } from '../models';
import { PlatformNotificationService } from './platform-notification.service';

@Injectable()
export class MaintenanceSettingsService {
  constructor(
    @InjectModel(MaintenanceSettings) private readonly settingsModel: typeof MaintenanceSettings,
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
        url: '/system-management',
      });
    }
    return settings;
  }

  /**
   * Trimmed payload for MaintenanceModeGuard — called on every gated request,
   * so it deliberately returns only what the guard needs to decide.
   */
  async getMaintenanceState(): Promise<{ enabled: boolean; message: string }> {
    const settings = await this.getOrCreate();
    return { enabled: settings.maintenanceModeEnabled, message: settings.message };
  }
}
