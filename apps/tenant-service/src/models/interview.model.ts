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
import { InterviewMode, InterviewOutcome, InterviewStatus } from '@app/common';
import { Employee } from './employee.model';
import { Candidate } from './candidate.model';

/**
 * A scheduled interview — the Upcoming Interviews panel and the "Interviews
 * Scheduled" KPI.
 *
 * `scheduledAt` is a timestamptz, not a DATEONLY like most other dates in
 * this schema: the panel renders a wall-clock range ("10:00 AM - 11:00 AM")
 * and an interview at 9am in Karachi is not the same instant as 9am in
 * London. Storing the duration rather than an explicit end time keeps the
 * two from disagreeing when an interview is rescheduled.
 *
 * `jobOpeningId` is denormalized from the candidate so the Upcoming
 * Interviews panel can show the position without a second join, and so
 * filtering interviews by requisition stays a single indexed predicate. It is
 * written from the candidate at schedule time and never diverges, because a
 * candidate cannot be moved between requisitions.
 */
@Table({
  tableName: 'interviews',
  timestamps: true,
  indexes: [
    // The Upcoming Interviews panel filters on status and orders by time, so
    // the composite serves both halves of that query.
    {
      fields: ['status', 'scheduledAt'],
      name: 'interview_status_scheduled_at_idx',
    },
    { fields: ['candidateId'], name: 'interview_candidate_idx' },
    { fields: ['jobOpeningId'], name: 'interview_job_opening_idx' },
    { fields: ['interviewerEmployeeId'], name: 'interview_interviewer_idx' },
  ],
})
export class Interview extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Candidate)
  @Column({ type: DataType.UUID, allowNull: false })
  declare candidateId: string;

  @BelongsTo(() => Candidate, 'candidateId')
  declare candidate: Candidate;

  /** Denormalized from the candidate — see the class comment. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare jobOpeningId: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare scheduledAt: Date;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 60 })
  declare durationMinutes: number;

  @Column({
    type: DataType.ENUM(...Object.values(InterviewMode)),
    allowNull: false,
    defaultValue: InterviewMode.ONLINE,
  })
  declare mode: InterviewMode;

  @Column({
    type: DataType.ENUM(...Object.values(InterviewStatus)),
    allowNull: false,
    defaultValue: InterviewStatus.SCHEDULED,
  })
  declare status: InterviewStatus;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare round: number;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true })
  declare interviewerEmployeeId: string | null;

  @BelongsTo(() => Employee, 'interviewerEmployeeId')
  declare interviewer: Employee;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare meetingLink: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare location: string | null;

  @Column({
    type: DataType.ENUM(...Object.values(InterviewOutcome)),
    allowNull: false,
    defaultValue: InterviewOutcome.PENDING,
  })
  declare outcome: InterviewOutcome;

  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare rating: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare feedback: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;

  /** Set when status leaves SCHEDULED, for cycle-time reporting. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare cancellationReason: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare scheduledByUserId: string | null;
}
