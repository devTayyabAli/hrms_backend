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
import { PayrollRecord } from './payroll-record.model';

export enum PayslipEmailStatus {
  NOT_SENT = 'NOT_SENT',
  SENDING = 'SENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

/**
 * A payslip: the visible number and delivery state for one line of a
 * completed payroll. Deliberately holds no pay figures — every amount is read
 * from the locked `payroll_records` row it points at, so the payslip and the
 * payroll can never disagree and nothing is ever recalculated.
 *
 * `sequence` is a tenant-wide counter behind the number (PS-2026-09-000123):
 * it only grows and payslips are never deleted, so a number is never reused.
 */
@Table({
  tableName: 'payslips',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['payrollRecordId'], name: 'payslip_record_unique' },
    { unique: true, fields: ['payslipNumber'], name: 'payslip_number_unique' },
    { unique: true, fields: ['sequence'], name: 'payslip_sequence_unique' },
    { fields: ['employeeId'], name: 'payslip_employee_idx' },
    { fields: ['payrollRunId'], name: 'payslip_run_idx' },
  ],
})
export class Payslip extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare payrollRunId: string;

  @ForeignKey(() => PayrollRecord)
  @Column({ type: DataType.UUID, allowNull: false })
  declare payrollRecordId: string;

  @BelongsTo(() => PayrollRecord, 'payrollRecordId')
  declare payrollRecord: PayrollRecord;

  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare payslipNumber: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare sequence: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare generatedAt: Date;

  @Column({ type: DataType.UUID, allowNull: true })
  declare generatedByUserId: string | null;

  // ── Email delivery ──────────────────────────────────────────────────────
  @Default(PayslipEmailStatus.NOT_SENT)
  @Column({
    type: DataType.ENUM(...Object.values(PayslipEmailStatus)),
    allowNull: false,
    defaultValue: PayslipEmailStatus.NOT_SENT,
  })
  declare emailStatus: PayslipEmailStatus;

  @Column({ type: DataType.STRING, allowNull: true })
  declare emailedTo: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare emailedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare emailedByUserId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare emailedByEmail: string | null;

  /** Short, credential-free reason — shown to payroll staff, never to employees. */
  @Column({ type: DataType.STRING(300), allowNull: true })
  declare emailError: string | null;

  /** When the current send started — a SENDING row older than a few minutes was interrupted. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare emailQueuedAt: Date | null;
}
