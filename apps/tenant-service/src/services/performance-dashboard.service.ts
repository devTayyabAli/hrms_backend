import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, literal, where as sqlWhere } from 'sequelize';
import {
  CreatePerformanceGoalDto,
  CreatePerformanceReviewDto,
  DashboardLimitDto,
  DataScope,
  SetReviewAccessDto,
  EmployeeNotificationKind,
  EmployeeStatus,
  GetPerformanceTrendQueryDto,
  GetReviewEvidenceQueryDto,
  PerformanceGoalStatus,
  PerformanceReviewStatus,
  TenantException,
  TenantErrorCode,
  UpdatePerformanceGoalDto,
  UpdatePerformanceReviewDto,
  WorkspaceProjectStatus,
  WorkspaceTaskStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { grantsPermission } from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { buildReviewSnapshot } from './performance-snapshot';
import { KpiTemplateService } from './kpi-template.service';
import { involvedProjectIds, seesConfidentialProjects, todayIso } from './workspace-shared';

/** What a reader sees in place of a confidential project they have no access to. */
const CONFIDENTIAL_PROJECT = 'Confidential project';
const CONFIDENTIAL_TASK = 'Confidential task';

const METRIC_FIELDS = [
  { key: 'professionalism', label: 'Professionalism' },
  { key: 'communication', label: 'Communication' },
  { key: 'qualityOfWork', label: 'Quality of Work' },
  { key: 'teamwork', label: 'Teamwork' },
  { key: 'leadership', label: 'Leadership' },
] as const;

type MetricKey = (typeof METRIC_FIELDS)[number]['key'];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function monthWindow(count: number, now = new Date()) {
  const months: { key: string; label: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const label = date.toLocaleString('en-US', { month: 'short' });
    months.push({ key, label });
  }
  return months;
}

/**
 * Performance reviews and goals, plus the KPI, trend and ranking reads the
 * Performance screen is built from. A scoped role (Department Head, Team
 * Lead) sees and writes reviews and goals only for the people its data scope
 * reaches; every count and average on the screen is over those people.
 */
@Injectable()
export class PerformanceDashboardService {
  private readonly logger = new Logger(PerformanceDashboardService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly kpiTemplates?: KpiTemplateService,
  ) {}

  /** `{}` for organization-wide callers; otherwise limits `field` to visible employees. */
  private scopeWhere(tenantId: string, field = 'employeeId'): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, field) : Promise.resolve({});
  }

  private scope(): DataScope {
    return this.dataScope ? this.dataScope.scope() : DataScope.ORGANIZATION;
  }

  /**
   * Which reviews the caller may open. Organization-wide callers (HR) see them
   * all. Anyone narrower sees open reviews of the people in their scope, but a
   * completed (confidential) review only when they were its reviewer or the
   * person's manager when it was made, headed the person's department then, or
   * HR let them. So a manager newly assigned to someone does not inherit what
   * was written about them before. Reviews made before snapshots existed are
   * not narrowed further, because there is nothing to tell who they belonged to.
   */
  async reviewScope(tenantId: string): Promise<Record<string | symbol, unknown>> {
    const base = await this.scopeWhere(tenantId);
    if (!this.dataScope || this.scope() === DataScope.ORGANIZATION) return base;
    const me = await this.dataScope.actorEmployeeId(tenantId);
    if (!me) return base;

    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const headed = new Set<string>(((await Department.findAll({ where: { tenantId, managerId: me }, attributes: ['id'], raw: true })) as unknown as { id: string }[]).map((row) => row.id));
    for (let depth = 0; headed.size && depth < 10; depth++) {
      const subs = (await Department.findAll({ where: { tenantId, parentDepartmentId: { [Op.in]: [...headed] } }, attributes: ['id'], raw: true })) as unknown as { id: string }[];
      const before = headed.size;
      subs.forEach((row) => headed.add(row.id));
      if (headed.size === before) break;
    }
    const snapshot = (key: string) => literal(`"PerformanceReview"."employeeSnapshot"->>'${key}'`);
    const visible: any[] = [
      { status: { [Op.ne]: PerformanceReviewStatus.COMPLETED }, closedAt: null },
      { employeeSnapshot: null },
      { reviewerId: me },
      sqlWhere(snapshot('reportingManagerId'), me),
      { accessGrantedTo: { [Op.contains]: [me] } },
    ];
    if (headed.size) visible.push(sqlWhere(snapshot('departmentId'), { [Op.in]: [...headed] } as any));
    return { ...base, [Op.and]: [{ [Op.or]: visible }] };
  }

  /** Whether the caller may start something new for someone who no longer works here. */
  private canAuthorizeInactive(): boolean {
    const rpc = currentRpcActor();
    return !rpc || rpc.isFullAccess === true || grantsPermission(rpc.permissions ?? [], 'performance.manage');
  }

  /** Nothing new is assigned to someone who left, unless someone who manages performance says so. */
  private assertCanAssign(employee: any, authorizeInactive: boolean | undefined, what: string) {
    if ([EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE].includes(employee.status)) return;
    if (authorizeInactive === true && this.canAuthorizeInactive()) return;
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `This person no longer works here, so they are not given a new ${what}. ${authorizeInactive ? 'Only someone who manages performance can authorize it.' : 'Someone who manages performance can authorize it.'}`,
      HttpStatus.CONFLICT,
    );
  }

  private notFound(what: string, id: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `${what} '${id}' not found in this organization.`,
      HttpStatus.NOT_FOUND,
    );
  }

  private limitOf(limit?: number): number {
    return Math.min(Math.max(limit ?? 10, 1), 100);
  }

  private metricAverage(dto: Partial<Record<MetricKey, number>>): number | null {
    const scores = METRIC_FIELDS.map((field) => dto[field.key]).filter(
      (score): score is number => score !== undefined && score !== null,
    );
    return average(scores);
  }

  /** The employee must exist and be inside the caller's data scope; outside it, they don't exist for the caller. */
  private async assertEmployee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) this.notFound('Employee', employeeId);
    if (this.dataScope && !(await this.dataScope.canSee(tenantId, employeeId))) this.notFound('Employee', employeeId);
    return employee;
  }

  private async employeeInclude(tenantId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    return {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl'],
      include: [
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
        { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
      ],
    };
  }

  private person(employee: any) {
    if (!employee) return null;
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
      avatarUrl: employee.avatarUrl ?? null,
      department: employee.department
        ? { id: employee.department.id, name: employee.department.name }
        : null,
      designation: employee.designation
        ? { id: employee.designation.id, title: employee.designation.title }
        : null,
    };
  }

  /** A line in the employee's notifications. Best effort: what happened is already saved. */
  private async notifyEmployee(tenantId: string, employeeId: string, title: string, body: string): Promise<void> {
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.PERFORMANCE, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`Performance notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  /** The people behind the reviewers on these reviews, by id. */
  private async reviewersOf(tenantId: string, reviews: any[]): Promise<Map<string, any>> {
    const ids = [...new Set(reviews.map((review) => review.reviewerId).filter(Boolean))] as string[];
    if (!ids.length) return new Map();
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'firstName', 'lastName'], raw: true })) as any[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Who should complete a review of this employee when nobody was picked: their reporting manager, if still employed. */
  private async managerOf(tenantId: string, employee: any): Promise<string | null> {
    if (!employee?.reportingManagerId) return null;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const manager: any = await Employee.findOne({ where: { id: employee.reportingManagerId, tenantId }, attributes: ['id', 'status'] });
    return manager && [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE].includes(manager.status) ? manager.id : null;
  }

  /** A person who may be picked to review: on the books, and not the one being reviewed. */
  private async assertReviewer(tenantId: string, reviewerId: string, employeeId: string) {
    if (reviewerId === employeeId) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Someone cannot review themselves.', HttpStatus.BAD_REQUEST);
    }
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const reviewer: any = await Employee.findOne({ where: { id: reviewerId, tenantId }, attributes: ['id', 'status'] });
    if (!reviewer || ![EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE].includes(reviewer.status)) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'The reviewer was not found, or no longer works here.', HttpStatus.BAD_REQUEST);
    }
  }

  private async tellReviewer(tenantId: string, reviewerId: string | null | undefined, employee: any, cycle: string) {
    if (!reviewerId) return;
    const name = [employee?.firstName, employee?.lastName].filter(Boolean).join(' ') || 'an employee';
    await this.notifyEmployee(tenantId, reviewerId, `Review to complete: ${name}`, `You are the reviewer for ${name}'s ${cycle} performance review. Open My Performance, Reviewing, to complete it.`);
  }

  private reviewRow(review: any, reviewers?: Map<string, any>) {
    const reviewer = review.reviewerId ? reviewers?.get(review.reviewerId) : null;
    const metrics = {} as Record<MetricKey, number | null>;
    for (const field of METRIC_FIELDS) {
      metrics[field.key] = asNumber(review[field.key]);
    }
    return {
      id: review.id,
      cycle: review.cycle,
      status: review.status,
      rating: asNumber(review.rating),
      reviewDate: review.reviewDate ?? null,
      metrics,
      reviewerComments: review.reviewerComments ?? null,
      published: Boolean(review.publishedAt),
      publishedAt: review.publishedAt ?? null,
      publishedBy: review.publishedByEmail ?? null,
      selfAssessment: review.selfAssessment ?? null,
      reviewer: reviewer ? { id: reviewer.id, name: [reviewer.firstName, reviewer.lastName].filter(Boolean).join(' ') } : null,
      reviewerSetBy: review.reviewerPinned ? 'HR' : 'REPORTING_MANAGER',
      /** The person's department, designation, manager and reviewer when the review was made. */
      cycleId: review.cycleId ?? null,
      planStatus: review.planPublishedAt ? 'PUBLISHED' : 'DRAFT',
      kpiScore: asNumber(review.kpiScore),
      /** Set when the person changed and HR has yet to decide what happens to this review. */
      pendingChange: review.pendingChange ?? null,
      closed: review.closedAt ? { reason: review.closedReason ?? null, at: review.closedAt } : null,
      snapshot: review.employeeSnapshot ?? null,
      accessGrantedTo: Array.isArray(review.accessGrantedTo) ? review.accessGrantedTo : [],
      employee: this.person(review.employee),
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    };
  }

  private goalRow(goal: any) {
    return {
      id: goal.id,
      title: goal.title,
      category: goal.category ?? null,
      progress: Number(goal.progress ?? 0),
      status: goal.status,
      dueDate: goal.dueDate ?? null,
      employee: this.person(goal.employee),
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    };
  }

  /**
   * KPI cards: Total Employees, Avg Rating, Completed Reviews, Pending Reviews.
   * Avg Rating is the mean of completed reviews only, matching the trend chart.
   */
  async getOverview(tenantId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const today = new Date().toISOString().slice(0, 10);
    // The same people for every card, so "Total Employees" is the group the
    // review and goal counts are over.
    const scope = await this.scopeWhere(tenantId);
    const employeeScope = await this.scopeWhere(tenantId, 'id');

    const [
      totalEmployees,
      completedReviews,
      pendingReviews,
      goalCount,
      completedGoals,
      goalsInProgress,
      goalsOverdue,
      ratings,
    ] = await Promise.all([
      Employee.count({ where: { tenantId, ...employeeScope } }),
      Review.count({ where: { tenantId, status: PerformanceReviewStatus.COMPLETED, ...scope } }),
      Review.count({
        where: { tenantId, status: { [Op.ne]: PerformanceReviewStatus.COMPLETED }, ...scope },
      }),
      Goal.count({ where: { tenantId, ...scope } }),
      Goal.count({ where: { tenantId, status: PerformanceGoalStatus.COMPLETED, ...scope } }),
      Goal.count({ where: { tenantId, status: PerformanceGoalStatus.IN_PROGRESS, ...scope } }),
      /**
       * Overdue is derived, not stored: a goal is overdue when its due date
       * has passed and it is not finished. Storing it would need a nightly
       * job to flip the flag and would be wrong for the hours in between.
       * NOT_STARTED counts too — a goal nobody began is the most overdue.
       */
      Goal.count({
        where: {
          tenantId,
          dueDate: { [Op.ne]: null, [Op.lt]: today },
          status: { [Op.ne]: PerformanceGoalStatus.COMPLETED },
          ...scope,
        },
      }),
      Review.findAll({
        where: { tenantId, status: PerformanceReviewStatus.COMPLETED, rating: { [Op.ne]: null }, ...scope },
        attributes: ['rating'],
        raw: true,
      }),
    ]);

    const scored = ratings
      .map((row: any) => asNumber(row.rating))
      .filter((value): value is number => value !== null);

    return {
      totalEmployees,
      averageRating: average(scored) ?? 0,
      completedReviews,
      pendingReviews,
      totalGoals: goalCount,
      completedGoals,
      goalsInProgress,
      goalsOverdue,
      goalsNotStarted: Math.max(0, goalCount - completedGoals - goalsInProgress),
    };
  }

  /** Performance Trend line — one point per month, missing months stay at zero. */
  async getTrend(tenantId: string, query: GetPerformanceTrendQueryDto = {}) {
    const months = query.months ?? 6;
    const window = monthWindow(months);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const scope = await this.scopeWhere(tenantId);
    const rows = await Review.findAll({
      where: {
        tenantId,
        status: PerformanceReviewStatus.COMPLETED,
        reviewDate: { [Op.ne]: null },
        rating: { [Op.ne]: null },
        ...scope,
      },
      attributes: ['reviewDate', 'rating'],
      raw: true,
    });

    const buckets = new Map<string, number[]>();
    for (const row of rows as any[]) {
      const key = String(row.reviewDate).slice(0, 7);
      const rating = asNumber(row.rating);
      if (rating === null) continue;
      const list = buckets.get(key) ?? [];
      list.push(rating);
      buckets.set(key, list);
    }

    // The chart plots two series. Goals achieved is counted on the goal's due
    // date — the month the work was due is the month it counts for, which is
    // what "achieved in September" means on a trend line.
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goalRows = (await Goal.findAll({
      where: {
        tenantId,
        status: PerformanceGoalStatus.COMPLETED,
        dueDate: { [Op.ne]: null },
        ...scope,
      },
      attributes: ['dueDate'],
      raw: true,
    })) as unknown as { dueDate: string }[];

    const goalsByMonth = new Map<string, number>();
    for (const row of goalRows) {
      const key = String(row.dueDate).slice(0, 7);
      goalsByMonth.set(key, (goalsByMonth.get(key) ?? 0) + 1);
    }

    return {
      months,
      points: window.map((month) => {
        const ratings = buckets.get(month.key) ?? [];
        return {
          period: month.key,
          label: month.label,
          averageRating: average(ratings) ?? 0,
          reviewCount: ratings.length,
          goalsAchieved: goalsByMonth.get(month.key) ?? 0,
        };
      }),
    };
  }

  /**
   * Performance by Department — the horizontal bars.
   *
   * Scored on completed reviews only, like every other chart on this screen,
   * and expressed as a percentage of the 5-point scale so the bars are
   * comparable regardless of how many people each department reviewed.
   */
  async getByDepartment(tenantId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const [departments, reviews] = await Promise.all([
      Department.findAll({ where: { tenantId }, order: [['name', 'ASC']] }),
      Review.findAll({
        where: {
          tenantId,
          status: PerformanceReviewStatus.COMPLETED,
          rating: { [Op.ne]: null },
          ...(await this.scopeWhere(tenantId)),
        },
        include: [
          {
            model: Employee,
            as: 'employee',
            attributes: ['id', 'departmentId'],
            required: true,
          },
        ],
      }),
    ]);

    const byDepartment = new Map<string, number[]>();
    for (const review of reviews as any[]) {
      const departmentId = review.employee?.departmentId;
      if (!departmentId) continue;
      const list = byDepartment.get(departmentId) ?? [];
      list.push(asNumber(review.rating) ?? 0);
      byDepartment.set(departmentId, list);
    }

    // A scoped caller gets only the departments their people sit in; the
    // rest of the organization isn't theirs to compare against.
    const visibleDepartments = this.scope() === DataScope.ORGANIZATION
      ? (departments as any[])
      : (departments as any[]).filter((department) => byDepartment.has(department.id));

    const rows = visibleDepartments.map((department) => {
      const scores = byDepartment.get(department.id) ?? [];
      const averageRating = average(scores) ?? 0;
      return {
        departmentId: department.id,
        department: department.name,
        averageRating,
        // The bar's fill, on the same 5-point scale getMetrics uses.
        score: Math.round((averageRating / 5) * 1000) / 10,
        reviewCount: scores.length,
      };
    });

    return {
      maxScore: 5,
      // Highest first, which is how the chart reads top to bottom.
      rows: rows.sort((a, b) => b.score - a.score || a.department.localeCompare(b.department)),
      unscored: rows.filter((row) => row.reviewCount === 0).length,
    };
  }

  /** Horizontal bars: Professionalism, Communication, Quality of Work, Teamwork, Leadership. */
  async getMetrics(tenantId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows = (await Review.findAll({
      where: { tenantId, status: PerformanceReviewStatus.COMPLETED, ...(await this.reviewScope(tenantId)) },
      attributes: METRIC_FIELDS.map((field) => field.key),
      raw: true,
    })) as unknown as Record<MetricKey, string | null>[];

    return {
      maxScore: 5,
      metrics: METRIC_FIELDS.map((field) => {
        const scores = rows
          .map((row) => asNumber(row[field.key]))
          .filter((value): value is number => value !== null);
        return {
          key: field.key,
          label: field.label,
          average: average(scores) ?? 0,
          reviewCount: scores.length,
        };
      }),
    };
  }

  /** Top Performers table, ranked by average completed rating. */
  async getTopPerformers(tenantId: string, query: DashboardLimitDto = {}) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows = await Review.findAll({
      where: {
        tenantId,
        status: PerformanceReviewStatus.COMPLETED,
        rating: { [Op.ne]: null },
        ...(await this.reviewScope(tenantId)),
      },
      include: [await this.employeeInclude(tenantId)],
      order: [['reviewDate', 'DESC'], ['createdAt', 'DESC']],
    });

    const grouped = new Map<
      string,
      { ratings: number[]; latest: any }
    >();
    for (const review of rows) {
      const rating = asNumber(review.rating);
      if (rating === null || !review.employeeId) continue;
      const current = grouped.get(review.employeeId) ?? { ratings: [], latest: review };
      current.ratings.push(rating);
      grouped.set(review.employeeId, current);
    }

    const ranked = [...grouped.values()]
      .map((entry) => {
        const employee = this.person(entry.latest.employee);
        if (!employee) return null;
        return {
          ...employee,
          averageRating: average(entry.ratings) ?? 0,
          latestRating: asNumber(entry.latest.rating) ?? 0,
          reviewsCompleted: entry.ratings.length,
          latestReview: {
            id: entry.latest.id,
            cycle: entry.latest.cycle,
            status: entry.latest.status,
            reviewDate: entry.latest.reviewDate ?? null,
          },
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.averageRating - a.averageRating || a.name.localeCompare(b.name));

    const limit = this.limitOf(query.limit);
    return { rows: ranked.slice(0, limit), total: ranked.length };
  }

  async getReviews(tenantId: string, query: DashboardLimitDto = {}) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows = await Review.findAll({
      where: { tenantId, ...(await this.reviewScope(tenantId)) },
      include: [await this.employeeInclude(tenantId)],
      order: [['reviewDate', 'DESC'], ['createdAt', 'DESC']],
      limit: this.limitOf(query.limit),
    });
    const reviewers = await this.reviewersOf(tenantId, rows as any[]);
    return rows.map((row) => this.reviewRow(row, reviewers));
  }

  async getReview(tenantId: string, reviewId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review = await Review.findOne({
      where: { id: reviewId, tenantId, ...(await this.reviewScope(tenantId)) },
      include: [await this.employeeInclude(tenantId)],
    });
    if (!review) this.notFound('Performance review', reviewId);
    return this.reviewRow(review, await this.reviewersOf(tenantId, [review]));
  }

  /**
   * Assigned projects, finished work, overdue work and notes from the
   * employee's manager or project owner, for the period asked about (the last
   * twelve months by default). Read only: it never writes a rating.
   *
   * A confidential project the reader may not see is still counted — the work
   * happened — but shows only as "Confidential project", with no task titles
   * and no comments, so a reviewer without the Confidential permission learns
   * how much work there was and nothing about what it was.
   */
  async getReviewEvidence(tenantId: string, reviewId: string, query: GetReviewEvidenceQueryDto = {}) {
    const period = this.evidencePeriod(query);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review = await Review.findOne({
      where: { id: reviewId, tenantId, ...(await this.reviewScope(tenantId)) },
      attributes: ['id', 'employeeId'],
    });
    if (!review) this.notFound('Performance review', reviewId);
    const employee = await this.assertEmployee(tenantId, review.employeeId);
    const evidence = await this.workEvidence(tenantId, employee.id, employee.reportingManagerId ?? null, period);
    return { reviewId: review.id, employeeId: employee.id, period, ...evidence };
  }

  /** `from` / `to` as given, otherwise the last twelve months ending today. */
  private evidencePeriod(query: GetReviewEvidenceQueryDto): { from: string; to: string } {
    const to = query.to ?? todayIso();
    const from = query.from ?? new Date(Date.parse(`${to}T00:00:00.000Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'The evidence period cannot start after it ends.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { from, to };
  }

  /** Confidential projects the reader is not allowed to see. Empty when they may see them all. */
  private async concealedProjectIds(tenantId: string): Promise<Set<string>> {
    if (seesConfidentialProjects()) return new Set();
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const confidential = (await Project.findAll({
      where: { tenantId, confidential: true },
      attributes: ['id'],
      raw: true,
    })) as unknown as { id: string }[];
    if (!confidential.length) return new Set();
    // Owner, member or assignee of one still sees it, as everywhere else.
    const me = await this.dataScope?.actorEmployeeId(tenantId);
    const mine = new Set(me ? await involvedProjectIds(this.modelProvider, tenantId, me) : []);
    return new Set(confidential.map((row) => row.id).filter((id) => !mine.has(id)));
  }

  private async workEvidence(
    tenantId: string,
    employeeId: string,
    managerId: string | null,
    period: { from: string; to: string },
  ) {
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const Comment = await this.modelProvider.getWorkspaceTaskCommentModel(tenantId);
    const concealed = await this.concealedProjectIds(tenantId);
    const isConcealed = (projectId: string | null | undefined) => Boolean(projectId && concealed.has(projectId));
    const dayOf = (value: unknown) => (value ? new Date(value as string | Date).toISOString().slice(0, 10) : '');
    const inPeriod = (day: string) => day !== '' && day >= period.from && day <= period.to;

    const extras = (await Assignee.findAll({
      where: { tenantId, employeeId },
      attributes: ['taskId'],
      raw: true,
    })) as unknown as { taskId: string }[];
    const extraIds = [...new Set(extras.map((row) => row.taskId))];
    const tasks = (await Task.findAll({
      where: {
        tenantId,
        [Op.or]: [{ assigneeEmployeeId: employeeId }, ...(extraIds.length ? [{ id: { [Op.in]: extraIds } }] : [])],
      },
      attributes: ['id', 'title', 'status', 'dueDate', 'completedAt', 'projectId'],
      include: [
        {
          model: Project,
          as: 'project',
          attributes: ['id', 'name', 'status', 'confidential', 'leadEmployeeId'],
          required: false,
        },
      ],
    })) as any[];
    const today = todayIso();
    const completed = tasks
      .filter((task) => task.status === WorkspaceTaskStatus.COMPLETED && inPeriod(dayOf(task.completedAt)))
      .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
    const overdue = tasks
      .filter(
        (task) =>
          task.status !== WorkspaceTaskStatus.COMPLETED &&
          task.dueDate &&
          task.dueDate < today &&
          inPeriod(String(task.dueDate)),
      )
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));

    const projects = new Map<string, { id: string; name: string; status: string; confidential: boolean; part: 'owner' | 'member' | 'assignee' }>();
    const keep = (project: any, part: 'owner' | 'member' | 'assignee') => {
      if (!project?.id || project.status === WorkspaceProjectStatus.CANCELLED) return;
      const rank = { owner: 0, member: 1, assignee: 2 };
      const current = projects.get(project.id);
      if (current && rank[current.part] <= rank[part]) return;
      projects.set(project.id, {
        id: project.id,
        name: project.name,
        status: project.status,
        confidential: project.confidential === true,
        part,
      });
    };
    const led = (await Project.findAll({
      where: { tenantId, leadEmployeeId: employeeId },
      attributes: ['id', 'name', 'status', 'confidential'],
    })) as any[];
    for (const project of led) keep(project, 'owner');
    const memberships = (await Member.findAll({
      where: { tenantId, employeeId },
      attributes: ['projectId'],
      raw: true,
    })) as unknown as { projectId: string }[];
    const memberIds = memberships.map((row) => row.projectId).filter((id) => !projects.has(id));
    if (memberIds.length) {
      const rows = (await Project.findAll({
        where: { tenantId, id: { [Op.in]: memberIds } },
        attributes: ['id', 'name', 'status', 'confidential'],
      })) as any[];
      for (const project of rows) keep(project, 'member');
    }
    for (const task of tasks) keep(task.project, 'assignee');
    const projectList = [...projects.values()]
      .map((project) => (concealed.has(project.id) ? { ...project, name: CONFIDENTIAL_PROJECT, concealed: true } : { ...project, concealed: false }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const comments = tasks.length
      ? ((await Comment.findAll({
          where: { tenantId, taskId: { [Op.in]: tasks.map((task) => task.id) } },
          attributes: ['id', 'taskId', 'body', 'authorName', 'authorEmployeeId', 'createdAt'],
          order: [['createdAt', 'DESC']],
          limit: 200,
        })) as any[])
      : [];
    const feedback = comments.filter((comment) => {
      const author = comment.authorEmployeeId as string | null;
      if (!author || author === employeeId) return false;
      if (!inPeriod(dayOf(comment.createdAt))) return false;
      const task = taskById.get(comment.taskId);
      // What was said about a project the reader may not see stays unsaid.
      if (isConcealed(task?.projectId)) return false;
      const lead = task?.project?.leadEmployeeId;
      return author === managerId || author === lead;
    });

    const taskLine = (task: any) => {
      const hidden = isConcealed(task.projectId);
      return {
        id: task.id as string,
        title: hidden ? CONFIDENTIAL_TASK : (task.title as string),
        projectName: hidden ? CONFIDENTIAL_PROJECT : ((task.project?.name as string | undefined) ?? null),
        concealed: hidden,
        dueDate: (task.dueDate as string | null) ?? null,
        completedAt: (task.completedAt as Date | null) ?? null,
      };
    };
    const take = <T>(rows: T[]) => rows.slice(0, 8);
    return {
      projects: take(projectList),
      completedTasks: take(completed).map(taskLine),
      overdueTasks: take(overdue).map(taskLine),
      managerFeedback: take(feedback).map((comment) => ({
        id: comment.id as string,
        taskTitle: (taskById.get(comment.taskId)?.title as string | undefined) ?? null,
        authorName: comment.authorName as string,
        body: comment.body as string,
        createdAt: comment.createdAt as Date,
      })),
      counts: {
        projects: projectList.length,
        completedTasks: completed.length,
        overdueTasks: overdue.length,
        managerFeedback: feedback.length,
      },
    };
  }

  async createReview(tenantId: string, dto: CreatePerformanceReviewDto) {
    const employee: any = await this.assertEmployee(tenantId, dto.employeeId);
    this.assertCanAssign(employee, dto.authorizeInactive, 'review');
    if (dto.reviewerId) await this.assertReviewer(tenantId, dto.reviewerId, dto.employeeId);
    const reviewerId = dto.reviewerId ?? (await this.managerOf(tenantId, employee));
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    await this.assertNoDuplicate(tenantId, dto.employeeId, dto.cycle);
    const rating = dto.rating ?? this.metricAverage(dto);
    const status = dto.status ?? PerformanceReviewStatus.PENDING;
    const created = await Review.create({
      tenantId,
      employeeId: dto.employeeId,
      cycle: dto.cycle.trim(),
      status,
      reviewerComments: dto.reviewerComments?.trim() || null,
      reviewerId,
      reviewerPinned: Boolean(dto.reviewerId),
      employeeSnapshot: await buildReviewSnapshot(this.modelProvider, tenantId, employee, reviewerId),
      accessGrantedTo: [],
      rating,
      professionalism: dto.professionalism ?? null,
      communication: dto.communication ?? null,
      qualityOfWork: dto.qualityOfWork ?? null,
      teamwork: dto.teamwork ?? null,
      leadership: dto.leadership ?? null,
      reviewDate:
        dto.reviewDate ??
        (status === PerformanceReviewStatus.COMPLETED
          ? new Date().toISOString().slice(0, 10)
          : null),
    });
    // An open review asks the employee for their side of it.
    if (status !== PerformanceReviewStatus.COMPLETED) {
      await this.notifyEmployee(
        tenantId,
        dto.employeeId,
        `Self-assessment requested: ${dto.cycle.trim()}`,
        `Your ${dto.cycle.trim()} performance review has started. Open My Performance to add your own assessment.`,
      );
      await this.tellReviewer(tenantId, reviewerId, employee, dto.cycle.trim());
    }
    return this.getReview(tenantId, created.id);
  }

  /**
   * Puts someone into a cycle: their review, with the reviewer the rules give
   * (their reporting manager, else the cycle's fallback reviewer, else HR), the
   * snapshot, and a note to them and to the reviewer. A system action for the
   * cycle service, which has already decided they belong, so it takes no data
   * scope. Returns null when they are already in it.
   */
  async enrolInCycle(
    tenantId: string,
    employee: any,
    cycle: { id: string; name: string; fallbackReviewerId?: string | null },
  ): Promise<{ id: string; reviewerId: string | null } | null> {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const wanted = cycle.name.trim().toLowerCase();
    const existing = (await Review.findAll({ where: { tenantId, employeeId: employee.id }, attributes: ['id', 'cycle', 'cycleId'], raw: true })) as unknown as { cycle: string; cycleId: string | null }[];
    if (existing.some((row) => row.cycleId === cycle.id || String(row.cycle).trim().toLowerCase() === wanted)) return null;

    let reviewerId = await this.managerOf(tenantId, employee);
    if (!reviewerId && cycle.fallbackReviewerId && cycle.fallbackReviewerId !== employee.id) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const fallback: any = await Employee.findOne({ where: { id: cycle.fallbackReviewerId, tenantId }, attributes: ['id', 'status'] });
      if (fallback && [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE].includes(fallback.status)) reviewerId = fallback.id;
    }
    const created: any = await Review.create({
      tenantId,
      employeeId: employee.id,
      cycle: cycle.name.trim(),
      cycleId: cycle.id,
      status: PerformanceReviewStatus.PENDING,
      reviewerId,
      reviewerPinned: false,
      employeeSnapshot: await buildReviewSnapshot(this.modelProvider, tenantId, employee, reviewerId),
      accessGrantedTo: [],
      rating: null,
    } as any);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', created.id, 'CREATE', {
      event: { from: null, to: 'REVIEW_ENROLLED_IN_CYCLE' },
      cycle: { from: null, to: cycle.name.trim() },
      reviewerId: { from: null, to: reviewerId },
    });
    // The KPIs that fit the person, as their own copy, and the reviewer's goal-setting action.
    const assigned = this.kpiTemplates ? await this.kpiTemplates.assignToReview(tenantId, { id: created.id, employeeId: employee.id, cycleId: cycle.id }, employee) : { templateId: null, count: 0 };
    await this.notifyEmployee(tenantId, employee.id, `Self-assessment requested: ${cycle.name.trim()}`, `Your ${cycle.name.trim()} performance review has started. Open My Performance to add your own assessment.`);
    await this.tellReviewer(tenantId, reviewerId, employee, cycle.name.trim());
    if (reviewerId) {
      const who = [employee.firstName, employee.lastName].filter(Boolean).join(' ') || 'an employee';
      await this.notifyEmployee(tenantId, reviewerId, `Set goals for ${who}`, `${who}'s ${cycle.name.trim()} plan needs your goals${assigned.count ? ` (${assigned.count} KPIs came from the ${cycle.name.trim()} template)` : ''}. Open Reviewing, then the plan, to set and publish them.`);
    }
    return { id: created.id as string, reviewerId };
  }

  /** One review per person per cycle: the same cycle name, ignoring case and spaces, is the same review assignment. */
  private async assertNoDuplicate(tenantId: string, employeeId: string, cycle: string, exceptReviewId?: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const wanted = cycle.trim().toLowerCase();
    const existing = ((await Review.findAll({ where: { tenantId, employeeId }, attributes: ['id', 'cycle'], raw: true })) as unknown as { id: string; cycle: string }[]).find(
      (row) => row.id !== exceptReviewId && String(row.cycle).trim().toLowerCase() === wanted,
    );
    if (existing) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, `This person already has a review for ${cycle.trim()}. Open that one instead.`, HttpStatus.CONFLICT);
    }
  }

  /** HR lets particular employees read a review they would not otherwise see; an empty list takes it away. */
  async setReviewAccess(tenantId: string, reviewId: string, dto: SetReviewAccessDto, actorEmail?: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review: any = await Review.findOne({ where: { id: reviewId, tenantId, ...(await this.reviewScope(tenantId)) } });
    if (!review) this.notFound('Performance review', reviewId);
    const ids = [...new Set(dto.employeeIds)].filter((id) => id !== review.employeeId);
    if (ids.length) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const found = await Employee.count({ where: { tenantId, id: { [Op.in]: ids } } });
      if (found !== ids.length) throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'One of the selected employees was not found.', HttpStatus.BAD_REQUEST);
    }
    const before = Array.isArray(review.accessGrantedTo) ? review.accessGrantedTo : [];
    await review.update({ accessGrantedTo: ids });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', {
      event: { from: null, to: 'REVIEW_ACCESS_CHANGED' },
      accessGrantedTo: { from: before.join(',') || null, to: ids.join(',') || null },
      ...(actorEmail ? { changedBy: { from: null, to: actorEmail } } : {}),
    });
    return this.getReview(tenantId, reviewId);
  }

  async updateReview(tenantId: string, reviewId: string, dto: UpdatePerformanceReviewDto) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review = await Review.findOne({ where: { id: reviewId, tenantId, ...(await this.reviewScope(tenantId)) } });
    if (!review) this.notFound('Performance review', reviewId);

    // What the employee has been shown must not change under them: unpublish it first.
    if (review.publishedAt) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'This review is published to the employee. Unpublish it before changing it.',
        HttpStatus.CONFLICT,
      );
    }

    const patch: any = {};
    if (dto.cycle !== undefined) {
      patch.cycle = dto.cycle.trim();
      await this.assertNoDuplicate(tenantId, review.employeeId, dto.cycle, review.id);
    }
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.reviewDate !== undefined) patch.reviewDate = dto.reviewDate;
    if (dto.reviewerComments !== undefined) patch.reviewerComments = dto.reviewerComments.trim() || null;
    for (const field of METRIC_FIELDS) {
      if (dto[field.key] !== undefined) patch[field.key] = dto[field.key];
    }
    let newReviewer: string | null = null;
    if (dto.reviewerId !== undefined) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const subject: any = await Employee.findOne({ where: { id: review.employeeId, tenantId } });
      if (dto.reviewerId) await this.assertReviewer(tenantId, dto.reviewerId, review.employeeId);
      const next = dto.reviewerId ?? (await this.managerOf(tenantId, subject));
      patch.reviewerId = next;
      patch.reviewerPinned = Boolean(dto.reviewerId);
      if (next && next !== review.reviewerId) newReviewer = next;
    }

    if (dto.rating !== undefined) {
      patch.rating = dto.rating;
    } else if (METRIC_FIELDS.some((field) => dto[field.key] !== undefined)) {
      const merged = {} as Record<MetricKey, number | undefined>;
      for (const field of METRIC_FIELDS) {
        const next = dto[field.key] ?? asNumber(review[field.key]);
        if (next !== null && next !== undefined) merged[field.key] = next;
      }
      const nextAverage = this.metricAverage(merged);
      if (nextAverage !== null) patch.rating = nextAverage;
    }

    const nextStatus = patch.status ?? review.status;
    if (nextStatus === PerformanceReviewStatus.COMPLETED && !patch.reviewDate && !review.reviewDate) {
      patch.reviewDate = new Date().toISOString().slice(0, 10);
    }

    // Completing a review freezes what was true then: the person's department, designation, manager and reviewer.
    if (nextStatus === PerformanceReviewStatus.COMPLETED && review.status !== PerformanceReviewStatus.COMPLETED) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const subject: any = await Employee.findOne({ where: { id: review.employeeId, tenantId } });
      if (subject) patch.employeeSnapshot = await buildReviewSnapshot(this.modelProvider, tenantId, subject, (patch.reviewerId !== undefined ? patch.reviewerId : review.reviewerId) ?? null);
    }
    await review.update(patch);
    if (newReviewer) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      await this.tellReviewer(tenantId, newReviewer, await Employee.findOne({ where: { id: review.employeeId, tenantId }, attributes: ['firstName', 'lastName'] }), review.cycle);
    }
    return this.getReview(tenantId, reviewId);
  }

  /**
   * Someone's reporting manager changed. Their open reviews that HR did not pin
   * to a particular reviewer follow to the new manager, who is told. Returns
   * how many moved.
   */
  async followManagerChange(tenantId: string, employeeId: string): Promise<number> {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const open = ((await Review.findAll({ where: { tenantId, employeeId, status: { [Op.ne]: PerformanceReviewStatus.COMPLETED }, reviewerPinned: false } as any })) as any[]).filter((row) => !row.publishedAt && !row.closedAt);
    if (!open.length) return 0;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId } });
    const next = await this.managerOf(tenantId, employee);
    let moved = 0;
    for (const review of open) {
      if ((review.reviewerId ?? null) === next) continue;
      const before = review.reviewerId ?? null;
      await review.update({ reviewerId: next });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', {
        event: { from: null, to: 'REVIEWER_FOLLOWED_MANAGER_CHANGE' },
        reviewerId: { from: before, to: next },
      });
      await this.tellReviewer(tenantId, next, employee, review.cycle);
      moved++;
    }
    return moved;
  }

  /**
   * A reviewer left. Their open reviews go to the employee's reporting manager,
   * or to HR when there is none. Returns how many moved.
   */
  async releaseReviewer(tenantId: string, reviewerId: string): Promise<number> {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const open = ((await Review.findAll({ where: { tenantId, reviewerId, status: { [Op.ne]: PerformanceReviewStatus.COMPLETED } } as any })) as any[]).filter((row) => !row.publishedAt && !row.closedAt);
    let moved = 0;
    for (const review of open) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const employee: any = await Employee.findOne({ where: { id: review.employeeId, tenantId } });
      const manager = await this.managerOf(tenantId, employee);
      const next = manager && manager !== reviewerId ? manager : null;
      await review.update({ reviewerId: next, reviewerPinned: false });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', {
        event: { from: null, to: 'REVIEWER_LEFT_REASSIGNED' },
        reviewerId: { from: reviewerId, to: next },
      });
      await this.tellReviewer(tenantId, next, employee, review.cycle);
      moved++;
    }
    return moved;
  }

  /** Shows a completed review's result, rating and feedback to the employee, and tells them. */
  async publishReview(tenantId: string, reviewId: string, actorEmail?: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review: any = await Review.findOne({ where: { id: reviewId, tenantId, ...(await this.reviewScope(tenantId)) } });
    if (!review) this.notFound('Performance review', reviewId);
    if (review.publishedAt) return this.getReview(tenantId, reviewId);
    if (review.status !== PerformanceReviewStatus.COMPLETED) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Only a completed review can be published.',
        HttpStatus.CONFLICT,
      );
    }
    await review.update({ publishedAt: new Date(), publishedByEmail: actorEmail ?? null });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', {
      published: { from: false, to: true },
    });
    await this.notifyEmployee(
      tenantId,
      review.employeeId,
      `Your ${review.cycle} review is ready`,
      `Your ${review.cycle} performance review has been published. Open My Performance to read it.`,
    );
    return this.getReview(tenantId, reviewId);
  }

  /** Takes a published review back so it can be corrected. The employee no longer sees the result. */
  async unpublishReview(tenantId: string, reviewId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review: any = await Review.findOne({ where: { id: reviewId, tenantId, ...(await this.reviewScope(tenantId)) } });
    if (!review) this.notFound('Performance review', reviewId);
    if (!review.publishedAt) return this.getReview(tenantId, reviewId);
    await review.update({ publishedAt: null, publishedByEmail: null });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', {
      published: { from: true, to: false },
    });
    return this.getReview(tenantId, reviewId);
  }

  /**
   * Returns a body rather than void: an RPC handler that resolves to
   * undefined completes the client observable without emitting, which the
   * gateway surfaces as an EmptyError even though the row is gone.
   */
  async deleteReview(tenantId: string, reviewId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const deleted = await Review.destroy({ where: { id: reviewId, tenantId, ...(await this.reviewScope(tenantId)) } });
    if (!deleted) this.notFound('Performance review', reviewId);
    return { deleted: true, id: reviewId };
  }

  async getGoals(tenantId: string, query: DashboardLimitDto = {}) {
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const rows = await Goal.findAll({
      where: { tenantId, ...(await this.scopeWhere(tenantId)) },
      include: [await this.employeeInclude(tenantId)],
      order: [['progress', 'DESC'], ['dueDate', 'ASC']],
      limit: this.limitOf(query.limit),
    });
    return rows.map((row) => this.goalRow(row));
  }

  async getGoal(tenantId: string, goalId: string) {
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goal = await Goal.findOne({
      where: { id: goalId, tenantId, ...(await this.scopeWhere(tenantId)) },
      include: [await this.employeeInclude(tenantId)],
    });
    if (!goal) this.notFound('Performance goal', goalId);
    return this.goalRow(goal);
  }

  async createGoal(tenantId: string, dto: CreatePerformanceGoalDto) {
    const employee = await this.assertEmployee(tenantId, dto.employeeId);
    this.assertCanAssign(employee, dto.authorizeInactive, 'goal');
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const progress = dto.progress ?? 0;
    const created = await Goal.create({
      tenantId,
      employeeId: dto.employeeId,
      title: dto.title.trim(),
      category: dto.category?.trim() || null,
      progress,
      status:
        dto.status ??
        (progress >= 100
          ? PerformanceGoalStatus.COMPLETED
          : progress > 0
            ? PerformanceGoalStatus.IN_PROGRESS
            : PerformanceGoalStatus.NOT_STARTED),
      dueDate: dto.dueDate ?? null,
    });
    await this.notifyEmployee(
      tenantId,
      dto.employeeId,
      `New goal: ${dto.title.trim()}`,
      `A performance goal was set for you${dto.dueDate ? `, due ${dto.dueDate}` : ''}. Open My Performance to follow it.`,
    );
    return this.getGoal(tenantId, created.id);
  }

  async updateGoal(tenantId: string, goalId: string, dto: UpdatePerformanceGoalDto) {
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goal = await Goal.findOne({ where: { id: goalId, tenantId, ...(await this.scopeWhere(tenantId)) } });
    if (!goal) this.notFound('Performance goal', goalId);

    const patch: any = {};
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.category !== undefined) patch.category = dto.category.trim() || null;
    if (dto.progress !== undefined) patch.progress = dto.progress;
    if (dto.dueDate !== undefined) patch.dueDate = dto.dueDate;
    if (dto.status !== undefined) {
      patch.status = dto.status;
    } else if (dto.progress !== undefined) {
      patch.status =
        dto.progress >= 100
          ? PerformanceGoalStatus.COMPLETED
          : dto.progress > 0
            ? PerformanceGoalStatus.IN_PROGRESS
            : PerformanceGoalStatus.NOT_STARTED;
    }

    await goal.update(patch);
    return this.getGoal(tenantId, goalId);
  }

  /** See deleteReview: an RPC handler must resolve to a value, not void. */
  async deleteGoal(tenantId: string, goalId: string) {
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const deleted = await Goal.destroy({ where: { id: goalId, tenantId, ...(await this.scopeWhere(tenantId)) } });
    if (!deleted) this.notFound('Performance goal', goalId);
    return { deleted: true, id: goalId };
  }
}
