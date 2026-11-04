import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { TrainingRecommendationStatus } from '@app/common';
import { Employee } from './employee.model';
import { TrainingCourse } from './training-course.model';

/**
 * A suggestion that someone take a course, usually from a performance review.
 * It changes nothing until HR assigns it, which makes an ordinary assignment
 * (`assignmentId`), or dismisses it. The course title and review cycle are
 * kept as they were, so the record still reads right if either changes.
 */
@Table({
  tableName: 'training_recommendations',
  timestamps: true,
  indexes: [
    { fields: ['employeeId'], name: 'training_recommendation_employee_idx' },
    { fields: ['status'], name: 'training_recommendation_status_idx' },
    {
      unique: true,
      fields: ['courseId', 'employeeId'],
      where: { status: 'PENDING' },
      name: 'unique_pending_training_recommendation',
    },
  ],
})
export class TrainingRecommendation extends Model {
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

  @ForeignKey(() => TrainingCourse)
  @Column({ type: DataType.UUID, allowNull: false })
  declare courseId: string;

  @BelongsTo(() => TrainingCourse, 'courseId')
  declare course: TrainingCourse;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare courseTitle: string;

  /** The performance review it came from, if any. Not a foreign key: reviews can be deleted. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare reviewId: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare reviewCycle: string | null;

  @Column({ type: DataType.STRING(500), allowNull: false })
  declare reason: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: TrainingRecommendationStatus.PENDING })
  declare status: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare recommendedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare recommendedByEmail: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare decidedByUserId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare decidedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare dismissReason: string | null;

  /** The assignment it became. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare assignmentId: string | null;
}
