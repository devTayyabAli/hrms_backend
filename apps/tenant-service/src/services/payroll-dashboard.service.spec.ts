import { HttpStatus } from '@nestjs/common';
import { LeaveRequestStatus, PayrollProcessStep, PolicyStatus, PolicyType } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PayrollDashboardService } from './payroll-dashboard.service';
import { table } from './testing/fake-table';

/**
 * The payroll rules that cost real money to get wrong, end to end through
 * the service: what a run is calculated from, the one-run-per-month rule,
 * the Review → Approval → Payment → Completed order, the lock after approval,
 * who may do what, and that one organization never sees another's payroll.
 *
 * The models are the shared in-memory fake (testing/fake-table), so the tests
 * read like the real flow.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';


const MON_SAT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SEPTEMBER = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };

const employee = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  employeeCode: 'EMP001',
  firstName: 'Ayesha',
  lastName: 'Khan',
  email: 'ayesha@x.com',
  status: 'ACTIVE',
  joiningDate: '2025-01-01',
  exitDate: null,
  basicSalary: '100000',
  allowances: '0',
  recurringDeductions: '0',
  salaryEffectiveFrom: '2025-01-01',
  bankName: 'HBL',
  bankAccountTitle: 'Ayesha Khan',
  bankAccountNumber: '0123',
  iban: null,
  ...over,
});

const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['payroll.view', 'payroll.create', 'payroll.edit'] };
const FINANCE = { roles: ['Finance'], isSuperAdmin: false, userId: 'u-fin', email: 'fin@x.com', permissions: ['payroll.view', 'payroll.approve'] };
const MANAGER = { roles: ['Department Manager'], isSuperAdmin: false, userId: 'u-mgr', email: 'mgr@x.com', permissions: ['employee.view'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

describe('PayrollDashboardService', () => {
  let models: Record<string, any>;
  let service: PayrollDashboardService;

  const build = (seed: { employees?: any[]; attendance?: any[]; leaves?: any[]; revisions?: any[]; shift?: any | null } = {}) => {
    models = {
      Run: table(),
      Record: table(),
      Adjustment: table(),
      Employee: table(seed.employees ?? [employee()]),
      Revision: table(seed.revisions ?? []),
      Attendance: table(seed.attendance ?? []),
      Leave: table(seed.leaves ?? []),
      WorkingHours: table(
        seed.shift === null
          ? []
          : [seed.shift ?? { tenantId: TENANT, workingDays: MON_SAT, startTime: '09:00', endTime: '18:00', breakDurationMinutes: 60, isDefault: true }],
      ),
      Policy: table([
        { tenantId: TENANT, policyType: PolicyType.PAYROLL, status: PolicyStatus.ACTIVE, configuration: { payFrequency: 'MONTHLY', currency: 'PKR' } },
      ]),
      Audit: table(),
      Profile: table(),
    };
    const provider = {
      getPayrollRunModel: async () => models.Run,
      getPayrollRecordModel: async () => models.Record,
      getPayrollAdjustmentModel: async () => models.Adjustment,
      getEmployeeModel: async () => models.Employee,
      getSalaryRevisionModel: async () => models.Revision,
      getAttendanceRecordModel: async () => models.Attendance,
      getLeaveRequestModel: async () => models.Leave,
      getLeavePolicyModel: async () => ({}),
      getWorkingHoursModel: async () => models.WorkingHours,
      getOrganizationPolicyModel: async () => models.Policy,
      getEntityAuditLogModel: async () => models.Audit,
      getEmployeeTaxProfileModel: async () => models.Profile,
      getDepartmentModel: async () => ({}),
      getDesignationModel: async () => ({}),
    };
    service = new PayrollDashboardService(provider as any);
  };

  const employeeId = () => models.Employee.rows[0].id;
  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to);

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-05T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    build();
  });
  afterEach(() => jest.useRealTimers());

  describe('creating a run', () => {
    it('calculates every line from salary, attendance and approved leave', async () => {
      build({ employees: [employee()] });
      const id = employeeId();
      models.Attendance.rows.push(
        { tenantId: TENANT, employeeId: id, date: '2026-09-02', status: 'ABSENT', overtimeMinutes: null },
        { tenantId: TENANT, employeeId: id, date: '2026-09-03', status: 'PRESENT', overtimeMinutes: null },
      );
      models.Leave.rows.push(
        { tenantId: TENANT, employeeId: id, status: LeaveRequestStatus.APPROVED, fromDate: '2026-09-07', toDate: '2026-09-07', totalDays: 1, leavePolicy: { isPaid: false } },
        // Pending leave never touches pay.
        { tenantId: TENANT, employeeId: id, status: LeaveRequestStatus.PENDING, fromDate: '2026-09-08', toDate: '2026-09-08', totalDays: 1, leavePolicy: { isPaid: false } },
      );

      const run = await service.createRun(TENANT, SEPTEMBER);

      expect(run.step).toBe(PayrollProcessStep.REVIEW);
      expect(run.currency).toBe('PKR');
      expect(run.records).toHaveLength(1);
      const line = run.records[0];
      expect(line.workingDays).toBe(26);
      expect(line.absenceDays).toBe(1);
      expect(line.unpaidLeaveDays).toBe(1);
      // Each deduction is rounded to the paisa before it is summed: 3,846.15 × 2.
      expect(line.unpaidDeduction).toBe(7_692.3);
      expect(line.netPay).toBe(92_307.7);
      expect(events()).toContain('PAYROLL_CREATED');
    });

    it('leaves out an employee with no salary, and says why', async () => {
      build({ employees: [employee(), employee({ employeeCode: 'EMP002', email: 'b@x.com', basicSalary: '0' })] });
      const run = await service.createRun(TENANT, SEPTEMBER);
      expect(run.records).toHaveLength(1);
      expect(run.skippedEmployees).toEqual([expect.objectContaining({ employeeCode: 'EMP002', reason: 'No salary set' })]);
    });

    it('pays a leaver up to their last day, and not a person who left before the month', async () => {
      build({
        employees: [
          employee({ status: 'RESIGNED', exitDate: '2026-09-20' }),
          employee({ employeeCode: 'EMP002', email: 'b@x.com', status: 'RESIGNED', exitDate: '2026-08-15' }),
        ],
      });
      const run = await service.createRun(TENANT, SEPTEMBER);
      expect(run.records).toHaveLength(1);
      expect(run.records[0].eligibleDays).toBe(17);
    });

    it('uses the salary revision in effect for the month, not a later raise', async () => {
      build();
      models.Revision.rows.push(
        { tenantId: TENANT, employeeId: employeeId(), effectiveFrom: '2026-01-01', basicSalary: '80000', allowances: '0', recurringDeductions: '0' },
      );
      // A raise that starts in October is filtered out for September.
      models.Revision.rows.push(
        { tenantId: TENANT, employeeId: employeeId(), effectiveFrom: '2026-10-01', basicSalary: '90000', allowances: '0', recurringDeductions: '0' },
      );
      const run = await service.createRun(TENANT, SEPTEMBER);
      expect(run.records[0].basicSalary).toBe(80_000);
    });

    it('refuses anything but one whole calendar month', async () => {
      await expect(service.createRun(TENANT, { periodStart: '2026-09-05', periodEnd: '2026-09-30' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
      expect(models.Run.create).not.toHaveBeenCalled();
    });

    it('refuses a month that already has a run', async () => {
      await service.createRun(TENANT, SEPTEMBER);
      await expect(service.createRun(TENANT, SEPTEMBER)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(models.Run.rows).toHaveLength(1);
    });

    it('refuses to run without working days to count against', async () => {
      build({ shift: null });
      await expect(service.createRun(TENANT, SEPTEMBER)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('refuses a month that has not started', async () => {
      await expect(service.createRun(TENANT, { periodStart: '2026-11-01', periodEnd: '2026-11-30' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });
  });

  describe('lifecycle', () => {
    const open = async () => (await service.createRun(TENANT, SEPTEMBER)).id;

    it('walks Review → Approval → Payment → Completed and records who and when', async () => {
      const id = await open();
      expect((await as(HR, () => service.submitRun(TENANT, id))).step).toBe(PayrollProcessStep.APPROVAL);
      const approved = await as(FINANCE, () => service.approveRun(TENANT, id));
      expect(approved.step).toBe(PayrollProcessStep.PAYMENT);
      expect(approved.locked).toBe(true);
      expect(approved.approvedAt).toBeTruthy();
      // Can't be paid before it was approved (today, on the fake clock).
      await expect(as(FINANCE, () => service.payRun(TENANT, id, { paymentDate: '2026-10-01' }))).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
      const paid = await as(FINANCE, () =>
        service.payRun(TENANT, id, { paymentDate: '2026-10-05', paymentReference: 'HBL batch 12' }),
      );
      expect(paid.step).toBe(PayrollProcessStep.COMPLETED);
      expect(paid.paymentDate).toBe('2026-10-05');
      expect(paid.paidBy).toEqual(expect.objectContaining({ email: 'fin@x.com' }));
      expect(events()).toEqual(
        expect.arrayContaining(['PAYROLL_SUBMITTED', 'PAYROLL_APPROVED', 'PAYROLL_PAID']),
      );
    });

    it('never skips a step', async () => {
      const id = await open();
      await expect(service.approveRun(TENANT, id)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(service.payRun(TENANT, id, { paymentDate: '2026-10-01' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('can be returned to Review from Approval, with a reason', async () => {
      const id = await open();
      await service.submitRun(TENANT, id);
      const back = await as(FINANCE, () => service.returnRun(TENANT, id, { reason: 'Fix Ahmed’s absences' }));
      expect(back.step).toBe(PayrollProcessStep.REVIEW);
      expect(back.returnReason).toBe('Fix Ahmed’s absences');
    });

    it('cannot be returned once approved', async () => {
      const id = await open();
      await service.submitRun(TENANT, id);
      await service.approveRun(TENANT, id);
      await expect(service.returnRun(TENANT, id, { reason: 'too late' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('refuses a payment date in the future', async () => {
      const id = await open();
      await service.submitRun(TENANT, id);
      await service.approveRun(TENANT, id);
      await expect(service.payRun(TENANT, id, { paymentDate: '2026-12-01' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('refuses to submit a line with negative net pay', async () => {
      build({ employees: [employee({ basicSalary: '1000', recurringDeductions: '5000' })] });
      const id = await open();
      await expect(service.submitRun(TENANT, id)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });
  });

  describe('adjustments', () => {
    it('changes a line in Review, with an audit entry', async () => {
      const run = await service.createRun(TENANT, SEPTEMBER);
      const line = await as(HR, () =>
        service.addAdjustment(TENANT, run.records[0].id, { type: 'EARNING' as any, amount: 5000, reason: 'Performance bonus' }),
      );
      expect(line.netPay).toBe(105_000);
      expect(line.adjustments).toEqual([expect.objectContaining({ amount: 5000, reason: 'Performance bonus' })]);
      expect((await service.getRun(TENANT, run.id)).netPay).toBe(105_000);
      expect(events()).toContain('PAYROLL_ADJUSTMENT_ADDED');

      const removed = await service.removeAdjustment(TENANT, line.adjustments[0].id);
      expect(removed.netPay).toBe(100_000);
      expect(events()).toContain('PAYROLL_ADJUSTMENT_REMOVED');
    });

    it('are kept when the run is recalculated', async () => {
      const run = await service.createRun(TENANT, SEPTEMBER);
      await service.addAdjustment(TENANT, run.records[0].id, { type: 'DEDUCTION' as any, amount: 1000, reason: 'Advance recovery' });
      models.Attendance.rows.push({ tenantId: TENANT, employeeId: employeeId(), date: '2026-09-02', status: 'ABSENT', overtimeMinutes: null });
      const fresh = await service.recalculateRun(TENANT, run.id);
      expect(fresh.records[0].absenceDays).toBe(1);
      expect(fresh.records[0].netPay).toBeCloseTo(100_000 - 100_000 / 26 - 1000, 2);
    });

    it('are refused once the run is approved — the lock', async () => {
      const run = await service.createRun(TENANT, SEPTEMBER);
      await service.submitRun(TENANT, run.id);
      await service.approveRun(TENANT, run.id);
      await expect(
        service.addAdjustment(TENANT, run.records[0].id, { type: 'EARNING' as any, amount: 1, reason: 'late fix' }),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(service.recalculateRun(TENANT, run.id)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });
  });

  describe('permissions', () => {
    it('lets HR prepare and submit, but not approve', async () => {
      const id = (await as(HR, () => service.createRun(TENANT, SEPTEMBER))).id;
      await as(HR, () => service.submitRun(TENANT, id));
      await expect(as(HR, () => service.approveRun(TENANT, id))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('does not let the submitter approve their own run', async () => {
      const both = { ...FINANCE, permissions: ['payroll.edit', 'payroll.approve'] };
      const id = (await service.createRun(TENANT, SEPTEMBER)).id;
      await as(both, () => service.submitRun(TENANT, id));
      await expect(as(both, () => service.approveRun(TENANT, id))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('lets an approver return and pay, but not create or edit', async () => {
      await expect(as(FINANCE, () => service.createRun(TENANT, SEPTEMBER))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      const run = await service.createRun(TENANT, SEPTEMBER);
      await expect(
        as(FINANCE, () => service.addAdjustment(TENANT, run.records[0].id, { type: 'EARNING' as any, amount: 1, reason: 'nope' })),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('keeps salaries from someone with employee access only', async () => {
      await expect(as(MANAGER, () => service.getEmployeePay(TENANT, employeeId()))).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
      await expect(
        as(MANAGER, () =>
          service.setEmployeeSalary(TENANT, employeeId(), { basicSalary: 1, allowances: 0, recurringDeductions: 0, effectiveFrom: '2026-09-01' }),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('treats payroll.manage as every payroll permission', async () => {
      const admin = { ...FINANCE, userId: 'u-admin', permissions: ['payroll.manage'] };
      const id = (await as(admin, () => service.createRun(TENANT, SEPTEMBER))).id;
      await as(HR, () => service.submitRun(TENANT, id));
      expect((await as(admin, () => service.approveRun(TENANT, id))).step).toBe(PayrollProcessStep.PAYMENT);
    });
  });

  describe('tenant isolation', () => {
    it('never finds another organization’s run', async () => {
      const id = (await service.createRun(TENANT, SEPTEMBER)).id;
      await expect(service.getRun(OTHER_TENANT, id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(service.submitRun(OTHER_TENANT, id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('never pays another organization’s employees', async () => {
      build({ employees: [employee(), employee({ tenantId: OTHER_TENANT, employeeCode: 'X1', email: 'x@y.com' })] });
      const run = await service.createRun(TENANT, SEPTEMBER);
      expect(run.records).toHaveLength(1);
    });
  });

  describe('salary', () => {
    it('keeps history: a new date adds a revision, the same date corrects it', async () => {
      const id = employeeId();
      await as(HR, () => service.setEmployeeSalary(TENANT, id, { basicSalary: 120_000, allowances: 10_000, recurringDeductions: 0, effectiveFrom: '2026-10-01', reason: 'Increment' }));
      await as(HR, () => service.setEmployeeSalary(TENANT, id, { basicSalary: 125_000, allowances: 10_000, recurringDeductions: 0, effectiveFrom: '2026-10-01' }));
      const pay = await as(HR, () => service.setEmployeeSalary(TENANT, id, { basicSalary: 90_000, allowances: 0, recurringDeductions: 0, effectiveFrom: '2026-01-01' }));

      expect(pay.history).toHaveLength(2);
      expect(pay.current).toEqual(expect.objectContaining({ basicSalary: 125_000, effectiveFrom: '2026-10-01' }));
      expect(models.Employee.rows[0].basicSalary).toBe(125_000);
      expect(events()).toEqual(expect.arrayContaining(['SALARY_REVISED', 'SALARY_CORRECTED']));
    });

    it('won’t start a salary before the joining date', async () => {
      await expect(
        service.setEmployeeSalary(TENANT, employeeId(), { basicSalary: 1, allowances: 0, recurringDeductions: 0, effectiveFrom: '2024-12-01' }),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('records bank changes with account numbers masked', async () => {
      await as(HR, () => service.setEmployeeBank(TENANT, employeeId(), { bankAccountNumber: '0123-4567890-01', iban: 'pk36 scbl 0000 0011 2345 6702' }));
      expect(models.Employee.rows[0].iban).toBe('PK36SCBL0000001123456702');
      const entry = models.Audit.rows.find((row: any) => row.changes?.event?.to === 'BANK_DETAILS_UPDATED');
      expect(entry.changes.bankAccountNumber.to).toBe('•••• 0-01');
      expect(JSON.stringify(entry.changes)).not.toContain('4567890');
    });
  });

  // ── Cycle, process checks and export (merged from nav_dev) ─────────────────

  describe('payroll cycle and pay date', () => {
    it('pays a monthly run 20 days after the month ends unless a pay date is given', async () => {
      const run = await service.createRun(TENANT, SEPTEMBER);
      expect(run).toMatchObject({ cycle: 'MONTHLY', payDate: '2026-10-20' });
    });

    it('keeps an explicit pay date', async () => {
      const run = await service.createRun(TENANT, { ...SEPTEMBER, payDate: '2026-10-05' } as any);
      expect(run.payDate).toBe('2026-10-05');
    });

    it('refuses a weekly or bi-weekly run — calculation is by calendar month', async () => {
      await expect(service.createRun(TENANT, { ...SEPTEMBER, cycle: 'BI_WEEKLY' } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(models.Run.rows).toHaveLength(0);
    });

    it('projects the next period and pay date a month on', async () => {
      await service.createRun(TENANT, SEPTEMBER);
      const cycle = await service.getCycle(TENANT);
      expect(cycle).toMatchObject({ periodLabel: 'September 2026', payDate: '2026-10-20', nextPeriodStart: '2026-10-30', nextPayDate: '2026-11-20' });
      expect(cycle.steps.map((s: any) => s.key)).toEqual(['REVIEW', 'APPROVAL', 'PAYMENT', 'COMPLETED']);
    });

    it('clamps a month-end pay date to the shorter month', async () => {
      jest.setSystemTime(new Date('2026-02-05T10:00:00Z'));
      await service.createRun(TENANT, { periodStart: '2026-01-01', periodEnd: '2026-01-31', payDate: '2026-01-31' } as any);
      expect((await service.getCycle(TENANT)).nextPayDate).toBe('2026-02-28');
    });

    it('returns an empty cycle before the first run', async () => {
      const cycle = await service.getCycle(TENANT);
      expect(cycle.currentRun).toBeNull();
      expect(cycle.steps).toHaveLength(4);
    });
  });

  describe('process checks', () => {
    it('passes when everyone is payable and has an NTN on this tax year’s profile', async () => {
      const run = await service.createRun(TENANT, SEPTEMBER);
      models.Profile.rows.push({ tenantId: TENANT, employeeId: employeeId(), taxYear: 2027, ntn: '1234567-8' });
      const checks = await service.getProcessChecks(TENANT, run.id);
      expect(checks.taxYear).toBe(2027);
      expect(checks.exceptions.rows.find((r: any) => r.key === 'INCOMPLETE_TAX_INFO').count).toBe(0);
      expect(checks.exceptions.rows.find((r: any) => r.key === 'MISSING_BANK_DETAILS').count).toBe(0);
      expect(checks.canAdvance).toBe(true);
    });

    it('reports missing bank details and a missing NTN, from live employee data', async () => {
      const run = await service.createRun(TENANT, SEPTEMBER);
      await models.Employee.rows[0].update({ bankName: null, bankAccountNumber: null, iban: null });
      const checks = await service.getProcessChecks(TENANT, run.id);
      expect(checks.exceptions.rows.find((r: any) => r.key === 'MISSING_BANK_DETAILS').count).toBe(1);
      expect(checks.exceptions.rows.find((r: any) => r.key === 'INCOMPLETE_TAX_INFO').count).toBe(1);
      expect(checks.canAdvance).toBe(false);
      expect(checks.blockedBy).toContain('bank details');
    });

    it('accepts an IBAN on its own as payable', async () => {
      const run = await service.createRun(TENANT, SEPTEMBER);
      await models.Employee.rows[0].update({ bankName: null, bankAccountNumber: null, iban: 'PK36SCBL0000001123456702' });
      expect((await service.getProcessChecks(TENANT, run.id)).canAdvance).toBe(true);
    });
  });

  it('exports every line of a run with its Phase 3 figures', async () => {
    const run = await service.createRun(TENANT, SEPTEMBER);
    const exported = await service.exportRecords(TENANT, run.id);
    expect(exported).toMatchObject({ totalMatched: 1, truncated: false });
    // (Employee code and name come from a join the in-memory tables don't do.)
    expect(exported.rows[0]).toMatchObject({ basicSalary: 100_000, grossPay: 100_000, netPay: 100_000, incomeTax: 0, status: 'IN_REVIEW' });
  });
});
