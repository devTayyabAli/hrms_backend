import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';

export enum ComplianceRuleType {
  INCOME_TAX = 'INCOME_TAX',
  EOBI = 'EOBI',
  PROVIDENT_FUND = 'PROVIDENT_FUND',
}

export enum ComplianceRuleStatus {
  /** Editable; never used by payroll. */
  DRAFT = 'DRAFT',
  /** Used by payroll for its effective dates. Frozen — change means a new rule. */
  ACTIVE = 'ACTIVE',
  /** No longer used for new calculations; kept, with the runs that used it. */
  RETIRED = 'RETIRED',
}

/**
 * One version of a statutory rule — a tax year's slabs, EOBI's rates, a
 * provident fund's terms — with the dates it applies to. Payroll picks the
 * active rule in effect on a period's first day and copies it into each
 * line's snapshot, so a later rule never changes a past payroll.
 *
 * Rules are never overwritten once active: a Finance Act change is a new
 * rule with its own dates, and the old one stays for the months it covered.
 */
@Table({
  tableName: 'compliance_rules',
  timestamps: true,
  indexes: [
    {
      fields: ['ruleType', 'status', 'effectiveFrom'],
      name: 'compliance_rule_type_status_idx',
    },
  ],
})
export class ComplianceRule extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(2), allowNull: false, defaultValue: 'PK' })
  declare country: string;

  @Column({
    type: DataType.ENUM(...Object.values(ComplianceRuleType)),
    allowNull: false,
  })
  declare ruleType: ComplianceRuleType;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare name: string;

  /** For income tax: the tax year (2027 = July 2026 – June 2027). */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare taxYear: number | null;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare effectiveFrom: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare effectiveTo: string | null;

  @Default(ComplianceRuleStatus.DRAFT)
  @Column({
    type: DataType.ENUM(...Object.values(ComplianceRuleStatus)),
    allowNull: false,
    defaultValue: ComplianceRuleStatus.DRAFT,
  })
  declare status: ComplianceRuleStatus;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare configuration: Record<string, any>;

  /** Set when a figure couldn't be confirmed — activation needs an explicit review. */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare requiresReview: boolean;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reviewNotes: string | null;

  /** Where the figures come from — the official document and section. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare source: string | null;

  /** The template it started from, if any. */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare templateKey: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByEmail: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare updatedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare activatedAt: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare activatedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare retiredAt: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare retiredByEmail: string | null;
}
