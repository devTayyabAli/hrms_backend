import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Employee } from './employee.model';

/**
 * An expense claim paid back through payroll.
 *
 *   SUBMITTED → APPROVED → INCLUDED (its payroll is approved)
 *            ↘ REJECTED
 *
 * Only an approved claim enters a payroll, as an earning of category
 * REIMBURSEMENT — whether it is taxed is the active income tax rule's call,
 * not this table's.
 */
@Table({
  tableName: 'reimbursements',
  timestamps: true,
  indexes: [
    { fields: ['employeeId', 'status'], name: 'reimbursement_employee_idx' },
    { fields: ['payrollRunId'], name: 'reimbursement_run_idx' },
  ],
})
export class Reimbursement extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @BelongsTo(() => Employee, 'employeeId')
  declare employee: Employee;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false })
  declare amount: string;

  /** TRAVEL, MEDICAL, FUEL, MEALS, OTHER … — the organization's own words. */
  @Column({ type: DataType.STRING(40), allowNull: false })
  declare category: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare expenseDate: string;

  @Column({ type: DataType.STRING(500), allowNull: false })
  declare description: string;

  /** Supporting document: a file uploaded through /files/upload. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare fileId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare fileName: string | null;

  @Column({ type: DataType.STRING(127), allowNull: true })
  declare mimeType: string | null;

  /** SUBMITTED | APPROVED | REJECTED | INCLUDED */
  @Default('SUBMITTED')
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'SUBMITTED' })
  declare status: string;

  /** YYYY-MM: the payroll it should be paid in; null = the next one calculated. */
  @Column({ type: DataType.STRING(7), allowNull: true })
  declare payrollPeriod: string | null;

  /** The payroll it is on, once a run picks it up. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare payrollRunId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare payrollRecordId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare submittedByEmail: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare decidedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;

  @Column({ type: DataType.STRING(300), allowNull: true })
  declare decisionNote: string | null;
}
