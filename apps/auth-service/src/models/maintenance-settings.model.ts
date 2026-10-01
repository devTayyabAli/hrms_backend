import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export enum MaintenanceAllowedAdmins {
  SUPER_ADMINS_ONLY = 'SUPER_ADMINS_ONLY',
  ALL_ADMINS = 'ALL_ADMINS',
}

export enum UpdateChannel {
  STABLE = 'STABLE',
  BETA = 'BETA',
}

/**
 * Singleton row — Maintenance tab.
 *
 * `maintenanceModeEnabled` + `message` are enforced for real by
 * MaintenanceModeGuard at the API gateway. The System Updates fields
 * (`automaticUpdates`, `updateNotifications`, `preferredUpdateTime`,
 * `updateChannel`) are stored preferences only: this codebase has no
 * update/deployment automation for them to drive.
 */
@Table({ tableName: 'maintenance_settings' })
export class MaintenanceSettings extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Default(false)
  @Column
  declare maintenanceModeEnabled: boolean;

  @Default('We are currently under maintenance. Please try again later.')
  @Column(DataType.STRING(400))
  declare message: string;

  @Default(MaintenanceAllowedAdmins.SUPER_ADMINS_ONLY)
  @Column({ type: DataType.ENUM(...Object.values(MaintenanceAllowedAdmins)) })
  declare allowedAdmins: MaintenanceAllowedAdmins;

  @Default(false)
  @Column
  declare automaticUpdates: boolean;

  @Default(false)
  @Column
  declare updateNotifications: boolean;

  @Default('03:00')
  @Column
  declare preferredUpdateTime: string;

  @Default(UpdateChannel.STABLE)
  @Column({ type: DataType.ENUM(...Object.values(UpdateChannel)) })
  declare updateChannel: UpdateChannel;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
