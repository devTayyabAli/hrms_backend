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
import { WorkspaceProject } from './workspace-project.model';

/**
 * Someone on a project besides the owner. The owner lives on the project as
 * `leadEmployeeId` and is not repeated here. A row does not change the
 * employee's department, reporting manager, or designation.
 */
@Table({
  tableName: 'workspace_project_members',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { unique: true, fields: ['projectId', 'employeeId'], name: 'workspace_project_member_unique' },
    { fields: ['employeeId'], name: 'workspace_project_member_employee_idx' },
  ],
})
export class WorkspaceProjectMember extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => WorkspaceProject)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare projectId: string;

  @BelongsTo(() => WorkspaceProject, { foreignKey: 'projectId', as: 'project' })
  declare project: WorkspaceProject;

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
