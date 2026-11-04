import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, col, fn } from 'sequelize';
import {
  AssetDeductionStatus,
  DecideSettlementDto,
  GetSettlementsQueryDto,
  SETTLEMENT_MAX_LINES,
  SettlementLineDto,
  SettlementLineType,
  SettlementStatus,
  SettlementStatusFilter,
  TenantErrorCode,
  TenantException,
  UpdateSettlementDto,
  UpdateSettlementLineDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { PayrollCompensationService } from './payroll-compensation.service';
import { PayrollDashboardService } from './payroll-dashboard.service';
import { payrollActor, writePayrollAudit as writeAudit } from './payroll-access';
import { Actor, Approval, PolicyStage, advanceApproval, buildApproval, canActOnStage, completeApproval, rejectApproval, resolveStages, stagesOf } from './approval-engine';
import { createRouteLookup, loadPolicyStages } from './approval-route-lookup';
import { PermissionHoldersService } from './permission-holders.service';
import { PayslipService } from './payslip.service';
import { SettlementDocument, renderSettlementPdf } from './settlement-pdf';
import { fiscalYearContaining, roundDays } from './leave-fiscal-year';
import { fullName } from './workspace-shared';

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? round2(n) : 0;
};
/** Until the organization chooses its own: anyone holding payroll.approve. */
const DEFAULT_APPROVAL: PolicyStage[] = [{ kind: 'PERMISSION', permission: 'payroll.approve' }];
/** A day's pay is the monthly basic divided by this. */
const DAYS_IN_MONTH = 30;
const OPEN_STATUSES = [SettlementStatus.DRAFT, SettlementStatus.SUBMITTED];

type Line = {
  id: string;
  kind: 'LEAVE_ENCASHMENT' | 'LOAN_BALANCE' | 'MANUAL';
  type: SettlementLineType;
  label: string;
  amount: number;
  category: string;
  auto: boolean;
  source?: Record<string, any> | null;
  posted?: boolean;
};

const totalsOf = (lines: Line[]) => {
  const earnings = round2(lines.filter((line) => line.type === SettlementLineType.EARNING).reduce((sum, line) => sum + line.amount, 0));
  const deductions = round2(lines.filter((line) => line.type === SettlementLineType.DEDUCTION).reduce((sum, line) => sum + line.amount, 0));
  return { earnings, deductions, net: round2(earnings - deductions) };
};

/**
 * What is owed to and by someone leaving. Leave they may cash in and the
 * balance of a loan or advance are worked out; anything else is a line typed
 * in. It is checked and approved by someone other than whoever prepared it,
 * and approving it turns each line into an ordinary payroll earning or
 * deduction in the month it is paid in. Tax is not worked out here: it is a
 * line. Approved reimbursements and approved asset deductions already reach
 * payroll by their own route, so they are shown but not counted again.
 */
@Injectable()
export class FinalSettlementService {
  private readonly logger = new Logger(FinalSettlementService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly compensation: PayrollCompensationService,
    private readonly payroll: PayrollDashboardService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly holders?: PermissionHoldersService,
    @Optional() private readonly payslips?: PayslipService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private approverActor(): Actor {
    const actor = payrollActor();
    return {
      employeeId: null,
      orgWide: false,
      permissions: actor.permissions,
      isFullAccess: actor.isFullAccess,
      holds: (permission) => actor.permissions.includes(permission) || (permission.startsWith('payroll.') && actor.permissions.includes('payroll.manage')),
    };
  }

  private preparedBy(row: any, actor: { userId: string | null; email: string | null }): boolean {
    return (Boolean(actor.userId) && row.preparedByUserId === actor.userId) || (Boolean(actor.email) && row.preparedByEmail?.toLowerCase() === actor.email);
  }

  // ==========================================
  // Working it out
  // ==========================================

  /** The lines the system can work out, and what they were worked out from. */
  private async autoLines(tenantId: string, offboardingCase: any) {
    const warnings: string[] = [];
    const lines: Line[] = [];
    const basicMonthly = await this.compensation.basicSalaryOn(tenantId, offboardingCase.employeeId, offboardingCase.lastWorkingDay);
    const dailyRate = basicMonthly ? round2(basicMonthly / DAYS_IN_MONTH) : null;

    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const policies = (await Policy.findAll({ where: { tenantId, isActive: true, isEncashable: true } as any, order: [['name', 'ASC']] })) as any[];
    if (policies.length) {
      if (!dailyRate) {
        warnings.push('There is no basic salary on record at the last working day, so leave cannot be valued. Add a leave line by hand.');
      } else {
        const year = fiscalYearContaining(offboardingCase.lastWorkingDay);
        const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
        const used = (await Leave.findAll({
          where: {
            tenantId,
            employeeId: offboardingCase.employeeId,
            leavePolicyId: { [Op.in]: policies.map((policy) => policy.id) },
            status: 'APPROVED',
            fromDate: { [Op.between]: [year.start, year.end] },
          } as any,
          attributes: ['leavePolicyId', [fn('SUM', col('totalDays')), 'days']],
          group: ['leavePolicyId'],
          raw: true,
        })) as unknown as { leavePolicyId: string; days: string | number }[];
        for (const policy of policies) {
          const taken = Number(used.find((row) => row.leavePolicyId === policy.id)?.days ?? 0);
          const days = Math.max(0, roundDays(Number(policy.annualAllocation ?? 0) - taken));
          if (days <= 0) continue;
          lines.push({
            id: randomUUID(),
            kind: 'LEAVE_ENCASHMENT',
            type: SettlementLineType.EARNING,
            label: `${policy.name}: ${days} unused ${days === 1 ? 'day' : 'days'}`,
            amount: round2(days * dailyRate),
            category: 'OTHER',
            auto: true,
            source: { leavePolicyId: policy.id, days, dailyRate, fiscalYear: year.label },
          });
        }
      }
    }

    for (const loan of await this.compensation.settlementLoans(tenantId, offboardingCase.employeeId)) {
      lines.push({
        id: randomUUID(),
        kind: 'LOAN_BALANCE',
        type: SettlementLineType.DEDUCTION,
        label: `${loan.kind === 'ADVANCE' ? 'Advance' : 'Loan'} balance`,
        amount: loan.balance,
        category: 'OTHER',
        auto: true,
        source: { loanId: loan.id, principal: loan.principal, remaining: loan.remaining, scheduled: loan.scheduled },
      });
    }
    return { lines, basicMonthly, dailyRate, warnings };
  }

  // ==========================================
  // Reading
  // ==========================================

  private async info(tenantId: string, employeeId: string) {
    const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
    const Flag = await this.modelProvider.getAssetDeductionFlagModel(tenantId);
    const [reimbursementsInProgress, pendingAssetDeductions] = await Promise.all([
      Reimbursement.count({ where: { tenantId, employeeId, status: { [Op.in]: ['SUBMITTED', 'APPROVED'] } } as any }),
      Flag.count({ where: { tenantId, employeeId, status: AssetDeductionStatus.PENDING } as any }),
    ]);
    return {
      // They reach payroll by their own route, so they are not lines here.
      reimbursementsInProgress,
      pendingAssetDeductions,
    };
  }

  private approvalView(approval: Approval | null) {
    if (!approval) return null;
    const { stages, index } = stagesOf(approval);
    return {
      statusText: approval.statusText,
      finalStep: approval.finalStep,
      currentPermission: approval.currentPermission ?? null,
      stageIndex: index,
      stages: stages.map((stage) => ({ kind: stage.kind, title: stage.title, permission: stage.permission })),
      workflow: approval.workflow,
    };
  }

  private canDecide(row: any): boolean {
    if (row.status !== SettlementStatus.SUBMITTED || !row.approval) return false;
    const actor = payrollActor();
    if (this.preparedBy(row, actor)) return false;
    const approvers: { userId?: string; email?: string }[] = (row.approval as any).approvers ?? [];
    if (approvers.some((a) => (a.userId && a.userId === actor.userId) || (a.email && a.email === actor.email))) return false;
    const { stages, index } = stagesOf(row.approval as Approval);
    return canActOnStage(stages[index], this.approverActor());
  }

  private async view(tenantId: string, row: any, offboardingCase?: any, employee?: any, withInfo = true) {
    const lines = (row.lines ?? []) as Line[];
    return {
      id: row.id as string,
      caseId: row.caseId as string,
      employee: employee ? { employeeId: employee.id as string, name: fullName(employee), employeeCode: (employee.employeeCode ?? null) as string | null } : { employeeId: row.employeeId as string, name: null, employeeCode: null },
      status: row.status as string,
      lastWorkingDay: (offboardingCase?.lastWorkingDay ?? null) as string | null,
      payrollPeriod: row.payrollPeriod as string,
      basicMonthly: row.basicMonthly === null || row.basicMonthly === undefined ? null : money(row.basicMonthly),
      dailyRate: row.dailyRate === null || row.dailyRate === undefined ? null : money(row.dailyRate),
      lines: lines.map((line) => ({ id: line.id, kind: line.kind, type: line.type, label: line.label, amount: line.amount, category: line.category, auto: line.auto, source: line.source ?? null, posted: line.posted === true })),
      totals: totalsOf(lines),
      info: withInfo ? await this.info(tenantId, row.employeeId) : null,
      approval: this.approvalView((row.approval as Approval | null) ?? null),
      rejection: row.rejection ?? null,
      preparedBy: row.preparedByEmail ?? null,
      submittedAt: row.submittedAt ?? null,
      decidedBy: row.decidedByEmail ?? null,
      decidedAt: row.decidedAt ?? null,
      decisionNote: row.decisionNote ?? null,
      paidAt: row.paidAt ?? null,
      paidBy: row.paidByEmail ?? null,
      createdAt: row.createdAt as Date,
      canDecide: this.canDecide(row),
    };
  }

  private async findCase(tenantId: string, caseId: string) {
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const found: any = await Case.findOne({ where: { id: caseId, tenantId } });
    if (!found) this.fail(HttpStatus.NOT_FOUND, `Offboarding case '${caseId}' not found.`);
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, found.employeeId, 'Offboarding case');
    return found;
  }

  private async findSettlement(tenantId: string, settlementId: string) {
    const Settlement = await this.modelProvider.getFinalSettlementModel(tenantId);
    const row: any = await Settlement.findOne({ where: { id: settlementId, tenantId } });
    if (!row) this.fail(HttpStatus.NOT_FOUND, `Settlement '${settlementId}' not found.`);
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, row.employeeId, 'Settlement');
    return row;
  }

  private async context(tenantId: string, row: any) {
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const [offboardingCase, employee] = await Promise.all([Case.findOne({ where: { id: row.caseId, tenantId } }), Employee.findOne({ where: { id: row.employeeId, tenantId }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'] })]);
    return { offboardingCase: offboardingCase as any, employee: employee as any };
  }

  /** The settlement of one offboarding case, or null when none has been prepared. */
  async getForCase(tenantId: string, caseId: string) {
    await this.findCase(tenantId, caseId);
    const Settlement = await this.modelProvider.getFinalSettlementModel(tenantId);
    const row: any = await Settlement.findOne({ where: { tenantId, caseId } });
    if (!row) return { settlement: null };
    const { offboardingCase, employee } = await this.context(tenantId, row);
    return { settlement: await this.view(tenantId, row, offboardingCase, employee) };
  }

  async getSettlement(tenantId: string, settlementId: string) {
    const row = await this.findSettlement(tenantId, settlementId);
    const { offboardingCase, employee } = await this.context(tenantId, row);
    return this.view(tenantId, row, offboardingCase, employee);
  }

  /**
   * The settlement as a statement to hand over: who, what is owed and by
   * whom, the net, how it was approved, and a line for each signature. A
   * draft or a cancelled one says so at the top, so it is never mistaken for
   * the final word.
   */
  async getSettlementPdf(tenantId: string, settlementId: string) {
    const row = await this.findSettlement(tenantId, settlementId);
    const { offboardingCase, employee } = await this.context(tenantId, row);
    const view = await this.view(tenantId, row, offboardingCase, employee, false);

    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const [department, designation, run] = await Promise.all([
      employee?.departmentId ? (Department.findOne({ where: { tenantId, id: employee.departmentId }, attributes: ['name'], raw: true }) as Promise<any>) : Promise.resolve(null),
      employee?.designationId ? (Designation.findOne({ where: { tenantId, id: employee.designationId }, attributes: ['title'], raw: true }) as Promise<any>) : Promise.resolve(null),
      (async () => (await this.modelProvider.getPayrollRunModel(tenantId)).findOne({ where: { tenantId, periodStart: `${row.payrollPeriod}-01` }, attributes: ['currency'], raw: true }) as Promise<any>)().catch(() => null),
    ]);
    const organization = this.payslips ? await this.payslips.organization(tenantId) : { name: 'Organization', address: null, phone: null, email: null, website: null, logoUrl: null };
    const logo = this.payslips ? await this.payslips.logoBytes(organization.logoUrl) : null;

    const document: SettlementDocument = {
      organization,
      currency: run?.currency ?? null,
      status: view.status,
      generatedAt: new Date().toISOString(),
      payrollPeriod: view.payrollPeriod,
      lastWorkingDay: view.lastWorkingDay,
      employee: {
        name: view.employee.name ?? '',
        employeeCode: view.employee.employeeCode,
        designation: designation?.title ?? null,
        department: department?.name ?? null,
        joiningDate: employee?.joiningDate ? String(employee.joiningDate).slice(0, 10) : null,
      },
      lines: view.lines.map((line) => ({ label: line.label, type: line.type as 'EARNING' | 'DEDUCTION', amount: line.amount, category: line.category })),
      totals: view.totals,
      approval: view.approval ? { statusText: view.approval.statusText, workflow: view.approval.workflow } : null,
      preparedBy: view.preparedBy,
      decidedBy: view.decidedBy,
      paidAt: view.paidAt ? new Date(view.paidAt).toISOString() : null,
    };
    let bytes: Buffer;
    try {
      bytes = await renderSettlementPdf(document, { logo });
    } catch (error: any) {
      this.logger.error(`Settlement PDF failed for ${settlementId}: ${error?.message ?? error}`);
      this.fail(HttpStatus.INTERNAL_SERVER_ERROR, 'The settlement PDF could not be produced. Please try again.');
    }
    const who = String(view.employee.employeeCode ?? view.employee.name ?? 'employee').replace(/[^A-Za-z0-9_-]+/g, '-');
    return { filename: `Final-Settlement-${who}.pdf`, mimeType: 'application/pdf' as const, contentBase64: bytes!.toString('base64') };
  }

  /** Settlements for the people the caller can reach, newest first. */
  async getSettlements(tenantId: string, query: GetSettlementsQueryDto = {}) {
    const Settlement = await this.modelProvider.getFinalSettlementModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;
    const base: Record<string, unknown> = { tenantId, ...(this.dataScope ? await this.dataScope.employeeWhere(tenantId, 'employeeId') : {}) };
    const status = query.status && query.status !== SettlementStatusFilter.ALL ? query.status : undefined;
    const { rows, count } = await Settlement.findAndCountAll({ where: { ...base, ...(status ? { status } : {}) } as any, order: [['createdAt', 'DESC']], limit, offset: (page - 1) * limit });

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const employeeIds = [...new Set((rows as any[]).map((row) => row.employeeId))];
    const caseIds = [...new Set((rows as any[]).map((row) => row.caseId))];
    const [employees, cases] = await Promise.all([
      employeeIds.length ? (Employee.findAll({ where: { tenantId, id: { [Op.in]: employeeIds } }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'] }) as Promise<any[]>) : Promise.resolve([] as any[]),
      caseIds.length ? (Case.findAll({ where: { tenantId, id: { [Op.in]: caseIds } } }) as Promise<any[]>) : Promise.resolve([] as any[]),
    ]);
    const data = [];
    for (const row of rows as any[]) {
      data.push(await this.view(tenantId, row, cases.find((c) => c.id === row.caseId), employees.find((e) => e.id === row.employeeId), false));
    }
    const countOf = (value: string) => Settlement.count({ where: { ...base, status: value } as any });
    const [draft, submitted, approved, paid] = await Promise.all([countOf('DRAFT'), countOf('SUBMITTED'), countOf('APPROVED'), countOf('PAID')]);
    return { data, total: count, page, limit, totalPages: Math.ceil(count / limit) || 1, summary: { draft, submitted, approved, paid } };
  }

  // ==========================================
  // Preparing
  // ==========================================

  private editable(row: any) {
    if (row.status !== SettlementStatus.DRAFT) this.fail(HttpStatus.CONFLICT, `This settlement is ${String(row.status).toLowerCase()} and can no longer be changed.`);
  }

  /**
   * Works out a settlement for an offboarding case. If one is already being
   * prepared, what the system works out is refreshed and the lines typed in
   * are kept; once it has been sent for approval it is left as it is.
   */
  async prepare(tenantId: string, caseId: string) {
    const offboardingCase = await this.findCase(tenantId, caseId);
    if (offboardingCase.status === 'CANCELLED') this.fail(HttpStatus.CONFLICT, 'This offboarding was cancelled, so there is nothing to settle.');
    const Settlement = await this.modelProvider.getFinalSettlementModel(tenantId);
    const existing: any = await Settlement.findOne({ where: { tenantId, caseId } });
    const auto = await this.autoLines(tenantId, offboardingCase);
    const actor = payrollActor();
    let row: any;

    if (existing) {
      if (existing.status !== SettlementStatus.DRAFT) return this.getSettlement(tenantId, existing.id);
      const manual = ((existing.lines ?? []) as Line[]).filter((line) => !line.auto);
      const lines = [...auto.lines, ...manual];
      await existing.update({ lines, totals: totalsOf(lines), basicMonthly: auto.basicMonthly, dailyRate: auto.dailyRate });
      row = existing;
    } else {
      row = await Settlement.create({
        tenantId,
        caseId,
        employeeId: offboardingCase.employeeId,
        status: SettlementStatus.DRAFT,
        payrollPeriod: String(offboardingCase.lastWorkingDay).slice(0, 7),
        basicMonthly: auto.basicMonthly,
        dailyRate: auto.dailyRate,
        lines: auto.lines,
        totals: totalsOf(auto.lines),
        preparedByUserId: actor.userId,
        preparedByEmail: actor.email,
      } as any);
      await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', row.id, 'CREATE', {
        event: { from: null, to: 'SETTLEMENT_PREPARED' },
        employeeId: { from: null, to: offboardingCase.employeeId },
        payrollPeriod: { from: null, to: row.payrollPeriod },
      });
    }
    const { employee } = await this.context(tenantId, row);
    return { ...(await this.view(tenantId, row, offboardingCase, employee)), warnings: auto.warnings };
  }

  async update(tenantId: string, settlementId: string, dto: UpdateSettlementDto) {
    const row = await this.findSettlement(tenantId, settlementId);
    this.editable(row);
    if (dto.payrollPeriod && dto.payrollPeriod !== row.payrollPeriod) {
      await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', { payrollPeriod: { from: row.payrollPeriod, to: dto.payrollPeriod } });
      await row.update({ payrollPeriod: dto.payrollPeriod });
    }
    return this.getSettlement(tenantId, settlementId);
  }

  private async saveLines(tenantId: string, row: any, lines: Line[]) {
    if (lines.length > SETTLEMENT_MAX_LINES) this.fail(HttpStatus.BAD_REQUEST, `A settlement has at most ${SETTLEMENT_MAX_LINES} lines.`);
    await row.update({ lines, totals: totalsOf(lines) });
  }

  async addLine(tenantId: string, settlementId: string, dto: SettlementLineDto) {
    const row = await this.findSettlement(tenantId, settlementId);
    this.editable(row);
    const line: Line = {
      id: randomUUID(),
      kind: 'MANUAL',
      type: dto.type,
      label: dto.label,
      amount: round2(dto.amount),
      category: dto.type === SettlementLineType.EARNING ? (dto.category ?? 'OTHER') : 'OTHER',
      auto: false,
    };
    await this.saveLines(tenantId, row, [...((row.lines ?? []) as Line[]), line]);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', { lineAdded: { from: null, to: `${line.type} ${line.label} ${line.amount}` } });
    return this.getSettlement(tenantId, settlementId);
  }

  private async findLine(row: any, lineId: string): Promise<Line> {
    const line = ((row.lines ?? []) as Line[]).find((candidate) => candidate.id === lineId);
    if (!line) this.fail(HttpStatus.NOT_FOUND, `Line '${lineId}' not found on this settlement.`);
    if (line!.auto) this.fail(HttpStatus.CONFLICT, 'This line is worked out by the system. Refresh the settlement to recalculate it, or add a line to correct it.');
    return line!;
  }

  async updateLine(tenantId: string, settlementId: string, lineId: string, dto: UpdateSettlementLineDto) {
    const row = await this.findSettlement(tenantId, settlementId);
    this.editable(row);
    const line = await this.findLine(row, lineId);
    const next: Line = {
      ...line,
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.amount !== undefined ? { amount: round2(dto.amount) } : {}),
      ...(dto.category !== undefined && line.type === SettlementLineType.EARNING ? { category: dto.category } : {}),
    };
    await this.saveLines(tenantId, row, ((row.lines ?? []) as Line[]).map((candidate) => (candidate.id === lineId ? next : candidate)));
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', { lineChanged: { from: `${line.label} ${line.amount}`, to: `${next.label} ${next.amount}` } });
    return this.getSettlement(tenantId, settlementId);
  }

  async removeLine(tenantId: string, settlementId: string, lineId: string) {
    const row = await this.findSettlement(tenantId, settlementId);
    this.editable(row);
    const line = await this.findLine(row, lineId);
    await this.saveLines(tenantId, row, ((row.lines ?? []) as Line[]).filter((candidate) => candidate.id !== lineId));
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', { lineRemoved: { from: `${line.label} ${line.amount}`, to: null } });
    return this.getSettlement(tenantId, settlementId);
  }

  // ==========================================
  // Approving
  // ==========================================

  /** Sends it for approval along the organization's route (by default, anyone holding payroll.approve). */
  async submit(tenantId: string, settlementId: string) {
    const row = await this.findSettlement(tenantId, settlementId);
    this.editable(row);
    if (!((row.lines ?? []) as Line[]).length) this.fail(HttpStatus.BAD_REQUEST, 'There is nothing in this settlement yet. Add a line, or cancel it.');
    const stages = (await loadPolicyStages(this.modelProvider, tenantId, 'FINAL_SETTLEMENT')) ?? DEFAULT_APPROVAL;
    const { employee } = await this.context(tenantId, row);
    const route = await resolveStages(stages, row.employeeId, await createRouteLookup(this.modelProvider, tenantId));
    await row.update({ status: SettlementStatus.SUBMITTED, submittedAt: new Date(), approval: buildApproval(route, fullName(employee) || 'the employee'), rejection: null });
    await this.holders?.tell(tenantId, row.approval, [row.employeeId], 'Final settlement waiting', `The final settlement for ${fullName(employee) || 'an employee'} is waiting for your approval.`);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', {
      event: { from: null, to: 'SETTLEMENT_SUBMITTED' },
      status: { from: 'DRAFT', to: 'SUBMITTED' },
      net: { from: null, to: totalsOf(row.lines).net },
    });
    return this.getSettlement(tenantId, settlementId);
  }

  /** Back to the preparer, who can change it and send it again. */
  private async sendBack(tenantId: string, row: any, note: string, actorLabel: string) {
    const actor = payrollActor();
    await row.update({
      status: SettlementStatus.DRAFT,
      approval: row.approval ? rejectApproval(row.approval as Approval, actorLabel) : null,
      rejection: { by: actor.email, at: new Date().toISOString(), note },
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', row.id, 'UPDATE', {
      event: { from: null, to: 'SETTLEMENT_SENT_BACK' },
      status: { from: 'SUBMITTED', to: 'DRAFT' },
      reason: { from: null, to: note },
    });
  }

  /**
   * Approve or send back a settlement. Whoever prepared it cannot decide it,
   * and nobody approves two stages of the same one. Approving the last stage
   * posts each line to payroll; if the month is locked, it says so and stays
   * waiting.
   */
  async decide(tenantId: string, settlementId: string, dto: DecideSettlementDto) {
    const row = await this.findSettlement(tenantId, settlementId);
    if (row.status !== SettlementStatus.SUBMITTED) this.fail(HttpStatus.CONFLICT, `This settlement is ${String(row.status).toLowerCase()}.`);
    const actor = payrollActor();
    if (this.preparedBy(row, actor)) this.fail(HttpStatus.FORBIDDEN, 'You prepared this settlement, so someone else has to approve it.');
    const approval = row.approval as Approval;
    const approvers: { userId?: string; email?: string; at: string }[] = (approval as any).approvers ?? [];
    if (approvers.some((a) => (a.userId && a.userId === actor.userId) || (a.email && a.email === actor.email))) {
      this.fail(HttpStatus.FORBIDDEN, 'You already approved an earlier stage of this settlement. A different person has to approve the next one.');
    }
    const { stages, index } = stagesOf(approval);
    if (!canActOnStage(stages[index], this.approverActor())) {
      this.fail(HttpStatus.FORBIDDEN, `This settlement is ${approval.statusText.charAt(0).toLowerCase()}${approval.statusText.slice(1)}`);
    }
    const label = stages[index].title ?? 'Approver';

    if (dto.decision === 'REJECT') {
      if (String(dto.note ?? '').trim().length < 3) this.fail(HttpStatus.BAD_REQUEST, 'Say why the settlement is sent back.');
      await this.sendBack(tenantId, row, String(dto.note).trim(), label);
      return this.getSettlement(tenantId, settlementId);
    }

    const approvedBy = [...approvers, { userId: actor.userId ?? undefined, email: actor.email ?? undefined, at: new Date().toISOString() }];
    if (index < stages.length - 1) {
      await row.update({ approval: { ...advanceApproval(approval, label), approvers: approvedBy } });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', { event: { from: null, to: 'SETTLEMENT_STAGE_APPROVED' }, stage: { from: index + 1, to: index + 2 } });
      await this.holders?.tell(tenantId, row.approval, [row.employeeId], 'Final settlement waiting', `${label} approved a final settlement. It is now waiting for your approval.`);
      return this.getSettlement(tenantId, settlementId);
    }

    await this.post(tenantId, row, dto.payrollPeriod);
    await row.update({
      status: SettlementStatus.APPROVED,
      approval: { ...completeApproval(approval, label), approvers: approvedBy },
      decidedByUserId: actor.userId,
      decidedByEmail: actor.email,
      decidedAt: new Date(),
      decisionNote: dto.note ?? null,
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', {
      event: { from: null, to: 'SETTLEMENT_APPROVED' },
      status: { from: 'SUBMITTED', to: 'APPROVED' },
      net: { from: null, to: totalsOf(row.lines).net },
      payrollPeriod: { from: null, to: row.payrollPeriod },
    });
    return this.getSettlement(tenantId, settlementId);
  }

  /**
   * Each line becomes an earning or a deduction in the payroll month. Lines
   * already posted (an earlier attempt that stopped partway) are not posted
   * again, and the month cannot be changed once any has been.
   */
  private async post(tenantId: string, row: any, requestedPeriod?: string) {
    const lines = ((row.lines ?? []) as Line[]).map((line) => ({ ...line }));
    const started = lines.some((line) => line.posted);
    const period = started ? row.payrollPeriod : (requestedPeriod ?? row.payrollPeriod);
    if (!started && period !== row.payrollPeriod) await row.update({ payrollPeriod: period });

    for (const line of lines) {
      if (line.posted) continue;
      await this.payroll.createAdjustmentEntry(tenantId, {
        employeeId: row.employeeId,
        payrollPeriod: period,
        type: line.type as any,
        category: line.type === SettlementLineType.EARNING ? line.category : undefined,
        amount: line.amount,
        reason: `Final settlement: ${line.label}`.slice(0, 300),
      });
      line.posted = true;
      // Kept as it goes, so a stop partway is picked up where it stopped.
      await row.update({ lines });
      if (line.kind === 'LOAN_BALANCE' && line.source?.loanId) await this.compensation.markLoanSettled(tenantId, line.source.loanId);
    }
  }

  /** Withdraw it while it is still being prepared or waiting for approval. */
  async cancel(tenantId: string, settlementId: string) {
    const row = await this.findSettlement(tenantId, settlementId);
    if (!OPEN_STATUSES.includes(row.status)) this.fail(HttpStatus.CONFLICT, `This settlement is ${String(row.status).toLowerCase()}.`);
    await row.update({ status: SettlementStatus.CANCELLED });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', { status: { from: 'OPEN', to: 'CANCELLED' } });
    return this.getSettlement(tenantId, settlementId);
  }

  /** Payroll has paid it out. */
  async markPaid(tenantId: string, settlementId: string) {
    const row = await this.findSettlement(tenantId, settlementId);
    if (row.status !== SettlementStatus.APPROVED) this.fail(HttpStatus.CONFLICT, 'Only an approved settlement can be marked as paid.');
    const actor = payrollActor();
    await row.update({ status: SettlementStatus.PAID, paidAt: new Date(), paidByEmail: actor.email });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'final_settlements', settlementId, 'UPDATE', { event: { from: null, to: 'SETTLEMENT_PAID' }, status: { from: 'APPROVED', to: 'PAID' } });
    return this.getSettlement(tenantId, settlementId);
  }
}
