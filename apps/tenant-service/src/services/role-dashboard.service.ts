import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, literal, where as sqlWhere } from 'sequelize';
import { AssetStatus, EmployeeStatus, PayrollProcessStep, TenantErrorCode, TenantException } from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { addDays } from './learning-shared';
import { todayIso } from './workspace-shared';
import { stagesOf, Approval } from './approval-engine';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const TEAM_DEPTH = 8;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * What is waiting for a Finance person, for IT, and for a manager, each with a
 * few headline numbers. Every count is of something another screen lists, and a
 * section that cannot be read comes back as null (and is named in
 * `unavailable`) rather than taking the dashboard down with it. Finance and IT
 * count what the caller's grants let them act on; the manager's counts are of
 * their own team and of what names them.
 */
@Injectable()
export class RoleDashboardService {
  private readonly logger = new Logger(RoleDashboardService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  /** What the caller holds. payroll.manage stands in for every other payroll grant. */
  private holds(permission: string): boolean {
    const rpc = currentRpcActor();
    if (!rpc || rpc.isFullAccess === true) return true;
    const held = rpc.permissions ?? [];
    return held.includes('*') || held.includes(permission) || (permission.startsWith('payroll.') && held.includes('payroll.manage'));
  }

  private actor() {
    const rpc = currentRpcActor();
    return { userId: rpc?.userId ?? null, email: rpc?.email?.toLowerCase() ?? null };
  }

  /** One section: its numbers, or null with its name noted when it could not be read. */
  private async section<T>(unavailable: string[], name: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error: any) {
      this.logger.warn(`Dashboard section '${name}' could not be read: ${error?.message ?? error}`);
      unavailable.push(name);
      return null;
    }
  }

  // ==========================================
  // Finance
  // ==========================================

  async getFinance(tenantId: string) {
    const unavailable: string[] = [];
    const me = this.actor();
    const Run = await this.modelProvider.getPayrollRunModel(tenantId);

    const payroll = await this.section(unavailable, 'payroll', async () => {
      const run: any = await Run.findOne({ where: { tenantId }, order: [['periodStart', 'DESC']] });
      return run
        ? { id: run.id as string, period: String(run.periodStart).slice(0, 7), step: run.step as string, status: run.status as string, employeeCount: Number(run.employeeCount ?? 0), netPay: Number(run.netPay ?? 0), payDate: (run.payDate ?? null) as string | null }
        : null;
    });

    const waitingOnYou = await this.section(unavailable, 'waitingOnYou', async () => {
      const canApprovePayroll = this.holds('payroll.approve');
      const runs = canApprovePayroll
        ? ((await Run.findAll({ where: { tenantId, step: PayrollProcessStep.APPROVAL } as any, attributes: ['id', 'submittedByUserId'] })) as any[]).filter((run) => !me.userId || run.submittedByUserId !== me.userId).length
        : 0;

      const Revision = await this.modelProvider.getSalaryRevisionRequestModel(tenantId);
      const salaryChanges = this.holds('payroll.compensation.approve')
        ? ((await Revision.findAll({ where: { tenantId, status: 'PENDING' } as any, attributes: ['requestedByUserId', 'requestedByEmail', 'approval'] })) as any[]).filter((row) => this.mineToDecide(row, me, 'requestedByUserId', 'requestedByEmail')).length
        : 0;

      const Settlement = await this.modelProvider.getFinalSettlementModel(tenantId);
      const settlements = this.holds('payroll.approve')
        ? ((await Settlement.findAll({ where: { tenantId, status: 'SUBMITTED' } as any, attributes: ['preparedByUserId', 'preparedByEmail', 'approval'] })) as any[]).filter((row) => this.mineToDecide(row, me, 'preparedByUserId', 'preparedByEmail')).length
        : 0;

      const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
      const reimbursements = this.holds('payroll.adjustments.manage')
        ? ((await Reimbursement.findAll({ where: { tenantId, status: 'SUBMITTED' } as any, attributes: ['approval'] })) as any[]).filter((row) => {
            // A claim with no route is payroll's to decide; one with a route is, once it reaches a payroll stage.
            if (!row.approval) return true;
            const { stages, index } = stagesOf(row.approval as Approval);
            return !stages[index].approverId && Boolean(stages[index].permission) && this.holds(stages[index].permission as string);
          }).length
        : 0;

      const offboardingClearances = this.holds('payroll.adjustments.manage') ? await this.financeClearancesPending(tenantId) : 0;
      const counts = { payrollRuns: runs, salaryChanges, settlements, reimbursements, offboardingClearances };
      return { ...counts, total: sum(Object.values(counts)) };
    });

    const totals = await this.section(unavailable, 'totals', async () => {
      const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
      const Loan = await this.modelProvider.getEmployeeLoanModel(tenantId);
      const Revision = await this.modelProvider.getSalaryRevisionRequestModel(tenantId);
      const Settlement = await this.modelProvider.getFinalSettlementModel(tenantId);
      const [reimbursementsSubmitted, loansActive, salaryChangesPending, settlementsOpen, settlementsApproved] = await Promise.all([
        Reimbursement.count({ where: { tenantId, status: 'SUBMITTED' } as any }),
        Loan.count({ where: { tenantId, status: 'ACTIVE' } as any }),
        Revision.count({ where: { tenantId, status: 'PENDING' } as any }),
        Settlement.count({ where: { tenantId, status: { [Op.in]: ['DRAFT', 'SUBMITTED'] } } as any }),
        Settlement.count({ where: { tenantId, status: 'APPROVED' } as any }),
      ]);
      return { reimbursementsSubmitted, loansActive, salaryChangesPending, settlementsOpen, settlementsApproved };
    });

    return { payroll, waitingOnYou, totals, unavailable };
  }

  /** A pending approval whose current stage the caller can decide, and that they did not prepare or approve earlier. */
  private mineToDecide(row: any, me: { userId: string | null; email: string | null }, userField: string, emailField: string): boolean {
    if (!row.approval) return false;
    if ((me.userId && row[userField] === me.userId) || (me.email && String(row[emailField] ?? '').toLowerCase() === me.email)) return false;
    const approvers: { userId?: string; email?: string }[] = (row.approval as any).approvers ?? [];
    if (approvers.some((a) => (a.userId && a.userId === me.userId) || (a.email && a.email === me.email))) return false;
    const { stages, index } = stagesOf(row.approval as Approval);
    const stage = stages[index];
    return !stage.approverId && Boolean(stage.permission) && this.holds(stage.permission as string);
  }

  private async openClearancesWith(tenantId: string, stage: string): Promise<{ caseId: string; employeeId: string }[]> {
    const Case = await this.modelProvider.getOffboardingCaseModel(tenantId);
    const Clearance = await this.modelProvider.getOffboardingClearanceModel(tenantId);
    const cases = (await Case.findAll({ where: { tenantId, status: 'OPEN' } as any, attributes: ['id', 'employeeId'], raw: true })) as unknown as { id: string; employeeId: string }[];
    if (!cases.length) return [];
    const pending = (await Clearance.findAll({ where: { tenantId, stage, status: 'PENDING', caseId: { [Op.in]: cases.map((row) => row.id) } } as any, attributes: ['caseId'], raw: true })) as unknown as { caseId: string }[];
    const ids = new Set(pending.map((row) => row.caseId));
    return cases.filter((row) => ids.has(row.id)).map((row) => ({ caseId: row.id, employeeId: row.employeeId }));
  }

  private async financeClearancesPending(tenantId: string): Promise<number> {
    return (await this.openClearancesWith(tenantId, 'FINANCE')).length;
  }

  // ==========================================
  // IT
  // ==========================================

  async getIt(tenantId: string) {
    const unavailable: string[] = [];
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const today = todayIso();

    const assets = await this.section(unavailable, 'assets', async () => {
      const byStatus = (await Asset.count({ where: { tenantId } as any, group: ['status'] })) as unknown as { status: string; count: number }[];
      const count = (status: string) => Number(byStatus.find((row) => row.status === status)?.count ?? 0);
      const warrantyExpiring = await Asset.count({ where: { tenantId, warrantyExpiry: { [Op.between]: [today, addDays(today, 30)] } } as any });
      return {
        total: byStatus.reduce((total, row) => total + Number(row.count), 0),
        available: count(AssetStatus.AVAILABLE),
        inUse: count(AssetStatus.IN_USE),
        maintenance: count(AssetStatus.MAINTENANCE),
        damaged: count(AssetStatus.DAMAGED),
        warrantyExpiringIn30Days: warrantyExpiring,
      };
    });

    const tickets = await this.section(unavailable, 'tickets', async () => {
      const Ticket = await this.modelProvider.getHelpdeskTicketModel(tenantId);
      const open = { [Op.in]: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_REQUESTER'] };
      const [openCount, unassigned, urgent, inProgress, resolvedThisWeek] = await Promise.all([
        Ticket.count({ where: { tenantId, status: open } as any }),
        Ticket.count({ where: { tenantId, status: open, assignedToEmployeeId: null } as any }),
        Ticket.count({ where: { tenantId, status: open, priority: 'URGENT' } as any }),
        Ticket.count({ where: { tenantId, status: 'IN_PROGRESS' } as any }),
        Ticket.count({ where: { tenantId, status: 'RESOLVED', resolvedAt: { [Op.gte]: new Date(Date.now() - 7 * 86_400_000) } } as any }),
      ]);
      return { open: openCount, unassigned, urgent, inProgress, resolvedThisWeek };
    });

    const waitingOnYou = await this.section(unavailable, 'waitingOnYou', async () => {
      const Request = await this.modelProvider.getAssetRequestModel(tenantId);
      const Flag = await this.modelProvider.getAssetDeductionFlagModel(tenantId);
      const Task = await this.modelProvider.getOnboardingTaskModel(tenantId);
      const [requests, deductions, setup, setupOverdue, leaving] = await Promise.all([
        Request.count({ where: { tenantId, status: { [Op.in]: ['OPEN', 'IN_PROGRESS'] } } as any }),
        Flag.count({ where: { tenantId, status: 'PENDING' } as any }),
        Task.count({ where: { tenantId, category: 'IT_SETUP', status: 'PENDING' } as any }),
        Task.count({ where: { tenantId, category: 'IT_SETUP', status: 'PENDING', dueDate: { [Op.lt]: today } } as any }),
        this.leavingWithAssets(tenantId),
      ]);
      // A register that cannot be read leaves this one count at zero, not the whole list.
      const unassignedTickets = await this.modelProvider
        .getHelpdeskTicketModel(tenantId)
        .then((Ticket) => Ticket.count({ where: { tenantId, status: 'OPEN', assignedToEmployeeId: null } as any }))
        .catch(() => 0);
      const counts = { assetRequests: requests, deductionsToDecide: deductions, onboardingSetup: setup, leavingWithAssets: leaving, ticketsToPickUp: unassignedTickets };
      return { ...counts, onboardingSetupOverdue: setupOverdue, total: sum(Object.values(counts)) };
    });

    return { assets, tickets, waitingOnYou, unavailable };
  }

  /** People whose offboarding is open and who still hold something. */
  private async leavingWithAssets(tenantId: string): Promise<number> {
    const open = await this.openClearancesWith(tenantId, 'IT');
    if (!open.length) return 0;
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const held = (await Asset.findAll({ where: { tenantId, assignedEmployeeId: { [Op.in]: open.map((row) => row.employeeId) } } as any, attributes: ['assignedEmployeeId'], raw: true })) as unknown as { assignedEmployeeId: string }[];
    return new Set(held.map((row) => row.assignedEmployeeId)).size;
  }

  // ==========================================
  // Manager
  // ==========================================

  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id'] }) : null;
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id'] });
    if (!employee) throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'No employee profile is linked to this login.', HttpStatus.NOT_FOUND);
    return employee;
  }

  /** The people under someone in the reporting line, any depth (within reason). */
  private async reportsOf(tenantId: string, managerId: string, direct = false): Promise<string[]> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const seen = new Set<string>([managerId]);
    let frontier = [managerId];
    for (let depth = 0; depth < (direct ? 1 : TEAM_DEPTH) && frontier.length; depth++) {
      const rows = (await Employee.findAll({ where: { tenantId, reportingManagerId: { [Op.in]: frontier }, status: { [Op.in]: EMPLOYED } } as any, attributes: ['id'], raw: true })) as unknown as { id: string }[];
      frontier = rows.map((row) => row.id).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
    }
    seen.delete(managerId);
    return [...seen];
  }

  /** The people a manager answers for: their scope when their role narrows one, else everyone under them. */
  private async teamOf(tenantId: string, managerId: string): Promise<string[]> {
    const scoped = this.dataScope ? await this.dataScope.visibleEmployeeIds(tenantId) : null;
    if (scoped === null) return this.reportsOf(tenantId, managerId);
    return scoped.filter((id) => id !== managerId);
  }

  async getManager(tenantId: string, userId?: string, email?: string) {
    const unavailable: string[] = [];
    const manager = await this.me(tenantId, userId, email);
    const today = todayIso();
    const team = await this.teamOf(tenantId, manager.id);
    const direct = await this.reportsOf(tenantId, manager.id, true);

    const people = await this.section(unavailable, 'team', async () => {
      if (!team.length) return { size: 0, directReports: 0, onLeaveToday: 0, joinedLast30Days: 0 };
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
      const [onLeave, joined] = await Promise.all([
        Leave.count({ where: { tenantId, status: 'APPROVED', employeeId: { [Op.in]: team }, fromDate: { [Op.lte]: today }, toDate: { [Op.gte]: today } } as any, distinct: true, col: 'employeeId' }),
        Employee.count({ where: { tenantId, id: { [Op.in]: team }, joiningDate: { [Op.gte]: addDays(today, -30) } } as any }),
      ]);
      return { size: team.length, directReports: direct.length, onLeaveToday: Number(onLeave), joinedLast30Days: Number(joined) };
    });

    const waitingOnMe = await this.section(unavailable, 'waitingOnMe', async () => {
      const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
      const Reimbursement = await this.modelProvider.getReimbursementModel(tenantId);
      const leave = await Leave.count({ where: { tenantId, status: 'PENDING', [Op.and]: [sqlWhere(literal(`"LeaveRequest"."approval"->>'currentApproverId'`), manager.id)] } as any });
      const reimbursements = await Reimbursement.count({ where: { tenantId, status: 'SUBMITTED', [Op.and]: [sqlWhere(literal(`"Reimbursement"."approval"->>'currentApproverId'`), manager.id)] } as any });
      const requests = await this.requestsWaitingOn(tenantId, manager.id);
      const offboarding = await this.offboardingWaitingOn(tenantId, direct);
      const counts = { leave, employeeRequests: requests, reimbursements, offboarding };
      return { ...counts, total: sum(Object.values(counts)) };
    });

    const attention = await this.section(unavailable, 'attention', async () => {
      if (!team.length) return { reviewsOpen: 0, goalsOverdue: 0, learningOverdue: 0, mandatoryLearningOverdue: 0 };
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
      const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
      const open = { status: { [Op.in]: ['NOT_STARTED', 'IN_PROGRESS'] }, dueDate: { [Op.lt]: today } };
      const [reviewsOpen, goalsOverdue, learningOverdue, mandatoryLearningOverdue] = await Promise.all([
        Review.count({ where: { tenantId, status: { [Op.ne]: 'COMPLETED' }, closedAt: null, [Op.or]: [{ employeeId: { [Op.in]: team } }, { reviewerId: manager.id }] } as any }),
        Goal.count({ where: { tenantId, employeeId: { [Op.in]: team }, status: { [Op.ne]: 'COMPLETED' }, dueDate: { [Op.lt]: today } } as any }),
        Assignment.count({ where: { tenantId, employeeId: { [Op.in]: team }, ...open } as any }),
        Assignment.count({ where: { tenantId, employeeId: { [Op.in]: team }, mandatory: true, ...open } as any }),
      ]);
      return { reviewsOpen, goalsOverdue, learningOverdue, mandatoryLearningOverdue };
    });

    return { isManager: team.length > 0, team: people, waitingOnMe, attention, unavailable };
  }

  /** Employee requests at the manager's step, when the organization has one. */
  private async requestsWaitingOn(tenantId: string, managerId: string): Promise<number> {
    const Setting = await this.modelProvider.getApprovalSettingModel(tenantId);
    const flow: any = await Setting.findOne({ where: { tenantId }, attributes: ['flow'] }).catch(() => null);
    if (flow?.flow !== 'MANAGER_THEN_HR') return 0;
    const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
    return Request.count({
      where: {
        tenantId,
        status: 'PENDING',
        [Op.and]: [
          sqlWhere(literal(`"EmployeeRequest"."resolution"->>'managerId'`), managerId),
          sqlWhere(literal(`COALESCE("EmployeeRequest"."resolution"->>'stage', 'MANAGER_PENDING')`), 'MANAGER_PENDING'),
        ],
      } as any,
    });
  }

  private async offboardingWaitingOn(tenantId: string, directReports: string[]): Promise<number> {
    if (!directReports.length) return 0;
    const open = await this.openClearancesWith(tenantId, 'MANAGER');
    const mine = new Set(directReports);
    return open.filter((row) => mine.has(row.employeeId)).length;
  }
}
