import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * A performance review cycle: a named period, who it is for (eligibility
 * rules), and how people get into it. The reviews it produces carry its id.
 * References are plain ids checked by the service, so no table has to exist
 * before this one.
 */
@Table({
  tableName: 'performance_cycles',
  timestamps: true,
  indexes: [
    { fields: ['tenantId', 'status'], name: 'performance_cycle_status_idx' },
    { fields: ['tenantId', 'name'], name: 'performance_cycle_name_idx' },
  ],
})
export class PerformanceCycle extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** "H2 2026". Becomes the cycle name on each review. */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  /** The period being reviewed. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare startDate: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare endDate: string;

  /** When reviews should be done. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare dueDate: string | null;

  /** DRAFT | ACTIVE | CLOSED */
  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'DRAFT' })
  declare status: string;

  /** AUTO_ENROL: eligible people get their review when it launches (and as they become eligible). HR_QUEUE: HR enrols them. */
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'AUTO_ENROL' })
  declare enrolmentMode: string;

  /** See EligibilityRules. */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare eligibility: Record<string, any>;

  /** Who completes the review of someone with no reporting manager. Null: it waits for HR. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare fallbackReviewerId: string | null;

  /** { includeAdditionalRoles: boolean }: whether people with additional roles get KPIs and evaluators for them. */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare roleRules: Record<string, any>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare launchedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare closedAt: Date | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByEmail: string | null;
}
