import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * One row per tenant database. No row means task review is off, so existing
 * organizations keep completing tasks directly until someone turns it on.
 */
@Table({ tableName: 'workspace_settings', timestamps: true })
export class WorkspaceSetting extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false, unique: true })
  declare tenantId: string;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare taskReviewEnabled: boolean;

  /**
   * Reminders. Null means on, so a tenant that only turned review on or off
   * still receives them until an admin switches one off.
   */
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: true })
  declare deadlineRemindersEnabled: boolean | null;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: true })
  declare overdueRemindersEnabled: boolean | null;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: true })
  declare reviewRemindersEnabled: boolean | null;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: true })
  declare projectStatusNotificationsEnabled: boolean | null;

  /** Told when added to a project, given a task, or a task's due date or priority changes. On when null. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare assignmentNotificationsEnabled: boolean | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
