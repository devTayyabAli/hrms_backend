import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * An organization's choices about Learning notifications. One row per
 * organization; no row, or a null, means the default, which is on. Lives in
 * each tenant's own physical database.
 */
@Table({
  tableName: 'learning_settings',
  timestamps: true,
  indexes: [{ unique: true, fields: ['tenantId'], name: 'unique_learning_settings_tenant' }],
})
export class LearningSetting extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** Tell people about a new course, a changed due date, or one withdrawn. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare assignmentNotificationsEnabled: boolean | null;

  /** Tell people a due date is coming up. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare deadlineRemindersEnabled: boolean | null;

  /** Tell people (and, for mandatory courses, their manager) a course is overdue. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare overdueRemindersEnabled: boolean | null;

  /** Tell a manager when someone finishes a mandatory course. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare completionNotificationsEnabled: boolean | null;

  /** How many days before the due date a reminder goes out, e.g. [3, 1]. Null means the default. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare reminderDays: number[] | null;
}
