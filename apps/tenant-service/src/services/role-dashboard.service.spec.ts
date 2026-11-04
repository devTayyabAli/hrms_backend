import { Op } from 'sequelize';
import { runAsRpcActor } from '@app/tenant-context';
import { RoleDashboardService } from './role-dashboard.service';
import { addDays } from './learning-shared';
import { todayIso } from './workspace-shared';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ME = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';
const A = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const B = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const today = todayIso();

const actor = (permissions: string[], over: Record<string, any> = {}) => ({ roles: [], isSuperAdmin: false, isFullAccess: false, userId: 'u-me', email: 'me@x.com', permissions, ...over });
const as = <T>(who: any, work: () => Promise<T>) => runAsRpcActor(who, work);

const model = (over: Record<string, any> = {}) => ({
  count: jest.fn().mockResolvedValue(0),
  findAll: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  ...over,
});

/** A pending approval whose current stage is anyone holding `permission`. */
const waiting = (permission: string, extra: Record<string, any> = {}) => ({
  approval: {
    stage: 'WITH_HR',
    statusText: 'x',
    currentApproverId: null,
    currentApproverName: null,
    currentApproverTitle: 'T',
    finalStep: true,
    nextApproverId: null,
    nextApproverName: null,
    nextApproverTitle: null,
    workflow: [],
    stages: [{ kind: 'PERMISSION', approverId: null, name: null, title: 'T', permission }],
    stageIndex: 0,
    currentPermission: permission,
    ...(extra.approval ?? {}),
  },
  ...extra,
});

describe('RoleDashboardService', () => {
  let models: Record<string, any>;
  let dataScope: { visibleEmployeeIds: jest.Mock };
  let service: RoleDashboardService;

  beforeEach(() => {
    models = {
      Run: model(),
      Revision: model(),
      Settlement: model(),
      Reimbursement: model(),
      Loan: model(),
      Case: model(),
      Clearance: model(),
      Asset: model(),
      AssetRequest: model(),
      Flag: model(),
      Ticket: model(),
      Task: model(),
      Employee: model(),
      Leave: model(),
      Review: model(),
      Goal: model(),
      Assignment: model(),
      ApprovalSetting: model(),
      EmployeeRequest: model(),
    };
    dataScope = { visibleEmployeeIds: jest.fn().mockResolvedValue(null) };
    const provider: any = {
      getPayrollRunModel: async () => models.Run,
      getSalaryRevisionRequestModel: async () => models.Revision,
      getFinalSettlementModel: async () => models.Settlement,
      getReimbursementModel: async () => models.Reimbursement,
      getEmployeeLoanModel: async () => models.Loan,
      getOffboardingCaseModel: async () => models.Case,
      getOffboardingClearanceModel: async () => models.Clearance,
      getAssetModel: async () => models.Asset,
      getAssetRequestModel: async () => models.AssetRequest,
      getAssetDeductionFlagModel: async () => models.Flag,
      getHelpdeskTicketModel: async () => models.Ticket,
      getOnboardingTaskModel: async () => models.Task,
      getEmployeeModel: async () => models.Employee,
      getLeaveRequestModel: async () => models.Leave,
      getPerformanceReviewModel: async () => models.Review,
      getPerformanceGoalModel: async () => models.Goal,
      getTrainingAssignmentModel: async () => models.Assignment,
      getApprovalSettingModel: async () => models.ApprovalSetting,
      getEmployeeRequestModel: async () => models.EmployeeRequest,
    };
    service = new RoleDashboardService(provider, dataScope as any);
  });

  describe('Finance', () => {
    const finance = (permissions: string[]) => as(actor(permissions), () => service.getFinance(TENANT));

    it('is empty, not broken, when nothing has happened', async () => {
      const result = await finance(['payroll.manage']);
      expect(result.payroll).toBeNull();
      expect(result.waitingOnYou).toEqual({ payrollRuns: 0, salaryChanges: 0, settlements: 0, reimbursements: 0, offboardingClearances: 0, total: 0 });
      expect(result.totals).toEqual({ reimbursementsSubmitted: 0, loansActive: 0, salaryChangesPending: 0, settlementsOpen: 0, settlementsApproved: 0 });
      expect(result.unavailable).toEqual([]);
    });

    it('shows the latest payroll', async () => {
      models.Run.findOne.mockResolvedValue({ id: 'r1', periodStart: '2026-11-01', step: 'APPROVAL', status: 'PROCESSING', employeeCount: 40, netPay: '3500000.50', payDate: '2026-11-30' });
      expect((await finance(['payroll.view'])).payroll).toEqual({ id: 'r1', period: '2026-11', step: 'APPROVAL', status: 'PROCESSING', employeeCount: 40, netPay: 3500000.5, payDate: '2026-11-30' });
      expect(models.Run.findOne.mock.calls[0][0].order).toEqual([['periodStart', 'DESC']]);
    });

    it('counts payroll waiting for approval only for someone who can approve it, and never one they submitted', async () => {
      models.Run.findAll.mockResolvedValue([{ id: 'r1', submittedByUserId: 'u-other' }, { id: 'r2', submittedByUserId: 'u-me' }]);

      expect((await finance(['payroll.approve'])).waitingOnYou!.payrollRuns).toBe(1);
      expect((await finance(['payroll.view'])).waitingOnYou!.payrollRuns).toBe(0);
      expect(models.Run.findAll.mock.calls[0][0].where.step).toBe('APPROVAL');
    });

    it('counts salary changes and settlements the caller can decide, not their own, nor ones they approved a stage of', async () => {
      models.Revision.findAll.mockResolvedValue([
        { requestedByUserId: 'u-x', requestedByEmail: 'x@x.com', ...waiting('payroll.compensation.approve') },
        { requestedByUserId: 'u-me', requestedByEmail: 'me@x.com', ...waiting('payroll.compensation.approve') },
        { requestedByUserId: 'u-y', requestedByEmail: 'y@x.com', ...waiting('payroll.compensation.approve', { approval: { approvers: [{ userId: 'u-me' }] } }) },
      ]);
      models.Settlement.findAll.mockResolvedValue([
        { preparedByUserId: 'u-x', preparedByEmail: 'x@x.com', ...waiting('payroll.approve') },
        { preparedByUserId: 'u-me', preparedByEmail: 'me@x.com', ...waiting('payroll.approve') },
      ]);

      const result = await finance(['payroll.compensation.approve', 'payroll.approve']);

      expect(result.waitingOnYou).toMatchObject({ salaryChanges: 1, settlements: 1 });
      // payroll.manage stands in for the other payroll grants.
      expect((await finance(['payroll.manage'])).waitingOnYou).toMatchObject({ salaryChanges: 1, settlements: 1 });
      expect((await finance(['payroll.view'])).waitingOnYou).toMatchObject({ salaryChanges: 0, settlements: 0 });
    });

    it('counts claims that are for payroll to decide: with no route, or at a payroll stage, not at a manager stage', async () => {
      const managerStage = { approval: { stages: [{ kind: 'REPORTING_MANAGER', approverId: ME, name: 'M', title: 'Lead', permission: null }], stageIndex: 0 } };
      models.Reimbursement.findAll.mockResolvedValue([{ approval: null }, waiting('payroll.adjustments.manage'), { ...managerStage }]);

      expect((await finance(['payroll.adjustments.manage'])).waitingOnYou!.reimbursements).toBe(2);
      expect((await finance(['payroll.view'])).waitingOnYou!.reimbursements).toBe(0);
    });

    it('counts offboardings where the Finance clearance is still wanted', async () => {
      models.Case.findAll.mockResolvedValue([{ id: 'c1', employeeId: A }, { id: 'c2', employeeId: B }]);
      models.Clearance.findAll.mockResolvedValue([{ caseId: 'c2' }]);

      expect((await finance(['payroll.adjustments.manage'])).waitingOnYou!.offboardingClearances).toBe(1);
      expect(models.Clearance.findAll.mock.calls[0][0].where).toMatchObject({ stage: 'FINANCE', status: 'PENDING' });
      expect((await finance(['payroll.view'])).waitingOnYou!.offboardingClearances).toBe(0);
    });

    it('adds up what is waiting, and the totals', async () => {
      models.Reimbursement.count.mockResolvedValue(4);
      models.Loan.count.mockResolvedValue(6);
      models.Revision.count.mockResolvedValue(2);
      models.Settlement.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
      models.Reimbursement.findAll.mockResolvedValue([{ approval: null }, { approval: null }]);

      const result = await finance(['payroll.adjustments.manage']);

      expect(result.waitingOnYou!.total).toBe(2);
      expect(result.totals).toEqual({ reimbursementsSubmitted: 4, loansActive: 6, salaryChangesPending: 2, settlementsOpen: 3, settlementsApproved: 1 });
    });

    it('keeps the rest when one section cannot be read, and says which', async () => {
      models.Loan.count.mockRejectedValue(new Error('relation "employee_loans" does not exist'));
      const result = await finance(['payroll.manage']);
      expect(result.totals).toBeNull();
      expect(result.unavailable).toEqual(['totals']);
      expect(result.waitingOnYou).not.toBeNull();
    });
  });

  describe('IT', () => {
    const it_ = () => as(actor(['assets.view']), () => service.getIt(TENANT));

    it('shows the register by status and what warranty is running out', async () => {
      models.Asset.count.mockResolvedValueOnce([{ status: 'AVAILABLE', count: '5' }, { status: 'IN_USE', count: '20' }, { status: 'MAINTENANCE', count: '2' }, { status: 'DAMAGED', count: '1' }]).mockResolvedValueOnce(3);

      const result = await it_();

      expect(result.assets).toEqual({ total: 28, available: 5, inUse: 20, maintenance: 2, damaged: 1, warrantyExpiringIn30Days: 3 });
      expect(models.Asset.count.mock.calls[1][0].where.warrantyExpiry[Op.between]).toEqual([today, addDays(today, 30)]);
    });

    it('counts what is waiting: requests, deductions, setup items (and the overdue ones), and people leaving with assets', async () => {
      models.AssetRequest.count.mockResolvedValue(3);
      models.Flag.count.mockResolvedValue(1);
      models.Task.count.mockResolvedValueOnce(7).mockResolvedValueOnce(2);
      models.Case.findAll.mockResolvedValue([{ id: 'c1', employeeId: A }, { id: 'c2', employeeId: B }]);
      models.Clearance.findAll.mockResolvedValue([{ caseId: 'c1' }, { caseId: 'c2' }]);
      models.Asset.findAll.mockResolvedValue([{ assignedEmployeeId: A }, { assignedEmployeeId: A }]);

      const { waitingOnYou } = await it_();

      expect(waitingOnYou).toEqual({ assetRequests: 3, deductionsToDecide: 1, onboardingSetup: 7, leavingWithAssets: 1, ticketsToPickUp: 0, onboardingSetupOverdue: 2, total: 12 });
      expect(models.AssetRequest.count.mock.calls[0][0].where.status[Op.in]).toEqual(['OPEN', 'IN_PROGRESS']);
      expect(models.Task.count.mock.calls[1][0].where).toMatchObject({ category: 'IT_SETUP', status: 'PENDING', dueDate: { [Op.lt]: today } });
      expect(models.Clearance.findAll.mock.calls[0][0].where).toMatchObject({ stage: 'IT', status: 'PENDING' });
    });

    it('counts the helpdesk queue, and how many tickets nobody has picked up', async () => {
      models.Ticket.count.mockResolvedValueOnce(9).mockResolvedValueOnce(4).mockResolvedValueOnce(2).mockResolvedValueOnce(3).mockResolvedValueOnce(6).mockResolvedValueOnce(4);

      const result = await it_();

      expect(result.tickets).toEqual({ open: 9, unassigned: 4, urgent: 2, inProgress: 3, resolvedThisWeek: 6 });
      expect(models.Ticket.count.mock.calls[0][0].where.status[Op.in]).toEqual(['OPEN', 'IN_PROGRESS', 'WAITING_ON_REQUESTER']);
      expect(models.Ticket.count.mock.calls[1][0].where).toMatchObject({ assignedToEmployeeId: null });
      expect(result.waitingOnYou).toMatchObject({ ticketsToPickUp: 4 });
    });

    it('keeps the rest when the tickets cannot be read', async () => {
      models.Asset.count.mockResolvedValueOnce([]).mockResolvedValueOnce(0);
      models.Ticket.count.mockRejectedValue(new Error('no table'));
      const result = await it_();
      expect(result.tickets).toBeNull();
      expect(result.unavailable).toEqual(['tickets']);
      expect(result.waitingOnYou).toMatchObject({ ticketsToPickUp: 0 });
    });

    it('does not look for held assets when nobody is leaving', async () => {
      await it_();
      expect(models.Asset.findAll).not.toHaveBeenCalled();
    });

    it('keeps the rest when the register cannot be read', async () => {
      models.Asset.count.mockRejectedValue(new Error('boom'));
      const result = await it_();
      expect(result.assets).toBeNull();
      expect(result.unavailable).toEqual(['assets']);
    });
  });

  describe('Manager', () => {
    const manager = () => service.getManager(TENANT, 'u-me');

    beforeEach(() => {
      models.Employee.findOne.mockResolvedValue({ id: ME });
      models.Employee.findAll.mockImplementation(async ({ where }: any) => {
        const bosses = where.reportingManagerId[Op.in] as string[];
        return bosses.includes(ME) ? [{ id: A }, { id: B }] : [];
      });
    });

    it('is not a manager when nobody works under them, and everything is zero', async () => {
      models.Employee.findAll.mockResolvedValue([]);
      const result = await manager();
      expect(result.isManager).toBe(false);
      expect(result.team).toEqual({ size: 0, directReports: 0, onLeaveToday: 0, joinedLast30Days: 0 });
      expect(result.attention).toEqual({ reviewsOpen: 0, goalsOverdue: 0, learningOverdue: 0, mandatoryLearningOverdue: 0 });
    });

    it('says so when the login has no employee profile', async () => {
      models.Employee.findOne.mockResolvedValue(null);
      await expect(manager()).rejects.toMatchObject({ status: 404 });
    });

    it('shows the team: its size, who is on leave today, and who joined recently', async () => {
      models.Leave.count.mockResolvedValueOnce(1).mockResolvedValue(0);
      models.Employee.count.mockResolvedValue(1);

      const result = await manager();

      expect(result).toMatchObject({ isManager: true, team: { size: 2, directReports: 2, onLeaveToday: 1, joinedLast30Days: 1 } });
      expect(models.Leave.count.mock.calls[0][0].where).toMatchObject({ status: 'APPROVED', employeeId: { [Op.in]: [A, B] } });
    });

    it('counts what is waiting on them to approve', async () => {
      models.Leave.count.mockResolvedValueOnce(0).mockResolvedValue(3);
      models.Reimbursement.count.mockResolvedValue(2);
      models.ApprovalSetting.findOne.mockResolvedValue({ flow: 'MANAGER_THEN_HR' });
      models.EmployeeRequest.count.mockResolvedValue(4);
      models.Case.findAll.mockResolvedValue([{ id: 'c1', employeeId: A }, { id: 'c2', employeeId: 'someone-else' }]);
      models.Clearance.findAll.mockResolvedValue([{ caseId: 'c1' }, { caseId: 'c2' }]);

      const result = await manager();

      expect(result.waitingOnMe).toEqual({ leave: 3, employeeRequests: 4, reimbursements: 2, offboarding: 1, total: 10 });
      expect(models.Clearance.findAll.mock.calls[0][0].where).toMatchObject({ stage: 'MANAGER', status: 'PENDING' });
    });

    it('counts employee requests only when the organization has a manager step', async () => {
      models.ApprovalSetting.findOne.mockResolvedValue({ flow: 'SINGLE' });
      expect((await manager()).waitingOnMe!.employeeRequests).toBe(0);
      expect(models.EmployeeRequest.count).not.toHaveBeenCalled();
    });

    it('shows what needs attention on the team', async () => {
      models.Review.count.mockResolvedValue(3);
      models.Goal.count.mockResolvedValue(2);
      models.Assignment.count.mockResolvedValueOnce(5).mockResolvedValueOnce(1);

      const { attention } = await manager();

      expect(attention).toEqual({ reviewsOpen: 3, goalsOverdue: 2, learningOverdue: 5, mandatoryLearningOverdue: 1 });
      expect(models.Review.count.mock.calls[0][0].where.status).toEqual({ [Op.ne]: 'COMPLETED' });
      expect(models.Assignment.count.mock.calls[1][0].where).toMatchObject({ mandatory: true, dueDate: { [Op.lt]: today } });
    });

    it('answers for the people their role reaches when the role narrows one, not only their reports', async () => {
      dataScope.visibleEmployeeIds.mockResolvedValue([ME, A, B, 'c']);
      const result = await manager();
      expect(result.team).toMatchObject({ size: 3 });
      expect(result.isManager).toBe(true);
    });

    it('keeps the rest when one section cannot be read', async () => {
      models.Review.count.mockRejectedValue(new Error('boom'));
      const result = await manager();
      expect(result.attention).toBeNull();
      expect(result.unavailable).toEqual(['attention']);
      expect(result.waitingOnMe).not.toBeNull();
    });
  });
});
