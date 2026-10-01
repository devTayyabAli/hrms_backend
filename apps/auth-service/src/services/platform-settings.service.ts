import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { DEFAULT_PASSWORD_EXPIRY_DAYS } from '@app/common';
import { PlatformSetting } from '../models';

export const SETTING_CATEGORIES = [
  'general',
  'security',
  'maintenance',
] as const;
export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

/**
 * What each category reads back before anyone has saved it.
 *
 * The security defaults describe the policy the platform actually enforces —
 * `STRONG_PASSWORD_REGEX` demands 12 characters with all four character
 * classes, and `DEFAULT_PASSWORD_EXPIRY_DAYS` sets the expiry — rather than a
 * looser set the screen would otherwise display while login refused to honour
 * it.
 */
const DEFAULTS: Record<SettingCategory, Record<string, any>> = {
  general: {
    platformName: 'Fuutura HRMS',
    platformTagline: 'Smart HR, Simplified',
    companyName: 'Fuutura Technologies',
    supportEmail: 'support@fuutura.com',
    dateFormat: 'DD/MM/YYYY',
    timeFormat: '12 Hour',
    currency: 'PKR-Pakistani Rupee (Rs.)',
    primaryColor: '#3F93F6',
    secondaryColor: '#0F1520',
    sidebarStyle: 'Dark',
    themeMode: 'Light',
    enableMultiLanguage: true,
    enableTwoFactorAdmins: true,
    enableMaintenanceNotifications: true,
    allowUserExport: true,
  },
  security: {
    passwordMinLength: 12,
    passwordRules: {
      uppercase: true,
      lowercase: true,
      numbers: true,
      specialChars: true,
    },
    passwordExpiry: `${DEFAULT_PASSWORD_EXPIRY_DAYS} Days`,
    sessionTimeout: '30 Minutes',
    maxLoginAttempts: '5',
    lockoutTime: '15 Minutes',
    twoFactorRoles: {
      superAdmin: true,
      admin: true,
      editor: true,
      hrUser: true,
      employee: false,
    },
    twoFactorMethods: {
      totp: true,
      emailOtp: true,
      smsOtp: false,
    },
    enableIpWhitelisting: false,
    allowedIps: [],
  },
  maintenance: {
    maintenanceMode: false,
    userMessage: 'We are currently under maintenance. Please try again later.',
    allowedAdmins: 'Only Super Admins',
    automaticUpdates: true,
    updateNotifications: true,
    preferredUpdateTime: '03:00 AM',
    updateChannel: 'Stable (Recommended)',
  },
};

@Injectable()
export class PlatformSettingsService {
  constructor(
    @InjectModel(PlatformSetting)
    private readonly settingModel: typeof PlatformSetting,
  ) {}

  private assertCategory(category: string): SettingCategory {
    if (!SETTING_CATEGORIES.includes(category as SettingCategory)) {
      throw new BadRequestException(
        `Unknown settings category "${category}". Expected one of: ${SETTING_CATEGORIES.join(', ')}.`,
      );
    }
    return category as SettingCategory;
  }

  /** Saved values over the defaults, so a caller always gets a complete object. */
  async get(category: string): Promise<Record<string, any>> {
    const key = this.assertCategory(category);
    const row = await this.settingModel.findOne({ where: { category: key } });
    return { ...DEFAULTS[key], ...(row?.values ?? {}) };
  }

  /**
   * Merges a patch into the stored values. The merge is deliberately shallow:
   * the settings screens submit each nested group whole (`passwordRules`,
   * `twoFactorMethods`), so a deep merge would make clearing a single toggle
   * impossible.
   */
  async update(
    category: string,
    patch: Record<string, any>,
    updatedBy?: string,
  ): Promise<Record<string, any>> {
    const key = this.assertCategory(category);
    const row = await this.settingModel.findOne({ where: { category: key } });
    const values = { ...(row?.values ?? {}), ...(patch ?? {}) };

    if (row) {
      await row.update({ values, updatedBy });
    } else {
      await this.settingModel.create({ category: key, values, updatedBy });
    }

    return { ...DEFAULTS[key], ...values };
  }
}
