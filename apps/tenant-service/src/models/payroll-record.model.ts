import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Employee } from './employee.model';
import { PayrollRun } from './payroll-run.model';

@Table({
  tableName: 'payroll_records',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['payrollRunId', 'employeeId'], name: 'payroll_record_run_employee_unique' },
    { fields: ['employeeId'], name: 'payroll_record_employee_idx' },
  ],
})
export class PayrollRecord extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => PayrollRun)
  @Column({ type: DataType.UUID, allowNull: false })
  declare payrollRunId: string;

  @BelongsTo(() => PayrollRun, 'payrollRunId')
  declare payrollRun: PayrollRun;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @BelongsTo(() => Employee, 'employeeId')
  declare employee: Employee;

  // A payroll line is a snapshot: every input and every figure the
  // calculation produced for this run, so a later raise, attendance fix or
  // bank change never alters a run that has been approved.

  /** Monthly salary in effect for the period (before proration). */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare basicSalary: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare allowances: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare salaryEffectiveFrom: string | null;

  /** Sum of EARNING adjustments — named `bonus` for the existing breakdown. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare bonus: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare grossPay: string;

  /** Total of every deduction below. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare deductions: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare netPay: string;

  // ── Days ────────────────────────────────────────────────────────────────
  /** Scheduled working days in the whole period. */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, defaultValue: 0 })
  declare workingDays: string;

  /** Working days inside the employee's employment (after joining, before exit). */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, defaultValue: 0 })
  declare eligibleDays: string;

  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, defaultValue: 0 })
  declare absenceDays: string;

  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, defaultValue: 0 })
  declare unpaidLeaveDays: string;

  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, defaultValue: 0 })
  declare paidLeaveDays: string;

  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, defaultValue: 0 })
  declare paidDays: string;

  /** Working days with no attendance record and no leave — paid, but worth a look. */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, defaultValue: 0 })
  declare unrecordedDays: string;

  /** eligibleDays / workingDays — below 1 for a joiner or leaver. */
  @Column({ type: DataType.DECIMAL(8, 6), allowNull: false, defaultValue: 1 })
  declare prorationFactor: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare employedFrom: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare employedTo: string | null;

  // ── Earnings ────────────────────────────────────────────────────────────
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare dailyRate: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare earnedBasic: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare earnedAllowances: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare overtimeMinutes: number;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare overtimePay: string;

  // ── Deductions ──────────────────────────────────────────────────────────
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare absenceDeduction: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare unpaidLeaveDeduction: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare recurringDeductions: string;

  /** Sum of DEDUCTION adjustments. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare adjustmentDeductions: string;

  /** Things HR should know about this line ("Joined 15 Sep — prorated"). */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare notes: string[] | null;

  // ── Where it is paid (snapshot) ─────────────────────────────────────────
  @Column({ type: DataType.STRING(128), allowNull: true })
  declare bankName: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare bankAccountTitle: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare bankAccountNumber: string | null;

  @Column({ type: DataType.STRING(34), allowNull: true })
  declare iban: string | null;

  // ── Compliance (Phase 3) ────────────────────────────────────────────────
  // `deductions` is the total taken from pay; `normalDeductions` is the
  // Phase 1 part of it and `statutoryDeductions` the rest. Employer
  // contributions are recorded here but are never part of `deductions`.

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare normalDeductions: string;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare taxYear: number | null;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare taxableIncome: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare incomeTax: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare eobiEmployee: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare eobiEmployer: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare pfEmployee: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare pfEmployer: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare statutoryDeductions: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare employerContributions: string;

  /**
   * Everything needed to reproduce the compliance figures: a copy of each
   * rule used (not just its id), the inputs and the calculation steps. Null
   * on lines calculated before compliance existed.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare complianceSnapshot: Record<string, any> | null;

  // ── Compensation (Phase 4) ──────────────────────────────────────────────

  /** Loan and advance instalments taken — part of `normalDeductions`. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare loanRecovery: string;

  /** Employer contribution components other than EOBI / PF — part of `employerContributions`. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare otherEmployerContributions: string;

  /**
   * Every earning, deduction and employer contribution on the line with how
   * it was worked out, and the compensation segments it was paid from. Null
   * on lines calculated before components existed.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare components: Record<string, any> | null;
}
