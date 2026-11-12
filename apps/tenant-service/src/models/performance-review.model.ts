import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Op } from 'sequelize';
import { PerformanceReviewStatus } from '@app/common';
import { Employee } from './employee.model';

export { PerformanceReviewStatus };

/**
 * One appraisal cycle for an employee. The five metric scores are what the
 * Performance Metrics bars average; `rating` is the overall score behind
 * Avg Rating and the Performance Trend chart.
 */
@Table({
  tableName: 'performance_reviews',
  timestamps: true,
  indexes: [
    { fields: ['employeeId'], name: 'performance_review_employee_idx' },
    { fields: ['status'], name: 'performance_review_status_idx' },
    { fields: ['reviewDate'], name: 'performance_review_date_idx' },
    // One review of a person for each cycle, held by the database as well as by the code, so two
    // requests at once cannot both make it. Reviews written by hand (no cycle) are not covered.
    { fields: ['employeeId', 'cycleId'], unique: true, name: 'performance_review_employee_cycle_unique_idx', where: { cycleId: { [Op.ne]: null } } },
  ],
})
export class PerformanceReview extends Model {
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

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare cycle: string;

  @Column({ type: DataType.ENUM(...Object.values(PerformanceReviewStatus)), allowNull: false, defaultValue: PerformanceReviewStatus.PENDING })
  declare status: PerformanceReviewStatus;

  /** Overall score, 0–5. Null until the review is rated. */
  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare rating: string | null;

  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare professionalism: string | null;

  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare communication: string | null;

  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare qualityOfWork: string | null;

  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare teamwork: string | null;

  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare leadership: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare reviewDate: string | null;

  /** The reviewer's feedback. The employee reads it once the review is published. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare reviewerComments: string | null;

  /** When the completed review was made visible to the employee. Null means they have not seen the result. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare publishedAt: Date | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare publishedByEmail: string | null;

  /** What the employee wrote about themselves: { scores, comments, submittedAt }. Null until they submit. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare selfAssessment: Record<string, any> | null;

  /**
   * Who completes the review. By default the employee's reporting manager, who
   * follows a change of manager while the review is open. Null means HR does
   * it. A plain id, checked by the service.
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare reviewerId: string | null;

  /** True once HR picked the reviewer: a change of manager no longer moves it. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare reviewerPinned: boolean;

  /**
   * Who and where the person was when the review was made (department,
   * designation, manager, reviewer), so the review keeps saying so however
   * the employee record changes. Null on reviews made before this existed.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare employeeSnapshot: Record<string, any> | null;

  /** The cycle this review belongs to, when it came from one. Null for a review made by hand. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare cycleId: string | null;

  /** When the plan (KPIs and goals) was shown to the employee. Null while it is a draft. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare planPublishedAt: Date | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare planPublishedByEmail: string | null;

  /** The weighted score of the KPIs the reviewer scored, 0 to 5. */
  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare kpiScore: string | null;

  /**
   * Set when Employee Management changed the person while the review was open
   * (a transfer, or the cycle's rules no longer include them) and HR has yet to
   * decide what happens to it. The review carries on unchanged until then.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare pendingChange: Record<string, any> | null;

  /** EMPLOYEE_EXITED | REMOVED_FROM_CYCLE: why an open review was closed. Nothing is deleted. */
  @Column({ type: DataType.STRING(30), allowNull: true })
  declare closedReason: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare closedAt: Date | null;

  /** True when more than one person evaluates it (see ReviewEvaluator): its rating is then their evaluations put together. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare multiReviewer: boolean;

  /**
   * Employees HR has let read this review although they would not otherwise
   * (a manager newly assigned to the person does not see earlier confidential
   * reviews on their own).
   */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare accessGrantedTo: string[];
}
