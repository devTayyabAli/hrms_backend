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
  HasMany,
} from 'sequelize-typescript';
import { WorkspaceProjectStatus } from '@app/common';
import { Employee } from './employee.model';
import { Department } from './department.model';
import { WorkspaceTask } from './workspace-task.model';

/**
 * A project on the Workspace › Projects screen.
 *
 * Progress is not stored: it is the share of the project's tasks that are
 * completed, worked out on read, so it can never disagree with the task list.
 */
@Table({
  tableName: 'workspace_projects',
  timestamps: true,
  indexes: [
    { fields: ['status'], name: 'workspace_project_status_idx' },
    { fields: ['leadEmployeeId'], name: 'workspace_project_lead_idx' },
  ],
})
export class WorkspaceProject extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare name: string;

  /** Client or internal sponsor. */
  @Column({ type: DataType.STRING(150), allowNull: true })
  declare client: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true, onDelete: 'SET NULL' })
  declare leadEmployeeId: string | null;

  @BelongsTo(() => Employee, { foreignKey: 'leadEmployeeId', as: 'lead' })
  declare lead: Employee | null;

  @ForeignKey(() => Department)
  @Column({ type: DataType.UUID, allowNull: true, onDelete: 'SET NULL' })
  declare departmentId: string | null;

  @BelongsTo(() => Department, { foreignKey: 'departmentId', as: 'department' })
  declare department: Department | null;

  @Default(WorkspaceProjectStatus.ACTIVE)
  @Column({ type: DataType.ENUM(...Object.values(WorkspaceProjectStatus)), allowNull: false })
  declare status: WorkspaceProjectStatus;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare dueDate: string | null;

  /** The next milestone, e.g. "UAT sign-off". */
  @Column({ type: DataType.STRING(150), allowNull: true })
  declare milestone: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;

  @HasMany(() => WorkspaceTask, { foreignKey: 'projectId', as: 'tasks' })
  declare tasks: WorkspaceTask[];
}
