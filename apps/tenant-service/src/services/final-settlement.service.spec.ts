import { Op } from 'sequelize';
import { runAsRpcActor } from '@app/tenant-context';
import { FinalSettlementService } from './final-settlement.service';
import { matches, table } from './testing/fake-table';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CASE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const LEAVE_POLICY = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const LOAN = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

const PREPARER = { roles: ['HR'], isSuperAdmin: false, isFullAccess: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['offboarding.manage', 'payroll.adjustments.manage'] };
const APPROVER = { roles: ['Finance'], isSuperAdmin: false, isFullAccess: false, userId: 'u-fin', email: 'fin@x.com', permissions: ['payroll.approve', 'payroll.adjustments.manage'] };
const SECOND = { roles: ['Finance'], isSuperAdmin: false, isFullAccess: false, userId: 'u-cfo', email: 'cfo@x.com', permissions: ['payroll.manage'] };
const OUTSIDER = { roles: ['HR'], isSuperAdmin: false, isFullAccess: false, userId: 'u-x', email: 'x@x.com', permissions: ['offboarding.manage'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

describe('FinalSettlementService', () => {
  let models: Record<string, any>;
  let compensation: { basicSalaryOn: jest.Mock; settlementLoans: jest.Mock; markLoanSettled: jest.Mock };
  let payroll: { createAdjustmentEntry: jest.Mock };
  let dataScope: { assertCanSee: jest.Mock; employeeWhere: jest.Mock };
  let service: FinalSettlementService;

  beforeEach(() => {
    models = {
      Settlement: table(),
      Case: table([{ id: CASE, tenantId: TENANT, employeeId: ANNA, status: 'OPEN', lastWorkingDay: '2026-12-15' }]),
      Employee: table([{ id: ANNA, tenantId: TENANT, firstName: 'Anna', lastName: 'Khan', employeeCode: 'E-1', status: 'ACTIVE', reportingManagerId: null }]),
      LeavePolicy: table([{ id: LEAVE_POLICY, tenantId: TENANT, name: 'Annual Leave', isActive: true, isEncashable: true, annualAllocation: 20 }, { id: 'sick', tenantId: TENANT, name: 'Sick Leave', isActive: true, isEncashable: false, annualAllocation: 10 }]),
      Leave: { findAll: jest.fn().mockResolvedValue([{ leavePolicyId: LEAVE_POLICY, days: '6' }]) },
      Reimbursement: { count: jest.fn().mockResolvedValue(2) },
      Flag: { count: jest.fn().mockResolvedValue(0) },
      Policy: table(),
      Audit: table(),
    };
    models.Settlement.findAndCountAll = jest.fn(async ({ where, limit, offset }: any) => {
      const found = models.Settlement.rows.filter((row: any) => matches(row, where));
      return { rows: found.slice(offset, offset + limit), count: found.length };
    });
    compensation = {
      basicSalaryOn: jest.fn().mockResolvedValue(90_000),
      settlementLoans: jest.fn().mockResolvedValue([{ id: LOAN, kind: 'ADVANCE', principal: 50_000, remaining: 20_000, scheduled: 8_000, balance: 12_000 }]),
      markLoanSettled: jest.fn().mockResolvedValue(undefined),
    };
    payroll = { createAdjustmentEntry: jest.fn().mockResolvedValue({ state: 'PENDING', entry: {} }) };
    dataScope = { assertCanSee: jest.fn().mockResolvedValue(undefined), employeeWhere: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getFinalSettlementModel: async () => models.Settlement,
      getOffboardingCaseModel: async () => models.Case,
      getEmployeeModel: async () => models.Employee,
      getLeavePolicyModel: async () => models.LeavePolicy,
      getLeaveRequestModel: async () => models.Leave,
      getReimbursementModel: async () => models.Reimbursement,
      getAssetDeductionFlagModel: async () => models.Flag,
      getApprovalPolicyModel: async () => models.Policy,
      getEntityAuditLogModel: async () => models.Audit,
      getDesignationModel: async () => ({ findAll: async () => [] }),
      getDepartmentModel: async () => ({ findOne: async () => null }),
    };
    service = new FinalSettlementService(provider, compensation as any, payroll as any, dataScope as any);
  });

  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to).filter(Boolean);
  const prepare = (): Promise<any> => as(PREPARER, () => service.prepare(TENANT, CASE));
  const draft = async () => (await prepare()) as any;
  const submitted = async () => {
    const view = await draft();
    await as(PREPARER, () => service.submit(TENANT, view.id));
    return view.id as string;
  };
  const decide = (actor: any, id: string, decision: 'APPROVE' | 'REJECT', extra: Record<string, any> = {}) => as(actor, () => service.decide(TENANT, id, { decision, ...extra } as any));

  describe('preparing', () => {
    it('values the unused leave that may be cashed in and takes the balance of a loan', async () => {
      const view = await draft();

      expect(view).toMatchObject({ status: 'DRAFT', payrollPeriod: '2026-12', lastWorkingDay: '2026-12-15', basicMonthly: 90_000, dailyRate: 3_000, preparedBy: 'hr@x.com', employee: { name: 'Anna Khan' } });
      expect(view.lines.map((l: any) => [l.kind, l.type, l.amount, l.auto])).toEqual([
        ['LEAVE_ENCASHMENT', 'EARNING', 42_000, true],
        ['LOAN_BALANCE', 'DEDUCTION', 12_000, true],
      ]);
      expect(view.lines[0].label).toBe('Annual Leave: 14 unused days');
      expect(view.lines[0].source).toMatchObject({ days: 14, dailyRate: 3_000 });
      expect(view.lines[1].label).toBe('Advance balance');
      expect(view.totals).toEqual({ earnings: 42_000, deductions: 12_000, net: 30_000 });
      // Only a leave type marked as encashable is counted, and the year is the one the last day falls in.
      expect(models.LeavePolicy.findAll).toBeDefined();
      expect(models.Leave.findAll.mock.calls[0][0].where.fromDate[Op.between]).toEqual(['2026-04-01', '2027-03-31']);
      expect(events()).toContain('SETTLEMENT_PREPARED');
    });

    it('shows what reaches payroll by its own route, without counting it again', async () => {
      const view = await draft();
      expect(view.info).toEqual({ reimbursementsInProgress: 2, pendingAssetDeductions: 0 });
      expect(view.lines.some((l: any) => /reimburse|asset/i.test(l.label))).toBe(false);
    });

    it('cannot value leave with no salary on record, and says so', async () => {
      compensation.basicSalaryOn.mockResolvedValue(null);
      const view = await draft();
      expect(view.lines.map((l: any) => l.kind)).toEqual(['LOAN_BALANCE']);
      expect(view.warnings[0]).toContain('no basic salary');
      expect(view.dailyRate).toBeNull();
    });

    it('leaves out a leave type with nothing left, and a loan with nothing to collect', async () => {
      models.Leave.findAll.mockResolvedValue([{ leavePolicyId: LEAVE_POLICY, days: '20' }]);
      compensation.settlementLoans.mockResolvedValue([]);
      expect((await draft()).lines).toEqual([]);
    });

    it('refreshes what the system works out and keeps what was typed in', async () => {
      const first = await draft();
      await as(PREPARER, () => service.addLine(TENANT, first.id, { type: 'DEDUCTION', label: 'Tax withheld', amount: 5_000 } as any));
      models.Leave.findAll.mockResolvedValue([{ leavePolicyId: LEAVE_POLICY, days: '10' }]);

      const again = await draft();

      expect(again.id).toBe(first.id);
      expect(again.lines.map((l: any) => [l.label, l.amount])).toEqual([['Annual Leave: 10 unused days', 30_000], ['Advance balance', 12_000], ['Tax withheld', 5_000]]);
      expect(models.Settlement.rows).toHaveLength(1);
    });

    it('leaves a settlement alone once it has been sent for approval', async () => {
      const id = await submitted();
      models.Leave.findAll.mockResolvedValue([{ leavePolicyId: LEAVE_POLICY, days: '0' }]);
      const view = await prepare();
      expect(view).toMatchObject({ id, status: 'SUBMITTED' });
      expect(view.lines).toHaveLength(2);
    });

    it('is refused for a cancelled offboarding, and for someone the caller cannot reach', async () => {
      models.Case.rows[0].status = 'CANCELLED';
      await expect(prepare()).rejects.toMatchObject({ status: 409 });
      models.Case.rows[0].status = 'OPEN';
      dataScope.assertCanSee.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
      await expect(prepare()).rejects.toMatchObject({ status: 404 });
    });

    it('is shown with its case, or as nothing when none was prepared', async () => {
      expect(await as(PREPARER, () => service.getForCase(TENANT, CASE))).toEqual({ settlement: null });
      const view = await draft();
      expect(((await as(PREPARER, () => service.getForCase(TENANT, CASE))) as any).settlement.id).toBe(view.id);
    });
  });

  describe('lines typed in', () => {
    it('adds, changes and removes them, and keeps the totals right', async () => {
      const first = await draft();
      let view: any = await as(PREPARER, () => service.addLine(TENANT, first.id, { type: 'EARNING', label: 'Gratuity', amount: 100_000, category: 'BONUS' } as any));
      const manual = view.lines.find((l: any) => l.label === 'Gratuity');
      expect(manual).toMatchObject({ kind: 'MANUAL', auto: false, category: 'BONUS' });
      expect(view.totals.net).toBe(130_000);

      view = await as(PREPARER, () => service.updateLine(TENANT, first.id, manual.id, { amount: 80_000, label: 'Gratuity (revised)' } as any));
      expect(view.lines.find((l: any) => l.id === manual.id)).toMatchObject({ amount: 80_000, label: 'Gratuity (revised)' });

      view = await as(PREPARER, () => service.removeLine(TENANT, first.id, manual.id));
      expect(view.totals.net).toBe(30_000);
    });

    it('does not give a deduction an earning category', async () => {
      const first = await draft();
      const view: any = await as(PREPARER, () => service.addLine(TENANT, first.id, { type: 'DEDUCTION', label: 'Notice shortfall', amount: 9_000, category: 'BONUS' } as any));
      expect(view.lines.find((l: any) => l.label === 'Notice shortfall').category).toBe('OTHER');
    });

    it('will not edit a line the system worked out', async () => {
      const first = await draft();
      const auto = first.lines[0];
      await expect(as(PREPARER, () => service.updateLine(TENANT, first.id, auto.id, { amount: 1 } as any))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('worked out by the system') });
      await expect(as(PREPARER, () => service.removeLine(TENANT, first.id, auto.id))).rejects.toMatchObject({ status: 409 });
      await expect(as(PREPARER, () => service.removeLine(TENANT, first.id, 'nope'))).rejects.toMatchObject({ status: 404 });
    });

    it('is limited to thirty lines', async () => {
      const first = await draft();
      for (let i = 0; i < 28; i++) await as(PREPARER, () => service.addLine(TENANT, first.id, { type: 'EARNING', label: `Line ${i}`, amount: 1 } as any));
      await expect(as(PREPARER, () => service.addLine(TENANT, first.id, { type: 'EARNING', label: 'One too many', amount: 1 } as any))).rejects.toMatchObject({ status: 400 });
    });

    it('can only be changed while it is a draft', async () => {
      const id = await submitted();
      await expect(as(PREPARER, () => service.addLine(TENANT, id, { type: 'EARNING', label: 'Late', amount: 1 } as any))).rejects.toMatchObject({ status: 409 });
      await expect(as(PREPARER, () => service.update(TENANT, id, { payrollPeriod: '2027-01' } as any))).rejects.toMatchObject({ status: 409 });
    });

    it('lets the payroll month be chosen while it is a draft', async () => {
      const first = await draft();
      expect(((await as(PREPARER, () => service.update(TENANT, first.id, { payrollPeriod: '2027-01' } as any))) as any).payrollPeriod).toBe('2027-01');
    });
  });

  describe('sending it for approval', () => {
    it('needs something in it, then waits for anyone holding payroll.approve', async () => {
      compensation.settlementLoans.mockResolvedValue([]);
      models.LeavePolicy.rows[0].isEncashable = false;
      const empty = await draft();
      await expect(as(PREPARER, () => service.submit(TENANT, empty.id))).rejects.toMatchObject({ status: 400 });

      await as(PREPARER, () => service.addLine(TENANT, empty.id, { type: 'EARNING', label: 'Bonus', amount: 1_000 } as any));
      const view: any = await as(PREPARER, () => service.submit(TENANT, empty.id));

      expect(view).toMatchObject({ status: 'SUBMITTED', approval: { currentPermission: 'payroll.approve', finalStep: true } });
      expect(view.submittedAt).toBeInstanceOf(Date);
      expect(events()).toContain('SETTLEMENT_SUBMITTED');
    });

    it('follows the organization\'s own route when it saved one', async () => {
      models.Policy.create({ tenantId: TENANT, requestType: 'FINAL_SETTLEMENT', stages: [{ kind: 'PERMISSION', permission: 'payroll.approve' }, { kind: 'PERMISSION', permission: 'payroll.manage' }] });
      const id = await submitted();
      expect(((await as(PREPARER, () => service.getSettlement(TENANT, id))) as any).approval.stages).toHaveLength(2);
    });
  });

  describe('approving', () => {
    it('is not for whoever prepared it, nor anyone without the permission', async () => {
      const id = await submitted();
      await expect(decide({ ...PREPARER, permissions: [...PREPARER.permissions, 'payroll.approve'] }, id, 'APPROVE')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('prepared this settlement') });
      await expect(decide(OUTSIDER, id, 'APPROVE')).rejects.toMatchObject({ status: 403 });
      expect(payroll.createAdjustmentEntry).not.toHaveBeenCalled();
    });

    it('posts every line to payroll for the month, closes the loan, and records who approved', async () => {
      const id = await submitted();

      const view: any = await decide(APPROVER, id, 'APPROVE', { note: 'Checked against the file' });

      expect(view).toMatchObject({ status: 'APPROVED', decidedBy: 'fin@x.com', decisionNote: 'Checked against the file' });
      expect(view.lines.every((l: any) => l.posted)).toBe(true);
      expect(payroll.createAdjustmentEntry).toHaveBeenCalledTimes(2);
      expect(payroll.createAdjustmentEntry).toHaveBeenNthCalledWith(1, TENANT, { employeeId: ANNA, payrollPeriod: '2026-12', type: 'EARNING', category: 'OTHER', amount: 42_000, reason: 'Final settlement: Annual Leave: 14 unused days' });
      expect(payroll.createAdjustmentEntry).toHaveBeenNthCalledWith(2, TENANT, { employeeId: ANNA, payrollPeriod: '2026-12', type: 'DEDUCTION', category: undefined, amount: 12_000, reason: 'Final settlement: Advance balance' });
      expect(compensation.markLoanSettled).toHaveBeenCalledWith(TENANT, LOAN);
      expect(events()).toContain('SETTLEMENT_APPROVED');
    });

    it('can be paid in a different month if that is chosen when approving', async () => {
      const id = await submitted();
      await decide(APPROVER, id, 'APPROVE', { payrollPeriod: '2027-01' });
      expect(payroll.createAdjustmentEntry.mock.calls.every((call: any[]) => call[1].payrollPeriod === '2027-01')).toBe(true);
      expect(models.Settlement.rows[0].payrollPeriod).toBe('2027-01');
    });

    it('says so when the month is locked, stays waiting, and picks up where it stopped', async () => {
      const id = await submitted();
      payroll.createAdjustmentEntry
        .mockResolvedValueOnce({ state: 'PENDING', entry: {} })
        .mockRejectedValueOnce(Object.assign(new Error('The December 2026 payroll is approved and locked'), { status: 409 }));

      await expect(decide(APPROVER, id, 'APPROVE')).rejects.toMatchObject({ status: 409 });
      expect(models.Settlement.rows[0].status).toBe('SUBMITTED');
      expect(models.Settlement.rows[0].lines.map((l: any) => l.posted)).toEqual([true, undefined]);
      expect(compensation.markLoanSettled).not.toHaveBeenCalled();

      // The retry posts only the line that was left, in the month the first one went to.
      payroll.createAdjustmentEntry.mockResolvedValue({ state: 'PENDING', entry: {} });
      const view: any = await decide(APPROVER, id, 'APPROVE', { payrollPeriod: '2027-02' });
      expect(view.status).toBe('APPROVED');
      expect(payroll.createAdjustmentEntry).toHaveBeenCalledTimes(3);
      expect(payroll.createAdjustmentEntry.mock.calls[2][1]).toMatchObject({ type: 'DEDUCTION', payrollPeriod: '2026-12' });
      expect(compensation.markLoanSettled).toHaveBeenCalledWith(TENANT, LOAN);
    });

    it('takes two approvers for two stages, and not the same person twice', async () => {
      models.Policy.create({ tenantId: TENANT, requestType: 'FINAL_SETTLEMENT', stages: [{ kind: 'PERMISSION', permission: 'payroll.approve' }, { kind: 'PERMISSION', permission: 'payroll.manage' }] });
      const id = await submitted();

      const first: any = await decide(APPROVER, id, 'APPROVE');
      expect(first.status).toBe('SUBMITTED');
      expect(payroll.createAdjustmentEntry).not.toHaveBeenCalled();
      await expect(decide({ ...APPROVER, permissions: ['payroll.approve', 'payroll.manage'] }, id, 'APPROVE')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('earlier stage') });

      expect(((await decide(SECOND, id, 'APPROVE')) as any).status).toBe('APPROVED');
    });

    it('sends it back with a reason, to be changed and sent again', async () => {
      const id = await submitted();
      await expect(decide(APPROVER, id, 'REJECT')).rejects.toMatchObject({ status: 400 });

      const back: any = await decide(APPROVER, id, 'REJECT', { note: 'Leave days look too high' });

      expect(back).toMatchObject({ status: 'DRAFT', rejection: { by: 'fin@x.com', note: 'Leave days look too high' } });
      expect(payroll.createAdjustmentEntry).not.toHaveBeenCalled();
      await as(PREPARER, () => service.addLine(TENANT, id, { type: 'DEDUCTION', label: 'Correction', amount: 100 } as any));
      expect(((await as(PREPARER, () => service.submit(TENANT, id))) as any).status).toBe('SUBMITTED');
    });

    it('cannot be decided twice', async () => {
      const id = await submitted();
      await decide(APPROVER, id, 'APPROVE');
      await expect(decide(APPROVER, id, 'APPROVE')).rejects.toMatchObject({ status: 409 });
    });

    it('shows an approver that it is theirs to decide, and the preparer that it is not', async () => {
      const id = await submitted();
      expect(((await as(APPROVER, () => service.getSettlement(TENANT, id))) as any).canDecide).toBe(true);
      expect(((await as({ ...PREPARER, permissions: ['payroll.approve'] }, () => service.getSettlement(TENANT, id))) as any).canDecide).toBe(false);
      expect(((await as(OUTSIDER, () => service.getSettlement(TENANT, id))) as any).canDecide).toBe(false);
    });
  });

  describe('as a PDF', () => {
    it('gives a statement for the settlement, named for the employee', async () => {
      const id = await submitted();
      const payslips = { organization: jest.fn().mockResolvedValue({ name: 'TechNova', address: null, phone: null, email: null, website: null, logoUrl: null }), logoBytes: jest.fn().mockResolvedValue(null) };
      (service as any).payslips = payslips;

      const pdf: any = await as(PREPARER, () => service.getSettlementPdf(TENANT, id));

      expect(pdf).toMatchObject({ filename: 'Final-Settlement-E-1.pdf', mimeType: 'application/pdf' });
      expect(Buffer.from(pdf.contentBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
      expect(payslips.organization).toHaveBeenCalledWith(TENANT);
    });

    it('is only for a settlement the caller can reach', async () => {
      const id = await submitted();
      dataScope.assertCanSee.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
      await expect(as(PREPARER, () => service.getSettlementPdf(TENANT, id))).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('afterwards', () => {
    it('can be cancelled while it is open, but not once approved', async () => {
      const first = await draft();
      expect(((await as(PREPARER, () => service.cancel(TENANT, first.id))) as any).status).toBe('CANCELLED');
      await expect(as(PREPARER, () => service.cancel(TENANT, first.id))).rejects.toMatchObject({ status: 409 });

      models.Settlement.rows.length = 0;
      const id = await submitted();
      await decide(APPROVER, id, 'APPROVE');
      await expect(as(PREPARER, () => service.cancel(TENANT, id))).rejects.toMatchObject({ status: 409 });
    });

    it('is marked paid only once approved', async () => {
      const id = await submitted();
      await expect(as(APPROVER, () => service.markPaid(TENANT, id))).rejects.toMatchObject({ status: 409 });
      await decide(APPROVER, id, 'APPROVE');
      const paid: any = await as(APPROVER, () => service.markPaid(TENANT, id));
      expect(paid).toMatchObject({ status: 'PAID', paidBy: 'fin@x.com' });
      expect(paid.paidAt).toBeInstanceOf(Date);
    });

    it('is listed with a count per status, for the people the caller can reach', async () => {
      const id = await submitted();
      models.Settlement.rows.push({ ...models.Settlement.rows[0], id: 'other', status: 'DRAFT', lines: [], totals: {} });

      const result: any = await as(APPROVER, () => service.getSettlements(TENANT, { status: 'SUBMITTED' as any }));

      expect(result.data.map((row: any) => row.id)).toEqual([id]);
      expect(result.summary).toEqual({ draft: 1, submitted: 1, approved: 0, paid: 0 });
      expect(result.data[0].info).toBeNull();
      expect(dataScope.employeeWhere).toHaveBeenCalled();
    });
  });
});
