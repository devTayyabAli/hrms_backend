import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo, CreatedAt } from 'sequelize-typescript';
import { WorkspaceTask } from './workspace-task.model';

/**
 * A progress note on a task. The author's name is stored as it was written,
 * so the history still reads correctly after a rename. Completing the task
 * does not remove these rows.
 */
@Table({
  tableName: 'workspace_task_comments',
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['taskId', 'createdAt'], name: 'workspace_task_comment_task_idx' }],
})
export class WorkspaceTaskComment extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => WorkspaceTask)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare taskId: string;

  @BelongsTo(() => WorkspaceTask, { foreignKey: 'taskId', as: 'task' })
  declare task: WorkspaceTask;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare authorUserId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare authorEmployeeId: string | null;

  @Column({ type: DataType.STRING(160), allowNull: false })
  declare authorName: string;

  @CreatedAt
  declare createdAt: Date;
}
