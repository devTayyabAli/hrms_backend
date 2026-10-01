import { HttpStatus } from '@nestjs/common';
import { PolicyStatus, PolicyType } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PayrollComplianceService } from './payroll-compliance.service';
import { PayrollDashboardService } from './payroll-dashboard.service';
import { COMPLIANCE_TEMPLATES } from '../data/compliance-templates';
import { table } from './testing/fake-table';

/**
 * Compliance end to end through the services: the rule lifecycle (drafts,
 * review confirmation, no overlaps, frozen once active), who may see and
 * change what, how payroll takes tax and EOBI into net pay, and that a later
 * rule never reaches a payroll already calculated.
 *
 * Rule figures here that aren't the TY2027 template's (rule B's slabs, the
 * EOBI minimum wage) are test values, not statements about the law.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const MON_SAT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SEPTEMBER = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
const OCTOBER = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };
const TY2027 = COMPLIANCE_TEMPLATES.find(
  (t) => t.key === 'PK_INCOME_TAX_SALARY_TY2027',
);

const ADMIN = {
  roles: ['ORGANIZATION_ADMIN'],
  isSuperAdmin: false,
  isFullAccess: true,
  userId: 'u-admin',
  email: 'admin@x.com',
  permissions: ['*'],
};
const PAYROLL_MANAGER = {
  roles: ['Payroll'],
  isSuperAdmin: false,
  userId: 'u-pm',
  email: 'pm@x.com',
  permissions: ['payroll.manage'],
};
const HR = {
  roles: ['HR'],
  isSuperAdmin: false,
  userId: 'u-hr',
  email: 'hr@x.com',
  permissions: [
    'payroll.view',
    'payroll.create',
    'payroll.edit',
    'payroll.tax.manage',
    'payroll.compliance.view',
  ],
};
const PAYROLL_VIEWER = {
  roles: ['Payroll viewer'],
  isSuperAdmin: false,
  userId: 'u-pv',
  email: 'pv@x.com',
  permissions: ['payroll.view'],
};
const TAX_VIEWER = {
  roles: ['Tax viewer'],
  isSuperAdmin: false,
  userId: 'u-tv',
  email: 'tv@x.com',
  permissions: ['payroll.tax.view'],
};
const MANAGER = {
  roles: ['Department Manager'],
  isSuperAdmin: false,
  userId: 'u-mgr',
  email: 'mgr@x.com',
  permissions: ['employee.view', 'attendance.view'],
};
const TEAM_LEAD = {
  roles: ['Team Lead'],
  isSuperAdmin: false,
  userId: 'u-tl',
  email: 'tl@x.com',
  permissions: ['leave_management.edit'],
};
const FINANCE = {
  roles: ['Finance'],
  isSuperAdmin: false,
  userId: 'u-fin',
  email: 'fin@x.com',
  permissions: ['payroll.view', 'payroll.approve'],
};
const as = <T>(actor: any, work: () => Promise<T>) =>
  runAsRpcActor(actor, work);

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
  basicSalary: '150000',
  allowances: '0',
  recurringDeductions: '0',
  salaryEffectiveFrom: '2025-01-01',
  ...over,
});

describe('PayrollComplianceService', () => {
  let models: Record<string, any>;
  let compliance: PayrollComplianceService;
  let payroll: PayrollDashboardService;

  const build = (employees = [employee()]) => {
    models = {
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
      WorkingHours: table([
        {
          tenantId: TENANT,
          workingDays: MON_SAT,
          startTime: '09:00',
          endTime: '18:00',
          breakDurationMinutes: 60,
          isDefault: true,
        },
      ]),
      Policy: table([
        {
          tenantId: TENANT,
          policyType: PolicyType.PAYROLL,
          status: PolicyStatus.ACTIVE,
          configuration: { currency: 'PKR' },
        },
      ]),
      Audit: table(),
    };
    const provider = {
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
    compliance = new PayrollComplianceService(provider as any);
    payroll = new PayrollDashboardService(
      provider as any,
      undefined,
      undefined,
      compliance,
    );
  };

  const events = () =>
    models.Audit.rows.map((row: any) => row.changes?.event?.to);
  const employeeId = () => models.Employee.rows[0].id;

  /** The TY2027 template, activated after confirming its review notes. */
  const activeTaxRule = async () => {
    const draft = await as(ADMIN, () =>
      compliance.createRule(TENANT, { templateKey: TY2027.key }),
    );
    return as(ADMIN, () =>
      compliance.activateRule(TENANT, draft.id, { confirmReviewed: true }),
    );
  };
  const activeEobiRule = async (minimumWage = 37_000) => {
    const draft = await as(ADMIN, () =>
      compliance.createRule(TENANT, { templateKey: 'PK_EOBI' }),
    );
    await as(ADMIN, () =>
      compliance.updateRule(TENANT, draft.id, {
        configuration: { ...draft.configuration, minimumWage },
      }),
    );
    return as(ADMIN, () =>
      compliance.activateRule(TENANT, draft.id, { confirmReviewed: true }),
    );
  };
  const approve = async (runId: string) => {
    await as(HR, () => payroll.submitRun(TENANT, runId));
    await as(FINANCE, () => payroll.approveRun(TENANT, runId));
  };

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-11-05T10:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    build();
  });
  afterEach(() => jest.useRealTimers());

  // ── Rules ─────────────────────────────────────────────────────────────────

  describe('rules', () => {
    it('creates every rule as a draft, copied from its template with the sources', async () => {
      const rule = await as(ADMIN, () =>
        compliance.createRule(TENANT, { templateKey: TY2027.key }),
      );
      expect(rule.status).toBe('DRAFT');
      expect(rule.requiresReview).toBe(true);
      expect(rule.source).toContain('fbr.gov.pk');
      const configuration = rule.configuration;
      expect(configuration.slabs).toEqual((TY2027.configuration as any).slabs);
      // A copy, not the template's own object.
      configuration.slabs[0].rate = 99;
      expect((TY2027.configuration as any).slabs[0].rate).toBe(0);
      expect(events()).toContain('COMPLIANCE_RULE_CREATED');
    });

    it('needs an explicit review confirmation to activate a rule marked for review', async () => {
      const draft = await as(ADMIN, () =>
        compliance.createRule(TENANT, { templateKey: TY2027.key }),
      );
      await expect(
        as(ADMIN, () => compliance.activateRule(TENANT, draft.id, {})),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      const active = await as(ADMIN, () =>
        compliance.activateRule(TENANT, draft.id, { confirmReviewed: true }),
      );
      expect(active.status).toBe('ACTIVE');
      expect(active.reviewNotes).toContain(
        'Reviewed and activated by admin@x.com',
      );
    });

    it('refuses to activate the EOBI template until a minimum wage is entered', async () => {
      const draft = await as(ADMIN, () =>
        compliance.createRule(TENANT, { templateKey: 'PK_EOBI' }),
      );
      expect(draft.validation.length).toBeGreaterThan(0);
      await expect(
        as(ADMIN, () =>
          compliance.activateRule(TENANT, draft.id, { confirmReviewed: true }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('refuses an effective date, a tax year or dates outside the tax year', async () => {
      await expect(
        as(ADMIN, () =>
          compliance.createRule(TENANT, {
            ruleType: 'INCOME_TAX',
            name: 'No date',
            taxYear: 2027,
            configuration: TY2027.configuration as any,
          }),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(
        as(ADMIN, () =>
          compliance.createRule(TENANT, {
            templateKey: TY2027.key,
            taxYear: null,
          }),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(
        as(ADMIN, () =>
          compliance.createRule(TENANT, {
            templateKey: TY2027.key,
            effectiveFrom: '2026-06-01',
          }),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(
        as(ADMIN, () =>
          compliance.createRule(TENANT, {
            templateKey: TY2027.key,
            effectiveTo: '2026-06-30',
          }),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('refuses an invalid configuration at activation', async () => {
      const broken = {
        ...(TY2027.configuration as any),
        slabs: [
          { from: 0, to: 600_000, fixed: 0, rate: 0 },
          { from: 700_000, to: null, fixed: 0, rate: 5 },
        ],
      };
      const draft = await as(ADMIN, () =>
        compliance.createRule(TENANT, {
          ruleType: 'INCOME_TAX',
          name: 'Gap',
          taxYear: 2027,
          effectiveFrom: '2026-07-01',
          configuration: broken,
        }),
      );
      await expect(
        as(ADMIN, () => compliance.activateRule(TENANT, draft.id, {})),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('refuses two active rules of a type with overlapping dates', async () => {
      await activeTaxRule();
      const second = await as(ADMIN, () =>
        compliance.createRule(TENANT, {
          templateKey: TY2027.key,
          effectiveFrom: '2026-10-01',
        }),
      );
      await expect(
        as(ADMIN, () =>
          compliance.activateRule(TENANT, second.id, { confirmReviewed: true }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('freezes a rule once active — only drafts can be edited', async () => {
      const active = await activeTaxRule();
      await expect(
        as(ADMIN, () =>
          compliance.updateRule(TENANT, active.id, { name: 'Changed' }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
      const retired = await as(ADMIN, () =>
        compliance.retireRule(TENANT, active.id),
      );
      expect(retired.status).toBe('RETIRED');
      expect(events()).toEqual(
        expect.arrayContaining([
          'COMPLIANCE_RULE_ACTIVATED',
          'COMPLIANCE_RULE_RETIRED',
        ]),
      );
    });
  });

  // ── Security ──────────────────────────────────────────────────────────────

  describe('who can do what', () => {
    it('keeps compliance and tax away from managers, team leads and plain payroll viewers', async () => {
      for (const actor of [MANAGER, TEAM_LEAD, PAYROLL_VIEWER]) {
        await expect(
          as(actor, () => compliance.listRules(TENANT)),
        ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(
          as(actor, () => compliance.listTaxProfiles(TENANT, 2027)),
        ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(
          as(actor, () => compliance.report(TENANT, 'TAX')),
        ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(
          as(actor, () => compliance.listTaxSummaries(TENANT, 2027)),
        ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      }
    });

    it('lets payroll.manage do everything, and .view only read', async () => {
      await expect(
        as(PAYROLL_MANAGER, () =>
          compliance.createRule(TENANT, { templateKey: TY2027.key }),
        ),
      ).resolves.toBeTruthy();
      await expect(
        as(TAX_VIEWER, () => compliance.listTaxProfiles(TENANT, 2027)),
      ).resolves.toHaveLength(1);
      await expect(
        as(TAX_VIEWER, () =>
          compliance.saveTaxProfile(TENANT, employeeId(), 2027, {
            ntn: '1234567-8',
          }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
      // Tax access is not rule access.
      await expect(
        as(TAX_VIEWER, () => compliance.listRules(TENANT)),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      // HR edits tax profiles and reads rules, but can't create them.
      await expect(
        as(HR, () =>
          compliance.saveTaxProfile(TENANT, employeeId(), 2027, {
            ntn: '1234567-8',
          }),
        ),
      ).resolves.toBeTruthy();
      await expect(
        as(HR, () => compliance.listRules(TENANT)),
      ).resolves.toHaveLength(1);
      await expect(
        as(HR, () =>
          compliance.createRule(TENANT, { templateKey: TY2027.key }),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('audits which tax profile fields changed, never their values', async () => {
      await as(HR, () =>
        compliance.saveTaxProfile(TENANT, employeeId(), 2027, {
          previousEmployerTaxableIncome: 812_345,
          previousEmployerTaxDeducted: 9_876,
        }),
      );
      const audit = models.Audit.rows.find(
        (row: any) => row.changes?.event?.to === 'TAX_PROFILE_SAVED',
      );
      expect(audit.changes.fields.to).toEqual([
        'previousEmployerTaxableIncome',
        'previousEmployerTaxDeducted',
      ]);
      expect(JSON.stringify(audit.changes)).not.toMatch(/812345|9876/);
    });

    it('validates a tax profile: no negative amounts, and an adjustment needs a reason', async () => {
      await expect(
        as(HR, () =>
          compliance.saveTaxProfile(TENANT, employeeId(), 2027, {
            annualTaxCredits: -1,
          }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
      await expect(
        as(HR, () =>
          compliance.saveTaxProfile(TENANT, employeeId(), 2027, {
            taxAdjustment: 5_000,
          }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
      await expect(
        as(HR, () => compliance.saveTaxProfile(TENANT, employeeId(), 1999, {})),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('gives an employee only their own tax certificate', async () => {
      build([
        employee(),
        employee({
          employeeCode: 'EMP002',
          email: 'bilal@x.com',
          userId: 'u-bilal',
          firstName: 'Bilal',
        }),
      ]);
      await activeTaxRule();
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      await approve(run.id);
      const [ayesha, bilal] = models.Employee.rows;
      const certificate = await as(ADMIN, () =>
        compliance.issueCertificate(TENANT, ayesha.id, 2027),
      );
      expect(certificate.certificateNumber).toBe('TC-2027-000001');
      expect(events()).toContain('TAX_CERTIFICATE_ISSUED');

      await expect(
        compliance.myCertificates(TENANT, 'u-ayesha'),
      ).resolves.toHaveLength(1);
      await expect(
        compliance.myCertificates(TENANT, 'u-bilal'),
      ).resolves.toEqual([]);
      // Someone else's certificate reads as not found.
      await expect(
        compliance.myCertificatePdf(
          TENANT,
          'u-bilal',
          undefined,
          certificate.id,
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
      const mine = await compliance.myTaxSummary(
        TENANT,
        'u-bilal',
        undefined,
        2027,
      );
      expect(mine.months).toHaveLength(1);
      expect(bilal).toBeTruthy();
    });

    it('reissues nothing when the figures have not changed', async () => {
      await activeTaxRule();
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      await approve(run.id);
      const first = await as(ADMIN, () =>
        compliance.issueCertificate(TENANT, employeeId(), 2027),
      );
      const again = await as(ADMIN, () =>
        compliance.issueCertificate(TENANT, employeeId(), 2027),
      );
      expect(again.id).toBe(first.id);
      expect(models.Certificate.rows).toHaveLength(1);
    });

    it('refuses a certificate with no approved payroll', async () => {
      await expect(
        as(ADMIN, () =>
          compliance.issueCertificate(TENANT, employeeId(), 2027),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });
  });

  // ── In the payroll run ────────────────────────────────────────────────────

  describe('payroll with compliance', () => {
    it('deducts income tax from net pay, and says so when no rule is active', async () => {
      const without = await payroll.createRun(TENANT, SEPTEMBER);
      expect(without.records[0].incomeTax).toBe(0);
      expect(without.compliance.notes.join(' ')).toMatch(
        /No active income tax rule/,
      );
      build();

      await activeTaxRule();
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      const line = run.records[0];
      // September is month 3 of TY2027: 150,000 now + 9 × 150,000 projected
      // = 1,500,000 → 6,000 + 11% × 300,000 = 39,000 a year, over 10 months.
      expect(line.incomeTax).toBe(3_900);
      expect(line.grossPay).toBe(150_000);
      expect(line.normalDeductions).toBe(0);
      expect(line.statutoryDeductions).toBe(3_900);
      expect(line.netPay).toBe(146_100);
      expect(run.compliance.incomeTax).toBe(3_900);
      expect(run.netPay).toBe(146_100);
    });

    it('stores employer EOBI apart — it never reduces net pay', async () => {
      await activeEobiRule(37_000);
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      const line = run.records[0];
      expect(line.statutoryDeductions).toBe(370);
      expect(line.employerContributions).toBe(1_850);
      expect(line.netPay).toBe(150_000 - 370);
      const detail = await payroll.getRecord(TENANT, line.id);
      expect(detail.compliance?.eobi).toEqual({
        wage: 37_000,
        employee: 370,
        employer: 1_850,
      });
    });

    it('explains each line: the rule used and every step', async () => {
      await activeTaxRule();
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      const detail = await payroll.getRecord(TENANT, run.records[0].id);
      expect(detail.compliance?.rules.incomeTax?.name).toBe(TY2027.name);
      expect(detail.compliance?.tax.steps.map((s: any) => s.label)).toEqual(
        expect.arrayContaining([
          'Taxable income this month',
          'Projected annual taxable income',
          'Annual tax from the slabs',
          'Income tax this month',
        ]),
      );
      expect(detail.deductionBreakdown).toEqual(
        expect.objectContaining({ normal: 0, statutory: 3_900, total: 3_900 }),
      );
    });

    it('taxes a bonus by its category, and not a reimbursement', async () => {
      await activeTaxRule();
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      const line = run.records[0];
      const reimbursed = await as(HR, () =>
        payroll.addAdjustment(TENANT, line.id, {
          type: 'EARNING' as any,
          category: 'REIMBURSEMENT',
          amount: 20_000,
          reason: 'Travel claim',
        }),
      );
      expect(reimbursed.incomeTax).toBe(3_900);
      expect(reimbursed.netPay).toBe(170_000 - 3_900);
      const bonused = await as(HR, () =>
        payroll.addAdjustment(TENANT, line.id, {
          type: 'EARNING' as any,
          category: 'BONUS',
          amount: 100_000,
          reason: 'Q3 bonus',
        }),
      );
      // 1,600,000 a year → 50,000 tax over 10 months.
      expect(bonused.incomeTax).toBe(5_000);
      expect(bonused.adjustments.map((a: any) => a.category).sort()).toEqual([
        'BONUS',
        'REIMBURSEMENT',
      ]);
    });

    it('recalculates an adjustment from the line’s own rule copy, not today’s rules', async () => {
      const ruleA = await activeTaxRule();
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      // The rule is retired after the line was calculated…
      await as(ADMIN, () => compliance.retireRule(TENANT, ruleA.id));
      const adjusted = await as(HR, () =>
        payroll.addAdjustment(TENANT, run.records[0].id, {
          type: 'EARNING' as any,
          category: 'BONUS',
          amount: 100_000,
          reason: 'Q3 bonus',
        }),
      );
      // …but the line still works from its snapshot of it.
      expect(adjusted.incomeTax).toBe(5_000);
      expect(adjusted.compliance?.rules.incomeTax?.id).toBe(ruleA.id);
    });

    it('never changes an approved payroll when a new rule takes over (Rule A → Rule B)', async () => {
      const ruleA = await activeTaxRule();
      const september = await payroll.createRun(TENANT, SEPTEMBER);
      await approve(september.id);
      const septemberLine = {
        ...models.Record.rows[0],
        complianceSnapshot: JSON.parse(
          JSON.stringify(models.Record.rows[0].complianceSnapshot),
        ),
      };

      // Rule A ends in September; Rule B (test slabs: 10% over 600,000) from October.
      await as(ADMIN, () => compliance.retireRule(TENANT, ruleA.id));
      const ruleB = await as(ADMIN, () =>
        compliance.createRule(TENANT, {
          ruleType: 'INCOME_TAX',
          name: 'Rule B',
          taxYear: 2027,
          effectiveFrom: '2026-10-01',
          effectiveTo: '2027-06-30',
          configuration: {
            ...(TY2027.configuration as any),
            slabs: [
              { from: 0, to: 600_000, fixed: 0, rate: 0 },
              { from: 600_000, to: null, fixed: 0, rate: 10 },
            ],
          },
        }),
      );
      await as(ADMIN, () => compliance.activateRule(TENANT, ruleB.id, {}));

      const october = await payroll.createRun(TENANT, OCTOBER);
      const octoberLine = october.records[0];
      // 150,000 × 2 so far + 8 × 150,000 = 1,500,000 → 90,000 a year under B,
      // less September's 3,900, over the 9 months left.
      expect(octoberLine.incomeTax).toBe(9_567);
      const octoberDetail = await payroll.getRecord(TENANT, octoberLine.id);
      expect(octoberDetail.compliance?.rules.incomeTax?.name).toBe('Rule B');
      expect(octoberDetail.compliance?.tax.yearToDateTax).toBe(3_900);

      // September is exactly as it was approved.
      const septemberNow = models.Record.rows.find(
        (row: any) => row.id === septemberLine.id,
      );
      expect(septemberNow.incomeTax).toBe(septemberLine.incomeTax);
      expect(septemberNow.netPay).toBe(septemberLine.netPay);
      expect(septemberNow.complianceSnapshot).toEqual(
        septemberLine.complianceSnapshot,
      );
      expect(septemberNow.complianceSnapshot.rules.incomeTax.name).toBe(
        TY2027.name,
      );
      // And it can't be recalculated or adjusted.
      await expect(
        as(HR, () => payroll.recalculateRun(TENANT, september.id)),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('reports tax and EOBI from approved months only, and exports with an audit entry', async () => {
      await activeTaxRule();
      await activeEobiRule(37_000);
      const september = await payroll.createRun(TENANT, SEPTEMBER);
      expect(
        (
          await as(ADMIN, () =>
            compliance.report(TENANT, 'TAX', { taxYear: 2027 }),
          )
        ).count,
      ).toBe(0);
      await approve(september.id);
      // The fake ignores `include`; attach the employee the way Sequelize would.
      for (const row of models.Record.rows)
        row.employee = models.Employee.rows.find(
          (e: any) => e.id === row.employeeId,
        );

      const tax = await as(ADMIN, () =>
        compliance.report(TENANT, 'TAX', { taxYear: 2027 }),
      );
      expect(tax.rows).toEqual([
        expect.objectContaining({
          employeeCode: 'EMP001',
          taxableIncome: 150_000,
          netTax: 3_900,
          rule: TY2027.name,
        }),
      ]);
      const eobi = await as(ADMIN, () =>
        compliance.report(TENANT, 'EOBI', { month: '2026-09' }),
      );
      expect(eobi.totals).toEqual({
        employeeContribution: 370,
        employerContribution: 1_850,
        totalContribution: 2_220,
      });

      const exported = await as(ADMIN, () =>
        compliance.exportReport(TENANT, 'TAX', { taxYear: 2027 }),
      );
      expect(exported.filename).toBe('tax-report-TY2027.csv');
      expect(exported.csv).toContain('Ayesha Khan');
      expect(events()).toContain('COMPLIANCE_REPORT_EXPORTED');
    });

    it('leaves a pre-compliance line as it was, counting its gross as taxable', async () => {
      // A Phase 1 line: no snapshot, deductions all normal.
      const run = await payroll.createRun(TENANT, SEPTEMBER);
      await approve(run.id);
      const line = models.Record.rows[0];
      Object.assign(line, {
        complianceSnapshot: null,
        incomeTax: 0,
        statutoryDeductions: 0,
      });
      const detail = await payroll.getRecord(TENANT, line.id);
      expect(detail.compliance).toBeNull();
      expect(detail.normalDeductions).toBe(detail.deductions);

      await activeTaxRule();
      const october = await payroll.createRun(TENANT, OCTOBER);
      const octoberDetail = await payroll.getRecord(
        TENANT,
        october.records[0].id,
      );
      expect(octoberDetail.notes.join(' ')).toMatch(
        /paid before tax was configured/,
      );
    });
  });
});
