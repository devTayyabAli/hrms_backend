import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  EmployeeNotificationKind,
  EmployeeStatus,
  PerformanceReviewStatus,
  ReviewChangeDecisionDto,
  ReviewChangeDecision,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { KpiTemplateService } from './kpi-template.service';
import { PermissionHoldersService } from './permission-holders.service';
import { buildReviewSnapshot } from './performance-snapshot';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { currentRpcActor } from '@app/tenant-context';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const nameOf = (row?: { firstName?: string | null; lastName?: string | null } | null) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '');

export interface PendingReviewChange {
  type: 'TRANSFER' | 'ELIGIBILITY' | 'MANAGER';
  detectedAt: string;
  /** What the review was set up for. */
  from: { departmentId: string | null; departmentName: string | null; designationId: string | null; designationTitle: string | null } | null;
  /** What the employee is now. */
  to: { departmentId: string | null; departmentName: string | null; designationId: string | null; designationTitle: string | null } | null;
  /** Why the cycle's rules no longer include them, when they do not. */
  eligibilityReason?: string | null;
  /** Their reporting manager changed: who is reviewing now, and who their manager is now. */
  manager?: { from: { id: string | null; name: string | null } | null; to: { id: string | null; name: string | null } | null } | null;
  options: ReviewChangeDecision[];
}

/**
 * Employee Management changed someone while a review of theirs was open. The
 * review does not silently change its criteria or reviewer: it is flagged, and
 * HR decides to keep it as it is, give it to the new manager, restart it on the
 * new department's KPIs, or take the person out of the cycle. That holds for a
 * new department or designation and for a new reporting manager alike. Reviews already
 * completed keep what they recorded, and someone who leaves has their open
 * reviews closed, never deleted.
 */
@Injectable()
export class PerformanceSyncService {
  private readonly logger = new Logger(PerformanceSyncService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly dashboard: PerformanceDashboardService,
    private readonly templates: KpiTemplateService,
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
      this.logger.warn(`A performance notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  /** Reviews of this person that can still change: not completed, not published, not closed. */
  private async openReviews(tenantId: string, employeeId: string): Promise<any[]> {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows = (await Review.findAll({ where: { tenantId, employeeId, status: { [Op.ne]: PerformanceReviewStatus.COMPLETED } } as any })) as any[];
    return rows.filter((row) => !row.publishedAt && !row.closedAt);
  }

  private async labels(tenantId: string, departmentId: string | null | undefined, designationId: string | null | undefined) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const [department, designation] = await Promise.all([
      departmentId ? (Department.findOne({ where: { id: departmentId, tenantId }, attributes: ['name'], raw: true }) as Promise<any>).catch(() => null) : Promise.resolve(null),
      designationId ? (Designation.findOne({ where: { id: designationId, tenantId }, attributes: ['title'], raw: true }) as Promise<any>).catch(() => null) : Promise.resolve(null),
    ]);
    return { departmentId: departmentId ?? null, departmentName: department?.name ?? null, designationId: designationId ?? null, designationTitle: designation?.title ?? null };
  }

  // ==========================================
  // What Employee Management tells it
  // ==========================================

  /**
   * Someone's department or designation changed. Their open reviews are flagged
   * for HR's decision (the review keeps its reviewer and KPIs until then), and
   * HR and the reviewer are told. Future cycles and KPIs follow the new
   * department by themselves. Returns how many reviews were flagged.
   */
  async onAssignmentChange(
    tenantId: string,
    employeeId: string,
    before: { departmentId?: string | null; designationId?: string | null },
    after: { departmentId?: string | null; designationId?: string | null },
  ): Promise<number> {
    const departmentMoved = after.departmentId !== undefined && (before.departmentId ?? null) !== (after.departmentId ?? null);
    const designationMoved = after.designationId !== undefined && (before.designationId ?? null) !== (after.designationId ?? null);
    if (!departmentMoved && !designationMoved) return 0;
    const open = await this.openReviews(tenantId, employeeId);
    if (!open.length) return 0;

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) return 0;
    const to = await this.labels(tenantId, employee.departmentId, employee.designationId);
    const fromNow = await this.labels(tenantId, before.departmentId, before.designationId);
    const who = nameOf(employee) || 'an employee';

    let flagged = 0;
    for (const review of open) {
      const existing = review.pendingChange as PendingReviewChange | null;
      // The "from" is what the review was set up for: kept from the first change, not rewritten by a second.
      const from = existing?.from ?? (review.employeeSnapshot ? { departmentId: review.employeeSnapshot.departmentId ?? null, departmentName: review.employeeSnapshot.departmentName ?? null, designationId: review.employeeSnapshot.designationId ?? null, designationTitle: review.employeeSnapshot.designationTitle ?? null } : fromNow);
      const pending: PendingReviewChange = {
        type: 'TRANSFER',
        detectedAt: existing?.detectedAt ?? new Date().toISOString(),
        from,
        to,
        eligibilityReason: existing?.eligibilityReason ?? null,
        manager: existing?.manager ?? null,
        options: [ReviewChangeDecision.KEEP, ReviewChangeDecision.REASSIGN, ReviewChangeDecision.RESTART, ReviewChangeDecision.REMOVE],
      };
      await review.update({ pendingChange: pending });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', {
        event: { from: null, to: 'TRANSFER_DETECTED' },
        department: { from: from?.departmentName ?? null, to: to.departmentName },
        designation: { from: from?.designationTitle ?? null, to: to.designationTitle },
      });
      await this.notify(tenantId, review.reviewerId, `Decision needed on ${who}'s review`, `${who} moved (${to.departmentName ?? 'a new department'}), and their ${review.cycle} review is still open. HR will decide whether it stays as it is.`);
      await this.holders?.tellPermission(tenantId, 'performance.manage', [employeeId], `Transfer decision needed: ${who}`, `${who}'s ${review.cycle} review is open and ${who} moved to ${to.departmentName ?? 'a new department'}. Keep it, give it to the new manager, restart it on the new KPIs, or remove them from the cycle.`);
      flagged++;
    }
    return flagged;
  }

  /**
   * Someone's reporting manager changed. Their open reviews that HR did not pin
   * to a particular reviewer are not handed to the new manager by themselves:
   * each is flagged, and HR and the current reviewer are told. HR keeps the
   * reviewer or gives the review to the new manager. A review with several
   * evaluators, one HR chose a reviewer for, a finished one and a closed one
   * are left as they are. Returns how many were flagged.
   */
  async onManagerChange(tenantId: string, employeeId: string): Promise<number> {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows = (await Review.findAll({ where: { tenantId, employeeId, status: { [Op.ne]: PerformanceReviewStatus.COMPLETED }, reviewerPinned: false } as any })) as any[];
    const open = rows.filter((row) => !row.publishedAt && !row.closedAt && !row.multiReviewer);
    if (!open.length) return 0;

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) return 0;
    const nextId = await this.dashboard.managerOf(tenantId, employee);
    const ids = [...new Set([nextId, ...open.map((row) => row.reviewerId)].filter(Boolean))] as string[];
    const people = ids.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'firstName', 'lastName'], raw: true })) as any[]) : [];
    const label = (id: string | null) => (id ? { id, name: nameOf(people.find((row) => row.id === id)) || null } : null);
    const who = nameOf(employee) || 'an employee';

    let flagged = 0;
    for (const review of open) {
      const existing = review.pendingChange as PendingReviewChange | null;
      if ((review.reviewerId ?? null) === nextId) {
        // The reviewer is the right person again: a flag that only said otherwise is dropped.
        if (existing?.type === 'MANAGER') {
          await review.update({ pendingChange: null });
          await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', { event: { from: null, to: 'MANAGER_CHANGE_RESOLVED' } });
        } else if (existing?.manager) {
          await review.update({ pendingChange: { ...existing, manager: null } });
        }
        continue;
      }
      const manager = { from: label(review.reviewerId ?? null), to: label(nextId) };
      const pending: PendingReviewChange = existing
        ? { ...existing, manager, options: [...new Set([...existing.options, ReviewChangeDecision.KEEP, ReviewChangeDecision.REASSIGN])] }
        : { type: 'MANAGER', detectedAt: new Date().toISOString(), from: null, to: null, eligibilityReason: null, manager, options: [ReviewChangeDecision.KEEP, ReviewChangeDecision.REASSIGN] };
      await review.update({ pendingChange: pending });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', {
        event: { from: null, to: 'MANAGER_CHANGE_DETECTED' },
        reviewerId: { from: review.reviewerId ?? null, to: nextId },
      });
      await this.notify(tenantId, review.reviewerId, `Decision needed on ${who}'s review`, `${who}'s reporting manager changed, and their ${review.cycle} review is still open. HR will decide whether you keep it or it goes to the new manager.`);
      await this.holders?.tellPermission(tenantId, 'performance.manage', [employeeId], `Manager change: ${who}`, `${who} has a new reporting manager and their ${review.cycle} review is open with ${manager.from?.name ?? 'no reviewer'}. Keep that reviewer, or give the review to ${manager.to?.name ?? 'HR'}.`);
      flagged++;
    }
    return flagged;
  }

  /**
   * Employment details that decide who is reviewed and how (status, employment
   * type, probation, contract) changed in Employee Management. Each open review
   * of theirs records it in its audit history, so the reason for a later
   * eligibility flag or a changed assignment can be traced. Nothing is changed
   * on the review itself. Returns how many reviews recorded it.
   */
  async recordEmploymentChange(tenantId: string, employeeId: string, changes: Record<string, { from: unknown; to: unknown }>): Promise<number> {
    const moved = Object.fromEntries(Object.entries(changes).filter(([, change]) => (change.from ?? null) !== (change.to ?? null)));
    if (!Object.keys(moved).length) return 0;
    const open = await this.openReviews(tenantId, employeeId);
    for (const review of open) {
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', { event: { from: null, to: 'EMPLOYEE_INFO_CHANGED' }, ...moved });
    }
    return open.length;
  }

  /**
   * The employee left. Their open reviews are closed, with the reason, and
   * nothing is deleted: what was written stays readable to those who may read
   * it. Their pending decisions are dropped. Returns how many were closed.
   */
  async closeForExit(tenantId: string, employeeId: string): Promise<number> {
    const open = await this.openReviews(tenantId, employeeId);
    for (const review of open) {
      await review.update({ closedReason: 'EMPLOYEE_EXITED', closedAt: new Date(), pendingChange: null });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', {
        event: { from: null, to: 'REVIEW_CLOSED_EMPLOYEE_EXITED' },
        status: { from: review.status, to: review.status },
      });
      await this.notify(tenantId, review.reviewerId, 'Review closed: employee left', `The ${review.cycle} review you were to complete was closed because the employee left. What was written is kept.`);
    }
    return open.length;
  }

  /**
   * A cycle's rules no longer include someone who has an open review in it (a
   * contract or department change, say). Flagged for HR, never removed by itself.
   */
  async flagEligibility(tenantId: string, review: any, reason: string): Promise<void> {
    if (review.closedAt || review.publishedAt || review.status === PerformanceReviewStatus.COMPLETED) return;
    const existing = review.pendingChange as PendingReviewChange | null;
    if (existing?.eligibilityReason === reason) return;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: review.employeeId, tenantId } });
    const pending: PendingReviewChange = existing
      ? { ...existing, eligibilityReason: reason, options: [...new Set([...existing.options, ReviewChangeDecision.REMOVE])] }
      : { type: 'ELIGIBILITY', detectedAt: new Date().toISOString(), from: null, to: employee ? await this.labels(tenantId, employee.departmentId, employee.designationId) : null, eligibilityReason: reason, options: [ReviewChangeDecision.KEEP, ReviewChangeDecision.REMOVE] };
    await review.update({ pendingChange: pending });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', { event: { from: null, to: 'ELIGIBILITY_CHANGED' }, reason: { from: null, to: reason } });
    const who = nameOf(employee) || 'an employee';
    await this.holders?.tellPermission(tenantId, 'performance.manage', [review.employeeId], `Eligibility changed: ${who}`, `${who} is no longer included in ${review.cycle} (${reason}) but has an open review. Keep it or remove them from the cycle.`);
  }

  /** They are eligible again: the flag that said otherwise is dropped. */
  async clearEligibility(tenantId: string, review: any): Promise<void> {
    const existing = review.pendingChange as PendingReviewChange | null;
    if (!existing?.eligibilityReason) return;
    const next = existing.type === 'ELIGIBILITY' ? null : { ...existing, eligibilityReason: null };
    await review.update({ pendingChange: next });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', { event: { from: null, to: 'ELIGIBILITY_RESTORED' } });
  }

  // ==========================================
  // HR's side
  // ==========================================

  private pendingRow(review: any, employee: any, reviewer: any) {
    const pending = review.pendingChange as PendingReviewChange;
    return {
      reviewId: review.id as string,
      cycle: review.cycle as string,
      employee: employee ? { id: employee.id as string, name: nameOf(employee), employeeCode: (employee.employeeCode ?? null) as string | null } : null,
      reviewer: reviewer ? { id: reviewer.id as string, name: nameOf(reviewer) } : null,
      type: pending.type,
      detectedAt: pending.detectedAt,
      from: pending.from,
      to: pending.to,
      eligibilityReason: pending.eligibilityReason ?? null,
      manager: pending.manager ?? null,
      options: pending.options,
    };
  }

  /** Reviews waiting for a decision, oldest first, among those the caller may open. */
  async pending(tenantId: string) {
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const rows = ((await Review.findAll({ where: { tenantId, pendingChange: { [Op.ne]: null }, ...(await this.dashboard.reviewScope(tenantId)) } as any, limit: 200 })) as any[]).filter((row) => row.pendingChange && !row.closedAt);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const ids = [...new Set(rows.flatMap((row) => [row.employeeId, row.reviewerId]).filter(Boolean))] as string[];
    const people = ids.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], raw: true })) as any[]) : [];
    const byId = new Map(people.map((row) => [row.id, row]));
    rows.sort((a, b) => String(a.pendingChange.detectedAt).localeCompare(String(b.pendingChange.detectedAt)));
    return { data: rows.map((row) => this.pendingRow(row, byId.get(row.employeeId), row.reviewerId ? byId.get(row.reviewerId) : null)), total: rows.length };
  }

  private async load(tenantId: string, reviewId: string) {
    await this.dashboard.getReview(tenantId, reviewId);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    return (await Review.findOne({ where: { id: reviewId, tenantId } })) as any;
  }

  /** HR decides what happens to a review whose person changed. */
  async decide(tenantId: string, reviewId: string, dto: ReviewChangeDecisionDto) {
    const review = await this.load(tenantId, reviewId);
    const pending = review.pendingChange as PendingReviewChange | null;
    if (!pending) this.fail(HttpStatus.CONFLICT, 'Nothing is waiting for a decision on this review.');
    if (review.closedAt || review.publishedAt || review.status === PerformanceReviewStatus.COMPLETED) this.fail(HttpStatus.CONFLICT, 'This review is already finished, so it keeps what it recorded.');
    if (!pending.options.includes(dto.decision)) this.fail(HttpStatus.BAD_REQUEST, `${dto.decision} is not one of the choices for this change.`);

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: review.employeeId, tenantId } });
    const note = dto.note?.trim() || null;
    const audit = (event: string, extra: Record<string, { from: unknown; to: unknown }> = {}) =>
      writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', { event: { from: null, to: event }, ...(note ? { note: { from: null, to: note } } : {}), ...extra });

    if (dto.decision === ReviewChangeDecision.KEEP) {
      await review.update({ pendingChange: null });
      await audit('CHANGE_DECISION_KEEP');
    } else if (dto.decision === ReviewChangeDecision.REASSIGN) {
      const next = dto.reviewerId ?? (employee?.reportingManagerId ?? null);
      if (next && next === review.employeeId) this.fail(HttpStatus.BAD_REQUEST, 'Someone cannot review themselves.');
      if (next) {
        const person: any = await Employee.findOne({ where: { id: next, tenantId }, attributes: ['id', 'status'] });
        if (!person || !EMPLOYED.includes(person.status)) this.fail(HttpStatus.BAD_REQUEST, 'The reviewer was not found, or no longer works here.');
      }
      const before = review.reviewerId ?? null;
      await review.update({ pendingChange: null, reviewerId: next, reviewerPinned: Boolean(dto.reviewerId) });
      await audit('CHANGE_DECISION_REASSIGN', { reviewerId: { from: before, to: next } });
      if (next && next !== before) await this.notify(tenantId, next, `Review to complete: ${nameOf(employee)}`, `You are now the reviewer for ${nameOf(employee)}'s ${review.cycle} performance review.`);
    } else if (dto.decision === ReviewChangeDecision.RESTART) {
      const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
      const kpis = (await Kpi.findAll({ where: { tenantId, reviewId } })) as any[];
      if (kpis.some((kpi) => kpi.score !== null && kpi.score !== undefined)) this.fail(HttpStatus.CONFLICT, 'Some KPIs have already been scored, so the review cannot restart. Keep it, or remove the person from the cycle.');
      for (const kpi of kpis) {
        await kpi.destroy();
        await writeAudit(this.modelProvider, this.logger, tenantId, 'review_kpis', kpi.id, 'DELETE', { reviewId: { from: null, to: reviewId }, title: { from: kpi.title, to: null } });
      }
      const assigned = employee ? await this.templates.assignToReview(tenantId, { id: review.id, employeeId: review.employeeId, cycleId: review.cycleId }, employee) : { count: 0 };
      // The plan goes back to a draft for the reviewer to set again against the new department.
      if (review.planPublishedAt) {
        const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
        if (review.cycleId) await Goal.update({ publishedAt: null } as any, { where: { tenantId, employeeId: review.employeeId, cycleId: review.cycleId } as any });
      }
      await review.update({
        pendingChange: null,
        planPublishedAt: null,
        planPublishedByEmail: null,
        employeeSnapshot: employee ? await buildReviewSnapshot(this.modelProvider, tenantId, employee, review.reviewerId ?? null) : review.employeeSnapshot,
      });
      await audit('CHANGE_DECISION_RESTART', { kpis: { from: kpis.length, to: assigned.count } });
      await this.notify(tenantId, review.reviewerId, `Set goals again for ${nameOf(employee)}`, `${nameOf(employee)}'s ${review.cycle} plan was restarted on their new department's KPIs. Open Reviewing, then the plan, to set and publish it.`);
      await this.notify(tenantId, review.employeeId, `Your ${review.cycle} goals are being reset`, `Your goals for ${review.cycle} are being set again for your new role. You will be told when they are ready.`);
    } else {
      await review.update({ pendingChange: null, closedReason: 'REMOVED_FROM_CYCLE', closedAt: new Date() });
      await audit('CHANGE_DECISION_REMOVE');
      await this.notify(tenantId, review.reviewerId, 'Review closed', `The ${review.cycle} review of ${nameOf(employee)} was closed: they were taken out of the cycle. What was written is kept.`);
      await this.notify(tenantId, review.employeeId, `Your ${review.cycle} review was closed`, `You are no longer part of ${review.cycle}. Nothing you wrote is deleted.`);
    }
    return this.dashboard.getReview(tenantId, reviewId);
  }

  /** HR reopens a review that was closed, when the person is back (or it was closed in error). */
  async reopen(tenantId: string, reviewId: string) {
    const review = await this.load(tenantId, reviewId);
    if (!review.closedAt) this.fail(HttpStatus.CONFLICT, 'This review is not closed.');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: review.employeeId, tenantId }, attributes: ['id', 'status', 'firstName', 'lastName'] });
    if (!employee || !EMPLOYED.includes(employee.status)) this.fail(HttpStatus.CONFLICT, 'This person does not work here, so their review stays closed.');
    const reason = review.closedReason;
    await review.update({ closedReason: null, closedAt: null });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', reviewId, 'UPDATE', { event: { from: null, to: 'REVIEW_REOPENED' }, reason: { from: reason, to: null }, ...(currentRpcActor()?.email ? { reopenedBy: { from: null, to: currentRpcActor()?.email } } : {}) });
    await this.notify(tenantId, review.reviewerId, `Review reopened: ${nameOf(employee)}`, `The ${review.cycle} review of ${nameOf(employee)} is open again.`);
    return this.dashboard.getReview(tenantId, reviewId);
  }
}
