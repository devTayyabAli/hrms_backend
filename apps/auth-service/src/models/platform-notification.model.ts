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
} from 'sequelize-typescript';
import { PlatformNotificationCategory } from '@app/common';
import { SuperAdmin } from './super-admin.model';

export { PlatformNotificationCategory };

/** Where browser push delivery for one notification stands. */
export enum PlatformNotificationPushState {
  /** Not for push: push is off, or the admin takes a digest instead. */
  NONE = 'none',
  /** Waiting for quiet hours to end; then sent as part of one summary. */
  HELD = 'held',
  SENT = 'sent',
}

/**
 * One notification for one Super Admin: what the bell lists, what browser
 * push delivers and what the email digest summarises. Read state is per
 * recipient, so it lives here rather than in a browser.
 */
@Table({
  tableName: 'platform_notifications',
  updatedAt: false,
  indexes: [
    { fields: ['superAdminId', 'createdAt'], name: 'platform_notifications_admin_created_idx' },
    { fields: ['pushState'], name: 'platform_notifications_push_state_idx' },
  ],
})
export class PlatformNotification extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => SuperAdmin)
  // Same inferred type as `super_admins.id`, which the foreign key must match.
  @Column({ allowNull: false, onDelete: 'CASCADE' })
  declare superAdminId: string;

  @BelongsTo(() => SuperAdmin, { onDelete: 'CASCADE' })
  declare superAdmin: SuperAdmin;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare category: PlatformNotificationCategory;

  @Column({ type: DataType.STRING(160), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  /** App path opened from the bell or a push notification, e.g. `/organizations`. */
  @Column({ type: DataType.STRING(300), allowNull: true })
  declare url: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare readAt: Date | null;

  @Default(PlatformNotificationPushState.NONE)
  @Column({ type: DataType.STRING(10), allowNull: false })
  declare pushState: PlatformNotificationPushState;

  @Column({ type: DataType.DATE, allowNull: true })
  declare pushedAt: Date | null;

  /** Set once an email digest has included it; null while still owed to one. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare digestedAt: Date | null;

  @CreatedAt
  @Column(DataType.DATE)
  declare createdAt: Date;
}
