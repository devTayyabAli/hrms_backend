import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Employee } from './employee.model';

/**
 * An employee's own recurring earning (mobile allowance for six months) or
 * deduction (salary deduction, other approved deduction), with its dates.
 * Payroll includes it for every period it is active in; an earning is
 * prorated over its own working days, a deduction is taken in full and, if
 * it has a total, never past what is left of it.
 */
@Table({
  tableName: 'employee_recurring_items',
  timestamps: true,
  indexes: [{ fields: ['employeeId', 'kind'], name: 'employee_recurring_item_employee_idx' }],
})
export class EmployeeRecurringItem extends Model {
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

  /** EARNING | DEDUCTION */
  @Column({ type: DataType.STRING(12), allowNull: false })
  declare kind: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare category: string;

  /** FIXED | PERCENTAGE */
  @Default('FIXED')
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'FIXED' })
  declare calculationMethod: string;

  /** FIXED: the monthly amount. PERCENTAGE: the percent. */
  @Column({ type: DataType.DECIMAL(14, 4), allowNull: false })
  declare amount: string;

  /** BASIC | GROSS — required for a percentage. */
  @Column({ type: DataType.STRING(12), allowNull: true })
  declare percentageBase: string | null;

  /** MONTHLY | ONE_TIME */
  @Default('MONTHLY')
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'MONTHLY' })
  declare frequency: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare startDate: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare endDate: string | null;

  /** Deductions only: stop once this much has been taken. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: true })
  declare totalAmount: string | null;

  /** Earnings: TAXABLE | NON_TAXABLE | RULE_DEPENDENT. */
  @Default('RULE_DEPENDENT')
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'RULE_DEPENDENT' })
  declare taxTreatment: string;

  /** ACTIVE | STOPPED — stopping keeps what was already paid or taken. */
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
