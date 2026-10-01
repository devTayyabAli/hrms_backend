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
import { EmploymentType, JobOpeningStatus } from '@app/common';
import { Department } from './department.model';
import { Designation } from './designation.model';
import { Employee } from './employee.model';
import { Candidate } from './candidate.model';

/**
 * One job requisition — the rows behind the Recruitment screen's Job Openings
 * table and the "Total Open Positions" KPI.
 *
 * Lives in each tenant's own physical database alongside Department and
 * Employee, so the department join behind the table stays local SQL.
 * `tenantId` is a plain, non-FK defense-in-depth column; the real isolation
 * boundary is the separate per-tenant database.
 *
 * The Applications count shown on each row is deliberately NOT a column here.
 * It is a COUNT over `candidates` resolved at read time, so it cannot drift
 * from the pipeline it summarises — a stored counter would need incrementing
 * on every candidate create, delete and requisition reassignment, and the
 * first missed write would leave the table reporting applications that do not
 * exist.
 */
@Table({
  tableName: 'job_openings',
  timestamps: true,
  indexes: [
    { fields: ['status'], name: 'job_opening_status_idx' },
    { fields: ['departmentId'], name: 'job_opening_department_idx' },
    // The table defaults to newest-posted-first; without this the default
    // view sorts the whole table on every page load.
    { fields: ['postedOn'], name: 'job_opening_posted_on_idx' },
    {
      fields: ['tenantId', 'requisitionCode'],
      name: 'job_opening_requisition_code_unique',
      unique: true,
    },
  ],
})
export class JobOpening extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** Human-friendly requisition label (e.g. JOB-1042), unique per tenant. */
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare requisitionCode: string;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare title: string;

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

  @Column({
    type: DataType.ENUM(...Object.values(EmploymentType)),
    allowNull: false,
    defaultValue: EmploymentType.FULL_TIME,
  })
  declare employmentType: EmploymentType;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare location: string | null;

  /** Seats this requisition is hiring for; drives the hiring-goal denominator. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare openings: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare skills: string[] | null;

  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare salaryMin: string | null;

  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare salaryMax: string | null;

  /** The Posted On column. DATEONLY — a posting is dated, not timed. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare postedOn: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare closingDate: string | null;

  @Column({
    type: DataType.ENUM(...Object.values(JobOpeningStatus)),
    allowNull: false,
    defaultValue: JobOpeningStatus.ACTIVE,
  })
  declare status: JobOpeningStatus;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true })
  declare hiringManagerEmployeeId: string | null;

  @BelongsTo(() => Employee, 'hiringManagerEmployeeId')
  declare hiringManager: Employee;

  @HasMany(() => Candidate, 'jobOpeningId')
  declare candidates: Candidate[];

  /** User who created the requisition, for the activity feed attribution. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;
}
