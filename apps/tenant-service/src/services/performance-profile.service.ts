import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, literal, where as sqlWhere } from 'sequelize';
import { DataScope, PerformanceReviewStatus, PipStatus, TenantErrorCode, TenantException } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformancePipService } from './performance-pip.service';
import { PerformanceDevelopmentService } from './performance-development.service';
import { HISTORY_TABLES, buildHistory, personIdsIn, type AuditRow, type HistoryAudience, type HistoryEntry } from './performance-history';

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const nameOf = (row?: { firstName?: string | null; lastName?: string | null } | null) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '');
const average = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null);
const daysFromToday = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/**
 * The Employee Performance Profile: one person's performance picture, gathered
 * from reviews, goals, KPIs, plans, development and acknowledgements, so the
 * employee profile can show it as one section.
 *
 * What a reader gets depends on who they are:
 *  - the employee: their own, but only what has been shared with them (published
 *    reviews, published goals and KPIs, plans once approved);
 *  - a manager or department head: people in their scope, with completed reviews
 *    only when they were involved at the time (the same confidentiality rule as
 *    the review screens), and plans only those they proposed;
 *  - HR (organization scope): everything, drafts and confidential plans included.
 * The change history follows the same rules (see performance-history.ts): staff
 * read what changed in the reviews they may open, the employee only what was
 * shared with them.
 * Nothing here is written; it only reads what the other services keep.
 */
@Injectable()
export class PerformanceProfileService {
  private readonly logger = new Logger(PerformanceProfileService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly dashboard?: PerformanceDashboardService,
    @Optional() private readonly pips?: PerformancePipService,
    @Optional() private readonly development?: PerformanceDevelopmentService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private organizationWide(): boolean {
    return !this.dataScope || this.dataScope.scope() === DataScope.ORGANIZATION;
  }

  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId } }) : null;
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  private async header(tenantId: string, employee: any) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const [department, designation, manager]: any[] = await Promise.all([
      employee.departmentId ? Department.findOne({ where: { id: employee.departmentId, tenantId }, attributes: ['id', 'name'] }) : null,
      employee.designationId ? Designation.findOne({ where: { id: employee.designationId, tenantId }, attributes: ['id', 'title'] }) : null,
      employee.reportingManagerId ? Employee.findOne({ where: { id: employee.reportingManagerId, tenantId }, attributes: ['id', 'firstName', 'lastName'] }) : null,
    ]);
    return {
      id: employee.id as string,
      name: nameOf(employee),
      employeeCode: (employee.employeeCode ?? null) as string | null,
      status: employee.status as string,
      department: department ? { id: department.id as string, name: department.name as string } : null,
      designation: designation ? { id: designation.id as string, title: designation.title as string } : null,
      reportingManager: manager ? { id: manager.id as string, name: nameOf(manager) } : null,
    };
  }

  private async reviewersById(tenantId: string, reviews: any[]) {
    const ids = [...new Set(reviews.map((review) => review.reviewerId).filter(Boolean))] as string[];
    if (!ids.length) return new Map<string, string>();
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'firstName', 'lastName'], raw: true })) as any[];
    return new Map(rows.map((row) => [row.id, nameOf(row)]));
  }

  private reviewRow(review: any, reviewers: Map<string, string>, acks: Map<string, any>, forEmployee: boolean) {
    const shown = forEmployee ? Boolean(review.publishedAt) : review.status === PerformanceReviewStatus.COMPLETED;
    return {
      id: review.id as string,
      cycle: review.cycle as string,
      status: review.status as string,
      reviewDate: day(review.reviewDate),
      published: Boolean(review.publishedAt),
      closed: Boolean(review.closedAt),
      closedReason: forEmployee ? null : ((review.closedReason ?? null) as string | null),
      reviewer: review.reviewerId ? (reviewers.get(review.reviewerId) ?? null) : null,
      multiReviewer: Boolean(review.multiReviewer),
      rating: shown ? num(review.rating) : null,
      department: (review.employeeSnapshot?.departmentName ?? null) as string | null,
      designation: (review.employeeSnapshot?.designationTitle ?? null) as string | null,
      managerThen: (review.employeeSnapshot?.reportingManagerName ?? null) as string | null,
      acknowledgement: acks.get(review.id) ?? null,
    };
  }

  private async acknowledgementsOf(tenantId: string, kind: 'REVIEW' | 'PIP', ids: string[]) {
    if (!ids.length) return new Map<string, any>();
    const Ack = await this.modelProvider.getPerformanceAcknowledgementModel(tenantId);
    const rows = (await Ack.findAll({ where: { tenantId, kind, recordId: { [Op.in]: ids } } })) as any[];
    return new Map(rows.map((row) => [row.recordId, { at: row.acknowledgedAt, agreement: row.agreement, comment: row.comment ?? null }]));
  }

  private goalRow(goal: any, forEmployee: boolean) {
    return {
      id: goal.id as string,
      title: goal.title as string,
      category: (goal.category ?? null) as string | null,
      progress: Number(goal.progress ?? 0),
      status: goal.status as string,
      dueDate: day(goal.dueDate),
      draft: !forEmployee && Boolean(goal.cycleId) && !goal.publishedAt,
    };
  }

  private kpiRow(kpi: any) {
    return {
      id: kpi.id as string,
      title: kpi.title as string,
      weight: Number(kpi.weight ?? 0),
      target: (kpi.target ?? null) as string | null,
      unit: (kpi.unit ?? null) as string | null,
      actual: kpi.actual === null || kpi.actual === undefined ? null : num(kpi.actual),
      score: kpi.score === null || kpi.score === undefined ? null : num(kpi.score),
      roleLabel: (kpi.roleLabel ?? null) as string | null,
      published: Boolean(kpi.publishedAt),
    };
  }

  /** The numbers at the top of the section. */
  private summarize(reviews: any[], goals: any[], plans: any[], development: { open: number }, pendingAck: number) {
    const rated = reviews.filter((review) => review.rating !== null).sort((a, b) => String(b.reviewDate ?? '').localeCompare(String(a.reviewDate ?? '')));
    const active = plans.find((plan) => plan.status === PipStatus.ACTIVE);
    return {
      latestRating: rated[0]?.rating ?? null,
      latestCycle: rated[0]?.cycle ?? null,
      averageRating: average(rated.map((review) => review.rating as number)),
      reviews: reviews.length,
      completedReviews: rated.length,
      openGoals: goals.filter((goal) => goal.status !== 'COMPLETED' && goal.status !== 'CANCELLED').length,
      activePip: Boolean(active),
      pipEndsInDays: active ? daysFromToday(active.endDate) : null,
      openDevelopmentItems: development.open,
      pendingAcknowledgements: pendingAck,
    };
  }

  /**
   * What changed in their goals, KPIs and evaluations, newest first. `reviews`
   * and `goals` are exactly the ones this reader may see: the history never
   * reaches past them.
   */
  private async history(tenantId: string, audience: HistoryAudience, reviews: any[], goals: any[]): Promise<HistoryEntry[]> {
    const staff = audience === 'STAFF';
    const reviewIds = reviews.map((review) => review.id as string);
    const goalIds = goals.map((goal) => goal.id as string);
    if (!reviewIds.length && !goalIds.length) return [];

    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const kpis = staff && reviewIds.length ? ((await Kpi.findAll({ where: { tenantId, reviewId: { [Op.in]: reviewIds } } as any, attributes: ['id', 'reviewId', 'title'], raw: true })) as unknown as { id: string; reviewId: string; title: string }[]) : [];

    const Log = await this.modelProvider.getEntityAuditLogModel(tenantId);
    // A KPI or goal that was removed is no longer a row, but its audit entry still names the review it belonged to.
    const where: any[] = [{ recordId: { [Op.in]: [...reviewIds, ...kpis.map((kpi) => kpi.id), ...goalIds] } }];
    if (staff && reviewIds.length) where.push(sqlWhere(literal(`"EntityAuditLog"."changes"->'reviewId'->>'to'`), { [Op.in]: reviewIds } as any));
    const found = (await Log.findAll({ where: { tableName: { [Op.in]: [...HISTORY_TABLES[audience]] }, [Op.or]: where } as any, order: [['createdAt', 'DESC']], limit: 300 })) as any[];
    const rows: AuditRow[] = found.map((row) => ({ createdAt: row.createdAt, tableName: row.tableName, recordId: row.recordId, action: row.action, changes: row.changes }));

    const personIds = staff ? personIdsIn(rows) : [];
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const people = personIds.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: personIds } }, attributes: ['id', 'firstName', 'lastName'], raw: true })) as any[]) : [];

    return buildHistory(rows, {
      audience,
      reviews: new Map(reviews.map((review) => [review.id as string, { cycle: review.cycle as string }])),
      kpis: new Map(kpis.map((kpi) => [kpi.id, { reviewId: kpi.reviewId, title: kpi.title }])),
      goals: new Map(goals.map((goal) => [goal.id as string, { title: goal.title as string, cycleId: (goal.cycleId ?? null) as string | null, publishedAt: (goal.publishedAt ?? null) as Date | null }])),
      people: new Map(people.map((row) => [row.id as string, nameOf(row)])),
    });
  }

  // ==========================================
  // For HR, managers and department heads
  // ==========================================

  async forEmployee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'Employee not found.');
    // Outside the caller's scope the person does not exist for them.
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, employee.id, 'Employee');
    const hr = this.organizationWide();

    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const reviewWhere = this.dashboard ? { [Op.and]: [{ tenantId, employeeId: employee.id }, await this.dashboard.reviewScope(tenantId)] } : { tenantId, employeeId: employee.id };
    const reviews = (await Review.findAll({ where: reviewWhere as any, order: [['createdAt', 'DESC']], limit: 100 })) as any[];
    const hiddenReviews = this.dashboard && !hr ? Math.max((await Review.count({ where: { tenantId, employeeId: employee.id } })) - reviews.length, 0) : 0;
    const reviewAcks = await this.acknowledgementsOf(tenantId, 'REVIEW', reviews.filter((review) => review.publishedAt).map((review) => review.id));
    const reviewers = await this.reviewersById(tenantId, reviews);
    const reviewRows = reviews.map((review) => this.reviewRow(review, reviewers, reviewAcks, false));

    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goalRecords = (await Goal.findAll({ where: { tenantId, employeeId: employee.id } as any, order: [['dueDate', 'ASC']], limit: 100 })) as any[];
    const goals = goalRecords.map((goal) => this.goalRow(goal, false));

    // The KPIs of the review that is still open.
    const open = reviews.find((review) => review.status !== PerformanceReviewStatus.COMPLETED && !review.closedAt);
    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const kpis = open ? ((await Kpi.findAll({ where: { tenantId, reviewId: open.id } as any, order: [['sortOrder', 'ASC']] })) as any[]).map((kpi) => this.kpiRow(kpi)) : [];

    // Plans: HR sees all; anyone narrower, only what they proposed.
    const plans = this.pips ? (((await this.pips.list(tenantId, { employeeId: employee.id })) as any).data as any[]) : [];
    const development = this.development ? await this.development.summaryFor(tenantId, employee.id) : { open: 0, done: 0, items: [] };

    const pendingChange = reviews.filter((review) => review.pendingChange && !review.closedAt).map((review) => ({ reviewId: review.id as string, change: review.pendingChange }));
    const pendingAck = reviewRows.filter((review) => review.published && !review.acknowledgement).length + plans.filter((plan) => [PipStatus.ACTIVE, PipStatus.CLOSED].includes(plan.status) && !plan.acknowledgement).length;

    return {
      employee: await this.header(tenantId, employee),
      access: { organizationWide: hr, hiddenReviews, plansShown: hr ? 'ALL' : 'PROPOSED_BY_YOU' },
      summary: this.summarize(reviewRows, goals, plans, development, pendingAck),
      reviews: reviewRows,
      currentReview: open ? { id: open.id as string, cycle: open.cycle as string, status: open.status as string, kpis } : null,
      goals,
      improvementPlans: plans,
      development: { open: development.open, done: development.done, items: development.items },
      pendingChanges: pendingChange,
      history: await this.history(tenantId, 'STAFF', reviews, goalRecords),
    };
  }

  // ==========================================
  // For the employee
  // ==========================================

  async mine(tenantId: string, userId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const all = (await Review.findAll({ where: { tenantId, employeeId: employee.id } as any, order: [['createdAt', 'DESC']], limit: 100 })) as any[];
    // Only what has been shared: published results, and open reviews as "in progress".
    const reviews = all.filter((review) => review.publishedAt || (review.status !== PerformanceReviewStatus.COMPLETED && !review.closedAt));
    const acks = await this.acknowledgementsOf(tenantId, 'REVIEW', reviews.filter((review) => review.publishedAt).map((review) => review.id));
    const reviewRows = reviews.map((review) => this.reviewRow(review, new Map(), acks, true));

    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goalRecords = (await Goal.findAll({ where: { tenantId, employeeId: employee.id, [Op.or]: [{ cycleId: null }, { publishedAt: { [Op.ne]: null } }] } as any, order: [['dueDate', 'ASC']], limit: 100 })) as any[];
    const goals = goalRecords.map((goal) => this.goalRow(goal, true));

    const open = all.find((review) => review.status !== PerformanceReviewStatus.COMPLETED && !review.closedAt);
    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const kpis = open ? ((await Kpi.findAll({ where: { tenantId, reviewId: open.id, publishedAt: { [Op.ne]: null } } as any, order: [['sortOrder', 'ASC']] })) as any[]).map((kpi) => this.kpiRow(kpi)) : [];

    const plans = this.pips ? (((await this.pips.myPlans(tenantId, userId, email)) as any).data as any[]) : [];
    const development = this.development ? await this.development.summaryFor(tenantId, employee.id) : { open: 0, done: 0, items: [] };
    const pendingAck = reviewRows.filter((review) => review.published && !review.acknowledgement).length + plans.filter((plan) => plan.canAcknowledge).length;

    return {
      employee: await this.header(tenantId, employee),
      summary: this.summarize(reviewRows, goals, plans, development, pendingAck),
      reviews: reviewRows,
      currentReview: open ? { id: open.id as string, cycle: open.cycle as string, status: open.status as string, kpis } : null,
      goals,
      improvementPlans: plans,
      development: { open: development.open, done: development.done, items: development.items },
      history: await this.history(tenantId, 'EMPLOYEE', reviews.filter((review) => review.publishedAt), goalRecords),
    };
  }

  // ==========================================
  // Counts for the performance dashboard
  // ==========================================

  /** What needs attention, limited to the people the caller may see. */
  async attention(tenantId: string) {
    const scope = this.dataScope ? await this.dataScope.employeeWhere(tenantId) : {};
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const plans = (await Plan.findAll({ where: { tenantId, status: { [Op.in]: [PipStatus.PROPOSED, PipStatus.ACTIVE] }, ...scope } as any, attributes: ['id', 'status', 'endDate', 'proposedById'], limit: 500 })) as any[];
    const me = this.organizationWide() || !this.dataScope ? null : await this.dataScope.actorEmployeeId(tenantId);
    // Confidential until approved: anyone narrower counts only the plans they proposed.
    const visible = this.organizationWide() ? plans : plans.filter((plan) => plan.proposedById && plan.proposedById === me);
    const active = visible.filter((plan) => plan.status === PipStatus.ACTIVE);

    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const awaiting = await Item.count({ where: { tenantId, type: 'RECOMMENDATION', status: 'OPEN', ...scope } as any });

    const Ack = await this.modelProvider.getPerformanceAcknowledgementModel(tenantId);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const published = (await Review.findAll({ where: { tenantId, publishedAt: { [Op.ne]: null }, ...scope } as any, attributes: ['id'], raw: true, limit: 2000 })) as unknown as { id: string }[];
    const acked = published.length ? ((await Ack.findAll({ where: { tenantId, kind: 'REVIEW', recordId: { [Op.in]: published.map((row) => row.id) } } as any, attributes: ['recordId', 'agreement'], raw: true })) as unknown as { recordId: string; agreement: string }[]) : [];

    return {
      pipsAwaitingApproval: visible.filter((plan) => plan.status === PipStatus.PROPOSED).length,
      activePips: active.length,
      pipsEndingSoon: active.filter((plan) => daysFromToday(day(plan.endDate) as string) <= 14).length,
      reviewsAwaitingAcknowledgement: published.length - acked.length,
      reviewDisagreements: acked.filter((row) => row.agreement === 'DISAGREE').length,
      recommendationsAwaitingEmployee: awaiting,
    };
  }
}
