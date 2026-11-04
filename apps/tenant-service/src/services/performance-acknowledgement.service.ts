import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  AcknowledgeDto,
  AcknowledgementAgreement,
  EmployeeNotificationKind,
  GetAcknowledgementsQueryDto,
  PipStatus,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { PermissionHoldersService } from './permission-holders.service';
import { writePayrollAudit as writeAudit } from './payroll-access';

const TABLE = 'performance_acknowledgements';
const nameOf = (row?: { firstName?: string | null; lastName?: string | null } | null) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '');

/**
 * The employee's acknowledgement of a published review or of their PIP: read,
 * agree or not, and a comment. It is recorded beside the record and never
 * changes the rating or the plan. Once only: a second attempt returns the first.
 * A disagreement tells HR and the manager.
 */
@Injectable()
export class PerformanceAcknowledgementService {
  private readonly logger = new Logger(PerformanceAcknowledgementService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
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
      this.logger.warn(`An acknowledgement notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName', 'reportingManagerId'] }) : null;
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName', 'reportingManagerId'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  private view(row: any) {
    return { at: row.acknowledgedAt as Date, agreement: row.agreement as string, comment: (row.comment ?? null) as string | null };
  }

  private async record(tenantId: string, kind: 'REVIEW' | 'PIP', recordId: string, me: any, dto: AcknowledgeDto, label: string, managerId: string | null) {
    const Ack = await this.modelProvider.getPerformanceAcknowledgementModel(tenantId);
    const existing: any = await Ack.findOne({ where: { tenantId, kind, recordId, employeeId: me.id } });
    if (existing) return { ...this.view(existing), alreadyAcknowledged: true };
    const agreement = dto.agreement ?? AcknowledgementAgreement.NOTED;
    if (agreement === AcknowledgementAgreement.DISAGREE && !dto.comment?.trim()) this.fail(HttpStatus.BAD_REQUEST, 'Say why you disagree, so HR can look into it.');
    const created: any = await Ack.create({ tenantId, employeeId: me.id, kind, recordId, agreement, comment: dto.comment?.trim() || null, acknowledgedAt: new Date() } as any);
    await writeAudit(this.modelProvider, this.logger, tenantId, TABLE, created.id, 'CREATE', { kind: { from: null, to: kind }, recordId: { from: null, to: recordId }, agreement: { from: null, to: agreement } });
    if (agreement === AcknowledgementAgreement.DISAGREE) {
      const who = nameOf(me) || 'An employee';
      await this.holders?.tellPermission(tenantId, 'performance.manage', [me.id], `${who} disagrees with ${label}`, `${who} acknowledged ${label} and disagrees: ${dto.comment!.trim()}`);
      await this.notify(tenantId, managerId, `${who} disagrees with ${label}`, `${who} acknowledged ${label} and disagrees: ${dto.comment!.trim()}`);
    }
    return { ...this.view(created), alreadyAcknowledged: false };
  }

  /** The employee acknowledges their own published review. */
  async acknowledgeReview(tenantId: string, userId: string, email: string | undefined, reviewId: string, dto: AcknowledgeDto) {
    const me = await this.me(tenantId, userId, email);
    const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
    const review: any = await Review.findOne({ where: { id: reviewId, tenantId, employeeId: me.id } });
    if (!review) this.fail(HttpStatus.NOT_FOUND, 'Review not found.');
    if (!review.publishedAt) this.fail(HttpStatus.CONFLICT, 'This review has not been shared with you yet.');
    return this.record(tenantId, 'REVIEW', review.id, me, dto, 'their performance review', review.reviewerId ?? me.reportingManagerId ?? null);
  }

  /** The employee acknowledges their own improvement plan, once it is approved. */
  async acknowledgePip(tenantId: string, userId: string, email: string | undefined, planId: string, dto: AcknowledgeDto) {
    const me = await this.me(tenantId, userId, email);
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const plan: any = await Plan.findOne({ where: { id: planId, tenantId, employeeId: me.id } });
    if (!plan || !plan.approvedAt) this.fail(HttpStatus.NOT_FOUND, 'Improvement plan not found.');
    if (![PipStatus.ACTIVE, PipStatus.CLOSED].includes(plan.status)) this.fail(HttpStatus.CONFLICT, 'This plan cannot be acknowledged.');
    return this.record(tenantId, 'PIP', plan.id, me, dto, 'their improvement plan', plan.proposedById ?? me.reportingManagerId ?? null);
  }

  /** The acknowledgement (if any) of each review id, for adding to review rows. */
  async forReviews(tenantId: string, reviewIds: string[]): Promise<Map<string, { at: Date; agreement: string; comment: string | null }>> {
    if (!reviewIds.length) return new Map();
    const Ack = await this.modelProvider.getPerformanceAcknowledgementModel(tenantId);
    const rows = (await Ack.findAll({ where: { tenantId, kind: 'REVIEW', recordId: { [Op.in]: reviewIds } } })) as any[];
    return new Map(rows.map((row) => [row.recordId, this.view(row)]));
  }

  /**
   * HR's list: published reviews and approved plans with their acknowledgement,
   * or without it (PENDING, the default), limited to who the caller may see.
   */
  async list(tenantId: string, query: GetAcknowledgementsQueryDto) {
    const status = query.status ?? 'PENDING';
    const Ack = await this.modelProvider.getPerformanceAcknowledgementModel(tenantId);
    const scope = this.dataScope ? await this.dataScope.employeeWhere(tenantId) : {};
    const acks = (await Ack.findAll({ where: { tenantId, ...scope } as any, limit: 2000 })) as any[];
    const done = new Map(acks.map((row) => [`${row.kind}:${row.recordId}`, row]));

    const entries: { kind: 'REVIEW' | 'PIP'; recordId: string; employeeId: string; subject: string; at: Date | null }[] = [];
    if (!query.kind || query.kind === 'REVIEW') {
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      const reviews = (await Review.findAll({ where: { tenantId, publishedAt: { [Op.ne]: null }, ...scope } as any, order: [['publishedAt', 'DESC']], limit: 500 })) as any[];
      for (const review of reviews) entries.push({ kind: 'REVIEW', recordId: review.id, employeeId: review.employeeId, subject: review.cycle ?? 'Performance review', at: review.publishedAt ?? null });
    }
    if (!query.kind || query.kind === 'PIP') {
      const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
      const plans = (await Plan.findAll({ where: { tenantId, status: { [Op.in]: [PipStatus.ACTIVE, PipStatus.CLOSED] }, ...scope } as any, order: [['approvedAt', 'DESC']], limit: 500 })) as any[];
      for (const plan of plans) entries.push({ kind: 'PIP', recordId: plan.id, employeeId: plan.employeeId, subject: 'Improvement plan', at: plan.approvedAt ?? null });
    }

    const wanted = entries.filter((entry) => {
      const ack = done.get(`${entry.kind}:${entry.recordId}`);
      if (status === 'PENDING') return !ack;
      if (status === 'DISAGREED') return ack?.agreement === AcknowledgementAgreement.DISAGREE;
      return Boolean(ack);
    });

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const ids = [...new Set(wanted.map((entry) => entry.employeeId))];
    const people = ids.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], raw: true })) as any[]) : [];
    const byId = new Map(people.map((person) => [person.id, person]));
    const data = wanted.map((entry) => {
      const person = byId.get(entry.employeeId);
      const ack = done.get(`${entry.kind}:${entry.recordId}`);
      return {
        kind: entry.kind,
        recordId: entry.recordId,
        subject: entry.subject,
        sharedAt: entry.at,
        employee: person ? { id: person.id as string, name: nameOf(person), employeeCode: (person.employeeCode ?? null) as string | null } : { id: entry.employeeId, name: null, employeeCode: null },
        acknowledgement: ack ? this.view(ack) : null,
      };
    });
    return { data, total: data.length };
  }
}
