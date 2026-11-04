import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * An additional role someone holds beside their primary position: a second
 * department they support, a dotted-line manager, or a named responsibility
 * ("Payroll liaison for Marketing"). The primary department, designation and
 * reporting manager stay on the employee: approvals follow them, and nothing
 * here changes that. This only adds who else a person works for and where.
 *
 * Ended assignments stay (with an end date) as the record. Every reference is
 * a plain id checked by the service, so the table needs no particular order
 * when the schema is created.
 */
@Table({
  tableName: 'employee_assignments',
  timestamps: true,
  indexes: [
    { fields: ['tenantId', 'employeeId'], name: 'employee_assignment_employee_idx' },
    { fields: ['reportingManagerId'], name: 'employee_assignment_manager_idx' },
    { fields: ['departmentId'], name: 'employee_assignment_department_idx' },
  ],
})
export class EmployeeAssignment extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  /** The other department they work for. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare departmentId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare designationId: string | null;

  /** A name for the role, when no designation fits: "Payroll liaison". */
  @Column({ type: DataType.STRING(120), allowNull: true })
  declare title: string | null;

  /** The additional (dotted-line) manager for this assignment. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare reportingManagerId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare responsibilities: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare startDate: string;

  /** Null while it lasts. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare endDate: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByEmail: string | null;
}
