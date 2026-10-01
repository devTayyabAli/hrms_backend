import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  ForeignKey,
  BelongsTo,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import { SuperAdmin } from './super-admin.model';

@Table({ tableName: 'notification_preferences' })
export class NotificationPreferences extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => SuperAdmin)
  @Column({ allowNull: false, unique: true })
  declare superAdminId: string;

  @BelongsTo(() => SuperAdmin)
  declare superAdmin: SuperAdmin;

  @Default(true)
  @Column
  declare accountUpdates: boolean;

  @Default(true)
  @Column
  declare securityAlerts: boolean;

  /** Security tab's "Login Alerts" toggle — notify on new sign-in attempts. */
  @Default(true)
  @Column
  declare loginAlerts: boolean;

  @Default(true)
  @Column
  declare systemAnnouncements: boolean;

  @Default(true)
  @Column
  declare reportsAnalytics: boolean;

  @Default(true)
  @Column
  declare pushNotifications: boolean;

  @Default('realtime')
  @Column
  declare notificationFrequency: string;

  @Default(false)
  @Column
  declare quietHoursEnabled: boolean;

  @Default('22:00')
  @Column
  declare quietHoursStartTime: string;

  @Default('07:00')
  @Column
  declare quietHoursEndTime: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
