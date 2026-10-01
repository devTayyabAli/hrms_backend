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
import { Department } from './department.model';
import { Designation } from './designation.model';
import { Employee } from './employee.model';
import { OnboardingTask } from './onboarding-task.model';

/**
 * A person being onboarded — the rows behind the Onboarding screen's New
 * Hires table, its four KPI cards and the Onboarding Progress donut.
 *
 * There is deliberately no `status` column. The Status column on the table,
 * the "Completed Onboarding" / "In Progress" cards and the donut are all
 * derived from this hire's checklist at read time via
 * `deriveOnboardingStatus`. A stored status would need rewriting on every
 * task toggle, add and delete, and the first missed write would show a hire
 * as COMPLETED with open tasks — three widgets disagreeing about the same
 * person. The checklist is the single source of truth.
 *
 * A new hire is also not an Employee row. Onboarding starts before the
 * employee record exists (often before the joining date), and a hire can drop
 * out without ever becoming staff. `employeeId` is the optional link, filled
 * in once the hire is converted, so headcount is never inflated by someone
 * who has not started.
 */
@Table({
  tableName: 'new_hires',
  timestamps: true,
  indexes: [
    { fields: ['departmentId'], name: 'new_hire_department_idx' },
    // The table defaults to newest-joining-first, and the KPI cards window on
    // this column.
    { fields: ['joiningDate'], name: 'new_hire_joining_date_idx' },
    { fields: ['employeeId'], name: 'new_hire_employee_idx' },
    { fields: ['candidateId'], name: 'new_hire_candidate_idx' },
    {
      fields: ['tenantId', 'email'],
      name: 'new_hire_email_unique',
      unique: true,
    },
  ],
})
export class NewHire extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare firstName: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare lastName: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare phone: string | null;

  /**
   * The Position column. Free text rather than only a designation FK: a hire
   * is frequently created from an offer letter before the tenant has a
   * matching designation row, and the offered title is what the table should
   * show. `designationId` carries the structured link when one exists.
   */
  @Column({ type: DataType.STRING(150), allowNull: false })
  declare position: string;

  @ForeignKey(() => Department)
  @Column({ type: DataType.UUID, allowNull: false })
  declare departmentId: string;

  @BelongsTo(() => Department, 'departmentId')
  declare department: Department;

  @ForeignKey(() => Designation)
  @Column({ type: DataType.UUID, allowNull: true })
  declare designationId: string | null;

  @BelongsTo(() => Designation, 'designationId')
  declare designation: Designation;

  /** The Join Date column. DATEONLY — a start date has no time of day. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare joiningDate: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true })
  declare reportingManagerEmployeeId: string | null;

  @BelongsTo(() => Employee, 'reportingManagerEmployeeId')
  declare reportingManager: Employee;

  /** Filled in once the hire is converted to staff — see the class comment. */
  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true })
  declare employeeId: string | null;

  @BelongsTo(() => Employee, 'employeeId')
  declare employee: Employee;

  /**
   * The candidate this hire came from, set when a candidate is moved to
   * HIRED. Not an FK: recruitment data is routinely purged on a retention
   * schedule, and that must not cascade away an active onboarding.
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare candidateId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;

  @HasMany(() => OnboardingTask, 'newHireId')
  declare tasks: OnboardingTask[];

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;
}
