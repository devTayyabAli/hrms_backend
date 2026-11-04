import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  CancelOffboardingDto,
  EmployeeNotificationKind,
  EmployeeStatus,
  GetOffboardingCasesQueryDto,
  InitiateOffboardingDto,
  OffboardingCaseFilter,
  OffboardingCaseStatus,
  OffboardingStage,
  TenantErrorCode,
  TenantException,
  UpdateOffboardingDto,
  UpdateOffboardingSettingsDto,
  grantsPermission,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { AssetClearanceService } from './asset-clearance.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields, formatDay, fullName } from './workspace-shared';
import { PermissionHoldersService } from './permission-holders.service';
import { departmentChain, isDepartmentStage, offboardingStepsFor } from './department-checklist';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const ALL_STAGES: OffboardingStage[] = [OffboardingStage.MANAGER, OffboardingStage.HR, OffboardingStage.IT, OffboardingStage.FINANCE];
const LABEL: Record<OffboardingStage, string> = {
  [OffboardingStage.MANAGER]: 'Reporting manager',
  [OffboardingStage.HR]: 'HR',
  [OffboardingStage.IT]: 'IT and assets',
  [OffboardingStage.FINANCE]: 'Finance',
};
const ESCAPE = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

/** Who is acting on a clearance: their employee record (if any) and what they hold. */
export interface ClearanceActor {
  employeeId: string | null;
  userId: string | null;
  email: string | null;
  holds: (permission: string) => boolean;
}

/**
 * A person leaving, and each department's clearance that they have nothing
 * outstanding. The reporting manager, HR and Finance say so themselves; IT's
 * clearance is not asked for again: it is read from the asset clearance, so it
 * is true exactly when the assets are back and confirmed. Whether an employee
 * can be marked Resigned only once everything is cleared is the organization's
 * choice, and off until it is turned on.
 */
@Injectable()
export class OffboardingService {
  private readonly logger = new Logger(OffboardingService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly assetClearance: AssetClearanceService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly holders?: PermissionHoldersService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  // ==========================================
  // Who is acting
  // ==========================================

  /** The signed-in person on an admin route, from the message's own signature. */
  private async actorOnAdminRoute(tenantId: string): Promise<ClearanceActor> {
    const rpc = currentRpcActor();
    const permissions = rpc?.permissions ?? [];
    return {
      employeeId: this.dataScope ? await this.dataScope.actorEmployeeId(tenantId) : null,
      userId: rpc?.userId ?? null,
      email: rpc?.email?.toLowerCase() ?? null,
      holds: (permission) => !rpc || rpc.isFullAccess === true || grantsPermission(permissions, permission),
    };
  }

  /** The employee behind a login: by login id, then by email. */
  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName'] }) : null;
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName'] });
    }
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  /** Whether this person may clear this stage of this case. IT is never cleared by hand. */
  private canClear(stage: string, employee: { id: string; reportingManagerId?: string | null }, actor: ClearanceActor, row?: any): boolean {
    if (actor.employeeId && actor.employeeId === employee.id) return false;
    // A step the person's department added: its owner, anyone holding the permission it names, or HR.
    if (isDepartmentStage(stage)) {
      return (Boolean(actor.employeeId) && row?.ownerEmployeeId === actor.employeeId) || Boolean(row?.ownerPermission && actor.holds(row.ownerPermission)) || actor.holds('offboarding.manage');
    }
    switch (stage as OffboardingStage) {
      case OffboardingStage.MANAGER:
        return (Boolean(actor.employeeId) && employee.reportingManagerId === actor.employeeId) || actor.holds('offboarding.manage');
      case OffboardingStage.HR:
        return actor.holds('offboarding.manage');
      case OffboardingStage.FINANCE:
        return actor.holds('payroll.adjustments.manage') || actor.holds('payroll.manage');
      default:
        return false;
    }
  }

  // ==========================================
  // Settings
  // ==========================================

  async getSettings(tenantId: string) {
    const Setting = await this.modelProvider.getOffboardingSettingModel(tenantId);
    const row: any = await Setting.findOne({ where: { tenantId } });
    const stored = Array.isArray(row?.stages) ? (row.stages as string[]).filter((stage) => ALL_STAGES.includes(stage as OffboardingStage)) : [];
    const stages = (stored.length ? ALL_STAGES.filter((stage) => stored.includes(stage)) : ALL_STAGES) as OffboardingStage[];
    return { gateEnabled: row?.gateEnabled === true, stages, available: ALL_STAGES.map((stage) => ({ stage, label: LABEL[stage] })) };
  }

  async updateSettings(tenantId: string, dto: UpdateOffboardingSettingsDto) {
    const before = await this.getSettings(tenantId);
    const Setting = await this.modelProvider.getOffboardingSettingModel(tenantId);
    const values: Record<string, unknown> = {};
    if (dto.gateEnabled !== undefined) values.gateEnabled = dto.gateEnabled;
    if (dto.stages !== undefined) values.stages = ALL_STAGES.filter((stage) => dto.stages!.includes(stage));
    if (Object.keys(values).length) {
      const row: any = await Setting.findOne({ where: { tenantId } });
      if (row) await row.update(values);
      else await Setting.create({ tenantId, ...values } as any);
    }
    const after = await this.getSettings(tenantId);
    const changes = diffFields({ gateEnabled: before.gateEnabled, stages: before.stages.join(',') } as any, { gateEnabled: after.gateEnabled, stages: after.stages.join(',') } as any);
    if (Object.keys(changes).length) await writeAudit(this.modelProvider, this.logger, tenantId, 'offboarding_settings', tenantId, 'UPDATE', changes);
    return after;
  }

  // ==========================================
  // Reading
  // ==========================================

  /** The stages of a case as they stand: stored answers, and IT worked out from the assets while it is open. */
  private async stagesOf(tenantId: string, offboardingCase: any, rows: any[], itState?: any) {
    const builtIn = ALL_STAGES.map((stage) => rows.find((row) => row.stage === stage)).filter(Boolean) as any[];
    // The steps the person's department added come after the standard ones, in the order it set them.
    const added = rows.filter((row) => isDepartmentStage(row.stage)).sort((a, b) => Number(String(a.stage).slice(5)) - Number(String(b.stage).slice(5)));
    const ordered = [...builtIn, ...added];
    const open = offboardingCase.status === 'OPEN';
    const it = ordered.find((row) => row.stage === OffboardingStage.IT);
    const state = open && it ? (itState ?? (await this.assetClearance.getClearance(tenantId, offboardingCase.employeeId))) : null;
    return ordered.map((row) => {
      const isIt = row.stage === OffboardingStage.IT;
      const custom = isDepartmentStage(row.stage);
      const cleared = isIt && state ? state.cleared === true : row.status === 'CLEARED';
      return {
        stage: row.stage as string,
        label: (custom ? (row.label ?? row.stage) : LABEL[row.stage as OffboardingStage]) as string,
        status: cleared ? 'CLEARED' : 'PENDING',
        source: isIt ? 'ASSETS' : custom ? 'DEPARTMENT' : 'MANUAL',
        description: custom ? ((row.description ?? null) as string | null) : null,
        owner: custom ? { kind: (row.ownerKind ?? null) as string | null, employeeId: (row.ownerEmployeeId ?? null) as string | null, permission: (row.ownerPermission ?? null) as string | null } : null,
        clearedBy: isIt ? (state?.confirmation?.confirmedBy ?? null) : (row.clearedByEmail ?? null),
        clearedAt: isIt ? (state?.confirmation?.confirmedAt ?? null) : (row.clearedAt ?? null),
        note: isIt ? (state?.confirmation?.note ?? null) : (row.note ?? null),
        blockers: isIt && state && !cleared ? (state.blockers as string[]) : [],
      };
    });
  }

  private statusOf(offboardingCase: any, stages: { status: string }[]): OffboardingCaseStatus {
    if (offboardingCase.status === 'COMPLETED') return OffboardingCaseStatus.COMPLETED;
    if (offboardingCase.status === 'CANCELLED') return OffboardingCaseStatus.CANCELLED;
    const cleared = stages.filter((stage) => stage.status === 'CLEARED').length;
    if (stages.length && cleared === stages.length) return OffboardingCaseStatus.CLEARED;
    return cleared > 0 ? OffboardingCaseStatus.IN_CLEARANCE : OffboardingCaseStatus.INITIATED;
  }

  /**
   * Why someone is leaving is HR's to know. Finance, IT and a manager clear
   * their part without it, so on the admin screens the reason (and the reason
   * a case was cancelled) is shown only to those who may see offboarding
   * itself. The person's own view of their case is not filtered.
   */
  private canSeeReasons(): boolean {
    const rpc = currentRpcActor();
    return !rpc || rpc.isFullAccess === true || grantsPermission(rpc.permissions ?? [], 'offboarding.view');
  }

  private async toRow(tenantId: string, offboardingCase: any, employee: any, rows: any[], showReason = true) {
    const stages = await this.stagesOf(tenantId, offboardingCase, rows);
    return {
      id: offboardingCase.id as string,
      employee: employee
        ? { employeeId: employee.id as string, name: fullName(employee), employeeCode: (employee.employeeCode ?? null) as string | null, avatarUrl: (employee.avatarUrl ?? null) as string | null }
        : { employeeId: offboardingCase.employeeId as string, name: null, employeeCode: null, avatarUrl: null },
      type: offboardingCase.type as string,
      status: this.statusOf(offboardingCase, stages),
      noticeDate: (offboardingCase.noticeDate ?? null) as string | null,
      lastWorkingDay: offboardingCase.lastWorkingDay as string,
      reason: showReason ? ((offboardingCase.reason ?? null) as string | null) : null,
      reasonHidden: !showReason && Boolean(offboardingCase.reason || offboardingCase.cancelReason),
      initiatedBy: (offboardingCase.initiatedByEmail ?? null) as string | null,
      initiatedAt: offboardingCase.createdAt as Date,
      completedAt: (offboardingCase.completedAt ?? null) as Date | null,
      cancelledAt: (offboardingCase.cancelledAt ?? null) as Date | null,
      cancelReason: showReason ? ((offboardingCase.cancelReason ?? null) as string | null) : null,
      stages,
      progress: { cleared: stages.filter((stage) => stage.status === 'CLEARED').length, total: stages.length },
    };
  }

  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, 'employeeId') : {};
  }

  private async clearancesOf(tenantId: string, caseIds: string[]) {
    if (!caseIds.length) return [];
    const Clearance = await this.modelProvider.getOffboardingClearanceModel(tenantId);
    return (await Clearance.findAll({ where: { tenantId, caseId: { [Op.in]: caseIds } } })) as any[];
  }

  private async employeesOf(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = unique.length
      ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: unique } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl', 'reportingManagerId', 'status', 'joiningDate'] })) as any[])
      : [];
    return new Map(rows.map((row) => [row.id as string, row]));
  }

  /** Cases for the people the caller can reach, open ones by default. */
  async getCases(tenantId: string, query: GetOffboardingCasesQueryDto = {}) {
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;
    const filter = query.status ?? OffboardingCaseFilter.OPEN;

    const base: Record<string | symbol, unknown> = { tenantId, ...(await this.scopeWhere(tenantId)) };
    if (query.employeeId) base.employeeId = query.employeeId;
    const and: any[] = [base];
    if (filter !== OffboardingCaseFilter.ALL) and.push({ status: filter });
    const term = query.search?.trim();
    if (term) {
      const like = `%${ESCAPE(term)}%`;
      const people = (await Employee.findAll({
        where: { tenantId, [Op.or]: [{ firstName: { [Op.iLike]: like } }, { lastName: { [Op.iLike]: like } }, { employeeCode: { [Op.iLike]: like } }] } as any,
        attributes: ['id'],
        raw: true,
        limit: 500,
      })) as unknown as { id: string }[];
      and.push({ employeeId: { [Op.in]: people.map((person) => person.id) } });
    }

    const { rows, count } = await Case.findAndCountAll({ where: { [Op.and]: and } as any, order: [['lastWorkingDay', 'ASC'], ['createdAt', 'DESC']], limit, offset: (page - 1) * limit });
    const [clearances, employees] = await Promise.all([this.clearancesOf(tenantId, (rows as any[]).map((row) => row.id)), this.employeesOf(tenantId, (rows as any[]).map((row) => row.employeeId))]);
    const showReason = this.canSeeReasons();
    const data = [];
    for (const row of rows as any[]) {
      data.push(await this.toRow(tenantId, row, employees.get(row.employeeId), clearances.filter((c) => c.caseId === row.id), showReason));
    }

    const countOf = (status: string) => Case.count({ where: { [Op.and]: [base, { status }] } as any });
    const [open, completed, cancelled] = await Promise.all([countOf('OPEN'), countOf('COMPLETED'), countOf('CANCELLED')]);
    return { data, total: count, page, limit, totalPages: Math.ceil(count / limit) || 1, summary: { open, completed, cancelled } };
  }

  private async findCase(tenantId: string, caseId: string, scoped = true) {
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const found: any = await Case.findOne({ where: { [Op.and]: [{ id: caseId, tenantId }, scoped ? await this.scopeWhere(tenantId) : {}] } as any });
    if (!found) this.fail(HttpStatus.NOT_FOUND, `Offboarding case '${caseId}' not found.`);
    return found;
  }

  /** One case, with what IT and Finance need to see before they clear it. */
  async getCase(tenantId: string, caseId: string, scoped = true) {
    const found = await this.findCase(tenantId, caseId, scoped);
    const [clearances, employees] = await Promise.all([this.clearancesOf(tenantId, [caseId]), this.employeesOf(tenantId, [found.employeeId])]);
    const row = await this.toRow(tenantId, found, employees.get(found.employeeId), clearances, this.canSeeReasons());

    const open = found.status === 'OPEN';
    const assets = open ? await this.assetClearance.getClearance(tenantId, found.employeeId) : null;
    const Loan = await this.modelProvider.getEmployeeLoanModel(tenantId);
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    const [activeLoans, reimbursementsInProgress] = await Promise.all([
      Loan.count({ where: { tenantId, employeeId: found.employeeId, status: 'ACTIVE' } as any }),
      Reimbursement.count({ where: { tenantId, employeeId: found.employeeId, status: { [Op.in]: ['SUBMITTED', 'APPROVED'] } } as any }),
    ]);
    const Settlement = await this.modelProvider.getFinalSettlementModel(tenantId);
    const settlement: any = await Settlement.findOne({ where: { tenantId, caseId }, attributes: ['id', 'status', 'totals'] });
    return {
      ...row,
      settlement: settlement ? { id: settlement.id as string, status: settlement.status as string, net: Number(settlement.totals?.net ?? 0) } : null,
      assets: assets ? { held: assets.assets, pendingDeductions: assets.pendingDeductions, blockers: assets.blockers } : null,
      finance: { activeLoans, reimbursementsInProgress, pendingAssetDeductions: assets?.pendingDeductions.length ?? 0 },
    };
  }

  // ==========================================
  // Starting, changing, ending
  // ==========================================

  private async notifyEmployee(tenantId: string, employeeId: string, title: string, body: string) {
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.GENERAL, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`An offboarding notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  private checkDates(noticeDate: string | null | undefined, lastWorkingDay: string, joiningDate?: string | null) {
    if (noticeDate && noticeDate > lastWorkingDay) this.fail(HttpStatus.BAD_REQUEST, 'The notice date cannot be after the last working day.');
    if (joiningDate && lastWorkingDay < String(joiningDate).slice(0, 10)) this.fail(HttpStatus.BAD_REQUEST, 'The last working day cannot be before they joined.');
  }

  /** Starts offboarding for someone who works here, and asks their manager to clear it. */
  async initiate(tenantId: string, dto: InitiateOffboardingDto) {
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, dto.employeeId, 'Employee');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { tenantId, id: dto.employeeId }, attributes: ['id', 'firstName', 'lastName', 'status', 'joiningDate', 'reportingManagerId', 'departmentId'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, `Employee '${dto.employeeId}' not found in this organization.`);
    if (!EMPLOYED.includes(employee.status)) this.fail(HttpStatus.CONFLICT, 'This person no longer works here.');
    this.checkDates(dto.noticeDate, dto.lastWorkingDay, employee.joiningDate);

    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    if (await Case.count({ where: { tenantId, employeeId: dto.employeeId, status: 'OPEN' } })) {
      this.fail(HttpStatus.CONFLICT, 'Offboarding has already been started for this person.');
    }

    const rpc = currentRpcActor();
    const settings = await this.getSettings(tenantId);
    const created: any = await Case.create({
      tenantId,
      employeeId: dto.employeeId,
      type: dto.type,
      status: 'OPEN',
      noticeDate: dto.noticeDate ?? null,
      lastWorkingDay: dto.lastWorkingDay,
      reason: dto.reason ?? null,
      initiatedByUserId: rpc?.userId ?? null,
      initiatedByEmail: rpc?.email?.toLowerCase() ?? null,
    } as any);
    const Clearance = await this.modelProvider.getOffboardingClearanceModel(tenantId);
    await Clearance.bulkCreate(settings.stages.map((stage) => ({ tenantId, caseId: created.id, stage, status: 'PENDING' })) as any[]);
    // What the person's department adds, beside the standard clearances.
    const departmentSteps = await offboardingStepsFor(this.modelProvider, tenantId, created.id, employee);
    if (departmentSteps.length) await Clearance.bulkCreate(departmentSteps.map((step) => step.row) as any[]);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'offboarding_cases', created.id, 'CREATE', {
      employeeId: { from: null, to: dto.employeeId },
      type: { from: null, to: dto.type },
      lastWorkingDay: { from: null, to: dto.lastWorkingDay },
    });
    if (settings.stages.includes(OffboardingStage.MANAGER) && employee.reportingManagerId) {
      await this.notifyEmployee(tenantId, employee.reportingManagerId, `Offboarding started: ${fullName(employee)}`, `${fullName(employee)}'s last working day is ${formatDay(dto.lastWorkingDay)}. Please clear your part.`);
    }
    for (const step of departmentSteps) {
      const body = `${fullName(employee)}'s last working day is ${formatDay(dto.lastWorkingDay)}. Please clear: ${step.title}.`;
      if (step.ownerEmployeeId && step.ownerEmployeeId !== employee.reportingManagerId) await this.notifyEmployee(tenantId, step.ownerEmployeeId, `Offboarding started: ${fullName(employee)}`, body);
      if (step.ownerPermission) await this.holders?.tellPermission(tenantId, step.ownerPermission, [employee.id], `Offboarding started: ${fullName(employee)}`, body);
    }
    return this.getCase(tenantId, created.id);
  }

  async update(tenantId: string, caseId: string, dto: UpdateOffboardingDto) {
    const found = await this.findCase(tenantId, caseId);
    if (found.status !== 'OPEN') this.fail(HttpStatus.CONFLICT, `This offboarding is ${String(found.status).toLowerCase()}.`);
    const employees = await this.employeesOf(tenantId, [found.employeeId]);
    const lastWorkingDay = dto.lastWorkingDay ?? found.lastWorkingDay;
    const noticeDate = dto.noticeDate !== undefined ? dto.noticeDate : found.noticeDate;
    this.checkDates(noticeDate, lastWorkingDay, (employees.get(found.employeeId) as any)?.joiningDate);

    const next: Record<string, unknown> = {};
    for (const key of ['type', 'noticeDate', 'lastWorkingDay', 'reason'] as const) if (dto[key] !== undefined) next[key] = dto[key];
    const changes = diffFields(found.get({ plain: true }), next);
    if (Object.keys(changes).length) {
      await found.update(next);
      await writeAudit(this.modelProvider, this.logger, tenantId, 'offboarding_cases', caseId, 'UPDATE', changes);
    }
    return this.getCase(tenantId, caseId);
  }

  /** They are staying after all. Nothing about the employee changes. */
  async cancel(tenantId: string, caseId: string, dto: CancelOffboardingDto) {
    const found = await this.findCase(tenantId, caseId);
    if (found.status !== 'OPEN') this.fail(HttpStatus.CONFLICT, `This offboarding is ${String(found.status).toLowerCase()}.`);
    await found.update({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.reason ?? null });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'offboarding_cases', caseId, 'UPDATE', { status: { from: 'OPEN', to: 'CANCELLED' } });
    return this.getCase(tenantId, caseId);
  }

  // ==========================================
  // Clearances
  // ==========================================

  private async changeStage(tenantId: string, caseId: string, stage: string, note: string | null | undefined, actor: ClearanceActor, clear: boolean, scoped: boolean) {
    const found = await this.findCase(tenantId, caseId, scoped);
    if (found.status !== 'OPEN') this.fail(HttpStatus.CONFLICT, `This offboarding is ${String(found.status).toLowerCase()}.`);
    if (stage === OffboardingStage.IT) {
      this.fail(HttpStatus.CONFLICT, 'IT clearance comes from the asset clearance. Hand the assets back and confirm it in Assets.');
    }
    const Clearance = await this.modelProvider.getOffboardingClearanceModel(tenantId);
    const row: any = await Clearance.findOne({ where: { tenantId, caseId, stage } });
    const custom = isDepartmentStage(stage);
    const name = custom ? String(row?.label ?? stage) : LABEL[stage as OffboardingStage];
    if (!row) this.fail(HttpStatus.NOT_FOUND, `${custom ? stage : name} is not one of the clearances this organization asks for.`);

    const employee = (await this.employeesOf(tenantId, [found.employeeId])).get(found.employeeId);
    if (actor.employeeId && actor.employeeId === found.employeeId) this.fail(HttpStatus.FORBIDDEN, "You can't clear your own offboarding.");
    if (!this.canClear(stage, employee, actor, row)) {
      this.fail(HttpStatus.FORBIDDEN, stage === OffboardingStage.MANAGER ? 'Only their reporting manager or HR can clear this.' : `You can't clear ${name} for this person.`);
    }

    if (clear) {
      if (row.status === 'CLEARED') return this.getCase(tenantId, caseId, scoped);
      await row.update({ status: 'CLEARED', clearedByUserId: actor.userId, clearedByEmail: actor.email, clearedAt: new Date(), note: note ?? null });
    } else {
      if (row.status !== 'CLEARED') return this.getCase(tenantId, caseId, scoped);
      await row.update({ status: 'PENDING', clearedByUserId: null, clearedByEmail: null, clearedAt: null, note: note ?? null });
    }
    await writeAudit(this.modelProvider, this.logger, tenantId, 'offboarding_clearances', row.id, 'UPDATE', {
      stage: { from: null, to: stage },
      status: { from: clear ? 'PENDING' : 'CLEARED', to: clear ? 'CLEARED' : 'PENDING' },
    });
    return this.getCase(tenantId, caseId, scoped);
  }

  /** Says this department has nothing outstanding. */
  async clearStage(tenantId: string, caseId: string, stage: string, note?: string | null) {
    return this.changeStage(tenantId, caseId, stage, note, await this.actorOnAdminRoute(tenantId), true, true);
  }

  /** Takes a clearance back, because something turned up. */
  async reopenStage(tenantId: string, caseId: string, stage: string, note?: string | null) {
    return this.changeStage(tenantId, caseId, stage, note, await this.actorOnAdminRoute(tenantId), false, true);
  }

  // ==========================================
  // The reporting manager's own
  // ==========================================

  /** What the signed-in person holds, for a step that names a permission. */
  private holdsOf(): (permission: string) => boolean {
    const rpc = currentRpcActor();
    return (permission) => rpc?.isFullAccess === true || grantsPermission(rpc?.permissions ?? [], permission);
  }

  /**
   * Offboardings where something is still wanted from me: my clearance as a
   * reporting manager, and any step a department added that is mine (by name,
   * or because I hold the permission it names). Each says which.
   */
  async getWaitingOnMe(tenantId: string, userId?: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Clearance = await this.modelProvider.getOffboardingClearanceModel(tenantId);
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const holds = this.holdsOf();

    const reports = (await Employee.findAll({ where: { tenantId, reportingManagerId: me.id }, attributes: ['id'], raw: true })) as unknown as { id: string }[];
    const mineByName = (await Clearance.findAll({ where: { tenantId, status: 'PENDING', ownerEmployeeId: me.id } as any })) as any[];
    const mineByPermission = ((await Clearance.findAll({ where: { tenantId, status: 'PENDING', ownerPermission: { [Op.ne]: null } } as any, limit: 500 })) as any[]).filter((row) => Boolean(row.ownerPermission) && holds(row.ownerPermission));
    const customMine = [...mineByName, ...mineByPermission];

    const caseIds = [...new Set(customMine.map((row) => row.caseId))];
    const where: any[] = [];
    if (reports.length) where.push({ employeeId: { [Op.in]: reports.map((row) => row.id) } });
    if (caseIds.length) where.push({ id: { [Op.in]: caseIds } });
    if (!where.length) return { data: [], total: 0 };
    const cases = (await Case.findAll({ where: { tenantId, status: 'OPEN', [Op.or]: where } as any, order: [['lastWorkingDay', 'ASC']] })) as any[];
    const [clearances, employees] = await Promise.all([this.clearancesOf(tenantId, cases.map((row) => row.id)), this.employeesOf(tenantId, cases.map((row) => row.employeeId))]);
    const reportIds = new Set(reports.map((row) => row.id));
    const data = [];
    for (const row of cases) {
      const rows = clearances.filter((c) => c.caseId === row.id);
      const waiting: { stage: string; label: string }[] = [];
      if (reportIds.has(row.employeeId) && rows.some((c) => c.stage === OffboardingStage.MANAGER && c.status === 'PENDING')) waiting.push({ stage: OffboardingStage.MANAGER, label: LABEL[OffboardingStage.MANAGER] });
      for (const step of customMine.filter((c) => c.caseId === row.id && c.status === 'PENDING')) {
        if (!waiting.some((w) => w.stage === step.stage) && step.ownerEmployeeId !== row.employeeId) waiting.push({ stage: step.stage, label: String(step.label ?? step.stage) });
      }
      if (!waiting.length) continue;
      data.push({ ...(await this.toRow(tenantId, row, employees.get(row.employeeId), rows, false)), waitingOnMe: waiting });
    }
    return { data, total: data.length };
  }

  /** My clearance: as the person's reporting manager, or the step their department added that is mine. */
  async clearAsManager(tenantId: string, userId: string | undefined, email: string | undefined, caseId: string, note?: string | null, stage: string = OffboardingStage.MANAGER) {
    const me = await this.me(tenantId, userId, email);
    const actor: ClearanceActor = { employeeId: me.id, userId: userId ?? null, email: email?.toLowerCase() ?? null, holds: isDepartmentStage(stage) ? this.holdsOf() : () => false };
    return this.changeStage(tenantId, caseId, stage, note, actor, true, false);
  }

  // ==========================================
  // Leaving
  // ==========================================

  /**
   * The gate on being marked Resigned, when the organization has turned it on:
   * an open offboarding, with every clearance in. Says what is still missing.
   */
  async assertCanLeave(tenantId: string, employeeId: string): Promise<void> {
    const settings = await this.getSettings(tenantId);
    if (!settings.gateEnabled) return;
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const found: any = await Case.findOne({ where: { tenantId, employeeId, status: 'OPEN' } });
    if (!found) this.fail(HttpStatus.CONFLICT, 'Start offboarding for this person first. They cannot be marked as resigned until it is cleared.');
    const stages = await this.stagesOf(tenantId, found, await this.clearancesOf(tenantId, [found.id]));
    const waiting = stages.filter((stage) => stage.status !== 'CLEARED').map((stage) => stage.label);
    if (waiting.length) this.fail(HttpStatus.CONFLICT, `Offboarding is not cleared yet. Still waiting for: ${waiting.join(', ')}.`);
  }

  /** The employee has been marked Resigned: their open offboarding is complete. Best effort. */
  async completeForExit(tenantId: string, employeeId: string): Promise<void> {
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const found: any = await Case.findOne({ where: { tenantId, employeeId, status: 'OPEN' } });
    if (!found) return;
    // IT's answer is kept as it stood when they left.
    const rows = await this.clearancesOf(tenantId, [found.id]);
    const it = rows.find((row) => row.stage === OffboardingStage.IT);
    if (it && it.status !== 'CLEARED') {
      const state = await this.assetClearance.getClearance(tenantId, employeeId);
      if (state.cleared) await it.update({ status: 'CLEARED', clearedAt: new Date(), note: 'Asset clearance' });
    }
    await found.update({ status: 'COMPLETED', completedAt: new Date() });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'offboarding_cases', found.id, 'UPDATE', { status: { from: 'OPEN', to: 'COMPLETED' } });
  }

  /** The last working day of someone's open offboarding, to fill in the exit date. */
  async lastWorkingDayOf(tenantId: string, employeeId: string): Promise<string | null> {
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const found: any = await Case.findOne({ where: { tenantId, employeeId, status: 'OPEN' }, attributes: ['lastWorkingDay'] });
    return found?.lastWorkingDay ?? null;
  }
}
