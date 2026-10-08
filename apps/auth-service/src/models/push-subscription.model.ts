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
} from 'sequelize-typescript';
import { SuperAdmin } from './super-admin.model';

/**
 * One browser a Super Admin turned push notifications on in. The endpoint is
 * unique across the table: a browser re-subscribing as a different admin
 * moves the row rather than duplicating it.
 */
@Table({
  tableName: 'push_subscriptions',
  indexes: [{ fields: ['superAdminId'], name: 'push_subscriptions_admin_idx' }],
})
export class PushSubscription extends Model {
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

  @Column({ type: DataType.TEXT, allowNull: false, unique: true })
  declare endpoint: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare p256dh: string;

  @Column({ type: DataType.STRING(50), allowNull: false })
  declare auth: string;

  /** "Chrome 154 on Windows 10/11" — so the admin can tell their devices apart. */
  @Column({ type: DataType.STRING(120), allowNull: true })
  declare deviceLabel: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSuccessAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare failureCount: number;
}
