/**
 * The change history shown in an employee's Performance Profile: what happened
 * to their goals, KPIs and evaluations, in words, newest first. It is read from
 * the audit log the performance services already write; nothing is stored here.
 *
 * Pure: it takes audit rows and what is needed to name them, and decides what
 * each reader may see.
 *  - STAFF (HR, a manager, a department head) get everything about the reviews
 *    they may open: the same rule that lets them open the review decides it.
 *  - The EMPLOYEE gets only what was shared with them: their own self-assessment,
 *    the moment a result was published to them, and changes to goals that were
 *    published to them or that they made themselves. Draft evaluations, KPI
 *    scores, reviewers, HR's notes and who made a change are never shown.
 */

export type HistoryAbout = 'REVIEW' | 'GOAL' | 'KPI';
export type HistoryAudience = 'STAFF' | 'EMPLOYEE';

export interface HistoryChange {
  field: string;
  label: string;
  from: unknown;
  to: unknown;
}

export interface HistoryEntry {
  at: Date | string;
  about: HistoryAbout;
  recordId: string;
  /** What it was about: the cycle, or the goal's or KPI's title. */
  subject: string | null;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  /** The code of a named event (a transfer, a manager change…), when there is one. */
  event: string | null;
  title: string;
  changes: HistoryChange[];
  /** Who did it (staff only). */
  by: string | null;
}

export interface AuditRow {
  createdAt: Date | string;
  tableName: string;
  recordId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  changes?: Record<string, { from: unknown; to: unknown }> | null;
}

export interface HistoryContext {
  audience: HistoryAudience;
  /** The reviews the reader may see, by id. */
  reviews: Map<string, { cycle: string }>;
  kpis: Map<string, { reviewId: string; title: string }>;
  goals: Map<string, { title: string; cycleId: string | null; publishedAt: Date | string | null }>;
  /** Names for the ids that appear in a `reviewerId` change. */
  people: Map<string, string>;
}

export const HISTORY_TABLES = {
  STAFF: ['review_kpis', 'performance_goals', 'performance_reviews'],
  EMPLOYEE: ['performance_goals', 'performance_reviews'],
} as const;

/** What the employee may read of a review's history, and of a goal's. */
const EMPLOYEE_REVIEW_FIELDS = new Set(['published', 'selfAssessment']);
const EMPLOYEE_GOAL_FIELDS = new Set(['title', 'progress', 'status', 'dueDate', 'category']);
/** Not changes to show: who did it, and where it belongs. */
const BOOKKEEPING = new Set(['actor', 'reviewId', 'event']);

const EVENT_TITLES: Record<string, string> = {
  REVIEW_ENROLLED_IN_CYCLE: 'Added to the review cycle',
  REVIEW_CONSOLIDATED: 'Evaluations combined into the final rating',
  REVIEW_CLOSED_EMPLOYEE_EXITED: 'Review closed: the employee left',
  REVIEW_REOPENED: 'Review reopened',
  REVIEW_ACCESS_CHANGED: 'Who may read this review changed',
  REVIEWERS_SET: 'Evaluators set',
  REVIEWERS_CLEARED: 'Evaluators cleared',
  REVIEWER_LEFT_REASSIGNED: 'Reviewer left; the review moved on',
  EVALUATOR_LEFT_SHARE_TO_LEAD: 'An evaluator left; their share went to the lead',
  ROLES_ADDED_TO_PLAN: 'KPIs added for additional roles',
  PLAN_PUBLISHED: 'Goals and KPIs published',
  PLAN_UNPUBLISHED: 'Goals and KPIs taken back',
  TRANSFER_DETECTED: 'Transferred while the review was open',
  MANAGER_CHANGE_DETECTED: 'Reporting manager changed while the review was open',
  MANAGER_CHANGE_RESOLVED: 'Manager change settled',
  ELIGIBILITY_CHANGED: 'No longer fits the cycle',
  ELIGIBILITY_RESTORED: 'Fits the cycle again',
  ELIGIBILITY_OVERRIDDEN: 'Included in the cycle by HR',
  EMPLOYEE_INFO_CHANGED: 'Employment details changed',
  CHANGE_DECISION_KEEP: 'HR kept the review as it was',
  CHANGE_DECISION_REASSIGN: 'HR gave the review to another reviewer',
  CHANGE_DECISION_RESTART: 'HR restarted the review on the new KPIs',
  CHANGE_DECISION_REMOVE: 'HR took them out of the cycle',
};

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  weight: 'Weight',
  target: 'Target',
  unit: 'Unit',
  actual: 'Actual',
  score: 'Score',
  comment: 'Comment',
  progress: 'Progress',
  status: 'Status',
  dueDate: 'Due date',
  category: 'Category',
  rating: 'Rating',
  reviewerId: 'Reviewer',
  reviewerComments: 'Reviewer comments',
  professionalism: 'Professionalism',
  communication: 'Communication',
  qualityOfWork: 'Quality of work',
  teamwork: 'Teamwork',
  leadership: 'Leadership',
  published: 'Published to the employee',
  selfAssessment: 'Self-assessment',
  employmentType: 'Employment type',
  probationEndDate: 'Probation ends',
  contractEndDate: 'Contract ends',
  department: 'Department',
  designation: 'Designation',
  note: 'Note',
  reason: 'Reason',
};

const labelOf = (field: string) => FIELD_LABELS[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());

/** The ids that need a name: those inside a `reviewerId` change. */
export const personIdsIn = (rows: readonly AuditRow[]): string[] => {
  const ids = new Set<string>();
  for (const row of rows) {
    const change = row.changes?.reviewerId;
    for (const value of [change?.from, change?.to]) if (typeof value === 'string' && value) ids.add(value);
  }
  return [...ids];
};

const asTime = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : 0);

const titleFor = (about: HistoryAbout, action: AuditRow['action'], event: string | null, fields: string[], changes: Record<string, { from: unknown; to: unknown }>): string => {
  if (event && EVENT_TITLES[event]) return EVENT_TITLES[event];
  if (about === 'GOAL') {
    if (action === 'CREATE') return 'Goal added';
    if (action === 'DELETE') return 'Goal removed';
    return fields.every((field) => field === 'progress' || field === 'status') ? 'Goal progress updated' : 'Goal changed';
  }
  if (about === 'KPI') {
    if (action === 'CREATE') return 'KPI added';
    if (action === 'DELETE') return 'KPI removed';
    return fields.some((field) => ['score', 'actual', 'comment'].includes(field)) ? 'KPI scored' : 'KPI changed';
  }
  if (action === 'CREATE') return 'Review started';
  if (fields.includes('published')) return changes.published?.to === true ? 'Result published' : 'Result taken back';
  if (fields.includes('selfAssessment')) return 'Self-assessment submitted';
  if (fields.includes('reviewerId')) return 'Reviewer changed';
  if (fields.some((field) => ['rating', 'status', 'reviewerComments', 'professionalism', 'communication', 'qualityOfWork', 'teamwork', 'leadership'].includes(field))) return 'Evaluation updated';
  return 'Review updated';
};

/** Audit rows as history entries for one reader, newest first. */
export const buildHistory = (rows: readonly AuditRow[], context: HistoryContext, limit = 100): HistoryEntry[] => {
  const employee = context.audience === 'EMPLOYEE';
  const entries: HistoryEntry[] = [];

  for (const row of rows) {
    const raw = row.changes ?? {};
    const about: HistoryAbout = row.tableName === 'review_kpis' ? 'KPI' : row.tableName === 'performance_goals' ? 'GOAL' : 'REVIEW';
    const event = typeof raw.event?.to === 'string' ? (raw.event.to as string) : null;
    let fields = Object.keys(raw).filter((field) => !BOOKKEEPING.has(field));
    let subject: string | null = null;

    if (about === 'REVIEW') {
      const review = context.reviews.get(row.recordId);
      if (!review) continue;
      subject = review.cycle;
    } else if (about === 'KPI') {
      if (employee) continue;
      const kpi = context.kpis.get(row.recordId);
      const reviewId = (raw.reviewId?.to as string | undefined) ?? kpi?.reviewId;
      if (!reviewId || !context.reviews.has(reviewId)) continue;
      subject = kpi?.title ?? (raw.title?.from as string | null) ?? (raw.title?.to as string | null) ?? null;
    } else {
      const goal = context.goals.get(row.recordId);
      const reviewId = raw.reviewId?.to as string | undefined;
      // A goal that is not the reader's to see, and a removed goal of a review they cannot open, are left out.
      if (!goal && (employee || !reviewId || !context.reviews.has(reviewId))) continue;
      subject = goal?.title ?? (raw.title?.from as string | null) ?? (raw.title?.to as string | null) ?? null;
      // Before a cycle's goal was published to them, the employee did not know of it.
      if (employee && goal?.cycleId && (!goal.publishedAt || asTime(row.createdAt) < asTime(goal.publishedAt))) continue;
    }

    if (employee) {
      const allowed = about === 'REVIEW' ? EMPLOYEE_REVIEW_FIELDS : EMPLOYEE_GOAL_FIELDS;
      fields = fields.filter((field) => allowed.has(field));
      if (!fields.length) continue;
    }

    const changes: HistoryChange[] = fields.map((field) => {
      const change = raw[field] ?? { from: null, to: null };
      const name = (value: unknown) => (field === 'reviewerId' && typeof value === 'string' ? (context.people.get(value) ?? value) : value);
      return { field, label: labelOf(field), from: name(change.from), to: name(change.to) };
    });

    entries.push({
      at: row.createdAt,
      about,
      recordId: row.recordId,
      subject,
      action: row.action,
      // A named event is staff's business: the employee sees what changed for them, not why.
      event: employee ? null : event,
      title: titleFor(about, row.action, employee ? null : event, fields, raw),
      changes,
      by: employee ? null : ((raw.actor?.to as string | undefined) ?? null),
    });
  }

  return entries.sort((a, b) => asTime(b.at) - asTime(a.at)).slice(0, limit);
};
