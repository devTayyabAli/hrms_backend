import { HttpStatus, Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  CreatePerformanceGoalDto,
  CreatePerformanceReviewDto,
  DashboardLimitDto,
  GetPerformanceTrendQueryDto,
  PerformanceGoalStatus,
  PerformanceReviewStatus,
  TenantException,
  TenantErrorCode,
  UpdatePerformanceGoalDto,
  UpdatePerformanceReviewDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

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

@Injectable()
export class PerformanceDashboardService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

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

  private async assertEmployee(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) this.notFound('Employee', employeeId);
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

  private reviewRow(review: any) {
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
      Employee.count({ where: { tenantId } }),
      Review.count({ where: { tenantId, status: PerformanceReviewStatus.COMPLETED } }),
      Review.count({
        where: { tenantId, status: { [Op.ne]: PerformanceReviewStatus.COMPLETED } },
      }),
      Goal.count({ where: { tenantId } }),
      Goal.count({ where: { tenantId, status: PerformanceGoalStatus.COMPLETED } }),
      Goal.count({ where: { tenantId, status: PerformanceGoalStatus.IN_PROGRESS } }),
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
        },
      }),
      Review.findAll({
        where: { tenantId, status: PerformanceReviewStatus.COMPLETED, rating: { [Op.ne]: null } },
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
    const rows = await Review.findAll({
      where: {
        tenantId,
        status: PerformanceReviewStatus.COMPLETED,
        reviewDate: { [Op.ne]: null },
        rating: { [Op.ne]: null },
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

    const rows = (departments as any[]).map((department) => {
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
      where: { tenantId, status: PerformanceReviewStatus.COMPLETED },
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
      where: { tenantId, status: PerformanceReviewStatus.COMPLETED, rating: { [Op.ne]: null } },
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
      where: { tenantId },
      include: [await this.employeeInclude(tenantId)],
      order: [['reviewDate', 'DESC'], ['createdAt', 'DESC']],
      limit: this.limitOf(query.limit),
    });
    return rows.map((row) => this.reviewRow(row));
  }

  async getReview(tenantId: string, reviewId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review = await Review.findOne({
      where: { id: reviewId, tenantId },
      include: [await this.employeeInclude(tenantId)],
    });
    if (!review) this.notFound('Performance review', reviewId);
    return this.reviewRow(review);
  }

  async createReview(tenantId: string, dto: CreatePerformanceReviewDto) {
    await this.assertEmployee(tenantId, dto.employeeId);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rating = dto.rating ?? this.metricAverage(dto);
    const status = dto.status ?? PerformanceReviewStatus.PENDING;
    const created = await Review.create({
      tenantId,
      employeeId: dto.employeeId,
      cycle: dto.cycle.trim(),
      status,
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
    return this.getReview(tenantId, created.id);
  }

  async updateReview(tenantId: string, reviewId: string, dto: UpdatePerformanceReviewDto) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review = await Review.findOne({ where: { id: reviewId, tenantId } });
    if (!review) this.notFound('Performance review', reviewId);

    const patch: any = {};
    if (dto.cycle !== undefined) patch.cycle = dto.cycle.trim();
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.reviewDate !== undefined) patch.reviewDate = dto.reviewDate;
    for (const field of METRIC_FIELDS) {
      if (dto[field.key] !== undefined) patch[field.key] = dto[field.key];
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

    await review.update(patch);
    return this.getReview(tenantId, reviewId);
  }

  /**
   * Returns a body rather than void: an RPC handler that resolves to
   * undefined completes the client observable without emitting, which the
   * gateway surfaces as an EmptyError even though the row is gone.
   */
  async deleteReview(tenantId: string, reviewId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const deleted = await Review.destroy({ where: { id: reviewId, tenantId } });
    if (!deleted) this.notFound('Performance review', reviewId);
    return { deleted: true, id: reviewId };
  }

  async getGoals(tenantId: string, query: DashboardLimitDto = {}) {
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const rows = await Goal.findAll({
      where: { tenantId },
      include: [await this.employeeInclude(tenantId)],
      order: [['progress', 'DESC'], ['dueDate', 'ASC']],
      limit: this.limitOf(query.limit),
    });
    return rows.map((row) => this.goalRow(row));
  }

  async getGoal(tenantId: string, goalId: string) {
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goal = await Goal.findOne({
      where: { id: goalId, tenantId },
      include: [await this.employeeInclude(tenantId)],
    });
    if (!goal) this.notFound('Performance goal', goalId);
    return this.goalRow(goal);
  }

  async createGoal(tenantId: string, dto: CreatePerformanceGoalDto) {
    await this.assertEmployee(tenantId, dto.employeeId);
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
    return this.getGoal(tenantId, created.id);
  }

  async updateGoal(tenantId: string, goalId: string, dto: UpdatePerformanceGoalDto) {
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goal = await Goal.findOne({ where: { id: goalId, tenantId } });
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
    const deleted = await Goal.destroy({ where: { id: goalId, tenantId } });
    if (!deleted) this.notFound('Performance goal', goalId);
    return { deleted: true, id: goalId };
  }
}
