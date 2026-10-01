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
import { EmployeeStatus } from '@app/common';
import { Department } from './department.model';
import { Designation } from './designation.model';

/**
 * The HR record for a person employed by this organization — what the admin
 * Employees screen lists, and what attendance records point at.
 *
 * Lives in each tenant's own physical database (see
 * apps/tenant-service/src/services/tenant-model-provider.service.ts), NOT a
 * shared platform table. `tenantId` is kept as a plain, non-FK column: a
 * defense-in-depth check (queries still filter by it), but the real isolation
 * boundary is the separate per-tenant database. No `@BelongsTo(() => Tenant)`
 * — Tenant lives in the platform database, a different physical connection.
 *
 * Deliberately separate from user-service's `User`, which models a *login*.
 * Not every employee needs credentials (and the ones who do are created
 * through the invitation flow), so `userId` is a nullable, non-FK pointer at
 * a row in a different service's database — never joined in SQL, only used
 * to correlate an employee with their login when both exist.
 */
@Table({
  tableName: 'employees',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['employeeCode'], name: 'unique_employee_code' },
    { unique: true, fields: ['email'], name: 'unique_employee_email' },
    { fields: ['departmentId'], name: 'employees_department_idx' },
    { fields: ['designationId'], name: 'employees_designation_idx' },
    { fields: ['status'], name: 'employees_status_idx' },
  ],
})
export class Employee extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** Human-readable ID shown in the table (EMP001). Unique within the tenant. */
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare employeeCode: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare firstName: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare lastName: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare phone: string | null;

  @ForeignKey(() => Department)
  @Column({ type: DataType.UUID, allowNull: true })
  declare departmentId: string | null;

  @BelongsTo(() => Department, 'departmentId')
  declare department: Department;

  /** Surfaces as the "Role" column on the Employees screen. */
  @ForeignKey(() => Designation)
  @Column({ type: DataType.UUID, allowNull: true })
  declare designationId: string | null;

  @BelongsTo(() => Designation, 'designationId')
  declare designation: Designation;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true })
  declare reportingManagerId: string | null;

  @BelongsTo(() => Employee, 'reportingManagerId')
  declare reportingManager: Employee;

  /** DATEONLY — a joining date is a calendar day, not an instant. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare joiningDate: string | null;

  /** Last working day. Only meaningful once status is RESIGNED. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare exitDate: string | null;

  @Default(EmployeeStatus.ACTIVE)
  @Column({
    type: DataType.ENUM(...Object.values(EmployeeStatus)),
    allowNull: false,
    defaultValue: EmployeeStatus.ACTIVE,
  })
  declare status: EmployeeStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare avatarUrl: string | null;

  /**
   * Login account in user-service's tenant database, when this employee has
   * one. Intentionally not a Sequelize FK — that table lives on a different
   * physical connection, so a cross-database constraint is impossible.
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare userId: string | null;

  /**
   * The salary currently in effect — kept in step with the latest
   * `salary_revisions` row whose date has arrived. Payroll resolves the
   * revision for each period itself, so a past run is never recomputed from
   * a later raise. Only the payroll salary endpoints write these, and only
   * payroll permissions read them.
   */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare basicSalary: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare allowances: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare recurringDeductions: string;

  /** When the salary above took effect. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare salaryEffectiveFrom: string | null;

  // ── Bank (salary transfer) ──────────────────────────────────────────────
  // bankName, bankAccountNumber and iban already exist in older tenant
  // databases with exactly these sizes; declared to match, not re-created.
  @Column({ type: DataType.STRING(128), allowNull: true })
  declare bankName: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare bankAccountTitle: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare bankAccountNumber: string | null;

  @Column({ type: DataType.STRING(34), allowNull: true })
  declare iban: string | null;

  // ── Personal ────────────────────────────────────────────────────────────
  @Column({ type: DataType.STRING(8), allowNull: true })
  declare salutation: string | null;

  /** Father's or husband's name. */
  @Column({ type: DataType.STRING(150), allowNull: true })
  declare fatherName: string | null;

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare gender: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare dateOfBirth: string | null;

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare maritalStatus: string | null;

  @Column({ type: DataType.STRING(80), allowNull: true })
  declare nationality: string | null;

  @Column({ type: DataType.STRING(60), allowNull: true })
  declare religion: string | null;

  @Column({ type: DataType.STRING(4), allowNull: true })
  declare bloodGroup: string | null;

  /** National ID / CNIC. Unique within the organization when set. */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare nationalId: string | null;

  // ── Contact ─────────────────────────────────────────────────────────────
  @Column({ type: DataType.STRING(500), allowNull: true })
  declare currentAddress: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare permanentAddress: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare city: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare emergencyContactName: string | null;

  @Column({ type: DataType.STRING(60), allowNull: true })
  declare emergencyContactRelation: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare emergencyContactPhone: string | null;

  // ── Employment ──────────────────────────────────────────────────────────
  /** PERMANENT, PROBATION, CONTRACT, INTERNSHIP, PART_TIME, CONSULTANT, TEMPORARY. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare employmentType: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare probationEndDate: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare contractEndDate: string | null;

  /** ONSITE, REMOTE or HYBRID. */
  @Column({ type: DataType.STRING(8), allowNull: true })
  declare workMode: string | null;
}
