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
import { TrainingCourse } from './training-course.model';

/**
 * One person's copy of a course: due when, mandatory or not, how far they got,
 * and when they finished. Also their training history — a completed assignment
 * stays for good, and taking a course again is a new assignment beside it.
 *
 * It keeps what was true at the time: the course's title, and the employee's
 * department, designation and manager when it was assigned. A transfer or a
 * renamed course later does not rewrite who was asked to learn what.
 *
 * `status` is NOT_STARTED, IN_PROGRESS, COMPLETED or CANCELLED. "Overdue" is
 * not stored: an open assignment whose due date has passed is overdue.
 * A person has one open assignment of a course at a time (the partial unique
 * index); neither foreign key cascades, so history is never lost to a delete.
 */
@Table({
  tableName: 'training_assignments',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['courseId', 'employeeId'],
      name: 'unique_open_training_assignment',
      where: { status: ['NOT_STARTED', 'IN_PROGRESS'] },
    },
    { fields: ['employeeId', 'status'], name: 'training_assignment_employee_idx' },
    { fields: ['courseId', 'status'], name: 'training_assignment_course_idx' },
    { fields: ['status', 'dueDate'], name: 'training_assignment_due_idx' },
    { fields: ['batchId'], name: 'training_assignment_batch_idx' },
  ],
})
export class TrainingAssignment extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => TrainingCourse)
  @Column({ type: DataType.UUID, allowNull: false })
  declare courseId: string;

  @BelongsTo(() => TrainingCourse, { foreignKey: 'courseId' })
  declare course: TrainingCourse;

  /** The course's title when it was assigned. */
  @Column({ type: DataType.STRING(200), allowNull: false })
  declare courseTitle: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId' })
  declare employee: Employee;

  /** The employee's department, designation and manager when it was assigned. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare departmentId: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare departmentName: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare designationTitle: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare reportingManagerId: string | null;

  /** DIRECT, DEPARTMENT, DESIGNATION or ONBOARDING: why they have it. */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'DIRECT' })
  declare source: string;

  /** The people assigned together in one action share this. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare batchId: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare mandatory: boolean;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare dueDate: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'NOT_STARTED' })
  declare status: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare completionNote: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare cancelledAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare cancelReason: string | null;

  /** Which "N days before" reminders have gone out, so each goes once. Cleared when the due date moves. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare remindersSent: number[] | null;

  /** The overdue notice has gone out. Cleared when the due date moves. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare overdueNoticeSent: boolean;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare assignedByUserId: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare assignedByEmail: string | null;
}
