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
import { WorkspaceTaskPriority, WorkspaceTaskStatus } from '@app/common';
import { Employee } from './employee.model';
import { WorkspaceProject } from './workspace-project.model';

/**
 * One task on Workspace › Tasks, assigned to one employee.
 *
 * "Overdue" is not stored — it is `dueDate < today` on a task that isn't
 * completed, decided at read time, so it can't go stale overnight.
 * `completedAt` is stamped and cleared by the service alongside `status`.
 */
@Table({
  tableName: 'workspace_tasks',
  timestamps: true,
  indexes: [
    // The list filters on status and sorts by due date by default.
    { fields: ['status', 'dueDate'], name: 'workspace_task_status_due_idx' },
    { fields: ['assigneeEmployeeId', 'status'], name: 'workspace_task_assignee_status_idx' },
    { fields: ['projectId'], name: 'workspace_task_project_idx' },
  ],
})
export class WorkspaceTask extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** Deleting a project keeps its tasks, unlinked. */
  @ForeignKey(() => WorkspaceProject)
  @Column({ type: DataType.UUID, allowNull: true, onDelete: 'SET NULL' })
  declare projectId: string | null;

  @BelongsTo(() => WorkspaceProject, { foreignKey: 'projectId', as: 'project' })
  declare project: WorkspaceProject | null;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false })
  declare assigneeEmployeeId: string;

  @BelongsTo(() => Employee, { foreignKey: 'assigneeEmployeeId', as: 'assignee' })
  declare assignee: Employee;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare dueDate: string;

  @Default(WorkspaceTaskPriority.NORMAL)
  @Column({ type: DataType.ENUM(...Object.values(WorkspaceTaskPriority)), allowNull: false })
  declare priority: WorkspaceTaskPriority;

  @Default(WorkspaceTaskStatus.PENDING)
  @Column({ type: DataType.ENUM(...Object.values(WorkspaceTaskStatus)), allowNull: false })
  declare status: WorkspaceTaskStatus;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;
}
