import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Employee } from './employee.model';
import { OffboardingCase } from './offboarding.model';

/**
 * What is owed to and by someone leaving. One for each offboarding case. The
 * lines are kept on the row, as they were worked out and as they were
 * changed; approving it turns them into payroll adjustments, which are the
 * records payroll reads.
 */
@Table({
  tableName: 'final_settlements',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['caseId'], name: 'unique_final_settlement_case' },
    { fields: ['employeeId'], name: 'final_settlement_employee_idx' },
    { fields: ['status'], name: 'final_settlement_status_idx' },
  ],
})
export class FinalSettlement extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => OffboardingCase)
  @Column({ type: DataType.UUID, allowNull: false })
  declare caseId: string;

  @BelongsTo(() => OffboardingCase, 'caseId')
  declare offboardingCase: OffboardingCase;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @BelongsTo(() => Employee, 'employeeId')
  declare employee: Employee;

  /** DRAFT | SUBMITTED | APPROVED | PAID | CANCELLED */
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'DRAFT' })
  declare status: string;

  /** YYYY-MM: the payroll it is paid in. */
  @Column({ type: DataType.STRING(7), allowNull: false })
  declare payrollPeriod: string;

  /** The monthly basic salary at the last working day, and the day's worth worked out from it. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: true })
  declare basicMonthly: string | null;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: true })
  declare dailyRate: string | null;

  /** [{ id, kind, type, label, amount, category, auto, source, adjustmentId }] */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare lines: Record<string, any>[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare totals: Record<string, number>;

  /** The route of approvers and where it is on it. Set when it is submitted. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare approval: Record<string, any> | null;

  /** Why it was last sent back: { by, at, note }. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare rejection: Record<string, any> | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare preparedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare preparedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare submittedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare decidedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare decidedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare decisionNote: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare paidAt: Date | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare paidByEmail: string | null;
}
