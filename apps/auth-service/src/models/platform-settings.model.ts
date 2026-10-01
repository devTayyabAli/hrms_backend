import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export enum SidebarStyle {
  EXPANDED = 'expanded',
  COLLAPSED = 'collapsed',
}

export enum ThemeMode {
  LIGHT = 'light',
  DARK = 'dark',
}

export enum TimeFormat {
  H12 = '12h',
  H24 = '24h',
}

/**
 * Singleton row — General Settings for the whole platform. There is exactly
 * one row; GeneralSettingsService creates it with defaults on first read.
 */
@Table({ tableName: 'platform_settings' })
export class PlatformSettings extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Default('HRMS Platform')
  @Column
  declare platformName: string;

  @Column
  declare platformTagline: string;

  @Default('#3F93F6')
  @Column
  declare primaryColor: string;

  @Default('#0F1520')
  @Column
  declare secondaryColor: string;

  @Column
  declare companyName: string;

  @Column
  declare supportEmail: string;

  @Default(SidebarStyle.EXPANDED)
  @Column({ type: DataType.ENUM(...Object.values(SidebarStyle)) })
  declare sidebarStyle: SidebarStyle;

  @Default(ThemeMode.LIGHT)
  @Column({ type: DataType.ENUM(...Object.values(ThemeMode)) })
  declare themeMode: ThemeMode;

  @Default('DD MM YYYY')
  @Column
  declare dateFormat: string;

  @Default(TimeFormat.H12)
  @Column({ type: DataType.ENUM(...Object.values(TimeFormat)) })
  declare timeFormat: TimeFormat;

  @Default('USD')
  @Column
  declare currency: string;

  @Default(false)
  @Column
  declare enableMultiLanguage: boolean;

  @Default(false)
  @Column
  declare enable2FAForAllAdmins: boolean;

  @Default(false)
  @Column
  declare enableMaintenanceModeNotifications: boolean;

  @Default(true)
  @Column
  declare allowUsersToExportData: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
