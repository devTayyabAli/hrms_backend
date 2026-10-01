import { COMPLIANCE_TEMPLATES } from '../data/compliance-templates';
import {
  calculateCompliance,
  slabTax,
  taxYearBounds,
  taxYearMonth,
  taxYearOf,
  validateRuleConfiguration,
  type ComplianceInput,
  type ComplianceProfile,
  type EobiConfig,
  type IncomeTaxConfig,
  type ProvidentFundConfig,
  type RuleRef,
} from './payroll-compliance';

/** The Tax Year 2027 salary rule exactly as the template ships it. */
const TY2027 = COMPLIANCE_TEMPLATES.find((t) => t.key === 'PK_INCOME_TAX_SALARY_TY2027')!;
const taxRule = (over: Partial<IncomeTaxConfig> = {}): RuleRef<IncomeTaxConfig> => ({
  id: 'rule-tax',
  name: TY2027.name,
  taxYear: 2027,
  effectiveFrom: '2026-07-01',
  effectiveTo: '2027-06-30',
  configuration: { ...(TY2027.configuration as IncomeTaxConfig), ...over },
});
const eobiRule = (over: Partial<EobiConfig> = {}): RuleRef<EobiConfig> => ({
  id: 'rule-eobi',
  name: 'EOBI',
  taxYear: null,
  effectiveFrom: '2026-07-01',
  effectiveTo: null,
  // A test figure — the real minimum wage is entered by the organization.
  configuration: { ...(COMPLIANCE_TEMPLATES[1].configuration as EobiConfig), minimumWage: 37_000, ...over },
});
const pfRule = (over: Partial<ProvidentFundConfig> = {}): RuleRef<ProvidentFundConfig> => ({
  id: 'rule-pf',
  name: 'PF',
  taxYear: null,
  effectiveFrom: '2026-07-01',
  effectiveTo: null,
  configuration: { base: 'BASIC', membership: 'OPT_IN', employeeRatePercent: 8, employerRatePercent: 8, ...over },
});

const profile = (over: Partial<ComplianceProfile> = {}): ComplianceProfile => ({
  forThisYear: true,
  residency: 'RESIDENT',
  previousEmployerTaxableIncome: 0,
  previousEmployerTaxDeducted: 0,
  annualDeductibleAllowances: 0,
  annualTaxCredits: 0,
  taxAdjustment: 0,
  reductionCode: null,
  medicalAllowanceMonthly: 0,
  freeMedicalProvided: false,
  eobiCovered: true,
  pfMember: null,
  pfJoinDate: null,
  ...over,
});

/** July 2026 — the first month of Tax Year 2027 — for a monthly salary. */
const input = (monthly: number, over: Partial<ComplianceInput> = {}): ComplianceInput => ({
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  month: {
    earnedBasic: monthly,
    earnedAllowances: 0,
    overtimePay: 0,
    absenceDeduction: 0,
    unpaidLeaveDeduction: 0,
    prorationFactor: 1,
    adjustments: [],
  },
  monthlySalary: { basic: monthly, allowances: 0 },
  ytd: { taxableIncome: 0, incomeTax: 0, months: 0 },
  exitDate: null,
  person: { dateOfBirth: '1990-01-01', gender: 'MALE' },
  profile: profile(),
  rules: { incomeTax: taxRule(), eobi: null, pf: null },
  ...over,
});

describe('the Tax Year 2027 salary slabs (FBR rate card, Finance Act 2026)', () => {
  const slabs = (TY2027.configuration as IncomeTaxConfig).slabs;

  it.each([
    [0, 0],
    [600_000, 0],
    [600_001, 0.01],
    [1_200_000, 6_000],
    [1_200_001, 6_000.11],
    [2_200_000, 116_000],
    [3_200_000, 316_000],
    [4_100_000, 541_000],
    [5_600_000, 976_000],
    [7_000_000, 1_424_000],
    [8_000_000, 1_774_000],
  ])('annual taxable income %i → tax %d', (income, tax) => {
    expect(slabTax(income, slabs).tax).toBeCloseTo(tax, 2);
  });

  it('is internally consistent, so the validator accepts it', () => {
    expect(validateRuleConfiguration('INCOME_TAX', TY2027.configuration)).toEqual([]);
  });

  it('has no salaried surcharge (section 4AB proviso as amended by Finance Act 2026)', () => {
    expect((TY2027.configuration as IncomeTaxConfig).surcharge).toBeNull();
  });
});

describe('tax year', () => {
  it('runs July to June and is named for the June it ends in', () => {
    expect(taxYearOf('2026-06-30')).toBe(2026);
    expect(taxYearOf('2026-07-01')).toBe(2027);
    expect(taxYearOf('2027-06-15')).toBe(2027);
    expect(taxYearBounds(2027)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(taxYearMonth('2026-07-01')).toBe(1);
    expect(taxYearMonth('2027-06-01')).toBe(12);
  });
});

describe('monthly income tax', () => {
  it('deducts nothing up to Rs 600,000 a year', () => {
    const result = calculateCompliance(input(50_000));
    expect(result.annualTaxableIncome).toBe(600_000);
    expect(result.incomeTax).toBe(0);
  });

  it('spreads the projected annual tax over the months left', () => {
    // 100,000 × 12 = 1,200,000 → 6,000 a year → 500 a month.
    const result = calculateCompliance(input(100_000));
    expect(result.taxYear).toBe(2027);
    expect(result.remainingMonths).toBe(12);
    expect(result.annualTax).toBe(6_000);
    expect(result.incomeTax).toBe(500);
  });

  it('handles a high income in the top slab', () => {
    // 12,000,000 → 1,424,000 + 35% × 5,000,000 = 3,174,000 → 264,500 a month.
    expect(calculateCompliance(input(1_000_000)).incomeTax).toBe(264_500);
  });

  it('counts earlier months and the tax already deducted', () => {
    // September (month 3): 2 locked months at 150,000 with 1,500 deducted.
    const result = calculateCompliance(
      input(150_000, { periodStart: '2026-09-01', periodEnd: '2026-09-30', ytd: { taxableIncome: 300_000, incomeTax: 1_500, months: 2 } }),
    );
    // Annual 1,800,000 → 6,000 + 11% × 600,000 = 72,000; (72,000 − 1,500) ÷ 10 = 7,050.
    expect(result.annualTaxableIncome).toBe(1_800_000);
    expect(result.incomeTax).toBe(7_050);
  });

  it('includes a mid-year joiner’s previous employment', () => {
    // Joins in January (month 7, 6 months left): 6 × 100,000 here + 600,000 before, 3,000 already deducted.
    const result = calculateCompliance(
      input(100_000, {
        periodStart: '2027-01-01',
        periodEnd: '2027-01-31',
        profile: profile({ previousEmployerTaxableIncome: 600_000, previousEmployerTaxDeducted: 3_000 }),
      }),
    );
    expect(result.remainingMonths).toBe(6);
    expect(result.annualTaxableIncome).toBe(1_200_000);
    expect(result.incomeTax).toBe(500); // (6,000 − 3,000) ÷ 6
  });

  it('settles a leaver’s tax in their last month', () => {
    const result = calculateCompliance(
      input(100_000, { periodStart: '2026-09-01', periodEnd: '2026-09-30', exitDate: '2026-09-20', ytd: { taxableIncome: 200_000, incomeTax: 0, months: 2 } }),
    );
    expect(result.remainingMonths).toBe(1);
    // Nothing projected after exit: 300,000 for the year → no tax.
    expect(result.annualTaxableIncome).toBe(300_000);
    expect(result.incomeTax).toBe(0);
  });

  it('recovers a tax adjustment over the remaining months', () => {
    const result = calculateCompliance(input(100_000, { profile: profile({ taxAdjustment: 1_200 }) }));
    expect(result.incomeTax).toBe(600);
    expect(result.taxAdjustmentPortion).toBe(100);
  });

  it('never deducts negative tax, and says so', () => {
    const result = calculateCompliance(
      input(100_000, { periodStart: '2027-06-01', periodEnd: '2027-06-30', ytd: { taxableIncome: 1_100_000, incomeTax: 9_000, months: 11 } }),
    );
    expect(result.incomeTax).toBe(0);
    expect(result.notes.join(' ')).toMatch(/already been deducted/);
  });

  it('leaves exempt earnings out and does not project one-offs', () => {
    const base = input(100_000);
    const result = calculateCompliance({
      ...base,
      month: {
        ...base.month,
        adjustments: [
          { category: 'REIMBURSEMENT', amount: 20_000 },
          { category: 'BONUS', amount: 60_000 },
        ],
      },
    });
    expect(result.taxableIncome).toBe(160_000);
    expect(result.exemptIncome).toBe(20_000);
    // 160,000 + 11 × 100,000 = 1,260,000 → 6,000 + 11% × 60,000 = 12,600 → 1,050 a month.
    expect(result.annualTaxableIncome).toBe(1_260_000);
    expect(result.incomeTax).toBe(1_050);
  });

  it('exempts a medical allowance up to 10% of basic', () => {
    const base = input(100_000);
    const result = calculateCompliance({
      ...base,
      month: { ...base.month, earnedAllowances: 20_000 },
      monthlySalary: { basic: 100_000, allowances: 20_000 },
      profile: profile({ medicalAllowanceMonthly: 15_000 }),
    });
    expect(result.taxableIncome).toBe(110_000);
    expect(result.exemptIncome).toBe(10_000);
    // Not when the employer provides free treatment.
    const free = calculateCompliance({ ...base, month: { ...base.month, earnedAllowances: 20_000 }, profile: profile({ medicalAllowanceMonthly: 15_000, freeMedicalProvided: true }) });
    expect(free.exemptIncome).toBe(0);
  });

  it('reduces taxable income for unpaid days', () => {
    const base = input(100_000);
    const result = calculateCompliance({ ...base, month: { ...base.month, absenceDeduction: 10_000 } });
    expect(result.taxableIncome).toBe(90_000);
  });

  it('applies a surcharge or reduction only when the rule sets one', () => {
    const surcharged = calculateCompliance(
      input(1_000_000, { rules: { incomeTax: taxRule({ surcharge: { thresholdAnnualIncome: 10_000_000, ratePercentOfTax: 10 } }), eobi: null, pf: null } }),
    );
    expect(surcharged.annualTax).toBe(3_491_400);
    const allowed = taxRule({ allowedReductions: [{ code: 'TEST', label: 'Test', percentOfTax: 25 }] });
    expect(calculateCompliance(input(100_000, { rules: { incomeTax: allowed, eobi: null, pf: null }, profile: profile({ reductionCode: 'TEST' }) })).annualTax).toBe(4_500);
    const notAllowed = calculateCompliance(input(100_000, { profile: profile({ reductionCode: 'TEST' }) }));
    expect(notAllowed.annualTax).toBe(6_000);
    expect(notAllowed.notes.join(' ')).toMatch(/not allowed/);
  });

  it('deducts nothing and warns when no rule covers the period', () => {
    const result = calculateCompliance(input(500_000, { rules: { incomeTax: null, eobi: null, pf: null } }));
    expect(result.incomeTax).toBe(0);
    expect(result.notes.join(' ')).toMatch(/No active income tax rule/);
  });

  it('calculates with whichever rule it is given — so a stored rule reproduces an old month', () => {
    const older = taxRule({ slabs: [{ from: 0, to: 1_000_000, fixed: 0, rate: 0 }, { from: 1_000_000, to: null, fixed: 0, rate: 10 }] });
    expect(calculateCompliance(input(100_000, { rules: { incomeTax: older, eobi: null, pf: null } })).annualTax).toBe(20_000);
    expect(calculateCompliance(input(100_000)).annualTax).toBe(6_000);
  });
});

describe('EOBI', () => {
  const withEobi = (over: Partial<ComplianceInput> = {}, config: Partial<EobiConfig> = {}) =>
    calculateCompliance(input(100_000, { rules: { incomeTax: null, eobi: eobiRule(config), pf: null }, ...over }));

  it('takes 1% from the employee and 5% from the employer, on the minimum wage', () => {
    const result = withEobi();
    expect(result.eobiWage).toBe(37_000);
    expect(result.eobiEmployee).toBe(370);
    expect(result.eobiEmployer).toBe(1_850);
    expect(result.statutoryDeductions).toBe(370);
    expect(result.employerContributions).toBe(1_850);
  });

  it('skips an employee not covered', () => {
    expect(withEobi({ profile: profile({ eobiCovered: false }) }).eobiEmployee).toBe(0);
  });

  it('applies age limits when the rule sets them', () => {
    const result = withEobi({ person: { dateOfBirth: '1960-01-01', gender: 'MALE' } }, { eligibility: { maxAgeMale: 60 } });
    expect(result.eobiEmployee).toBe(0);
    expect(result.notes.join(' ')).toMatch(/age limit/);
  });

  it('can use the actual wage, capped', () => {
    const result = withEobi({}, { wageBase: 'ACTUAL_WAGE_CAPPED', wageCap: 50_000 });
    expect(result.eobiWage).toBe(50_000);
    expect(result.eobiEmployer).toBe(2_500);
  });
});

describe('provident fund', () => {
  const withPf = (over: Partial<ComplianceInput> = {}, config: Partial<ProvidentFundConfig> = {}) =>
    calculateCompliance(input(100_000, { rules: { incomeTax: null, eobi: null, pf: pfRule(config) }, ...over }));

  it('contributes for a member, on basic', () => {
    const result = withPf({ profile: profile({ pfMember: true }) });
    expect(result.pfBase).toBe(100_000);
    expect(result.pfEmployee).toBe(8_000);
    expect(result.pfEmployer).toBe(8_000);
    // Only the employee's share leaves their pay.
    expect(result.statutoryDeductions).toBe(8_000);
  });

  it('skips a non-member under opt-in, includes everyone under all-employees', () => {
    expect(withPf().pfEmployee).toBe(0);
    expect(withPf({}, { membership: 'ALL_EMPLOYEES' }).pfEmployee).toBe(8_000);
    expect(withPf({ profile: profile({ pfMember: false }) }, { membership: 'ALL_EMPLOYEES' }).pfEmployee).toBe(0);
  });

  it('supports a gross base, fixed amounts and caps', () => {
    const base = input(100_000);
    const gross = calculateCompliance({
      ...base,
      month: { ...base.month, earnedAllowances: 50_000 },
      profile: profile({ pfMember: true }),
      rules: { incomeTax: null, eobi: null, pf: pfRule({ base: 'GROSS', maxEmployerMonthly: 10_000 }) },
    });
    expect(gross.pfEmployee).toBe(12_000);
    expect(gross.pfEmployer).toBe(10_000);
    expect(withPf({ profile: profile({ pfMember: true }) }, { employeeRatePercent: null, employeeFixedAmount: 2_500 }).pfEmployee).toBe(2_500);
  });

  it('waits for the join date', () => {
    expect(withPf({ profile: profile({ pfMember: true, pfJoinDate: '2026-08-01' }) }).pfEmployee).toBe(0);
  });

  it('does nothing where the organization has no PF rule', () => {
    const result = calculateCompliance(input(100_000, { profile: profile({ pfMember: true }) }));
    expect(result.pfEmployee + result.pfEmployer).toBe(0);
  });
});

describe('rule validation', () => {
  it('won’t activate the EOBI or PF templates until their figures are entered', () => {
    expect(validateRuleConfiguration('EOBI', COMPLIANCE_TEMPLATES[1].configuration).join(' ')).toMatch(/minimum wage/);
    expect(validateRuleConfiguration('PROVIDENT_FUND', COMPLIANCE_TEMPLATES[2].configuration).join(' ')).toMatch(/contribution/);
  });

  it('catches slabs that don’t join up or carry the wrong fixed amount', () => {
    const errors = validateRuleConfiguration('INCOME_TAX', {
      slabs: [
        { from: 0, to: 600_000, fixed: 0, rate: 0 },
        { from: 700_000, to: null, fixed: 5_000, rate: 1 },
      ],
      componentTreatment: {},
    });
    expect(errors.join(' ')).toMatch(/join up/);
    expect(errors.join(' ')).toMatch(/fixed amount/);
  });

  it('rejects rates outside 0–100%', () => {
    expect(validateRuleConfiguration('EOBI', { employeeRatePercent: 150, employerRatePercent: 5, wageBase: 'FIXED_MINIMUM_WAGE', minimumWage: 1 }).join(' ')).toMatch(/percentage/);
  });
});
