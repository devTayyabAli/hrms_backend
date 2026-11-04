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
import { Employee } from './employee.model';
import { WorkspaceTask } from './workspace-task.model';

/**
 * One person responsible for a task. The first assignee is also stored on the
 * task as `assigneeEmployeeId` so older reads keep working. A row does not
 * change the employee's department, reporting manager, or designation.
 */
@Table({
  tableName: 'workspace_task_assignees',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { unique: true, fields: ['taskId', 'employeeId'], name: 'workspace_task_assignee_unique' },
    { fields: ['employeeId'], name: 'workspace_task_assignee_employee_idx' },
  ],
})
export class WorkspaceTaskAssignee extends Model {
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

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare employeeId: string;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId', as: 'employee' })
  declare employee: Employee;

  @Column({ type: DataType.UUID, allowNull: true })
  declare addedByUserId: string | null;

  @CreatedAt
  declare createdAt: Date;
}
