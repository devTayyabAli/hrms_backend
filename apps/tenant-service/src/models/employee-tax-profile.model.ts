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
import { Employee } from './employee.model';

/**
 * An employee's tax and statutory-contribution details for one tax year —
 * what payroll needs beyond salary: NTN and residency, income and tax from a
 * previous employer this year, deductible allowances and credits, a manual
 * tax adjustment, the medical allowance included in their allowances, and
 * EOBI / provident fund membership.
 *
 * Payroll data, behind payroll tax permissions — never on employee routes.
 */
@Table({
  tableName: 'employee_tax_profiles',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['employeeId', 'taxYear'],
      name: 'employee_tax_profile_year_unique',
    },
  ],
})
export class EmployeeTaxProfile extends Model {
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

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare taxYear: number;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare effectiveFrom: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare ntn: string | null;

  /** On the Active Taxpayers List (filer) or not — recorded for reference. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare taxStatus: 'FILER' | 'NON_FILER' | null;

  @Default('RESIDENT')
  @Column({
    type: DataType.STRING(16),
    allowNull: false,
    defaultValue: 'RESIDENT',
  })
  declare residency: 'RESIDENT' | 'NON_RESIDENT';

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare previousEmployerTaxableIncome: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare previousEmployerTaxDeducted: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare annualDeductibleAllowances: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare annualTaxCredits: string;

  /** Extra annual tax to recover (+) or over-deduction to give back (−). */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare taxAdjustment: string;

  @Column({ type: DataType.STRING(300), allowNull: true })
  declare taxAdjustmentReason: string | null;

  /** A reduction the tax rule allows, by its code — ignored unless the rule lists it. */
  @Column({ type: DataType.STRING(40), allowNull: true })
  declare reductionCode: string | null;

  /** Part of the monthly allowances that is medical allowance. */
  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  declare medicalAllowanceMonthly: string;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare freeMedicalProvided: boolean;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare eobiCovered: boolean;

  @Column({ type: DataType.STRING(40), allowNull: true })
  declare eobiRegistrationNumber: string | null;

  /** Null = the provident fund rule's default membership. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare pfMember: boolean | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare pfJoinDate: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare updatedByEmail: string | null;
}
