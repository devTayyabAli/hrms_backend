import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  ClosePipDto,
  CreatePipDto,
  DataScope,
  EmployeeNotificationKind,
  EmployeeStatus,
  GetPipsQueryDto,
  MAX_PIP_DAYS,
  PipCheckInDto,
  PipOutcome,
  PipStatus,
  PipTargetDto,
  RejectPipDto,
  TenantErrorCode,
  TenantException,
  UpdatePipDto,
  grantsPermission,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { PermissionHoldersService } from './permission-holders.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import type { PipTarget } from '../models/performance-improvement.model';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const TABLE = 'performance_improvement_plans';
const today = () => new Date().toISOString().slice(0, 10);
const day = (value: unknown) => String(value ?? '').slice(0, 10);
const nameOf = (row?: { firstName?: string | null; lastName?: string | null } | null) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Performance Improvement Plans. A manager proposes one for someone they
 * manage, HR approves it (never the person who proposed it), and only then does
 * the employee see it and acknowledge it. While active it takes check-ins and
 * HR marks its targets; it ends with an outcome. Until it is approved it is
 * confidential to the proposer and HR. Nothing is deleted: a rejected, closed
 * or cancelled plan stays on record, and someone who leaves has theirs closed
 * as cancelled.
 */
@Injectable()
export class PerformancePipService {
  private readonly logger = new Logger(PerformancePipService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly holders?: PermissionHoldersService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private holdsManage(): boolean {
    const rpc = currentRpcActor();
    return !rpc || rpc.isFullAccess === true || grantsPermission(rpc.permissions ?? [], 'performance.manage');
  }

  private async notify(tenantId: string, employeeId: string | null | undefined, title: string, body: string) {
    if (!employeeId) return;
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.PERFORMANCE, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`A PIP notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName'] }) : null;
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  /** Organization-wide callers (HR) see every plan; anyone narrower sees only those they proposed. */
  private async visibleWhere(tenantId: string): Promise<Record<string, unknown>> {
    if (!this.dataScope || this.dataScope.scope() === DataScope.ORGANIZATION) return {};
    const me = await this.dataScope.actorEmployeeId(tenantId);
    return { proposedById: me ?? '00000000-0000-0000-0000-000000000000' };
  }

  private async peopleById(tenantId: string, ids: (string | null | undefined)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Map<string, any>();
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: wanted } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], raw: true })) as any[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async acknowledgementsOf(tenantId: string, ids: string[]) {
    if (!ids.length) return new Map<string, any>();
    const Ack = await this.modelProvider.getPerformanceAcknowledgementModel(tenantId);
    const rows = (await Ack.findAll({ where: { tenantId, kind: 'PIP', recordId: { [Op.in]: ids } } })) as any[];
    return new Map(rows.map((row) => [row.recordId, { at: row.acknowledgedAt, agreement: row.agreement, comment: row.comment ?? null }]));
  }

  private row(plan: any, people: Map<string, any>, acks: Map<string, any>) {
    const employee = people.get(plan.employeeId);
    const proposer = plan.proposedById ? people.get(plan.proposedById) : null;
    return {
      id: plan.id as string,
      employee: employee ? { id: employee.id as string, name: nameOf(employee), employeeCode: (employee.employeeCode ?? null) as string | null } : { id: plan.employeeId as string, name: null, employeeCode: null },
      reviewId: (plan.reviewId ?? null) as string | null,
      proposedBy: proposer ? { id: proposer.id as string, name: nameOf(proposer) } : plan.proposedByEmail ? { id: null, name: plan.proposedByEmail as string } : null,
      reason: plan.reason as string,
      startDate: day(plan.startDate),
      endDate: day(plan.endDate),
      daysLeft: plan.status === PipStatus.ACTIVE ? daysBetween(today(), day(plan.endDate)) : null,
      status: plan.status as string,
      targets: (Array.isArray(plan.targets) ? plan.targets : []) as PipTarget[],
      checkIns: Array.isArray(plan.checkIns) ? plan.checkIns : [],
      extensions: Array.isArray(plan.extensions) ? plan.extensions : [],
      approvedBy: (plan.approvedByEmail ?? null) as string | null,
      approvedAt: plan.approvedAt ?? null,
      rejectionReason: (plan.rejectionReason ?? null) as string | null,
      outcome: (plan.outcome ?? null) as string | null,
      outcomeNote: (plan.outcomeNote ?? null) as string | null,
      closedAt: plan.closedAt ?? null,
      acknowledgement: acks.get(plan.id) ?? null,
    };
  }

  private async view(tenantId: string, plans: any[]) {
    const people = await this.peopleById(tenantId, plans.flatMap((plan) => [plan.employeeId, plan.proposedById]));
    const acks = await this.acknowledgementsOf(tenantId, plans.map((plan) => plan.id));
    return plans.map((plan) => this.row(plan, people, acks));
  }

  private async load(tenantId: string, id: string, scoped = true) {
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const plan: any = await Plan.findOne({ where: { id, tenantId, ...(scoped ? await this.visibleWhere(tenantId) : {}) } as any });
    if (!plan) this.fail(HttpStatus.NOT_FOUND, 'Improvement plan not found.');
    return plan;
  }

  private audit(tenantId: string, id: string, action: 'CREATE' | 'UPDATE', changes: Record<string, { from: unknown; to: unknown }>) {
    return writeAudit(this.modelProvider, this.logger, tenantId, TABLE, id, action, changes);
  }

  private targetsOf(input: PipTargetDto[], existing: PipTarget[] = [], resetStatus = false): PipTarget[] {
    const byId = new Map(existing.map((target) => [target.id, target]));
    return input.map((item) => {
      if (item.id && !byId.has(item.id)) this.fail(HttpStatus.BAD_REQUEST, 'One of the targets is not part of this plan.');
      return {
        id: item.id ?? randomUUID(),
        title: item.title.trim(),
        description: item.description?.trim() || null,
        successCriteria: item.successCriteria?.trim() || null,
        dueDate: item.dueDate ? day(item.dueDate) : null,
        status: resetStatus ? 'OPEN' : (item.status ?? (item.id ? byId.get(item.id)?.status : 'OPEN') ?? 'OPEN'),
      };
    });
  }

  private checkDates(startDate: string, endDate: string) {
    if (endDate <= startDate) this.fail(HttpStatus.BAD_REQUEST, 'The plan has to end after it starts.');
    if (daysBetween(startDate, endDate) > MAX_PIP_DAYS) this.fail(HttpStatus.BAD_REQUEST, `A plan can run at most ${MAX_PIP_DAYS} days.`);
  }

  // ==========================================
  // Proposing
  // ==========================================

  private async create(tenantId: string, dto: CreatePipDto, proposer: { id: string | null; email: string | null }, active: boolean) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: dto.employeeId, tenantId } });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'Employee not found.');
    if (!EMPLOYED.includes(employee.status)) this.fail(HttpStatus.CONFLICT, 'This person no longer works here, so they cannot be given a plan.');
    if (proposer.id && proposer.id === employee.id) this.fail(HttpStatus.FORBIDDEN, 'Nobody proposes a plan for themselves.');
    const startDate = day(dto.startDate);
    const endDate = day(dto.endDate);
    this.checkDates(startDate, endDate);

    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const open = (await Plan.findAll({ where: { tenantId, employeeId: employee.id, status: { [Op.in]: [PipStatus.PROPOSED, PipStatus.ACTIVE] } } as any, attributes: ['id'], raw: true })) as unknown as { id: string }[];
    if (open.length) this.fail(HttpStatus.CONFLICT, 'This person already has an improvement plan that is proposed or running.');
    if (dto.reviewId) {
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      if (!(await Review.count({ where: { id: dto.reviewId, tenantId, employeeId: employee.id } }))) this.fail(HttpStatus.BAD_REQUEST, 'That review is not one of this person\'s.');
    }

    const created: any = await Plan.create({
      tenantId,
      employeeId: employee.id,
      reviewId: dto.reviewId ?? null,
      proposedById: proposer.id,
      proposedByEmail: proposer.email,
      reason: dto.reason.trim(),
      startDate,
      endDate,
      status: active ? PipStatus.ACTIVE : PipStatus.PROPOSED,
      targets: this.targetsOf(dto.targets, [], true),
      checkIns: [],
      extensions: [],
      ...(active ? { approvedByEmail: proposer.email, approvedAt: new Date() } : {}),
    } as any);
    await this.audit(tenantId, created.id, 'CREATE', { event: { from: null, to: active ? 'PIP_STARTED' : 'PIP_PROPOSED' }, employeeId: { from: null, to: employee.id }, endDate: { from: null, to: endDate } });
    const who = nameOf(employee) || 'an employee';
    if (active) {
      await this.notify(tenantId, employee.id, 'An improvement plan was set up for you', `A performance improvement plan runs until ${endDate}. Open My Performance to read it and acknowledge it.`);
    } else {
      await this.holders?.tellPermission(tenantId, 'performance.manage', [employee.id, proposer.id ?? ''], `Improvement plan to approve: ${who}`, `A performance improvement plan was proposed for ${who}. It needs HR's approval before they see it.`);
    }
    return (await this.view(tenantId, [created]))[0];
  }

  /** HR (or anyone who manages performance) starts a plan: it is active at once. Anyone narrower proposes, and HR approves. */
  async createFromAdmin(tenantId: string, dto: CreatePipDto) {
    const rpc = currentRpcActor();
    const me = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId) : null;
    return this.create(tenantId, dto, { id: me, email: rpc?.email ?? null }, this.holdsManage());
  }

  /** A manager proposes a plan for someone who reports to them, or whose review they complete. */
  async proposeAsManager(tenantId: string, userId: string, email: string | undefined, dto: CreatePipDto) {
    const me = await this.me(tenantId, userId, email);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const subject: any = await Employee.findOne({ where: { id: dto.employeeId, tenantId }, attributes: ['id', 'reportingManagerId'] });
    let allowed = Boolean(subject && subject.reportingManagerId === me.id);
    if (subject && !allowed) {
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      allowed = (await Review.count({ where: { tenantId, employeeId: subject.id, reviewerId: me.id } })) > 0;
    }
    if (!allowed) this.fail(HttpStatus.FORBIDDEN, 'You can propose a plan only for someone who reports to you, or whose review you complete.');
    return this.create(tenantId, dto, { id: me.id, email: email ?? null }, false);
  }

  // ==========================================
  // Reading
  // ==========================================

  async list(tenantId: string, query: GetPipsQueryDto = {}) {
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const rows = (await Plan.findAll({
      where: { tenantId, ...(query.status ? { status: query.status } : {}), ...(query.employeeId ? { employeeId: query.employeeId } : {}), ...(await this.visibleWhere(tenantId)) } as any,
      order: [['createdAt', 'DESC']],
      limit: 200,
    })) as any[];
    return { data: await this.view(tenantId, rows), total: rows.length };
  }

  /** Plans I proposed. */
  async mine(tenantId: string, userId: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const rows = (await Plan.findAll({ where: { tenantId, proposedById: me.id } as any, order: [['createdAt', 'DESC']], limit: 100 })) as any[];
    return { data: await this.view(tenantId, rows), total: rows.length };
  }

  private async history(tenantId: string, id: string) {
    const Log = await this.modelProvider.getEntityAuditLogModel(tenantId);
    const rows = (await Log.findAll({ where: { tableName: TABLE, recordId: id } as any, order: [['createdAt', 'DESC']], limit: 200 })) as any[];
    return rows.map((row) => {
      const { actor, ...changes } = (row.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      return { at: row.createdAt as Date, action: row.action as string, by: (actor?.to ?? null) as string | null, changes };
    });
  }

  async get(tenantId: string, id: string) {
    const plan = await this.load(tenantId, id);
    return { ...(await this.view(tenantId, [plan]))[0], history: await this.history(tenantId, id) };
  }

  async getAsProposer(tenantId: string, userId: string, email: string | undefined, id: string) {
    const me = await this.me(tenantId, userId, email);
    const plan = await this.loadOwn(tenantId, id, me.id);
    return { ...(await this.view(tenantId, [plan]))[0], history: await this.history(tenantId, id) };
  }

  private async loadOwn(tenantId: string, id: string, proposerId: string) {
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const plan: any = await Plan.findOne({ where: { id, tenantId, proposedById: proposerId } });
    if (!plan) this.fail(HttpStatus.NOT_FOUND, 'Improvement plan not found.');
    return plan;
  }

  /** The employee's own: plans that have been approved, with what they have acknowledged. */
  async myPlans(tenantId: string, userId: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const rows = ((await Plan.findAll({ where: { tenantId, employeeId: me.id } as any, order: [['createdAt', 'DESC']], limit: 20 })) as any[]).filter((plan) => plan.approvedAt);
    const views = await this.view(tenantId, rows);
    // What the employee reads: no proposal history, only the plan as approved.
    return { data: views.map((row) => ({ ...row, rejectionReason: null, canAcknowledge: !row.acknowledgement && [PipStatus.ACTIVE, PipStatus.CLOSED].includes(row.status as PipStatus) })) };
  }

  // ==========================================
  // Changing
  // ==========================================

  private async applyUpdate(tenantId: string, plan: any, dto: UpdatePipDto, canEditActive: boolean) {
    if (![PipStatus.PROPOSED, PipStatus.ACTIVE].includes(plan.status)) this.fail(HttpStatus.CONFLICT, `This plan is ${String(plan.status).toLowerCase()} and can no longer be changed.`);
    const proposal = plan.status === PipStatus.PROPOSED;
    if (!proposal && !canEditActive) this.fail(HttpStatus.FORBIDDEN, 'Only HR can change a plan that is running.');
    const patch: Record<string, unknown> = {};
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const set = (key: string, next: unknown, label = key) => {
      if ((plan[key] ?? null) !== (next ?? null)) {
        patch[key] = next;
        diff[label] = { from: plan[key] ?? null, to: next ?? null };
      }
    };
    if (dto.reason !== undefined) {
      if (!proposal) this.fail(HttpStatus.CONFLICT, 'The reason cannot change once the plan is running.');
      set('reason', dto.reason.trim());
    }
    if (dto.startDate !== undefined) {
      if (!proposal) this.fail(HttpStatus.CONFLICT, 'The start date cannot change once the plan is running.');
      set('startDate', day(dto.startDate));
    }
    const startDate = (patch.startDate as string) ?? day(plan.startDate);
    if (dto.endDate !== undefined) {
      const endDate = day(dto.endDate);
      this.checkDates(startDate, endDate);
      if (!proposal && endDate !== day(plan.endDate)) {
        if (endDate < day(plan.endDate)) this.fail(HttpStatus.BAD_REQUEST, 'A running plan can be extended, not shortened. Close it instead.');
        if (!dto.extensionReason?.trim()) this.fail(HttpStatus.BAD_REQUEST, 'Say why the plan is being extended.');
        const extensions = [...(Array.isArray(plan.extensions) ? plan.extensions : []), { from: day(plan.endDate), to: endDate, reason: dto.extensionReason.trim(), at: new Date().toISOString(), byEmail: currentRpcActor()?.email ?? null }];
        patch.extensions = extensions;
      }
      set('endDate', endDate);
    } else if (dto.startDate !== undefined) {
      this.checkDates(startDate, day(plan.endDate));
    }
    if (dto.targets !== undefined) {
      const next = this.targetsOf(dto.targets, plan.targets ?? [], proposal);
      patch.targets = next;
      diff.targets = { from: (plan.targets ?? []).map((target: PipTarget) => `${target.title}:${target.status}`).join('; '), to: next.map((target) => `${target.title}:${target.status}`).join('; ') };
    }
    if (!Object.keys(patch).length) return plan;
    await plan.update(patch);
    await this.audit(tenantId, plan.id, 'UPDATE', { event: { from: null, to: 'PIP_CHANGED' }, ...diff });
    if (!proposal) await this.notify(tenantId, plan.employeeId, 'Your improvement plan was updated', 'Your improvement plan changed. Open My Performance to read it.');
    return plan;
  }

  /** HR (or someone who may edit performance) changes a plan: while proposed anything, once running its targets and (with a reason) its end date. */
  async update(tenantId: string, id: string, dto: UpdatePipDto) {
    const plan = await this.load(tenantId, id);
    await this.applyUpdate(tenantId, plan, dto, true);
    return (await this.view(tenantId, [plan]))[0];
  }

  /** The proposer changes their own proposal while it waits for HR. */
  async updateAsProposer(tenantId: string, userId: string, email: string | undefined, id: string, dto: UpdatePipDto) {
    const me = await this.me(tenantId, userId, email);
    const plan = await this.loadOwn(tenantId, id, me.id);
    await this.applyUpdate(tenantId, plan, dto, false);
    return (await this.view(tenantId, [plan]))[0];
  }

  async approve(tenantId: string, id: string, email?: string) {
    const plan = await this.load(tenantId, id);
    if (plan.status !== PipStatus.PROPOSED) this.fail(HttpStatus.CONFLICT, `This plan is ${String(plan.status).toLowerCase()}, not waiting for approval.`);
    const rpc = currentRpcActor();
    const me = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId) : null;
    if (plan.proposedById && me === plan.proposedById && rpc?.isFullAccess !== true) this.fail(HttpStatus.FORBIDDEN, 'You proposed this plan, so someone else has to approve it.');
    if (me && me === plan.employeeId) this.fail(HttpStatus.FORBIDDEN, 'Nobody approves a plan for themselves.');
    await plan.update({ status: PipStatus.ACTIVE, approvedByEmail: email ?? rpc?.email ?? null, approvedAt: new Date() });
    await this.audit(tenantId, id, 'UPDATE', { event: { from: null, to: 'PIP_APPROVED' }, status: { from: PipStatus.PROPOSED, to: PipStatus.ACTIVE } });
    await this.notify(tenantId, plan.employeeId, 'An improvement plan was set up for you', `A performance improvement plan runs until ${day(plan.endDate)}. Open My Performance to read it and acknowledge it.`);
    await this.notify(tenantId, plan.proposedById, 'Improvement plan approved', 'The plan you proposed was approved and the employee has been told.');
    return (await this.view(tenantId, [plan]))[0];
  }

  async reject(tenantId: string, id: string, dto: RejectPipDto) {
    const plan = await this.load(tenantId, id);
    if (plan.status !== PipStatus.PROPOSED) this.fail(HttpStatus.CONFLICT, `This plan is ${String(plan.status).toLowerCase()}, not waiting for approval.`);
    await plan.update({ status: PipStatus.REJECTED, rejectionReason: dto.reason.trim(), closedAt: new Date() });
    await this.audit(tenantId, id, 'UPDATE', { event: { from: null, to: 'PIP_REJECTED' }, reason: { from: null, to: dto.reason.trim() } });
    await this.notify(tenantId, plan.proposedById, 'Improvement plan not approved', `HR did not approve the plan you proposed: ${dto.reason.trim()}`);
    return (await this.view(tenantId, [plan]))[0];
  }

  private async addCheckIn(tenantId: string, plan: any, dto: PipCheckInDto, byEmail: string | null) {
    if (plan.status !== PipStatus.ACTIVE) this.fail(HttpStatus.CONFLICT, 'Check-ins can only be added while the plan is running.');
    const date = dto.date ? day(dto.date) : today();
    if (date < day(plan.startDate)) this.fail(HttpStatus.BAD_REQUEST, 'A check-in cannot be before the plan started.');
    const checkIn = { id: randomUUID(), date, note: dto.note.trim(), progress: dto.progress, byEmail, at: new Date().toISOString() };
    await plan.update({ checkIns: [...(Array.isArray(plan.checkIns) ? plan.checkIns : []), checkIn] });
    await this.audit(tenantId, plan.id, 'UPDATE', { event: { from: null, to: 'PIP_CHECK_IN' }, progress: { from: null, to: dto.progress } });
    await this.notify(tenantId, plan.employeeId, 'Check-in on your improvement plan', 'A check-in was added to your improvement plan. Open My Performance to read it.');
    return (await this.view(tenantId, [plan]))[0];
  }

  async checkIn(tenantId: string, id: string, dto: PipCheckInDto) {
    return this.addCheckIn(tenantId, await this.load(tenantId, id), dto, currentRpcActor()?.email ?? null);
  }

  async checkInAsProposer(tenantId: string, userId: string, email: string | undefined, id: string, dto: PipCheckInDto) {
    const me = await this.me(tenantId, userId, email);
    return this.addCheckIn(tenantId, await this.loadOwn(tenantId, id, me.id), dto, email ?? null);
  }

  async close(tenantId: string, id: string, dto: ClosePipDto) {
    const plan = await this.load(tenantId, id);
    if (plan.status !== PipStatus.ACTIVE) this.fail(HttpStatus.CONFLICT, 'Only a running plan can be closed.');
    await plan.update({ status: PipStatus.CLOSED, outcome: dto.outcome, outcomeNote: dto.note?.trim() || null, closedAt: new Date() });
    await this.audit(tenantId, id, 'UPDATE', { event: { from: null, to: 'PIP_CLOSED' }, outcome: { from: null, to: dto.outcome }, status: { from: PipStatus.ACTIVE, to: PipStatus.CLOSED } });
    const words: Record<string, string> = { SUCCESSFUL: 'was completed successfully', UNSUCCESSFUL: 'ended without meeting its targets', CANCELLED: 'was cancelled' };
    await this.notify(tenantId, plan.employeeId, 'Your improvement plan has ended', `Your improvement plan ${words[dto.outcome]}.${dto.note?.trim() ? ` ${dto.note.trim()}` : ''}`);
    await this.notify(tenantId, plan.proposedById, 'Improvement plan closed', `The improvement plan you proposed ${words[dto.outcome]}.`);
    return (await this.view(tenantId, [plan]))[0];
  }

  /** The employee left: a plan that was proposed or running is closed as cancelled, and kept. Returns how many. */
  async onEmployeeLeft(tenantId: string, employeeId: string): Promise<number> {
    const Plan = await this.modelProvider.getImprovementPlanModel(tenantId);
    const open = (await Plan.findAll({ where: { tenantId, employeeId, status: { [Op.in]: [PipStatus.PROPOSED, PipStatus.ACTIVE] } } as any })) as any[];
    for (const plan of open) {
      await plan.update({ status: PipStatus.CLOSED, outcome: PipOutcome.CANCELLED, outcomeNote: 'The employee left.', closedAt: new Date() });
      await this.audit(tenantId, plan.id, 'UPDATE', { event: { from: null, to: 'PIP_CLOSED_EMPLOYEE_LEFT' }, outcome: { from: null, to: PipOutcome.CANCELLED } });
    }
    return open.length;
  }
}
