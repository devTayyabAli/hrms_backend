import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { MaintenanceSettings } from '../models';
import { UpdateMaintenanceSettingsDto } from '@app/common';

@Injectable()
export class MaintenanceSettingsService {
  constructor(
    @InjectModel(MaintenanceSettings) private readonly settingsModel: typeof MaintenanceSettings,
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
    await settings.update(dto);
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
