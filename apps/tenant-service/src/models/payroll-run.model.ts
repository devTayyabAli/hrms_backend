import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';
import { PayrollCycle, PayrollProcessStep } from '@app/common';

export { PayrollProcessStep };

export enum PayrollRunStatus {
  DRAFT = 'DRAFT',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Table({
  tableName: 'payroll_runs',
  timestamps: true,
  indexes: [
    { fields: ['periodStart', 'periodEnd'], name: 'payroll_run_period_idx' },
    { fields: ['status'], name: 'payroll_run_status_idx' },
  ],
})
export class PayrollRun extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare periodStart: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare periodEnd: string;

  @Column({ type: DataType.ENUM(...Object.values(PayrollRunStatus)), allowNull: false, defaultValue: PayrollRunStatus.DRAFT })
  declare status: PayrollRunStatus;

  /**
   * Payroll Process stepper. Independent of `status`, which stays the
   * operational state (draft / processing / completed) the overview counts.
   */
  @Column({
    type: DataType.ENUM(...Object.values(PayrollProcessStep)),
    allowNull: false,
    defaultValue: PayrollProcessStep.REVIEW,
  })
  declare step: PayrollProcessStep;

  /**
   * The Payroll Cycle panel. `payDate` is when people are actually paid,
   * which is not the period end — September's payroll commonly pays in
   * October, and the screen shows both.
   */
  @Default(PayrollCycle.MONTHLY)
  @Column({
    type: DataType.ENUM(...Object.values(PayrollCycle)),
    allowNull: false,
    defaultValue: PayrollCycle.MONTHLY,
  })
  declare cycle: PayrollCycle;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare payDate: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare employeeCount: number;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare grossPay: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare deductions: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare netPay: string;

  /** When the run finished (marked paid). Kept for the existing overview. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare processedAt: Date | null;

  /** ISO 4217 code the amounts are in — the payroll policy's, else the organization's. */
  @Column({ type: DataType.STRING(3), allowNull: true })
  declare currency: string | null;

  /** Employees left out of the run and why ("No salary set"). */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare skippedEmployees: { employeeId: string; employeeCode: string; name: string; reason: string }[] | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare calculatedAt: Date | null;

  // ── Lifecycle: who moved the run, and when ──────────────────────────────
  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare submittedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare submittedByUserId: string | null;

  /** Approval locks the run: no line or adjustment changes after this. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare approvedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare approvedByUserId: string | null;

  /** The last time an approver sent it back to Review, and why. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare returnedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare returnedByUserId: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare returnReason: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare paidAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare paidByUserId: string | null;

  /** The date salaries actually went out — may differ from when it was recorded. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare paymentDate: string | null;

  @Column({ type: DataType.STRING(120), allowNull: true })
  declare paymentReference: string | null;

  /** Run-wide compliance warnings ("No active income tax rule covers September 2026"). */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare complianceNotes: string[] | null;

  /** Login emails behind the *ByUserId columns, so the screen can name people. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare actorEmails: Partial<Record<'created' | 'submitted' | 'approved' | 'returned' | 'paid', string>> | null;
}
