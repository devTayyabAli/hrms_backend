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

  /**
   * True when an authorized editor kept a due date outside the project's
   * start and expected end. Null is the same as false.
   */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare dueDateException: boolean | null;

  /**
   * True when an assignee has left the organization and this task is still
   * open. Completed tasks are never flagged, and they keep their assignee.
   * Null is the same as false.
   */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare needsReassignment: boolean | null;

  @Default(WorkspaceTaskPriority.NORMAL)
  @Column({ type: DataType.ENUM(...Object.values(WorkspaceTaskPriority)), allowNull: false })
  declare priority: WorkspaceTaskPriority;

  @Default(WorkspaceTaskStatus.PENDING)
  @Column({ type: DataType.ENUM(...Object.values(WorkspaceTaskStatus)), allowNull: false })
  declare status: WorkspaceTaskStatus;

  /** Honoured only when the organization has task review turned on. */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare requiresReview: boolean | null;

  /** PENDING while a reviewer has not decided. Null when review is not in play. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare reviewStatus: 'PENDING' | 'APPROVED' | 'RETURNED' | null;

  /**
   * What the reviewer said when they approved or returned the task. Always
   * present on a return; optional on an approval. Each decision replaces the
   * last, so an approval never shows an older return note.
   */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare reviewFeedback: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare reviewedAt: Date | null;

  /** Kept as a name as well as an id, so the record still reads right if the reviewer later leaves. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare reviewedByEmployeeId: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare reviewedByName: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;

  /** Set after the one upcoming-deadline notice, so it is not sent again. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare deadlineReminderSent: boolean | null;

  /** Set after the one overdue notice. Cleared when the due date moves. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare overdueReminderSent: boolean | null;

  /** Set after one follow-up while a task is still waiting for review. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare reviewReminderSent: boolean | null;
}
