import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
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
}
