import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

export interface PipTarget {
  id: string;
  title: string;
  description: string | null;
  successCriteria: string | null;
  dueDate: string | null;
  /** OPEN | MET | NOT_MET */
  status: string;
}

export interface PipCheckIn {
  id: string;
  date: string;
  note: string;
  /** ON_TRACK | AT_RISK | OFF_TRACK */
  progress: string;
  byEmail: string | null;
  at: string;
}

/**
 * A Performance Improvement Plan: why, what has to change by when, how it went
 * at each check-in, and how it ended. A manager proposes it and HR approves it
 * before the employee sees it; it is confidential until then. Targets and
 * check-ins are kept on the plan (a plan is read whole, and has few of them).
 * Plain ids: nothing here blocks other tables.
 */
@Table({
  tableName: 'performance_improvement_plans',
  timestamps: true,
  indexes: [
    { fields: ['tenantId', 'employeeId'], name: 'pip_employee_idx' },
    { fields: ['tenantId', 'status'], name: 'pip_status_idx' },
  ],
})
export class ImprovementPlan extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  /** The review it came out of, if any. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare reviewId: string | null;

  /** The manager who proposed it. Null when HR started it. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare proposedById: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare proposedByEmail: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare reason: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare startDate: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare endDate: string;

  /** PROPOSED | ACTIVE | CLOSED | REJECTED */
  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'PROPOSED' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare targets: PipTarget[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare checkIns: PipCheckIn[];

  /** Each time the end date moved: from, to, why, who. */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare extensions: Record<string, any>[];

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare approvedByEmail: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare approvedAt: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare rejectionReason: string | null;

  /** SUCCESSFUL | UNSUCCESSFUL | CANCELLED */
  @Column({ type: DataType.STRING(14), allowNull: true })
  declare outcome: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare outcomeNote: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare closedAt: Date | null;
}

/**
 * A development goal the employee works on, or a recommendation made to them
 * (often a course): what to grow, by when, and how far along. Unlike a PIP it is
 * supportive, so the employee sees it from the start and may add their own.
 */
@Table({
  tableName: 'development_items',
  timestamps: true,
  indexes: [{ fields: ['tenantId', 'employeeId', 'status'], name: 'development_item_employee_idx' }],
})
export class DevelopmentItem extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare reviewId: string | null;

  /** GOAL | RECOMMENDATION (until the employee accepts it, when it becomes a GOAL) */
  @Column({ type: DataType.STRING(14), allowNull: false, defaultValue: 'GOAL' })
  declare type: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare skill: string | null;

  /** A course in Learning that would help. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare courseId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare courseTitle: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare targetDate: string | null;

  /** OPEN | IN_PROGRESS | DONE | DROPPED | DISMISSED */
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'OPEN' })
  declare status: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare progress: number;

  /** MANAGER | HR | SELF */
  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'MANAGER' })
  declare source: string;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByEmail: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;
}

/**
 * An employee's acknowledgement of a published review or of their PIP: that
 * they have read it, whether they agree, and anything they want on record. It
 * never changes the rating or the plan; it is part of the history beside them.
 */
@Table({
  tableName: 'performance_acknowledgements',
  timestamps: true,
  indexes: [{ fields: ['kind', 'recordId', 'employeeId'], unique: true, name: 'performance_acknowledgement_unique_idx' }],
})
export class PerformanceAcknowledgement extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  /** REVIEW | PIP */
  @Column({ type: DataType.STRING(8), allowNull: false })
  declare kind: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare recordId: string;

  /** AGREE | DISAGREE | NOTED */
  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'NOTED' })
  declare agreement: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare comment: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare acknowledgedAt: Date;
}
