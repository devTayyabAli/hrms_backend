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
      getDepartmentModel: async () => ({}),
      getDesignationModel: async () => ({}),
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
