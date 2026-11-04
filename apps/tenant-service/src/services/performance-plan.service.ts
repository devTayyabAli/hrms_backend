import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op, literal, where as sqlWhere } from 'sequelize';
import {
  EmployeeNotificationKind,
  PerformanceGoalStatus,
  PerformanceReviewStatus,
  SavePerformancePlanDto,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { normalizeItems, weightTotal } from './kpi-template.service';

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const KPI_FIELDS = ['title', 'description', 'weight', 'target', 'unit', 'measurement', 'category'] as const;

/**
 * The plan of a review: its KPIs and its goals, set by the reviewer (or HR),
 * shown to the employee once published, and locked when the review is
 * completed. Every change to a KPI or goal is written to the audit history,
 * with the review it belongs to, so the history of a plan can be read back.
 *
 * A review's goals belong to its cycle, so a review made by hand without a cycle
 * carries KPIs only.
 */
@Injectable()
export class PerformancePlanService {
  private readonly logger = new Logger(PerformancePlanService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly dashboard: PerformanceDashboardService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName'] }) : null;
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  private async notify(tenantId: string, employeeId: string, title: string, body: string) {
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.PERFORMANCE, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`A plan notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  private async audit(tenantId: string, table: 'review_kpis' | 'performance_goals' | 'performance_reviews', id: string, reviewId: string, action: 'CREATE' | 'UPDATE' | 'DELETE', changes: Record<string, { from: unknown; to: unknown }>) {
    await writeAudit(this.modelProvider, this.logger, tenantId, table, id, action, { reviewId: { from: null, to: reviewId }, ...changes });
  }

  // ==========================================
  // Reading
  // ==========================================

  private kpiRow(kpi: any, withResults: boolean) {
    return {
      id: kpi.id as string,
      title: kpi.title as string,
      description: (kpi.description ?? null) as string | null,
      weight: Number(kpi.weight),
      target: (kpi.target ?? null) as string | null,
      unit: (kpi.unit ?? null) as string | null,
      measurement: kpi.measurement as string,
      category: (kpi.category ?? null) as string | null,
      source: kpi.source as string,
      ...(withResults ? { actual: (kpi.actual ?? null) as string | null, score: asNumber(kpi.score), comment: (kpi.comment ?? null) as string | null } : {}),
    };
  }

  private goalRow(goal: any) {
    return {
      id: goal.id as string,
      title: goal.title as string,
      category: (goal.category ?? null) as string | null,
      dueDate: (goal.dueDate ?? null) as string | null,
      progress: Number(goal.progress ?? 0),
      status: goal.status as string,
    };
  }

  private async kpisOf(tenantId: string, reviewId: string): Promise<any[]> {
    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const rows = (await Kpi.findAll({ where: { tenantId, reviewId } })) as any[];
    return rows.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  }

  private async goalsOf(tenantId: string, review: any): Promise<any[]> {
    if (!review.cycleId) return [];
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const rows = (await Goal.findAll({ where: { tenantId, employeeId: review.employeeId, cycleId: review.cycleId } as any })) as any[];
    return rows.sort((a, b) => String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')) || String(a.title).localeCompare(String(b.title)));
  }

  private async loadReview(tenantId: string, reviewId: string, reviewerId?: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review: any = await Review.findOne({ where: { id: reviewId, tenantId, ...(reviewerId ? { reviewerId } : {}) } });
    if (!review) this.fail(HttpStatus.NOT_FOUND, reviewerId ? `Performance review '${reviewId}' is not one you review.` : `Performance review '${reviewId}' not found in this organization.`);
    return review;
  }

  private async planView(tenantId: string, review: any) {
    const [kpis, goals] = await Promise.all([this.kpisOf(tenantId, review.id), this.goalsOf(tenantId, review)]);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: review.employeeId, tenantId }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], raw: true });
    return {
      review: { id: review.id as string, cycle: review.cycle as string, cycleId: (review.cycleId ?? null) as string | null, status: review.status as string, published: Boolean(review.publishedAt) },
      employee: employee ? { id: employee.id as string, name: [employee.firstName, employee.lastName].filter(Boolean).join(' '), employeeCode: (employee.employeeCode ?? null) as string | null } : null,
      planStatus: review.planPublishedAt ? 'PUBLISHED' : 'DRAFT',
      planPublishedAt: review.planPublishedAt ?? null,
      goalsSupported: Boolean(review.cycleId),
      kpis: kpis.map((kpi) => this.kpiRow(kpi, true)),
      goals: goals.map((goal) => this.goalRow(goal)),
      weightTotal: weightTotal(kpis),
      kpiScore: asNumber(review.kpiScore),
      canEdit: review.status !== PerformanceReviewStatus.COMPLETED && !review.publishedAt && !review.closedAt,
      pendingChange: review.pendingChange ?? null,
    };
  }

  // ==========================================
  // Writing
  // ==========================================

  private async save(tenantId: string, review: any, dto: SavePerformancePlanDto) {
    if (review.closedAt) this.fail(HttpStatus.CONFLICT, 'This review was closed, so its KPIs and goals can no longer change.');
    if (review.status === PerformanceReviewStatus.COMPLETED || review.publishedAt) {
      this.fail(HttpStatus.CONFLICT, 'This review is completed, so its KPIs and goals can no longer change.');
    }
    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
    const live = Boolean(review.planPublishedAt);
    let changed = false;

    if (dto.kpis !== undefined) {
      const items = normalizeItems(dto.kpis);
      if (weightTotal(items) > 100) this.fail(HttpStatus.BAD_REQUEST, `The KPI weights add up to ${weightTotal(items)}. They cannot add up to more than 100.`);
      const existing = await this.kpisOf(tenantId, review.id);
      const byId = new Map(existing.map((row) => [row.id, row]));
      for (const item of dto.kpis) if (item.id && !byId.has(item.id)) this.fail(HttpStatus.BAD_REQUEST, 'One of the KPIs is not part of this review.');
      const kept = new Set(dto.kpis.map((item) => item.id).filter(Boolean));
      for (const row of existing) {
        if (kept.has(row.id)) continue;
        if (row.score !== null && row.score !== undefined) this.fail(HttpStatus.CONFLICT, `The KPI "${row.title}" has been scored, so it cannot be removed.`);
        await row.destroy();
        await this.audit(tenantId, 'review_kpis', row.id, review.id, 'DELETE', { title: { from: row.title, to: null } });
        changed = true;
      }
      for (const [index, item] of items.entries()) {
        const input = dto.kpis[index];
        const row = input.id ? byId.get(input.id) : null;
        if (row) {
          const patch: Record<string, unknown> = {};
          const diff: Record<string, { from: unknown; to: unknown }> = {};
          for (const field of KPI_FIELDS) {
            const next = (item as any)[field];
            const before = (row as any)[field] ?? null;
            if ((before ?? null) !== (next ?? null)) {
              patch[field] = next;
              diff[field] = { from: before, to: next };
            }
          }
          if (Number(row.sortOrder) !== (index + 1) * 10) patch.sortOrder = (index + 1) * 10;
          if (Object.keys(patch).length) {
            await row.update(patch);
            if (Object.keys(diff).length) {
              await this.audit(tenantId, 'review_kpis', row.id, review.id, 'UPDATE', diff);
              changed = true;
            }
          }
        } else {
          const created: any = await Kpi.create({
            tenantId,
            employeeId: review.employeeId,
            reviewId: review.id,
            cycleId: review.cycleId ?? null,
            templateId: null,
            title: item.title,
            description: item.description,
            weight: item.weight,
            target: item.target,
            unit: item.unit,
            measurement: item.measurement,
            category: item.category,
            source: 'MANUAL',
            sortOrder: (index + 1) * 10,
            publishedAt: live ? new Date() : null,
          } as any);
          await this.audit(tenantId, 'review_kpis', created.id, review.id, 'CREATE', { title: { from: null, to: item.title }, weight: { from: null, to: item.weight } });
          changed = true;
        }
      }
    }

    if (dto.goals !== undefined) {
      if (!review.cycleId) this.fail(HttpStatus.BAD_REQUEST, 'Goals belong to a review cycle, and this review is not part of one.');
      const existing = await this.goalsOf(tenantId, review);
      const byId = new Map(existing.map((row) => [row.id, row]));
      for (const item of dto.goals) if (item.id && !byId.has(item.id)) this.fail(HttpStatus.BAD_REQUEST, 'One of the goals is not part of this review.');
      const kept = new Set(dto.goals.map((item) => item.id).filter(Boolean));
      for (const row of existing) {
        if (kept.has(row.id)) continue;
        if (Number(row.progress) > 0) this.fail(HttpStatus.CONFLICT, `The goal "${row.title}" already has progress, so it cannot be removed.`);
        await row.destroy();
        await this.audit(tenantId, 'performance_goals', row.id, review.id, 'DELETE', { title: { from: row.title, to: null } });
        changed = true;
      }
      for (const item of dto.goals) {
        const row = item.id ? byId.get(item.id) : null;
        if (row) {
          const diff: Record<string, { from: unknown; to: unknown }> = {};
          const patch: Record<string, unknown> = {};
          const next = { title: item.title.trim(), category: item.category?.trim() || null, dueDate: item.dueDate ? String(item.dueDate).slice(0, 10) : null };
          for (const field of ['title', 'category', 'dueDate'] as const) {
            const before = field === 'dueDate' && row.dueDate ? String(row.dueDate).slice(0, 10) : (row[field] ?? null);
            if ((before ?? null) !== (next[field] ?? null)) {
              patch[field] = next[field];
              diff[field] = { from: before, to: next[field] };
            }
          }
          if (Object.keys(patch).length) {
            await row.update(patch);
            await this.audit(tenantId, 'performance_goals', row.id, review.id, 'UPDATE', diff);
            changed = true;
          }
        } else {
          const created: any = await Goal.create({
            tenantId,
            employeeId: review.employeeId,
            cycleId: review.cycleId,
            title: item.title.trim(),
            category: item.category?.trim() || null,
            progress: 0,
            status: PerformanceGoalStatus.NOT_STARTED,
            dueDate: item.dueDate ? String(item.dueDate).slice(0, 10) : null,
            publishedAt: live ? new Date() : null,
          } as any);
          await this.audit(tenantId, 'performance_goals', created.id, review.id, 'CREATE', { title: { from: null, to: created.title } });
          changed = true;
        }
      }
    }

    // A plan the employee can already see: tell them it changed.
    if (changed && live) await this.notify(tenantId, review.employeeId, `Your ${review.cycle} goals were updated`, `Your reviewer changed your KPIs or goals for ${review.cycle}. Open My Performance to see them.`);
    return this.planView(tenantId, review);
  }

  private async publish(tenantId: string, review: any, actorEmail?: string) {
    if (review.closedAt) this.fail(HttpStatus.CONFLICT, 'This review was closed, so its plan can no longer be published.');
    if (review.status === PerformanceReviewStatus.COMPLETED || review.publishedAt) this.fail(HttpStatus.CONFLICT, 'This review is completed, so its plan can no longer be published.');
    if (review.planPublishedAt) return this.planView(tenantId, review);
    const [kpis, goals] = await Promise.all([this.kpisOf(tenantId, review.id), this.goalsOf(tenantId, review)]);
    if (!kpis.length && !goals.length) this.fail(HttpStatus.BAD_REQUEST, 'Add at least one KPI or goal before publishing.');
    if (kpis.length && weightTotal(kpis) !== 100) this.fail(HttpStatus.BAD_REQUEST, `The KPI weights add up to ${weightTotal(kpis)}. They must add up to 100 before the plan is published.`);
    const now = new Date();
    for (const row of [...kpis, ...goals]) await row.update({ publishedAt: now });
    await review.update({ planPublishedAt: now, planPublishedByEmail: actorEmail ?? currentRpcActor()?.email ?? null });
    await this.audit(tenantId, 'performance_reviews', review.id, review.id, 'UPDATE', { event: { from: null, to: 'PLAN_PUBLISHED' }, kpis: { from: null, to: kpis.length }, goals: { from: null, to: goals.length } });
    await this.notify(tenantId, review.employeeId, `Your ${review.cycle} goals are set`, `Your KPIs and goals for ${review.cycle} are ready. Open My Performance to read them.`);
    return this.planView(tenantId, review);
  }

  private async unpublish(tenantId: string, review: any) {
    if (review.status === PerformanceReviewStatus.COMPLETED || review.publishedAt) this.fail(HttpStatus.CONFLICT, 'This review is completed, so its plan can no longer be taken back.');
    if (!review.planPublishedAt) return this.planView(tenantId, review);
    const [kpis, goals] = await Promise.all([this.kpisOf(tenantId, review.id), this.goalsOf(tenantId, review)]);
    for (const row of [...kpis, ...goals]) await row.update({ publishedAt: null });
    await review.update({ planPublishedAt: null, planPublishedByEmail: null });
    await this.audit(tenantId, 'performance_reviews', review.id, review.id, 'UPDATE', { event: { from: null, to: 'PLAN_UNPUBLISHED' } });
    return this.planView(tenantId, review);
  }

  // ==========================================
  // The reviewer's own: the goal-setting action
  // ==========================================

  async reviewerPlan(tenantId: string, userId: string, email: string | undefined, reviewId: string) {
    const me = await this.me(tenantId, userId, email);
    return this.planView(tenantId, await this.loadReview(tenantId, reviewId, me.id));
  }

  async reviewerSave(tenantId: string, userId: string, email: string | undefined, reviewId: string, dto: SavePerformancePlanDto) {
    const me = await this.me(tenantId, userId, email);
    return this.save(tenantId, await this.loadReview(tenantId, reviewId, me.id), dto);
  }

  async reviewerPublish(tenantId: string, userId: string, email: string | undefined, reviewId: string) {
    const me = await this.me(tenantId, userId, email);
    return this.publish(tenantId, await this.loadReview(tenantId, reviewId, me.id), email);
  }

  // ==========================================
  // HR and others with performance permissions (data scope applies)
  // ==========================================

  /** The review, if the caller may open it (their data scope and the history rules), as the other admin screens do. */
  private async visibleReview(tenantId: string, reviewId: string) {
    await this.dashboard.getReview(tenantId, reviewId);
    return this.loadReview(tenantId, reviewId);
  }

  async adminPlan(tenantId: string, reviewId: string) {
    return this.planView(tenantId, await this.visibleReview(tenantId, reviewId));
  }

  async adminSave(tenantId: string, reviewId: string, dto: SavePerformancePlanDto) {
    return this.save(tenantId, await this.visibleReview(tenantId, reviewId), dto);
  }

  async adminPublish(tenantId: string, reviewId: string, email?: string) {
    return this.publish(tenantId, await this.visibleReview(tenantId, reviewId), email);
  }

  async adminUnpublish(tenantId: string, reviewId: string) {
    return this.unpublish(tenantId, await this.visibleReview(tenantId, reviewId));
  }

  /** What changed in a review's plan and evaluation, newest first. */
  async history(tenantId: string, reviewId: string) {
    const review = await this.visibleReview(tenantId, reviewId);
    const Log = await this.modelProvider.getEntityAuditLogModel(tenantId);
    const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
    const kpiIds = ((await Kpi.findAll({ where: { tenantId, reviewId }, attributes: ['id'], raw: true })) as unknown as { id: string }[]).map((row) => row.id);
    const rows = (await Log.findAll({
      where: {
        tableName: { [Op.in]: ['review_kpis', 'performance_goals', 'performance_reviews'] },
        [Op.or]: [{ recordId: { [Op.in]: [reviewId, ...kpiIds] } }, sqlWhere(literal(`"EntityAuditLog"."changes"->'reviewId'->>'to'`), reviewId)],
      } as any,
      order: [['createdAt', 'DESC']],
      limit: 300,
    })) as any[];
    return {
      review: { id: review.id as string, cycle: review.cycle as string },
      data: rows.map((row) => {
        const { reviewId: _scope, actor, ...changes } = (row.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
        return { at: row.createdAt as Date, about: row.tableName === 'review_kpis' ? 'KPI' : row.tableName === 'performance_goals' ? 'GOAL' : 'REVIEW', action: row.action as string, by: (actor?.to ?? null) as string | null, changes };
      }),
    };
  }

  // ==========================================
  // The employee's own
  // ==========================================

  /** My KPIs and goals for each review whose plan has been published. Results appear once the review is published to me. */
  async myPlans(tenantId: string, userId: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const reviews = ((await Review.findAll({ where: { tenantId, employeeId: me.id, planPublishedAt: { [Op.ne]: null } } as any, order: [['createdAt', 'DESC']], limit: 50 })) as any[]).filter((row) => row.planPublishedAt);
    const data = [];
    for (const review of reviews) {
      const [kpis, goals] = await Promise.all([this.kpisOf(tenantId, review.id), this.goalsOf(tenantId, review)]);
      const published = Boolean(review.publishedAt);
      data.push({
        review: { id: review.id as string, cycle: review.cycle as string, status: review.status as string, published },
        kpis: kpis.map((kpi) => this.kpiRow(kpi, published)),
        goals: goals.filter((goal) => goal.publishedAt).map((goal) => this.goalRow(goal)),
        weightTotal: weightTotal(kpis),
        kpiScore: published ? asNumber(review.kpiScore) : null,
      });
    }
    return { data };
  }
}
