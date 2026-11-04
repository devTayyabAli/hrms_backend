import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  EmployeeNotificationKind,
  EmployeeStatus,
  PerformanceReviewStatus,
  SetReviewEvaluatorsDto,
  SubmitReviewEvaluationDto,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PermissionHoldersService } from './permission-holders.service';
import { METRIC_KEYS, MetricKey, consolidate } from './performance-consolidation';
import { applyKpiScores, weightedKpiScore } from './performance-kpi';
import { buildReviewSnapshot } from './performance-snapshot';
import { writePayrollAudit as writeAudit } from './payroll-access';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const MAX_EVALUATORS = 8;
const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const nameOf = (row?: { firstName?: string | null; lastName?: string | null } | null) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '');
const average = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null);

/**
 * Reviews with more than one evaluator. Each evaluator writes and submits their
 * own evaluation (they do not see each other's), the lead being the review's
 * main reviewer. The final rating is their ratings weighted by each one's share,
 * the competency scores likewise, and every evaluation stays on record. When
 * the last one submits the review completes by itself; HR can complete it
 * earlier with the evaluations that are in.
 */
@Injectable()
export class PerformanceEvaluatorService {
  private readonly logger = new Logger(PerformanceEvaluatorService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dashboard?: PerformanceDashboardService,
    @Optional() private readonly holders?: PermissionHoldersService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private async notify(tenantId: string, employeeId: string | null | undefined, title: string, body: string) {
    if (!employeeId) return;
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.PERFORMANCE, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`An evaluator notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  private async evaluatorsOf(tenantId: string, reviewId: string): Promise<any[]> {
    const Evaluator = await this.modelProvider.getReviewEvaluatorModel(tenantId);
    const rows = (await Evaluator.findAll({ where: { tenantId, reviewId } })) as any[];
    return rows.sort((a, b) => Number(b.isLead) - Number(a.isLead) || String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  private async loadReview(tenantId: string, reviewId: string) {
    // The same visibility the other admin screens apply.
    if (this.dashboard) await this.dashboard.getReview(tenantId, reviewId);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review: any = await Review.findOne({ where: { id: reviewId, tenantId } });
    if (!review) this.fail(HttpStatus.NOT_FOUND, `Performance review '${reviewId}' not found in this organization.`);
    return review;
  }

  private metricsOf(row: any): Record<MetricKey, number | null> {
    const metrics = {} as Record<MetricKey, number | null>;
    for (const key of METRIC_KEYS) metrics[key] = asNumber(row[key]);
    return metrics;
  }

  private async peopleById(tenantId: string, ids: string[]) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = ids.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: [...new Set(ids)] } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], raw: true })) as any[]) : [];
    return new Map(rows.map((row) => [row.id, row]));
  }

  // ==========================================
  // Seeing and setting the evaluators (HR)
  // ==========================================

  /** What the evaluators are and have written, with what the review comes to, for someone who may read them all. */
  async list(tenantId: string, reviewId: string) {
    const review = await this.loadReview(tenantId, reviewId);
    const evaluators = await this.evaluatorsOf(tenantId, reviewId);
    const people = await this.peopleById(tenantId, evaluators.map((row) => row.employeeId));
    const submitted = evaluators.filter((row) => row.status === 'SUBMITTED');
    const preview = submitted.length ? consolidate(submitted.map((row) => ({ weight: row.weight, rating: asNumber(row.rating), metrics: this.metricsOf(row) }))) : null;
    return {
      review: { id: review.id as string, cycle: review.cycle as string, status: review.status as string, multiReviewer: Boolean(review.multiReviewer) },
      evaluators: evaluators.map((row) => ({
        id: row.id as string,
        employee: people.get(row.employeeId) ? { id: row.employeeId as string, name: nameOf(people.get(row.employeeId)), employeeCode: (people.get(row.employeeId).employeeCode ?? null) as string | null } : { id: row.employeeId as string, name: null, employeeCode: null },
        roleLabel: (row.roleLabel ?? null) as string | null,
        isLead: Boolean(row.isLead),
        weight: Number(row.weight),
        status: row.status as string,
        rating: asNumber(row.rating),
        metrics: this.metricsOf(row),
        comments: (row.comments ?? null) as string | null,
        submittedAt: row.submittedAt ?? null,
      })),
      weightTotal: evaluators.reduce((sum, row) => sum + Number(row.weight), 0),
      consolidated: { rating: asNumber(review.rating), kpiScore: asNumber(review.kpiScore), ...(preview ? { ifCompletedNow: preview } : {}) },
    };
  }

  async set(tenantId: string, reviewId: string, dto: SetReviewEvaluatorsDto) {
    const review = await this.loadReview(tenantId, reviewId);
    if (review.closedAt || review.publishedAt || review.status === PerformanceReviewStatus.COMPLETED) this.fail(HttpStatus.CONFLICT, 'This review is finished, so its reviewers can no longer change.');
    const existing = await this.evaluatorsOf(tenantId, reviewId);
    const Evaluator = await this.modelProvider.getReviewEvaluatorModel(tenantId);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);

    // An empty list goes back to a single reviewer.
    if (!dto.reviewers.length) {
      if (existing.some((row) => row.status === 'SUBMITTED')) this.fail(HttpStatus.CONFLICT, 'Someone has already submitted their evaluation, so the review cannot go back to one reviewer.');
      for (const row of existing) await row.destroy();
      await review.update({ multiReviewer: false });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', { event: { from: null, to: 'REVIEWERS_CLEARED' } });
      return this.list(tenantId, reviewId);
    }

    const entries = dto.reviewers;
    if (entries.length < 2) this.fail(HttpStatus.BAD_REQUEST, 'Give at least two reviewers, or none to go back to one.');
    if (entries.length > MAX_EVALUATORS) this.fail(HttpStatus.BAD_REQUEST, `A review can have at most ${MAX_EVALUATORS} reviewers.`);
    const ids = entries.map((entry) => entry.employeeId);
    if (new Set(ids).size !== ids.length) this.fail(HttpStatus.BAD_REQUEST, 'The same person is listed twice.');
    if (ids.includes(review.employeeId)) this.fail(HttpStatus.BAD_REQUEST, 'Someone cannot evaluate themselves.');
    if (entries.filter((entry) => entry.isLead === true).length !== 1) this.fail(HttpStatus.BAD_REQUEST, 'Name exactly one lead reviewer.');
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    if (total !== 100) this.fail(HttpStatus.BAD_REQUEST, `The reviewers\' shares add up to ${total}. They must add up to 100.`);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const found = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'status'], raw: true })) as unknown as { id: string; status: string }[];
    if (found.length !== ids.length || found.some((row) => !EMPLOYED.includes(row.status as EmployeeStatus))) this.fail(HttpStatus.BAD_REQUEST, 'A reviewer was not found, or no longer works here.');

    const leaving = existing.filter((row) => !ids.includes(row.employeeId));
    if (leaving.some((row) => row.status === 'SUBMITTED')) this.fail(HttpStatus.CONFLICT, 'Someone who has already submitted their evaluation cannot be taken off the review.');
    const lead = entries.find((entry) => entry.isLead === true)!;
    const wasMulti = Boolean(review.multiReviewer);

    for (const row of leaving) await row.destroy();
    const added: string[] = [];
    for (const entry of entries) {
      const row = existing.find((candidate) => candidate.employeeId === entry.employeeId);
      if (row) await row.update({ weight: entry.weight, roleLabel: entry.roleLabel?.trim() || null, isLead: entry.isLead === true });
      else {
        await Evaluator.create({ tenantId, reviewId, employeeId: entry.employeeId, roleLabel: entry.roleLabel?.trim() || null, isLead: entry.isLead === true, weight: entry.weight, status: 'PENDING' } as any);
        added.push(entry.employeeId);
      }
    }

    // The lead's draft on the review itself moves into their own evaluation, so it is not mistaken for the consolidated result.
    const hadDraft = !wasMulti && (METRIC_KEYS.some((key) => asNumber(review[key]) !== null) || review.reviewerComments || asNumber(review.rating) !== null);
    if (hadDraft) {
      const leadRow: any = (await this.evaluatorsOf(tenantId, reviewId)).find((row) => row.employeeId === lead.employeeId);
      const metrics: Record<string, unknown> = {};
      for (const key of METRIC_KEYS) metrics[key] = review[key] ?? null;
      await leadRow.update({ ...metrics, rating: review.rating ?? null, comments: review.reviewerComments ?? null, status: 'IN_PROGRESS' });
    }
    const patch: Record<string, unknown> = { multiReviewer: true, reviewerId: lead.employeeId, reviewerPinned: review.reviewerId === lead.employeeId ? review.reviewerPinned : true };
    if (hadDraft) {
      for (const key of METRIC_KEYS) patch[key] = null;
      patch.rating = null;
      patch.reviewerComments = null;
    }
    await Review.update(patch as any, { where: { id: reviewId, tenantId } as any });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', {
      event: { from: null, to: 'REVIEWERS_SET' },
      reviewers: { from: existing.map((row) => `${row.employeeId}:${row.weight}`).join(',') || null, to: entries.map((entry) => `${entry.employeeId}:${entry.weight}`).join(',') },
    });
    const subject = (await this.peopleById(tenantId, [review.employeeId])).get(review.employeeId);
    for (const id of added) await this.notify(tenantId, id, `Evaluate ${nameOf(subject)}`, `You are one of the reviewers of ${nameOf(subject)}'s ${review.cycle} performance review${entries.find((entry) => entry.employeeId === id)?.roleLabel ? `, as ${entries.find((entry) => entry.employeeId === id)?.roleLabel}` : ''}. Open Reviewing to write your evaluation.`);
    return this.list(tenantId, reviewId);
  }

  // ==========================================
  // Writing an evaluation (the evaluator's own)
  // ==========================================

  /** What an evaluator sees of the review's evaluators: the lead sees who has submitted, never what they wrote. */
  async infoFor(tenantId: string, reviews: any[], meId: string): Promise<Map<string, any>> {
    const multi = reviews.filter((row) => row.multiReviewer);
    const out = new Map<string, any>();
    if (!multi.length) return out;
    const Evaluator = await this.modelProvider.getReviewEvaluatorModel(tenantId);
    const rows = (await Evaluator.findAll({ where: { tenantId, reviewId: { [Op.in]: multi.map((row) => row.id) } } })) as any[];
    const people = await this.peopleById(tenantId, rows.map((row) => row.employeeId));
    for (const review of multi) {
      const mine = rows.find((row) => row.reviewId === review.id && row.employeeId === meId);
      const all = rows.filter((row) => row.reviewId === review.id);
      out.set(review.id, {
        multiReviewer: true,
        myEvaluation: mine
          ? { roleLabel: mine.roleLabel ?? null, isLead: Boolean(mine.isLead), weight: Number(mine.weight), status: mine.status as string, rating: asNumber(mine.rating), metrics: this.metricsOf(mine), comments: mine.comments ?? null, submittedAt: mine.submittedAt ?? null }
          : null,
        evaluators: mine?.isLead || review.reviewerId === meId ? all.map((row) => ({ employee: { id: row.employeeId as string, name: nameOf(people.get(row.employeeId)) }, roleLabel: row.roleLabel ?? null, isLead: Boolean(row.isLead), weight: Number(row.weight), status: row.status as string })) : null,
      });
    }
    return out;
  }

  /** Whether this person evaluates the review, as lead or otherwise. */
  async isEvaluator(tenantId: string, reviewId: string, employeeId: string): Promise<boolean> {
    const Evaluator = await this.modelProvider.getReviewEvaluatorModel(tenantId);
    return (await Evaluator.count({ where: { tenantId, reviewId, employeeId } })) > 0;
  }

  /** The KPIs this evaluator scores: those given to them, and (for the lead) those with no one named. */
  async kpisFor(tenantId: string, reviewId: string, employeeId: string, isLead: boolean): Promise<any[]> {
    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const rows = (await Kpi.findAll({ where: { tenantId, reviewId } })) as any[];
    return rows.filter((row) => row.evaluatorEmployeeId === employeeId || (!row.evaluatorEmployeeId && isLead)).sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  }

  async submit(tenantId: string, review: any, meId: string, dto: SubmitReviewEvaluationDto): Promise<void> {
    const evaluator = (await this.evaluatorsOf(tenantId, review.id)).find((row) => row.employeeId === meId);
    if (!evaluator) this.fail(HttpStatus.NOT_FOUND, `Performance review '${review.id}' is not one you evaluate.`);
    if (evaluator.status === 'SUBMITTED') this.fail(HttpStatus.CONFLICT, 'You have already submitted your evaluation of this review.');

    const patch: Record<string, unknown> = {};
    for (const key of METRIC_KEYS) if ((dto as any)[key] !== undefined) patch[key] = (dto as any)[key];
    if (dto.reviewerComments !== undefined) patch.comments = dto.reviewerComments.trim() || null;
    const scores = METRIC_KEYS.map((key) => ((dto as any)[key] !== undefined ? ((dto as any)[key] as number) : asNumber(evaluator[key]))).filter((value): value is number => value !== null && value !== undefined);

    // KPI scores: only those that are theirs to score.
    let ownKpiScore: number | null = null;
    if (dto.kpiScores?.length) {
      const mine = new Set((await this.kpisFor(tenantId, review.id, meId, Boolean(evaluator.isLead))).map((row) => row.id));
      if (dto.kpiScores.some((entry) => !mine.has(entry.kpiId))) this.fail(HttpStatus.BAD_REQUEST, 'One of those KPIs is not yours to score.');
      await applyKpiScores(this.modelProvider, this.logger, tenantId, review, dto.kpiScores);
    }
    const ownKpis = await this.kpisFor(tenantId, review.id, meId, Boolean(evaluator.isLead));
    ownKpiScore = weightedKpiScore(ownKpis.map((row) => ({ weight: row.weight, score: row.score })));

    if (METRIC_KEYS.some((key) => (dto as any)[key] !== undefined) || dto.kpiScores?.length) {
      patch.rating = scores.length ? average(scores) : ownKpiScore;
    }
    if (dto.complete === true) {
      if (!scores.length && ownKpiScore === null) this.fail(HttpStatus.BAD_REQUEST, 'Give at least one score before submitting your evaluation.');
      patch.status = 'SUBMITTED';
      patch.submittedAt = new Date();
      if (patch.rating === undefined) patch.rating = scores.length ? average(scores) : ownKpiScore;
    } else if (evaluator.status === 'PENDING' && Object.keys(patch).length) {
      patch.status = 'IN_PROGRESS';
    }
    if (!Object.keys(patch).length) return;

    await evaluator.update(patch);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'review_evaluators', evaluator.id, 'UPDATE', {
      reviewId: { from: null, to: review.id },
      event: { from: null, to: dto.complete === true ? 'EVALUATION_SUBMITTED' : 'EVALUATION_SAVED' },
      rating: { from: null, to: asNumber(evaluator.rating) },
    });
    // The review's own KPI score is across everyone's KPIs.
    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const all = (await Kpi.findAll({ where: { tenantId, reviewId: review.id } })) as any[];
    const kpiScore = weightedKpiScore(all.map((row) => ({ weight: row.weight, score: row.score })));
    await review.update({ kpiScore, ...(review.status === PerformanceReviewStatus.PENDING ? { status: PerformanceReviewStatus.IN_PROGRESS } : {}) });
    if (dto.complete === true) await this.consolidateIfReady(tenantId, review, false);
  }

  // ==========================================
  // Putting them together
  // ==========================================

  private async consolidateIfReady(tenantId: string, review: any, force: boolean): Promise<boolean> {
    const evaluators = await this.evaluatorsOf(tenantId, review.id);
    const submitted = evaluators.filter((row) => row.status === 'SUBMITTED');
    if (!submitted.length || (!force && submitted.length < evaluators.length)) return false;

    const result = consolidate(submitted.map((row) => ({ weight: row.weight, rating: asNumber(row.rating), metrics: this.metricsOf(row) })));
    const rating = result.rating ?? asNumber(review.kpiScore);
    const lead = submitted.find((row) => row.isLead) ?? submitted[0];
    const patch: Record<string, unknown> = { ...result.metrics, rating, reviewerComments: lead.comments ?? null, status: PerformanceReviewStatus.COMPLETED, reviewDate: review.reviewDate ?? new Date().toISOString().slice(0, 10) };
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const subject: any = await Employee.findOne({ where: { id: review.employeeId, tenantId } });
    if (subject) patch.employeeSnapshot = await buildReviewSnapshot(this.modelProvider, tenantId, subject, review.reviewerId ?? null);
    await review.update(patch);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', {
      event: { from: null, to: 'REVIEW_CONSOLIDATED' },
      rating: { from: null, to: rating },
      submitted: { from: null, to: submitted.map((row) => row.employeeId).join(',') },
      notSubmitted: { from: null, to: evaluators.filter((row) => row.status !== 'SUBMITTED').map((row) => row.employeeId).join(',') || null },
    });
    return true;
  }

  /** HR completes the review now, with the evaluations that are in. Shares are weighed across those who submitted. */
  async consolidateNow(tenantId: string, reviewId: string) {
    const review = await this.loadReview(tenantId, reviewId);
    if (!review.multiReviewer) this.fail(HttpStatus.CONFLICT, 'This review has one reviewer. It is completed from their evaluation.');
    if (review.closedAt || review.status === PerformanceReviewStatus.COMPLETED) this.fail(HttpStatus.CONFLICT, 'This review is already finished.');
    if (!(await this.consolidateIfReady(tenantId, review, true))) this.fail(HttpStatus.BAD_REQUEST, 'Nobody has submitted an evaluation yet.');
    return this.list(tenantId, reviewId);
  }

  // ==========================================
  // Someone who evaluates leaves
  // ==========================================

  /**
   * An additional evaluator left: their share goes to the lead, and the lead and
   * HR are told. If the lead left, nothing changes by itself: HR is told to set
   * the reviewers again. Submitted evaluations are never removed. Returns how
   * many reviews it touched.
   */
  async onEvaluatorLeft(tenantId: string, employeeId: string): Promise<number> {
    const Evaluator = await this.modelProvider.getReviewEvaluatorModel(tenantId);
    const mine = (await Evaluator.findAll({ where: { tenantId, employeeId } })) as any[];
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    let touched = 0;
    for (const row of mine) {
      const review: any = await Review.findOne({ where: { id: row.reviewId, tenantId } });
      if (!review || review.closedAt || review.publishedAt || review.status === PerformanceReviewStatus.COMPLETED || row.status === 'SUBMITTED') continue;
      const subject = (await this.peopleById(tenantId, [review.employeeId])).get(review.employeeId);
      if (row.isLead) {
        await this.holders?.tellPermission(tenantId, 'performance.manage', [review.employeeId], 'Lead reviewer left', `The lead reviewer of ${nameOf(subject)}'s ${review.cycle} review left. Set the reviewers again.`);
      } else {
        const lead: any = (await this.evaluatorsOf(tenantId, review.id)).find((candidate) => candidate.isLead);
        if (lead) await lead.update({ weight: Number(lead.weight) + Number(row.weight) });
        await row.destroy();
        await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', { event: { from: null, to: 'EVALUATOR_LEFT_SHARE_TO_LEAD' }, evaluator: { from: employeeId, to: null }, weight: { from: row.weight, to: null } });
        await this.notify(tenantId, lead?.employeeId, `A reviewer left: ${nameOf(subject)}`, `One of the reviewers of ${nameOf(subject)}'s ${review.cycle} review left; their share is now yours.`);
      }
      touched++;
    }
    return touched;
  }
}
