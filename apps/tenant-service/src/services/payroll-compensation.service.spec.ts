import { HttpStatus } from '@nestjs/common';
import { PolicyStatus, PolicyType } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PayrollCompensationService } from './payroll-compensation.service';
import { PayrollComplianceService } from './payroll-compliance.service';
import { PayrollDashboardService } from './payroll-dashboard.service';
import { COMPLIANCE_TEMPLATES } from '../data/compliance-templates';
import { table } from './testing/fake-table';

/**
 * Compensation end to end: the component catalog, structures, effective-
 * dated compensation, recurring items, loans, reimbursements, one-off
 * entries and the import — through the real payroll run, with the Phase 3
 * compliance engine taxing the result. The Phase 4 must-haves are here:
 * a later compensation, structure, component or loan change never alters an
 * approved payroll, and nobody without payroll grants sees any of it.
 *
 * Working days are Mon–Sat: September 2026 has 26, October 2026 has 27.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const MON_SAT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SEPTEMBER = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
const OCTOBER = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };
const TY2027 = COMPLIANCE_TEMPLATES.find((t) => t.key === 'PK_INCOME_TAX_SALARY_TY2027')!;

const ADMIN = { roles: ['ORGANIZATION_ADMIN'], isSuperAdmin: false, isFullAccess: true, userId: 'u-admin', email: 'admin@x.com', permissions: ['*'] };
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['payroll.view', 'payroll.create', 'payroll.edit'] };
const FINANCE = { roles: ['Finance'], isSuperAdmin: false, userId: 'u-fin', email: 'fin@x.com', permissions: ['payroll.view', 'payroll.approve'] };
const VIEWER = { roles: ['Payroll viewer'], isSuperAdmin: false, userId: 'u-pv', email: 'pv@x.com', permissions: ['payroll.view'] };
const LOANS_OFFICER = { roles: ['Loans'], isSuperAdmin: false, userId: 'u-lo', email: 'lo@x.com', permissions: ['payroll.loans.manage'] };
const MANAGER = { roles: ['Department Manager'], isSuperAdmin: false, userId: 'u-mgr', email: 'mgr@x.com', permissions: ['employee.view', 'attendance.view'] };
const TEAM_LEAD = { roles: ['Team Lead'], isSuperAdmin: false, userId: 'u-tl', email: 'tl@x.com', permissions: ['leave_management.edit'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

const employee = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  employeeCode: 'EMP001',
  firstName: 'Ayesha',
  lastName: 'Khan',
  email: 'ayesha@x.com',
  userId: 'u-ayesha',
  status: 'ACTIVE',
  joiningDate: '2025-01-01',
  exitDate: null,
  dateOfBirth: '1990-05-01',
  gender: 'FEMALE',
  basicSalary: '0',
  allowances: '0',
  recurringDeductions: '0',
  salaryEffectiveFrom: null,
  ...over,
});

describe('PayrollCompensationService', () => {
  let models: Record<string, any>;
  let compensation: PayrollCompensationService;
  let compliance: PayrollComplianceService;
  let payroll: PayrollDashboardService;

  const build = (employees = [employee()]) => {
    models = {
      Component: table(),
      Structure: table(),
      StructureLine: table(),
      Item: table(),
      Loan: table(),
      Reimbursement: table(),
      Rule: table(),
      Profile: table(),
      Certificate: table(),
      Run: table(),
      Record: table(),
      Adjustment: table(),
      Employee: table(employees),
      Revision: table(),
      Attendance: table(),
      Leave: table(),
      WorkingHours: table([{ tenantId: TENANT, workingDays: MON_SAT, startTime: '09:00', endTime: '18:00', breakDurationMinutes: 60, isDefault: true }]),
      Policy: table([{ tenantId: TENANT, policyType: PolicyType.PAYROLL, status: PolicyStatus.ACTIVE, configuration: { currency: 'PKR' } }]),
      Audit: table(),
      Notification: table(),
      SalaryRequest: table(),
      ApprovalPolicy: table(),
      Department: table(),
    };
    const provider = {
      getPayrollComponentModel: async () => models.Component,
      getSalaryStructureModel: async () => models.Structure,
      getSalaryStructureComponentModel: async () => models.StructureLine,
      getEmployeeRecurringItemModel: async () => models.Item,
      getEmployeeLoanModel: async () => models.Loan,
      getReimbursementModel: async () => models.Reimbursement,
      getComplianceRuleModel: async () => models.Rule,
      getEmployeeTaxProfileModel: async () => models.Profile,
      getTaxCertificateModel: async () => models.Certificate,
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
      getEmployeeNotificationModel: async () => models.Notification,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => ({ findAll: async () => [] }),
      getSalaryRevisionRequestModel: async () => models.SalaryRequest,
      getApprovalPolicyModel: async () => models.ApprovalPolicy,
    };
    compensation = new PayrollCompensationService(provider as any);
    compliance = new PayrollComplianceService(provider as any);
    payroll = new PayrollDashboardService(provider as any, undefined, undefined, compliance, compensation);
  };

  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to);
  const employeeId = (index = 0) => models.Employee.rows[index].id;
  const approve = async (runId: string) => {
    await as(HR, () => payroll.submitRun(TENANT, runId));
    await as(FINANCE, () => payroll.approveRun(TENANT, runId));
  };

  /** The catalog of the Management Package. */
  const catalog = async () => {
    const all = await as(ADMIN, () => compensation.listComponents(TENANT));
    const basicComponent = all.find((c) => c.code === 'BASIC')!;
    const housing = await as(ADMIN, () =>
      compensation.createComponent(TENANT, { code: 'HOUSING', name: 'Housing Allowance', type: 'EARNING', category: 'ALLOWANCE', calculationMethod: 'PERCENTAGE', value: 20, percentageBase: 'BASIC' }),
    );
    const transport = await as(ADMIN, () =>
      compensation.createComponent(TENANT, { code: 'TRANSPORT', name: 'Transport Allowance', type: 'EARNING', category: 'ALLOWANCE', calculationMethod: 'FIXED', value: 15_000, effectiveFrom: '2026-01-01' }),
    );
    const medical = await as(ADMIN, () =>
      compensation.createComponent(TENANT, { code: 'MEDICAL', name: 'Medical Allowance', type: 'EARNING', category: 'ALLOWANCE', calculationMethod: 'FIXED', value: 10_000, effectiveFrom: '2026-01-01' }),
    );
    return { basicComponent, housing, transport, medical };
  };

  const managementPackage = async () => {
    const c = await catalog();
    const structure = await as(ADMIN, () =>
      compensation.createStructure(TENANT, {
        code: 'MGMT',
        name: 'Management Package',
        effectiveFrom: '2026-01-01',
        components: [{ componentId: c.basicComponent.id }, { componentId: c.housing.id }, { componentId: c.transport.id }, { componentId: c.medical.id }],
      }),
    );
    return { ...c, structure: structure! };
  };

  /** Basic only, from a date. */
  const salary = async (amount: number, effectiveFrom: string, index = 0) => {
    const all = await as(ADMIN, () => compensation.listComponents(TENANT));
    const basicComponent = all.find((c) => c.code === 'BASIC')!;
    return as(ADMIN, () => compensation.saveCompensation(TENANT, employeeId(index), { effectiveFrom, lines: [{ componentId: basicComponent.id, value: amount }] }));
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    build();
  });
  afterEach(() => jest.useRealTimers());

  // ── Components & structures ───────────────────────────────────────────────

  describe('components and structures', () => {
    it('always has a Basic Salary component that can’t be disabled', async () => {
      const all = await as(ADMIN, () => compensation.listComponents(TENANT));
      const basicComponent = all.find((c) => c.isSystem)!;
      expect(basicComponent).toMatchObject({ code: 'BASIC', category: 'BASIC', includedInLeaveBase: true });
      await expect(as(ADMIN, () => compensation.setComponentStatus(TENANT, basicComponent.id, 'INACTIVE'))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('requires an explicit base for a percentage component', async () => {
      await compensation.ensureSystemComponents(TENANT);
      await expect(
        as(ADMIN, () => compensation.createComponent(TENANT, { code: 'HOUSING', name: 'Housing', type: 'EARNING', category: 'ALLOWANCE', calculationMethod: 'PERCENTAGE', value: 20 })),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('assigns a structure with the employee’s own basic', async () => {
      const { structure, basicComponent } = await managementPackage();
      await as(ADMIN, () =>
        compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-07-01', structureId: structure.id, lines: [{ componentId: basicComponent.id, value: 150_000 }] }),
      );
      const view = await as(ADMIN, () => compensation.getCompensation(TENANT, employeeId()));
      expect(view.current.structureName).toBe('Management Package');
      expect(view.current.totals).toMatchObject({ basic: 150_000, allowances: 55_000, gross: 205_000 });
      expect(events()).toContain('COMPENSATION_ASSIGNED');
      // The employee row keeps Phase 1's figures in step.
      expect(models.Employee.rows[0]).toMatchObject({ basicSalary: 150_000, allowances: 55_000 });
    });

    it('lets one employee’s amount differ from the structure', async () => {
      const { structure, basicComponent, transport } = await managementPackage();
      await as(ADMIN, () =>
        compensation.saveCompensation(TENANT, employeeId(), {
          effectiveFrom: '2026-07-01',
          structureId: structure.id,
          lines: [{ componentId: basicComponent.id, value: 150_000 }, { componentId: transport.id, value: 20_000 }],
        }),
      );
      const view = await as(ADMIN, () => compensation.getCompensation(TENANT, employeeId()));
      expect(view.current.lines.find((l) => l.code === 'TRANSPORT')!.monthlyAmount).toBe(20_000);
      expect(view.current.totals.gross).toBe(210_000);
    });

    it('never changes an employee when the structure or a component changes later', async () => {
      const { structure, basicComponent, housing } = await managementPackage();
      await as(ADMIN, () => compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-07-01', structureId: structure.id, lines: [{ componentId: basicComponent.id, value: 150_000 }] }));
      await as(ADMIN, () => compensation.updateComponent(TENANT, housing.id, { value: 40 }));
      await as(ADMIN, () => compensation.updateStructure(TENANT, structure.id, { components: [{ componentId: basicComponent.id }, { componentId: housing.id }] }));
      const view = await as(ADMIN, () => compensation.getCompensation(TENANT, employeeId()));
      expect(view.current.lines.find((l) => l.code === 'HOUSING')!.monthlyAmount).toBe(30_000);
      expect(view.current.totals.gross).toBe(205_000);
    });

    it('won’t put a disabled component on anyone', async () => {
      const { basicComponent, medical } = await catalog();
      await as(ADMIN, () => compensation.setComponentStatus(TENANT, medical.id, 'INACTIVE'));
      await expect(
        as(ADMIN, () =>
          compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-07-01', lines: [{ componentId: basicComponent.id, value: 100_000 }, { componentId: medical.id, value: 5_000 }] }),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });
  });

  // ── Compensation history in payroll ───────────────────────────────────────

  describe('effective-dated compensation', () => {
    it('keeps every revision, and pays each month from the one in effect', async () => {
      await salary(100_000, '2026-07-01');
      await salary(125_000, '2026-10-01');
      const history = (await as(ADMIN, () => compensation.getCompensation(TENANT, employeeId()))).history;
      expect(history.map((h) => [h.effectiveFrom, h.totals.basic])).toEqual([
        ['2026-10-01', 125_000],
        ['2026-07-01', 100_000],
      ]);
      expect(history[0].previous).toMatchObject({ basic: 100_000 });

      const september = await payroll.createRun(TENANT, SEPTEMBER);
      const october = await payroll.createRun(TENANT, OCTOBER);
      expect(september.records[0].grossPay).toBe(100_000);
      expect(october.records[0].grossPay).toBe(125_000);
    });

    it('splits a raise on the 16th by working days', async () => {
      await salary(100_000, '2026-07-01');
      await salary(125_000, '2026-10-16');
      const run = await payroll.createRun(TENANT, OCTOBER);
      // 100,000 × 13/27 + 125,000 × 14/27
      expect(run.records[0].grossPay).toBe(112_962.96);
      const detail = await payroll.getRecord(TENANT, run.records[0].id);
      expect(detail.breakdown?.segments.map((s: any) => [s.from, s.to, s.eligibleDays])).toEqual([
        ['2026-10-01', '2026-10-15', 13],
        ['2026-10-16', '2026-10-31', 14],
      ]);
    });

    it('refuses a change dated inside an approved payroll month', async () => {
      await salary(100_000, '2026-07-01');
      const september = await payroll.createRun(TENANT, SEPTEMBER);
      await approve(september.id);
      await expect(salary(110_000, '2026-09-15')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(salary(110_000, '2026-10-01')).resolves.toBeTruthy();
    });
  });

  // ── Historical integrity ──────────────────────────────────────────────────

  it('never changes an approved payroll: structure move, component edit, loan change and new rules all leave September alone', async () => {
    const { structure, basicComponent, housing, transport } = await managementPackage();
    await as(ADMIN, () => compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-07-01', structureId: structure.id, lines: [{ componentId: basicComponent.id, value: 150_000 }] }));
    const loan = await as(ADMIN, () => compensation.createLoan(TENANT, { employeeId: employeeId(), kind: 'LOAN', principal: 120_000, installmentAmount: 20_000, issuedOn: '2026-08-20', startDate: '2026-09-01' }));
    const september = await payroll.createRun(TENANT, SEPTEMBER);
    await approve(september.id);
    const before = JSON.parse(JSON.stringify(models.Record.rows[0]));
    expect(before.grossPay).toBe(205_000);
    expect(before.loanRecovery).toBe(20_000);

    // October: a new structure, an edited component, a changed loan.
    const structureB = await as(ADMIN, () =>
      compensation.createStructure(TENANT, { code: 'SENIOR', name: 'Senior Package', effectiveFrom: '2026-10-01', components: [{ componentId: basicComponent.id }, { componentId: transport.id, value: 25_000 }] }),
    );
    await as(ADMIN, () => compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-10-01', structureId: structureB!.id, lines: [{ componentId: basicComponent.id, value: 180_000 }] }));
    await as(ADMIN, () => compensation.updateComponent(TENANT, housing.id, { value: 50 }));
    await as(ADMIN, () => compensation.updateLoan(TENANT, loan.id, { installmentAmount: 30_000 }));

    const october = await payroll.createRun(TENANT, OCTOBER);
    expect(october.records[0].grossPay).toBe(205_000); // 180,000 + 25,000
    expect(october.records[0].normalDeductions).toBe(30_000);

    const after = models.Record.rows.find((row: any) => row.id === before.id);
    for (const key of ['grossPay', 'netPay', 'deductions', 'loanRecovery', 'earnedAllowances']) expect(after[key]).toEqual(before[key]);
    expect(after.components).toEqual(before.components);
    await expect(as(HR, () => payroll.recalculateRun(TENANT, september.id))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });

    const [loanNow] = await as(ADMIN, () => compensation.listLoans(TENANT));
    expect(loanNow).toMatchObject({ recovered: 20_000, scheduled: 30_000, remaining: 100_000 });
  });

  // ── Recurring items, loans, reimbursements, entries ───────────────────────

  describe('what else a payroll pays and takes', () => {
    beforeEach(async () => {
      await salary(100_000, '2026-07-01');
    });

    it('stops a recurring deduction at its total, and a loan at its balance', async () => {
      await as(ADMIN, () =>
        compensation.createRecurringItem(TENANT, employeeId(), { kind: 'DEDUCTION', name: 'Salary Deduction', category: 'OTHER_DEDUCTION', amount: 4_000, startDate: '2026-09-01', totalAmount: 6_000 }),
      );
      await as(ADMIN, () => compensation.createLoan(TENANT, { employeeId: employeeId(), kind: 'ADVANCE', principal: 25_000, installmentAmount: 20_000, issuedOn: '2026-08-25', startDate: '2026-09-01' }));
      const september = await payroll.createRun(TENANT, SEPTEMBER);
      expect(september.records[0].normalDeductions).toBe(24_000);
      await approve(september.id);
      const october = await payroll.createRun(TENANT, OCTOBER);
      // The last 2,000 of the deduction, the last 5,000 of the advance.
      expect(october.records[0].normalDeductions).toBe(7_000);
      const [advance] = await as(ADMIN, () => compensation.listLoans(TENANT));
      expect(advance).toMatchObject({ recovered: 20_000, scheduled: 5_000, remaining: 5_000 });
    });

    it('pays a reimbursement only once approved, then marks it included', async () => {
      const claim = await compensation.submitMyReimbursement(TENANT, 'u-ayesha', undefined, { amount: 5_000, category: 'TRAVEL', expenseDate: '2026-09-10', description: 'Client visit' });
      const submitted = await payroll.createRun(TENANT, SEPTEMBER);
      expect(submitted.records[0].grossPay).toBe(100_000);
      await as(ADMIN, () => compensation.decideReimbursement(TENANT, claim.id, { decision: 'APPROVE' }));
      const recalculated = await as(HR, () => payroll.recalculateRun(TENANT, submitted.id));
      expect(recalculated.records[0].grossPay).toBe(105_000);
      await approve(submitted.id);
      expect(models.Reimbursement.rows[0]).toMatchObject({ status: 'INCLUDED', payrollRunId: submitted.id });
      expect(events()).toEqual(expect.arrayContaining(['REIMBURSEMENT_SUBMITTED', 'REIMBURSEMENT_APPROVED']));
    });

    it('tells the employee when a claim is approved or rejected, with the reason', async () => {
      const first = await compensation.submitMyReimbursement(TENANT, 'u-ayesha', undefined, { amount: 5_000, category: 'TRAVEL', expenseDate: '2026-09-10', description: 'Client visit' });
      const second = await compensation.submitMyReimbursement(TENANT, 'u-ayesha', undefined, { amount: 900, category: 'MEDICAL', expenseDate: '2026-09-11', description: 'Pharmacy' });

      await as(ADMIN, () => compensation.decideReimbursement(TENANT, first.id, { decision: 'APPROVE' }));
      await as(ADMIN, () => compensation.decideReimbursement(TENANT, second.id, { decision: 'REJECT', note: 'No receipt attached' }));

      const [approved, rejected] = models.Notification.rows;
      expect(approved).toMatchObject({ employeeId: employeeId(), kind: 'REQUEST', title: 'Reimbursement approved' });
      expect(approved.body).toContain('next payroll');
      expect(rejected).toMatchObject({ employeeId: employeeId(), title: 'Reimbursement rejected' });
      expect(rejected.body).toContain('No receipt attached');
    });

    it('holds a bonus entered ahead of its month, and refuses a locked month', async () => {
      const entry = await as(HR, () =>
        payroll.createAdjustmentEntry(TENANT, { employeeId: employeeId(), payrollPeriod: '2026-10', type: 'EARNING' as any, category: 'BONUS', amount: 20_000, reason: 'Q3 bonus' }),
      );
      expect(entry.state).toBe('PENDING');
      const september = await payroll.createRun(TENANT, SEPTEMBER);
      expect(september.records[0].grossPay).toBe(100_000);
      await approve(september.id);
      await expect(
        as(HR, () => payroll.createAdjustmentEntry(TENANT, { employeeId: employeeId(), payrollPeriod: '2026-09', type: 'EARNING' as any, category: 'BONUS', amount: 1, reason: 'Too late' })),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      const october = await payroll.createRun(TENANT, OCTOBER);
      expect(october.records[0].grossPay).toBe(120_000);
      const [row] = await as(HR, () => payroll.listAdjustmentEntries(TENANT, { period: '2026-10' }));
      expect(row).toMatchObject({ state: 'IN_REVIEW', category: 'BONUS', payrollRunId: october.id });
    });
  });

  it('previews the run by component before it is submitted', async () => {
    build([employee(), employee({ employeeCode: 'EMP002', email: 'bilal@x.com', userId: 'u-bilal', firstName: 'Bilal' })]);
    const { structure, basicComponent } = await managementPackage();
    for (const [index, basic] of [[0, 150_000], [1, 100_000]] as const) {
      await as(ADMIN, () => compensation.saveCompensation(TENANT, employeeId(index), { effectiveFrom: '2026-07-01', structureId: structure.id, lines: [{ componentId: basicComponent.id, value: basic }] }));
    }
    await as(ADMIN, () => compensation.createLoan(TENANT, { employeeId: employeeId(1), kind: 'LOAN', principal: 60_000, installmentAmount: 10_000, issuedOn: '2026-08-20', startDate: '2026-09-01' }));
    const run = await payroll.createRun(TENANT, SEPTEMBER);
    const view = await as(HR, () => payroll.getRun(TENANT, run.id));
    const byName = (rows: any[], name: string) => rows.find((row) => row.name === name);
    expect(view.components.linesWithComponents).toBe(2);
    expect(byName(view.components.earnings, 'Basic Salary')).toMatchObject({ amount: 250_000, employees: 2 });
    expect(byName(view.components.earnings, 'Housing Allowance')).toMatchObject({ amount: 50_000, employees: 2 });
    expect(view.components.deductions).toEqual([expect.objectContaining({ source: 'LOAN', amount: 10_000, employees: 1 })]);
  });

  // ── Tax classification ────────────────────────────────────────────────────

  it('lets Phase 3 tax each component by its classification', async () => {
    const draft = await as(ADMIN, () => compliance.createRule(TENANT, { templateKey: TY2027.key }));
    await as(ADMIN, () => compliance.activateRule(TENANT, draft.id, { confirmReviewed: true }));
    const all = await as(ADMIN, () => compensation.listComponents(TENANT));
    const basicComponent = all.find((c) => c.code === 'BASIC')!;
    const fuel = await as(ADMIN, () =>
      compensation.createComponent(TENANT, { code: 'FUEL', name: 'Fuel Allowance', type: 'EARNING', category: 'ALLOWANCE', calculationMethod: 'FIXED', value: 30_000, taxTreatment: 'NON_TAXABLE', effectiveFrom: '2026-01-01' }),
    );
    await as(ADMIN, () => compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-07-01', lines: [{ componentId: basicComponent.id, value: 150_000 }, { componentId: fuel.id }] }));
    const run = await payroll.createRun(TENANT, SEPTEMBER);
    // Only the basic is taxed: 1,500,000 a year → 39,000 over 10 months.
    expect(run.records[0].grossPay).toBe(180_000);
    expect(run.records[0].incomeTax).toBe(3_900);
  });

  // ── Approving salary changes and expense claims ───────────────────────────

  describe('approval of salary changes', () => {
    const PROPOSER = HR;
    const APPROVER = { roles: ['Finance'], isSuperAdmin: false, userId: 'u-fin', email: 'fin@x.com', permissions: ['payroll.view', 'payroll.compensation.approve'] };
    const SECOND_APPROVER = { roles: ['Finance'], isSuperAdmin: false, userId: 'u-cfo', email: 'cfo@x.com', permissions: ['payroll.view', 'payroll.approve'] };
    const BOTH = { roles: ['Finance'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['payroll.edit', 'payroll.compensation.approve'] };

    const requirePolicy = (stages: any[]) => models.ApprovalPolicy.create({ tenantId: TENANT, requestType: 'SALARY_REVISION', stages });
    const propose = async (actor: any = PROPOSER, amount = 120_000) => {
      const all = await as(ADMIN, () => compensation.listComponents(TENANT));
      const basic = all.find((c) => c.code === 'BASIC')!;
      return as(actor, () => compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-12-01', lines: [{ componentId: basic.id, value: amount }], reason: 'Annual raise' })) as Promise<any>;
    };
    const decide = (actor: any, id: string, decision: 'APPROVE' | 'REJECT', note?: string) => as(actor, () => compensation.decideSalaryRevision(TENANT, id, { decision, note }));

    beforeEach(async () => {
      await salary(100_000, '2026-07-01');
    });

    it('writes the change straight away when the organization has not asked for approval', async () => {
      const result = await propose();
      expect(result.pending).toBeUndefined();
      expect(models.Revision.rows).toHaveLength(2);
      expect(models.SalaryRequest.rows).toHaveLength(0);
    });

    it('holds the change for approval instead of writing it, and shows what would change', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);

      const result = await propose();

      expect(result).toMatchObject({ pending: true, revision: null, openRun: null });
      expect(models.Revision.rows).toHaveLength(1);
      expect(result.request).toMatchObject({
        status: 'PENDING',
        effectiveFrom: '2026-12-01',
        reason: 'Annual raise',
        requestedBy: 'hr@x.com',
        change: { grossFrom: 100_000, grossTo: 120_000, difference: 20_000, percent: 20 },
        approval: { currentPermission: 'payroll.compensation.approve', finalStep: true },
      });
      expect(events()).toContain('SALARY_CHANGE_PROPOSED');
    });

    it('still checks the change when it is proposed', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const all = await as(ADMIN, () => compensation.listComponents(TENANT));
      const basic = all.find((c) => c.code === 'BASIC')!;
      await expect(as(PROPOSER, () => compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-12-01', lines: [{ componentId: basic.id, value: 0 }] }))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(models.SalaryRequest.rows).toHaveLength(0);
    });

    it('writes the revision when someone else approves it, from the proposal as it was made', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const { request } = await propose();

      const done = await decide(APPROVER, request.id, 'APPROVE', 'Looks right');

      expect(done).toMatchObject({ status: 'APPROVED', decisionNote: 'Looks right', decidedBy: 'fin@x.com' });
      expect(models.Revision.rows).toHaveLength(2);
      expect(done.revisionId).toBe(models.Revision.rows[1].id);
      const view = await as(ADMIN, () => compensation.getCompensation(TENANT, employeeId()));
      expect(view.history[0]).toMatchObject({ effectiveFrom: '2026-12-01', reason: 'Annual raise' });
      expect(events()).toEqual(expect.arrayContaining(['SALARY_CHANGE_APPROVED']));
    });

    it('never lets the person who proposed a change approve it, even holding the permission', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const { request } = await propose(BOTH);

      await expect(decide(BOTH, request.id, 'APPROVE')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN, message: expect.stringContaining('proposed this change') });
      expect(models.Revision.rows).toHaveLength(1);
      const [row] = await as(BOTH, () => compensation.listSalaryRevisionRequests(TENANT));
      expect(row.canDecide).toBe(false);
    });

    it('is not for anyone without the approval permission, not even one who can change compensation', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const { request } = await propose();
      const manager = { roles: ['Payroll'], isSuperAdmin: false, userId: 'u-pm', email: 'pm@x.com', permissions: ['payroll.compensation.manage'] };

      await expect(decide(manager, request.id, 'APPROVE')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      expect(models.Revision.rows).toHaveLength(1);
    });

    it('lets payroll.manage stand in for the approval permission, and shows an approver what is waiting', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const { request } = await propose();
      const boss = { roles: ['Payroll'], isSuperAdmin: false, userId: 'u-boss', email: 'boss@x.com', permissions: ['payroll.manage'] };

      const waiting = await as(APPROVER, () => compensation.listSalaryRevisionRequests(TENANT, { status: 'PENDING' }));
      expect(waiting).toHaveLength(1);
      expect(waiting[0].canDecide).toBe(true);
      expect((await decide(boss, request.id, 'APPROVE')).status).toBe('APPROVED');
    });

    it('rejects with a reason and writes nothing', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const { request } = await propose();

      await expect(decide(APPROVER, request.id, 'REJECT')).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      const done = await decide(APPROVER, request.id, 'REJECT', 'Not in budget');

      expect(done).toMatchObject({ status: 'REJECTED', decisionNote: 'Not in budget' });
      expect(models.Revision.rows).toHaveLength(1);
      await expect(decide(APPROVER, request.id, 'APPROVE')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('takes two approvers for two stages, and not the same person twice', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }, { kind: 'PERMISSION', permission: 'payroll.approve' }]);
      const { request } = await propose();

      const first = await decide(APPROVER, request.id, 'APPROVE');
      expect(first.status).toBe('PENDING');
      expect(models.Revision.rows).toHaveLength(1);

      await expect(decide({ ...APPROVER, permissions: [...APPROVER.permissions, 'payroll.approve'] }, request.id, 'APPROVE')).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
        message: expect.stringContaining('earlier stage'),
      });
      await expect(decide(APPROVER, request.id, 'APPROVE')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

      const done = await decide(SECOND_APPROVER, request.id, 'APPROVE');
      expect(done.status).toBe('APPROVED');
      expect(models.Revision.rows).toHaveLength(2);
    });

    it('keeps two changes for the same date from waiting together, and lets the proposer withdraw one', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const { request } = await propose();

      await expect(propose()).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      const other = { ...HR, userId: 'u-hr9', email: 'hr9@x.com' };
      await expect(as(other, () => compensation.cancelSalaryRevisionRequest(TENANT, request.id))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

      const cancelled = await as(PROPOSER, () => compensation.cancelSalaryRevisionRequest(TENANT, request.id));
      expect(cancelled.status).toBe('CANCELLED');
      expect(await propose()).toMatchObject({ pending: true });
    });

    it('says so when the month was locked after it was proposed, and stays waiting', async () => {
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const { request } = await propose();
      models.Run.create({ tenantId: TENANT, periodStart: '2026-12-01', periodEnd: '2026-12-31', step: 'APPROVAL' });

      await expect(decide(APPROVER, request.id, 'APPROVE')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(models.SalaryRequest.rows[0].status).toBe('PENDING');
      expect(models.Revision.rows).toHaveLength(1);
    });

    it('cannot be skipped with an import', async () => {
      await catalog();
      await requirePolicy([{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }]);
      const csv = 'Employee ID,Component,Amount,Effective Date\nEMP001,BASIC,150000,2026-12-01\n';

      await expect(as(ADMIN, () => compensation.importCompensation(TENANT, { csv, apply: true }))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(models.Revision.rows).toHaveLength(1);
      expect(await as(ADMIN, () => compensation.importCompensation(TENANT, { csv }))).toMatchObject({ valid: 1, applied: 0 });
    });
  });

  describe('reimbursements with a route', () => {
    const MANAGER_EMPLOYEE = { ...employee({ employeeCode: 'EMP002', firstName: 'Sara', lastName: 'Manager', email: 'sara@x.com', userId: 'u-sara', reportingManagerId: null }) };
    const OTHER = { roles: [], isSuperAdmin: false, userId: 'u-other', email: 'other@x.com', permissions: [] };
    const PAYROLL = { roles: ['Finance'], isSuperAdmin: false, userId: 'u-fin', email: 'fin@x.com', permissions: ['payroll.view', 'payroll.adjustments.manage'] };
    const CLAIM = { amount: 5_000, category: 'TRAVEL', expenseDate: '2026-10-10', description: 'Client visit' };
    let manager: any;

    beforeEach(() => {
      build([employee({ reportingManagerId: null }), MANAGER_EMPLOYEE, employee({ employeeCode: 'EMP003', firstName: 'Omar', email: 'omar@x.com', userId: 'u-omar' })]);
      manager = models.Employee.rows[1];
      models.Employee.rows[0].reportingManagerId = manager.id;
      models.ApprovalPolicy.create({ tenantId: TENANT, requestType: 'REIMBURSEMENT', stages: [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'PERMISSION', permission: 'payroll.adjustments.manage' }] });
    });

    const submit = () => as(OTHER, () => compensation.submitMyReimbursement(TENANT, 'u-ayesha', undefined, CLAIM)) as Promise<any>;

    it('goes to the reporting manager first, and tells them', async () => {
      const claim = await submit();

      expect(claim.approval).toMatchObject({ currentApproverId: manager.id, finalStep: false, statusText: expect.stringContaining('With Sara Manager') });
      expect(claim.status).toBe('SUBMITTED');
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[manager.id, 'Reimbursement waiting']]);
    });

    it('goes straight to payroll, as before, when the organization has saved no route', async () => {
      models.ApprovalPolicy.rows.length = 0;
      const claim = await submit();
      expect(claim.approval).toBeNull();
      expect((await as(PAYROLL, () => compensation.decideReimbursement(TENANT, claim.id, { decision: 'APPROVE' }))).status).toBe('APPROVED');
    });

    it('shows the manager what is waiting for them, and nobody else', async () => {
      await submit();
      // The query matches the route's current approver inside the stored JSON; the fake table cannot, so it is applied here.
      models.Reimbursement.findAll.mockImplementationOnce(async () =>
        models.Reimbursement.rows.filter((row: any) => row.status === 'SUBMITTED' && row.approval?.currentApproverId === manager.id),
      );
      const mine = await compensation.myReimbursementApprovals(TENANT, 'u-sara');
      expect(mine.total).toBe(1);
      expect(mine.data[0]).toMatchObject({ employee: { name: 'Ayesha Khan' }, amount: 5000, canDecide: true });
    });

    it('moves on to payroll when the manager approves, without paying it, and tells the employee', async () => {
      const claim = await submit();
      models.Notification.rows.length = 0;

      const moved = await as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-sara', undefined, claim.id, { decision: 'APPROVE' }));

      expect(moved).toMatchObject({ status: 'SUBMITTED', approval: { currentPermission: 'payroll.adjustments.manage', finalStep: true } });
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[models.Employee.rows[0].id, 'Reimbursement update']]);
      expect(events()).toContain('REIMBURSEMENT_STAGE_APPROVED');
    });

    it('is approved for payment only when payroll approves the last stage', async () => {
      const claim = await submit();
      await as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-sara', undefined, claim.id, { decision: 'APPROVE' }));
      models.Notification.rows.length = 0;

      const done = await as(PAYROLL, () => compensation.decideReimbursement(TENANT, claim.id, { decision: 'APPROVE', payrollPeriod: '2026-11' }));

      expect(done).toMatchObject({ status: 'APPROVED', payrollPeriod: '2026-11', decidedBy: 'fin@x.com' });
      expect(models.Notification.rows[0]).toMatchObject({ title: 'Reimbursement approved' });
    });

    it('does not let payroll decide before the manager has', async () => {
      const claim = await submit();
      await expect(as(PAYROLL, () => compensation.decideReimbursement(TENANT, claim.id, { decision: 'APPROVE' }))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      expect(models.Reimbursement.rows[0].status).toBe('SUBMITTED');
    });

    it('does not let anyone else, or the claimant, decide the manager\'s stage', async () => {
      const claim = await submit();
      await expect(as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-omar', undefined, claim.id, { decision: 'APPROVE' }))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-ayesha', undefined, claim.id, { decision: 'APPROVE' }))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('lets the manager reject with a reason, which ends it and tells the employee', async () => {
      const claim = await submit();
      await expect(as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-sara', undefined, claim.id, { decision: 'REJECT' }))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      models.Notification.rows.length = 0;

      const done = await as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-sara', undefined, claim.id, { decision: 'REJECT', note: 'Not a work expense' }));

      expect(done).toMatchObject({ status: 'REJECTED', decisionNote: 'Not a work expense' });
      expect(models.Notification.rows[0]).toMatchObject({ title: 'Reimbursement rejected' });
      expect(models.Notification.rows[0].body).toContain('Not a work expense');
    });

    it('does not apply to a claim payroll staff record for someone', async () => {
      const claim = await as(PAYROLL, () => compensation.createReimbursement(TENANT, { employeeId: employeeId(), ...CLAIM })) as any;
      expect(claim.approval).toBeNull();
    });

    it('treats a claim without a route as not found on the manager\'s side', async () => {
      models.ApprovalPolicy.rows.length = 0;
      const claim = await submit();
      await expect(as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-sara', undefined, claim.id, { decision: 'APPROVE' }))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    describe('telling the people holding the permission', () => {
      it('tells them when the claim reaches a permission stage, and not while a named manager has it', async () => {
        const tell = jest.fn();
        (compensation as any).holders = { tell };

        const claim = await submit();
        expect(tell).toHaveBeenCalledWith(TENANT, expect.objectContaining({ currentApproverId: manager.id }), [expect.any(String)], 'Reimbursement waiting', expect.any(String));

        tell.mockClear();
        await as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-sara', undefined, claim.id, { decision: 'APPROVE' }));
        expect(tell).toHaveBeenCalledWith(TENANT, expect.objectContaining({ currentPermission: 'payroll.adjustments.manage', finalStep: true }), [models.Employee.rows[0].id], 'Reimbursement waiting', expect.stringContaining('Sara Manager'));
      });
    });

    describe('when the reporting line changes or the approver leaves', () => {
      it('moves a claim nobody has approved yet to the new manager, and tells both', async () => {
        await submit();
        const omar = models.Employee.rows[2];
        models.Employee.rows[0].reportingManagerId = omar.id;
        models.Notification.rows.length = 0;

        const moved = await compensation.rerouteReimbursementsAfterReportingChange(TENANT, employeeId(0));

        expect(moved).toBe(1);
        expect(models.Reimbursement.rows[0].approval).toMatchObject({ currentApproverId: omar.id, finalStep: false });
        expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([
          [employeeId(0), 'Reimbursement update'],
          [omar.id, 'Reimbursement waiting'],
        ]);
      });

      it('follows the direct reports of the person whose line changed', async () => {
        await submit();
        // Sara (the claimant\'s manager) is moved under Omar: her team\'s claims are re-checked, and nothing changes for them.
        models.Employee.rows[1].reportingManagerId = models.Employee.rows[2].id;
        expect(await compensation.rerouteReimbursementsAfterReportingChange(TENANT, manager.id)).toBe(0);
        expect(models.Reimbursement.rows[0].approval.currentApproverId).toBe(manager.id);
      });

      it('leaves a claim alone when the route is unchanged, or once payroll has it', async () => {
        const claim = await submit();
        expect(await compensation.rerouteReimbursementsAfterReportingChange(TENANT, employeeId(0))).toBe(0);

        await as(OTHER, () => compensation.decideMyReimbursementApproval(TENANT, 'u-sara', undefined, claim.id, { decision: 'APPROVE' }));
        models.Employee.rows[0].reportingManagerId = models.Employee.rows[2].id;
        expect(await compensation.rerouteReimbursementsAfterReportingChange(TENANT, employeeId(0))).toBe(0);
        expect(models.Reimbursement.rows[0].approval).toMatchObject({ currentPermission: 'payroll.adjustments.manage' });
      });

      it('does nothing for claims with no saved route, or when the policy has since been removed', async () => {
        models.ApprovalPolicy.rows.length = 0;
        await submit();
        models.Employee.rows[0].reportingManagerId = models.Employee.rows[2].id;
        expect(await compensation.rerouteReimbursementsAfterReportingChange(TENANT, employeeId(0))).toBe(0);
        expect(models.Reimbursement.rows[0].approval).toBeNull();
      });

      it('hands a claim on to payroll when the manager it was waiting on leaves', async () => {
        await submit();
        // The query matches the stored JSON inside the database; the fake table cannot, so it is applied here.
        models.Reimbursement.findAll.mockImplementationOnce(async () => models.Reimbursement.rows.filter((row: any) => row.approval?.currentApproverId === manager.id));
        models.Notification.rows.length = 0;

        const moved = await compensation.releaseReimbursementsWaitingOn(TENANT, manager.id);

        expect(moved).toBe(1);
        expect(models.Reimbursement.rows[0].approval).toMatchObject({ currentPermission: 'payroll.adjustments.manage', finalStep: true });
        expect(models.Reimbursement.rows[0].approval.statusText).toContain('no longer with the organization');
        expect(models.Notification.rows[0]).toMatchObject({ employeeId: employeeId(0), title: 'Reimbursement update' });
      });
    });
  });

  // ── Import ────────────────────────────────────────────────────────────────

  describe('compensation import', () => {
    it('checks every row and saves nothing unless all are valid', async () => {
      await catalog();
      const csv = 'Employee ID,Component,Amount,Effective Date\nEMP001,BASIC,150000,2026-07-01\nEMP001,HOUSING,20,2026-07-01\nEMP999,BASIC,1000,2026-07-01\n';
      const check = await as(ADMIN, () => compensation.importCompensation(TENANT, { csv }));
      expect(check).toMatchObject({ valid: 2, invalid: 1, applied: 0 });
      await expect(as(ADMIN, () => compensation.importCompensation(TENANT, { csv, apply: true }))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(models.Revision.rows).toHaveLength(0);

      const good = csv.split('\n').slice(0, 3).join('\n');
      const done = await as(ADMIN, () => compensation.importCompensation(TENANT, { csv: good, apply: true }));
      expect(done).toMatchObject({ valid: 2, invalid: 0, applied: 1 });
      const view = await as(ADMIN, () => compensation.getCompensation(TENANT, employeeId()));
      expect(view.current.totals.gross).toBe(180_000);
      expect(events()).toContain('COMPENSATION_IMPORTED');
    });
  });

  // ── Security ──────────────────────────────────────────────────────────────

  describe('who can see and change compensation', () => {
    it('keeps managers and team leads out of every compensation area', async () => {
      await salary(100_000, '2026-07-01');
      for (const actor of [MANAGER, TEAM_LEAD]) {
        await expect(as(actor, () => compensation.getCompensation(TENANT, employeeId()))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(as(actor, () => compensation.listComponents(TENANT))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(as(actor, () => compensation.listLoans(TENANT))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(as(actor, () => compensation.listReimbursements(TENANT))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(as(actor, () => payroll.listAdjustmentEntries(TENANT))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(as(actor, () => compensation.listRecurringItems(TENANT, employeeId()))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      }
    });

    it('lets payroll.view read compensation but not loans, and change nothing', async () => {
      await salary(100_000, '2026-07-01');
      await expect(as(VIEWER, () => compensation.getCompensation(TENANT, employeeId()))).resolves.toBeTruthy();
      await expect(as(VIEWER, () => compensation.listLoans(TENANT))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(salaryAs(VIEWER)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      // Loans are their own grant.
      await expect(
        as(LOANS_OFFICER, () => compensation.createLoan(TENANT, { employeeId: employeeId(), kind: 'LOAN', principal: 1_000, installmentAmount: 100, issuedOn: '2026-10-01', startDate: '2026-11-01' })),
      ).resolves.toBeTruthy();
      await expect(as(LOANS_OFFICER, () => compensation.getCompensation(TENANT, employeeId()))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('never reaches another organization’s employees or records', async () => {
      const OTHER = '22222222-2222-4222-8222-222222222222';
      await salary(100_000, '2026-07-01');
      await as(ADMIN, () => compensation.createLoan(TENANT, { employeeId: employeeId(), kind: 'LOAN', principal: 10_000, installmentAmount: 1_000, issuedOn: '2026-10-01', startDate: '2026-11-01' }));
      await expect(as(ADMIN, () => compensation.getCompensation(OTHER, employeeId()))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(as(ADMIN, () => compensation.listLoans(OTHER))).resolves.toEqual([]);
      await expect(as(ADMIN, () => compensation.listRecurringItems(OTHER, employeeId()))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      const [loan] = models.Loan.rows;
      await expect(as(ADMIN, () => compensation.updateLoan(OTHER, loan.id, { installmentAmount: 5_000 }))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(models.Loan.rows[0].installmentAmount).toBe(1_000);
    });

    it('shows an employee only their own compensation and claims', async () => {
      build([employee(), employee({ employeeCode: 'EMP002', email: 'bilal@x.com', userId: 'u-bilal', firstName: 'Bilal' })]);
      await salary(100_000, '2026-07-01', 0);
      await salary(80_000, '2026-07-01', 1);
      await compensation.submitMyReimbursement(TENANT, 'u-ayesha', undefined, { amount: 1_000, category: 'MEALS', expenseDate: '2026-10-02', description: 'Team lunch' });
      const mine = await compensation.myCompensation(TENANT, 'u-bilal');
      expect(mine.current?.totals.basic).toBe(80_000);
      // How a component is configured stays with payroll.
      expect(Object.keys(mine.current!.lines[0]).sort()).toEqual(['category', 'code', 'monthlyAmount', 'name', 'type']);
      await expect(compensation.myReimbursements(TENANT, 'u-bilal')).resolves.toEqual([]);
      await expect(compensation.myReimbursements(TENANT, 'u-ayesha')).resolves.toHaveLength(1);
      // A claim is always the caller's own, whatever the body says.
      const claim = await compensation.submitMyReimbursement(TENANT, 'u-bilal', undefined, { employeeId: employeeId(0), amount: 50, category: 'OTHER', expenseDate: '2026-10-02', description: 'Parking' } as any);
      expect(claim.employeeId).toBe(employeeId(1));
      await expect(compensation.myCompensation(TENANT, 'u-nobody')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  async function salaryAs(actor: any) {
    const all = await as(ADMIN, () => compensation.listComponents(TENANT));
    const basicComponent = all.find((c) => c.code === 'BASIC')!;
    return as(actor, () => compensation.saveCompensation(TENANT, employeeId(), { effectiveFrom: '2026-10-01', lines: [{ componentId: basicComponent.id, value: 1 }] }));
  }
});
