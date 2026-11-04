import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  PerformanceActorDto,
  PerformanceGoalStatus,
  PerformanceReviewStatus,
  SubmitReviewEvaluationDto,
  SubmitSelfAssessmentDto,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { buildReviewSnapshot } from './performance-snapshot';
import { applyKpiScores } from './performance-kpi';
import { PerformanceEvaluatorService } from './performance-evaluator.service';

const METRICS = ['professionalism', 'communication', 'qualityOfWork', 'teamwork', 'leadership'] as const;
type Metric = (typeof METRICS)[number];

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const goalStatusFor = (progress: number): PerformanceGoalStatus =>
  progress >= 100 ? PerformanceGoalStatus.COMPLETED : progress > 0 ? PerformanceGoalStatus.IN_PROGRESS : PerformanceGoalStatus.NOT_STARTED;

/**
 * Performance as the employee sees it: the reviews that are open for their
 * own assessment, the results HR has published, and their goals. Everything is
 * the caller's own: the employee linked to the login. A review that is
 * someone else's is simply not found, and a result the employee has not been
 * shown is not part of what they can read.
 */
@Injectable()
export class PerformanceSelfService {
  private readonly logger = new Logger(PerformanceSelfService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly evaluators?: PerformanceEvaluatorService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  /** The employee behind this login: by login id, then by email. */
  private async me(actor: PerformanceActorDto) {
    const { tenantId, userId, email } = actor;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName'] }) : null;
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName'] });
    }
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  /**
   * Open reviews show only what the employee can act on. The rating, scores and
   * feedback appear once the review is published.
   */
  private reviewRow(review: any) {
    const published = Boolean(review.publishedAt);
    const metrics = {} as Record<Metric, number | null>;
    for (const metric of METRICS) metrics[metric] = asNumber(review[metric]);
    return {
      id: review.id as string,
      cycle: review.cycle as string,
      status: review.status as string,
      published,
      publishedAt: (review.publishedAt ?? null) as Date | null,
      reviewDate: (review.reviewDate ?? null) as string | null,
      canSelfAssess: !published && review.status !== PerformanceReviewStatus.COMPLETED && !review.closedAt,
      selfAssessment: (review.selfAssessment ?? null) as Record<string, any> | null,
      evaluation: published
        ? { rating: asNumber(review.rating), metrics, reviewerComments: (review.reviewerComments ?? null) as string | null }
        : null,
    };
  }

  private async findReview(tenantId: string, employeeId: string, reviewId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review: any = await Review.findOne({ where: { id: reviewId, tenantId, employeeId } });
    if (!review) this.fail(HttpStatus.NOT_FOUND, `Performance review '${reviewId}' is not one of yours.`);
    return review;
  }

  /** My reviews, newest first: the ones waiting for my self-assessment and the published results. */
  async getReviews(actor: PerformanceActorDto) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows: any[] = (await Review.findAll({
      where: { tenantId, employeeId: employee.id },
      order: [['createdAt', 'DESC'], ['id', 'ASC']],
      limit: 100,
    })) as any[];
    const acks = await this.acknowledgements(tenantId, rows.filter((row) => row.publishedAt).map((row) => row.id));
    const data = rows.map((row) => ({ ...this.reviewRow(row), acknowledgement: acks.get(row.id) ?? null }));
    return {
      data,
      summary: {
        total: data.length,
        awaitingSelfAssessment: data.filter((row) => row.canSelfAssess && !row.selfAssessment).length,
        published: data.filter((row) => row.published).length,
      },
    };
  }

  async getReview(actor: PerformanceActorDto, reviewId: string) {
    const employee = await this.me(actor);
    const review = await this.findReview(actor.tenantId, employee.id, reviewId);
    const acks = await this.acknowledgements(actor.tenantId, review.publishedAt ? [review.id] : []);
    return { ...this.reviewRow(review), acknowledgement: acks.get(review.id) ?? null };
  }

  /** What I said when I acknowledged each of these reviews (best effort: a missing table must not hide the reviews). */
  private async acknowledgements(tenantId: string, reviewIds: string[]): Promise<Map<string, { at: Date; agreement: string; comment: string | null }>> {
    if (!reviewIds.length || !this.modelProvider.getPerformanceAcknowledgementModel) return new Map();
    try {
      const Ack = await this.modelProvider.getPerformanceAcknowledgementModel(tenantId);
      const rows = (await Ack.findAll({ where: { tenantId, kind: 'REVIEW', recordId: { [Op.in]: reviewIds } } })) as any[];
      return new Map(rows.map((row) => [row.recordId, { at: row.acknowledgedAt as Date, agreement: row.agreement as string, comment: (row.comment ?? null) as string | null }]));
    } catch (error: any) {
      this.logger.warn(`Acknowledgements could not be read: ${error?.message ?? error}`);
      return new Map();
    }
  }

  /**
   * Saves my own scores and note for an open review. I can change them until
   * the review is completed. At least one score or a note is needed.
   */
  async submitSelfAssessment(actor: PerformanceActorDto, reviewId: string, dto: SubmitSelfAssessmentDto) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const review = await this.findReview(tenantId, employee.id, reviewId);
    if (review.closedAt) this.fail(HttpStatus.CONFLICT, 'This review was closed, so a self-assessment can no longer be added.');
    if (review.publishedAt || review.status === PerformanceReviewStatus.COMPLETED) {
      this.fail(HttpStatus.CONFLICT, 'This review is completed. A self-assessment can no longer be added or changed.');
    }

    const scores: Partial<Record<Metric, number>> = {};
    for (const metric of METRICS) {
      const score = dto[metric];
      if (score !== undefined && score !== null) scores[metric] = score;
    }
    const comments = dto.comments?.trim() || null;
    if (!Object.keys(scores).length && !comments) {
      this.fail(HttpStatus.BAD_REQUEST, 'Give at least one score or write a comment.');
    }

    const previous = review.selfAssessment as Record<string, any> | null;
    await review.update({ selfAssessment: { scores, comments, submittedAt: new Date().toISOString() } });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', {
      selfAssessment: { from: previous ? 'submitted' : null, to: 'submitted' },
    });
    return this.reviewRow(review);
  }

  private goalRow(goal: any) {
    return {
      id: goal.id as string,
      title: goal.title as string,
      category: (goal.category ?? null) as string | null,
      progress: Number(goal.progress ?? 0),
      status: goal.status as string,
      dueDate: (goal.dueDate ?? null) as string | null,
    };
  }

  /** My goals: the ones still open first, soonest due first. */
  async getGoals(actor: PerformanceActorDto) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    // A goal set for a cycle is shown once its plan is published; one set by hand outside a cycle shows at once.
    const rows: any[] = (await Goal.findAll({ where: { tenantId, employeeId: employee.id, [Op.or]: [{ cycleId: null }, { publishedAt: { [Op.ne]: null } }] } as any, limit: 200 })) as any[];
    const open = (goal: any) => goal.status !== PerformanceGoalStatus.COMPLETED;
    rows.sort((a, b) => Number(open(b)) - Number(open(a)) || String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')) || String(a.title).localeCompare(String(b.title)));
    return {
      data: rows.map((row) => this.goalRow(row)),
      summary: {
        total: rows.length,
        notStarted: rows.filter((row) => row.status === PerformanceGoalStatus.NOT_STARTED).length,
        inProgress: rows.filter((row) => row.status === PerformanceGoalStatus.IN_PROGRESS).length,
        completed: rows.filter((row) => row.status === PerformanceGoalStatus.COMPLETED).length,
      },
    };
  }

  // ==========================================
  // Reviews I complete for others
  // ==========================================

  private reviewingRow(review: any, employee: any, info?: any) {
    const metrics = {} as Record<Metric, number | null>;
    for (const metric of METRICS) metrics[metric] = asNumber(review[metric]);
    return {
      id: review.id as string,
      cycle: review.cycle as string,
      status: review.status as string,
      published: Boolean(review.publishedAt),
      reviewDate: (review.reviewDate ?? null) as string | null,
      employee: employee ? { id: employee.id as string, name: [employee.firstName, employee.lastName].filter(Boolean).join(' '), employeeCode: (employee.employeeCode ?? null) as string | null, avatarUrl: (employee.avatarUrl ?? null) as string | null } : null,
      selfAssessment: (review.selfAssessment ?? null) as Record<string, any> | null,
      rating: asNumber(review.rating),
      metrics,
      reviewerComments: (review.reviewerComments ?? null) as string | null,
      kpiScore: asNumber(review.kpiScore),
      planStatus: review.planPublishedAt ? 'PUBLISHED' : 'DRAFT',
      cycleId: (review.cycleId ?? null) as string | null,
      // More than one evaluator: my own evaluation, and (for the lead) who has submitted. Never what the others wrote.
      multiReviewer: Boolean(review.multiReviewer),
      myEvaluation: info?.myEvaluation ?? null,
      evaluators: info?.evaluators ?? null,
      closed: review.closedAt ? { reason: (review.closedReason ?? null) as string | null, at: review.closedAt } : null,
      pendingChange: review.pendingChange ?? null,
      // Once the result is published to the employee it is HR's to unpublish before anyone changes it.
      canEvaluate: !review.publishedAt && !review.closedAt,
    };
  }

  private async employeesOf(tenantId: string, ids: string[]) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = ids.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: [...new Set(ids)] } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl'], raw: true })) as any[]) : [];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The reviews I am the reviewer of, those still to complete first. */
  async getReviewing(actor: PerformanceActorDto) {
    const { tenantId } = actor;
    const me = await this.me(actor);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    // The ones I am the reviewer of, and the ones I am one of several evaluators of.
    let evaluating: string[] = [];
    if (this.evaluators) {
      const Evaluator = await this.modelProvider.getReviewEvaluatorModel(tenantId);
      evaluating = ((await Evaluator.findAll({ where: { tenantId, employeeId: me.id }, attributes: ['reviewId'], raw: true })) as unknown as { reviewId: string }[]).map((row) => row.reviewId);
    }
    const rows: any[] = (await Review.findAll({ where: { tenantId, [Op.or]: [{ reviewerId: me.id }, ...(evaluating.length ? [{ id: { [Op.in]: evaluating } }] : [])] } as any, order: [['createdAt', 'DESC'], ['id', 'ASC']], limit: 200 })) as any[];
    const people = await this.employeesOf(tenantId, rows.map((row) => row.employeeId));
    const infos = this.evaluators ? await this.evaluators.infoFor(tenantId, rows, me.id) : new Map<string, any>();
    const data = rows.map((row) => this.reviewingRow(row, people.get(row.employeeId), infos.get(row.id)));
    const open = data.filter((row) => row.status !== PerformanceReviewStatus.COMPLETED && !row.closed);
    return {
      data: [...open, ...data.filter((row) => !open.includes(row))],
      summary: { total: data.length, toComplete: open.length, completed: data.filter((row) => row.status === PerformanceReviewStatus.COMPLETED).length, closed: data.filter((row) => row.closed).length },
    };
  }

  private async findReviewing(tenantId: string, reviewerId: string, reviewId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    let review: any = await Review.findOne({ where: { id: reviewId, tenantId, reviewerId } });
    // One of several evaluators of the review.
    if (!review && this.evaluators && (await this.evaluators.isEvaluator(tenantId, reviewId, reviewerId))) review = await Review.findOne({ where: { id: reviewId, tenantId } });
    if (!review) this.fail(HttpStatus.NOT_FOUND, `Performance review '${reviewId}' is not one you review.`);
    return review;
  }

  async getReviewingOne(actor: PerformanceActorDto, reviewId: string) {
    const me = await this.me(actor);
    const review = await this.findReviewing(actor.tenantId, me.id, reviewId);
    const info = this.evaluators ? (await this.evaluators.infoFor(actor.tenantId, [review], me.id)).get(review.id) : undefined;
    const row: any = this.reviewingRow(review, (await this.employeesOf(actor.tenantId, [review.employeeId])).get(review.employeeId), info);
    // The KPIs this evaluator is the one to score.
    if (review.multiReviewer && this.evaluators && info?.myEvaluation) {
      row.myKpis = (await this.evaluators.kpisFor(actor.tenantId, review.id, me.id, Boolean(info.myEvaluation.isLead))).map((kpi) => ({ id: kpi.id, title: kpi.title, weight: Number(kpi.weight), target: kpi.target ?? null, roleLabel: kpi.roleLabel ?? null, actual: kpi.actual ?? null, score: asNumber(kpi.score), comment: kpi.comment ?? null }));
    }
    return row;
  }

  /**
   * I score and write feedback on a review I am the reviewer of. Saving keeps
   * it in progress; completing it needs at least one score. HR still decides
   * when the employee sees it, and a published review has to be unpublished
   * before it changes.
   */
  async submitEvaluation(actor: PerformanceActorDto, reviewId: string, dto: SubmitReviewEvaluationDto) {
    const { tenantId } = actor;
    const me = await this.me(actor);
    const review = await this.findReviewing(tenantId, me.id, reviewId);
    if (review.publishedAt) this.fail(HttpStatus.CONFLICT, 'This review is published to the employee. Ask HR to unpublish it before changing it.');
    if (review.closedAt) this.fail(HttpStatus.CONFLICT, 'This review was closed (the person left, or was taken out of the cycle), so it can no longer be evaluated.');
    // More than one evaluator: this goes on my own evaluation, and the review completes when all are in.
    if (review.multiReviewer && this.evaluators) {
      await this.evaluators.submit(tenantId, review, me.id, dto);
      return this.getReviewingOne(actor, reviewId);
    }

    const patch: Record<string, unknown> = {};
    for (const metric of METRICS) if (dto[metric] !== undefined) patch[metric] = dto[metric];
    if (dto.reviewerComments !== undefined) patch.reviewerComments = dto.reviewerComments.trim() || null;
    const scores = METRICS.map((metric) => (dto[metric] !== undefined ? dto[metric] : asNumber(review[metric]))).filter((value): value is number => value !== null && value !== undefined);
    if (METRICS.some((metric) => dto[metric] !== undefined) && scores.length) {
      patch.rating = Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 100) / 100;
    }
    // KPI scores: kept against each KPI, with the review's weighted KPI score. With no competency scores at all, that is the rating.
    let kpiScore = asNumber(review.kpiScore);
    if (dto.kpiScores?.length) {
      kpiScore = await applyKpiScores(this.modelProvider, this.logger, tenantId, review, dto.kpiScores);
      patch.kpiScore = kpiScore;
      if (!scores.length && kpiScore !== null) patch.rating = kpiScore;
    }
    if (dto.complete === true) {
      if (!scores.length && kpiScore === null) this.fail(HttpStatus.BAD_REQUEST, 'Give at least one score before completing the review.');
      patch.status = PerformanceReviewStatus.COMPLETED;
      if (!review.reviewDate) patch.reviewDate = new Date().toISOString().slice(0, 10);
      // Completing freezes what was true then: the person's department, designation, manager and reviewer.
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const subject: any = await Employee.findOne({ where: { id: review.employeeId, tenantId } });
      if (subject) patch.employeeSnapshot = await buildReviewSnapshot(this.modelProvider, tenantId, subject, me.id);
    } else if (review.status === PerformanceReviewStatus.PENDING && Object.keys(patch).length) {
      patch.status = PerformanceReviewStatus.IN_PROGRESS;
    }
    if (!Object.keys(patch).length) return this.getReviewingOne(actor, reviewId);

    const before = { status: review.status, rating: asNumber(review.rating) };
    await review.update(patch);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', {
      event: { from: null, to: dto.complete === true ? 'REVIEW_COMPLETED_BY_REVIEWER' : 'REVIEW_EVALUATED' },
      status: { from: before.status, to: review.status },
      rating: { from: before.rating, to: asNumber(review.rating) },
    });
    return this.getReviewingOne(actor, reviewId);
  }

  /** I can move my own goal's progress; its title, date and category stay with whoever set it. */
  async updateGoalProgress(actor: PerformanceActorDto, goalId: string, progress: number) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const goal: any = await Goal.findOne({ where: { id: goalId, tenantId, employeeId: employee.id } });
    if (!goal) this.fail(HttpStatus.NOT_FOUND, `Goal '${goalId}' is not one of yours.`);

    const status = goalStatusFor(progress);
    const before = { progress: Number(goal.progress ?? 0), status: goal.status };
    if (before.progress !== progress || before.status !== status) {
      await goal.update({ progress, status });
      // A goal of a cycle carries its review, so the history of that review's plan includes the employee's progress.
      let reviewId: string | null = null;
      if (goal.cycleId) {
        const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
        const owner: any = await Review.findOne({ where: { tenantId, employeeId: employee.id, cycleId: goal.cycleId }, attributes: ['id'] });
        reviewId = owner?.id ?? null;
      }
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_goals', goalId, 'UPDATE', {
        ...(reviewId ? { reviewId: { from: null, to: reviewId } } : {}),
        progress: { from: before.progress, to: progress },
        status: { from: before.status, to: status },
      });
    }
    return this.goalRow(goal);
  }
}
