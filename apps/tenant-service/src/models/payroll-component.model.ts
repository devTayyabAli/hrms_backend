import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * A payroll component in the organization's catalog — an earning, a
 * deduction or an employer contribution, and how it is worked out.
 *
 * The catalog describes components; it doesn't pay anyone. An employee's
 * compensation copies a component's settings when it is saved and works out
 * the monthly amount then, so editing a component here changes nobody's pay
 * until their compensation is revised.
 */
@Table({
  tableName: 'payroll_components',
  timestamps: true,
  indexes: [{ unique: true, fields: ['code'], name: 'payroll_component_code_unique' }],
})
export class PayrollComponent extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** HOUSING, TRANSPORT — how formulas and imports refer to it. */
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare code: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  /** EARNING | DEDUCTION | EMPLOYER_CONTRIBUTION */
  @Column({ type: DataType.STRING(24), allowNull: false })
  declare type: string;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare category: string;

  /** FIXED | PERCENTAGE | FORMULA */
  @Column({ type: DataType.STRING(16), allowNull: false })
  declare calculationMethod: string;

  /** FIXED: default monthly amount. PERCENTAGE: the percent. */
  @Column({ type: DataType.DECIMAL(14, 4), allowNull: true })
  declare value: string | null;

  /** BASIC | SELECTED | GROSS | TAXABLE_EARNINGS — required for a percentage. */
  @Column({ type: DataType.STRING(24), allowNull: true })
  declare percentageBase: string | null;

  @Default([])
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare baseComponents: string[];

  @Column({ type: DataType.TEXT, allowNull: true })
  declare formula: string | null;

  /** TAXABLE | NON_TAXABLE | RULE_DEPENDENT — the compliance engine applies it. */
  @Default('RULE_DEPENDENT')
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'RULE_DEPENDENT' })
  declare taxTreatment: string;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare includedInGross: boolean;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare includedInOvertimeBase: boolean;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare includedInLeaveBase: boolean;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare effectiveFrom: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare effectiveTo: string | null;

  /** ACTIVE | INACTIVE — an inactive component can't be added to anything new. */
  @Default('ACTIVE')
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'ACTIVE' })
  declare status: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** The Basic Salary component every organization has; it can't be removed. */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isSystem: boolean;

  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByEmail: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare updatedByEmail: string | null;
}
