import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Employee } from './employee.model';

/**
 * An employee loan or salary advance, recovered from payroll in instalments.
 *
 * The balance is never stored: it is the principal less every instalment
 * recorded on payroll lines. So a recalculated or deleted Review run can't
 * leave a wrong balance behind, and an approved payroll's recovery — part of
 * its snapshot — never changes when the loan is edited later.
 */
@Table({
  tableName: 'employee_loans',
  timestamps: true,
  indexes: [{ fields: ['employeeId', 'status'], name: 'employee_loan_employee_idx' }],
})
export class EmployeeLoan extends Model {
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

  /** LOAN | ADVANCE */
  @Column({ type: DataType.STRING(12), allowNull: false })
  declare kind: string;

  /** Loan principal, or the advance amount. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false })
  declare principal: string;

  /** Taken each period (the last one only what is left). */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false })
  declare installmentAmount: string;

  /** Loans: the planned number of instalments, for display. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare installments: number | null;

  /** When the money was given. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare issuedOn: string;

  /** The first payroll month it is recovered in (any date in that month). */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare startDate: string;

  /** ACTIVE | ON_HOLD | COMPLETED | CANCELLED */
  @Default('ACTIVE')
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'ACTIVE' })
  declare status: string;

  @Column({ type: DataType.STRING(300), allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByEmail: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare updatedByEmail: string | null;
}
