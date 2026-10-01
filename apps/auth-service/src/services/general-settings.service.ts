import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { PlatformSettings } from '../models';
import { UpdateGeneralSettingsDto } from '@app/common';

@Injectable()
export class GeneralSettingsService {
  constructor(
    @InjectModel(PlatformSettings) private readonly settingsModel: typeof PlatformSettings,
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
    await settings.update(dto);
    return settings;
  }
}
