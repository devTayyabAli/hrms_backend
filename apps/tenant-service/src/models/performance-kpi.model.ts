import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

export interface KpiItem {
  id: string;
  title: string;
  description: string | null;
  weight: number;
  target: string | null;
  unit: string | null;
  measurement: string;
  category: string | null;
}

/**
 * A set of KPIs HR keeps for people in particular departments or designations.
 * It is what an employee's KPIs start as when they are enrolled in a cycle; the
 * employee's own copy (ReviewKpi) is what changes after that, so editing a
 * template never rewrites a plan already made. References are plain ids.
 */
@Table({
  tableName: 'kpi_templates',
  timestamps: true,
  indexes: [{ fields: ['tenantId', 'isActive'], name: 'kpi_template_active_idx' }],
})
export class KpiTemplate extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** Empty: any department. A department includes the ones under it. */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare departmentIds: string[];

  /** Empty: any designation. */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare designationIds: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare items: KpiItem[];

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByEmail: string | null;
}

/**
 * One KPI in one person's review: copied from a template when they were
 * enrolled, or added by hand, then adjusted for them. The reviewer scores it
 * in the evaluation. Plain ids: nothing here blocks deleting a template.
 */
@Table({
  tableName: 'review_kpis',
  timestamps: true,
  indexes: [
    { fields: ['reviewId'], name: 'review_kpi_review_idx' },
    { fields: ['employeeId'], name: 'review_kpi_employee_idx' },
  ],
})
export class ReviewKpi extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare reviewId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare cycleId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare templateId: string | null;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare weight: number;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare target: string | null;

  @Column({ type: DataType.STRING(30), allowNull: true })
  declare unit: string | null;

  /** NUMBER | PERCENT | YES_NO | RATING */
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'NUMBER' })
  declare measurement: string;

  @Column({ type: DataType.STRING(60), allowNull: true })
  declare category: string | null;

  /** TEMPLATE | MANUAL */
  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'MANUAL' })
  declare source: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sortOrder: number;

  /** What was achieved, as the reviewer wrote it. */
  @Column({ type: DataType.STRING(100), allowNull: true })
  declare actual: string | null;

  /** 0 to 5, from the reviewer. */
  @Column({ type: DataType.DECIMAL(3, 1), allowNull: true })
  declare score: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare comment: string | null;

  /** Set when the plan is shown to the employee. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare publishedAt: Date | null;
}
