import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * One person who evaluates a review that has more than one reviewer (a Team
 * Lead in one department and a Project Manager for another assignment, say).
 * Each evaluator writes and submits their own evaluation without seeing the
 * others; the review's final rating is their ratings weighted by `weight`, and
 * each stays on record. A review with a single reviewer has no rows here: the
 * evaluation lives on the review itself, as before.
 *
 * References are plain ids checked by the service.
 */
@Table({
  tableName: 'review_evaluators',
  timestamps: true,
  indexes: [
    { fields: ['reviewId', 'employeeId'], unique: true, name: 'review_evaluator_unique_idx' },
    { fields: ['employeeId'], name: 'review_evaluator_employee_idx' },
  ],
})
export class ReviewEvaluator extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare reviewId: string;

  /** The evaluator. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  /** What they evaluate the person as: "Team Lead", "Project Manager". */
  @Column({ type: DataType.STRING(120), allowNull: true })
  declare roleLabel: string | null;

  /** The lead is the review's main reviewer: sets the plan, and writes the overall comment. Exactly one per review. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isLead: boolean;

  /** Their share of the final rating, in percent. A review's weights add up to 100. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare weight: number;

  /** PENDING | IN_PROGRESS | SUBMITTED */
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'PENDING' })
  declare status: string;

  @Column({ type: DataType.DECIMAL(3, 1), allowNull: true })
  declare professionalism: string | null;

  @Column({ type: DataType.DECIMAL(3, 1), allowNull: true })
  declare communication: string | null;

  @Column({ type: DataType.DECIMAL(3, 1), allowNull: true })
  declare qualityOfWork: string | null;

  @Column({ type: DataType.DECIMAL(3, 1), allowNull: true })
  declare teamwork: string | null;

  @Column({ type: DataType.DECIMAL(3, 1), allowNull: true })
  declare leadership: string | null;

  /** The average of the scores they gave, or what their KPIs came to when they gave none. */
  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare rating: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare comments: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare submittedAt: Date | null;
}
