import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo, CreatedAt } from 'sequelize-typescript';
import { WorkspaceTask } from './workspace-task.model';

/**
 * One optional line on a task. A task can have none. Completing the task
 * keeps the lines, including which ones were already done.
 */
@Table({
  tableName: 'workspace_task_checklist_items',
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['taskId', 'position'], name: 'workspace_task_checklist_task_idx' }],
})
export class WorkspaceTaskChecklistItem extends Model {
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

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare label: string;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare done: boolean;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare position: number;

  @CreatedAt
  declare createdAt: Date;
}
