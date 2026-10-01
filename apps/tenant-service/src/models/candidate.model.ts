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
  HasMany,
} from 'sequelize-typescript';
import { CandidateSource, CandidateStage } from '@app/common';
import { Employee } from './employee.model';
import { JobOpening } from './job-opening.model';
import { Interview } from './interview.model';

/** One entry in a candidate's stage history. */
export interface CandidateStageHistoryEntry {
  stage: CandidateStage;
  at: string;
  byUserId: string | null;
  note: string | null;
}

/**
 * An application against a job requisition — the cards in the Candidate
 * Pipeline, the rows behind "Total Applications", and the input to both the
 * Application Sources donut and the Recruitment Pipeline funnel.
 *
 * Two fields exist purely to keep the funnel chart honest:
 *
 * `stage` is where the candidate is *now*, and is what the kanban columns
 * group by. `furthestStageRank` is how far they ever got, and never decreases
 * — a candidate rejected at the interview round leaves the Interview column
 * (stage becomes REJECTED) but still counts toward "reached Interview" in the
 * funnel. Deriving the funnel from `stage` alone would make every rejection
 * silently shrink the upper funnel, so conversion rates would climb as
 * candidates were turned down.
 *
 * `stageHistory` keeps the audit trail of moves. The Recent Activities feed
 * reads from RecruitmentActivity rather than this column, because that feed
 * mixes in interview and requisition events this array could never hold.
 */
@Table({
  tableName: 'candidates',
  timestamps: true,
  indexes: [
    // (jobOpeningId, stage) is composite because the pipeline board filters
    // on both together, and it still serves a per-requisition application
    // count as a leading-column prefix.
    { fields: ['jobOpeningId', 'stage'], name: 'candidate_job_stage_idx' },
    { fields: ['stage'], name: 'candidate_stage_idx' },
    // The funnel chart counts candidates at or past each rank.
    { fields: ['furthestStageRank'], name: 'candidate_furthest_rank_idx' },
    // The Application Sources donut groups by this.
    { fields: ['source'], name: 'candidate_source_idx' },
    { fields: ['appliedAt'], name: 'candidate_applied_at_idx' },
    // One person cannot hold two live applications for the same requisition.
    {
      fields: ['tenantId', 'jobOpeningId', 'email'],
      name: 'candidate_job_email_unique',
      unique: true,
    },
  ],
})
export class Candidate extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare firstName: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare lastName: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare phone: string | null;

  @ForeignKey(() => JobOpening)
  @Column({ type: DataType.UUID, allowNull: false })
  declare jobOpeningId: string;

  @BelongsTo(() => JobOpening, 'jobOpeningId')
  declare jobOpening: JobOpening;

  @Column({
    type: DataType.ENUM(...Object.values(CandidateSource)),
    allowNull: false,
    defaultValue: CandidateSource.OTHER,
  })
  declare source: CandidateSource;

  @Column({
    type: DataType.ENUM(...Object.values(CandidateStage)),
    allowNull: false,
    defaultValue: CandidateStage.APPLIED,
  })
  declare stage: CandidateStage;

  /**
   * Highest funnel rank ever reached (0 = APPLIED ... 4 = HIRED). Monotonic:
   * only ever raised, never lowered, including on rejection. See the class
   * comment for why the funnel cannot be computed without it.
   */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare furthestStageRank: number;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare stageHistory: CandidateStageHistoryEntry[] | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare resumeUrl: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare linkedInUrl: string | null;

  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  declare expectedSalary: string | null;

  @Column({ type: DataType.DECIMAL(4, 1), allowNull: true })
  declare yearsOfExperience: string | null;

  /** Aggregate evaluation score out of 5, set from interview feedback. */
  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare rating: string | null;

  /** DATEONLY: an application is dated, and the donut filters by day. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare appliedAt: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true })
  declare referredByEmployeeId: string | null;

  @BelongsTo(() => Employee, 'referredByEmployeeId')
  declare referredBy: Employee;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;

  @HasMany(() => Interview, 'candidateId')
  declare interviews: Interview[];
}
