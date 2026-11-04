import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo, CreatedAt } from 'sequelize-typescript';
import { WorkspaceTask } from './workspace-task.model';

/**
 * A file linked to a task. The bytes live in the file store; this row keeps
 * the name and type. Completing the task does not remove the file.
 */
@Table({
  tableName: 'workspace_task_attachments',
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['taskId'], name: 'workspace_task_attachment_task_idx' }],
})
export class WorkspaceTaskAttachment extends Model {
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

  @Column({ type: DataType.UUID, allowNull: false })
  declare fileId: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare fileName: string;

  @Column({ type: DataType.STRING(127), allowNull: true })
  declare mimeType: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare sizeBytes: number | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare uploadedByUserId: string | null;

  @CreatedAt
  declare createdAt: Date;
}
