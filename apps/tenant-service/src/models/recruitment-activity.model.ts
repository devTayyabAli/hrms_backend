import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';
import { RecruitmentActivityType } from '@app/common';

/**
 * Append-only feed backing the Recent Activities panel ("New application
 * received", "Candidate moved to interview", "Offer accepted").
 *
 * A dedicated table rather than a derivation for two reasons. The panel mixes
 * candidate, interview and requisition events, so no single entity's history
 * column could produce it — assembling the feed would mean reading and
 * merge-sorting three tables on every dashboard load. And the rendered
 * sentence has to survive the thing it describes: an entry stays readable
 * after the candidate is deleted, which a join could not manage.
 *
 * `title` and `description` are therefore snapshots, written once at the
 * moment of the event and never recomputed. The id columns are nullable, not
 * foreign keys, precisely so a delete upstream cannot cascade this history
 * away or block the delete.
 */
@Table({
  tableName: 'recruitment_activities',
  timestamps: true,
  // Entries are immutable once written; there is nothing for updatedAt to
  // record, and the feed only ever orders by when the event happened.
  updatedAt: false,
  indexes: [
    // The feed is "latest N", optionally narrowed to one type.
    { fields: ['createdAt'], name: 'recruitment_activity_created_at_idx' },
    { fields: ['type'], name: 'recruitment_activity_type_idx' },
    { fields: ['candidateId'], name: 'recruitment_activity_candidate_idx' },
  ],
})
export class RecruitmentActivity extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({
    type: DataType.ENUM(...Object.values(RecruitmentActivityType)),
    allowNull: false,
  })
  declare type: RecruitmentActivityType;

  /** Headline, e.g. "New application received". Snapshot — see class comment. */
  @Column({ type: DataType.STRING(255), allowNull: false })
  declare title: string;

  /** Detail line, e.g. "Sarah Khan applied for Frontend Developer". */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare candidateId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare jobOpeningId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare interviewId: string | null;

  /** Acting admin, for "who did this" attribution on the feed row. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare actorUserId: string | null;

  /** Event-specific extras (previous stage, new stage, reason, ...). */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;
}
