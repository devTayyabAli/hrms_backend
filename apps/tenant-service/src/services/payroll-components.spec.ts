import {
  legacyCompensation,
  parseFormula,
  phase1Totals,
  resolveCompensation,
  validateComponentRule,
  type ComponentRule,
} from './payroll-components';

/** A component rule with sensible defaults. */
const rule = (over: Partial<ComponentRule> & { code: string }): ComponentRule => ({
  name: over.code,
  type: 'EARNING',
  category: 'ALLOWANCE',
  calculationMethod: 'FIXED',
  value: 0,
  percentageBase: null,
  baseComponents: [],
  formula: null,
  taxTreatment: 'RULE_DEPENDENT',
  includedInGross: true,
  includedInOvertimeBase: false,
  includedInLeaveBase: false,
  ...over,
});
const basic = (value: number) => rule({ code: 'BASIC', name: 'Basic Salary', category: 'BASIC', value, includedInLeaveBase: true, includedInOvertimeBase: true });
const amounts = (lines: { code: string; monthlyAmount: number }[]) => Object.fromEntries(lines.map((l) => [l.code, l.monthlyAmount]));

describe('resolveCompensation', () => {
  it('works out the Management Package: fixed amounts and 20% of basic', () => {
    const { lines, errors, totals } = resolveCompensation([
      basic(150_000),
      rule({ code: 'HOUSING', name: 'Housing Allowance', calculationMethod: 'PERCENTAGE', value: 20, percentageBase: 'BASIC' }),
      rule({ code: 'TRANSPORT', name: 'Transport Allowance', value: 15_000 }),
      rule({ code: 'MEDICAL', name: 'Medical Allowance', value: 10_000 }),
    ]);
    expect(errors).toEqual([]);
    expect(amounts(lines)).toEqual({ BASIC: 150_000, HOUSING: 30_000, TRANSPORT: 15_000, MEDICAL: 10_000 });
    expect(totals).toEqual({ basic: 150_000, allowances: 55_000, gross: 205_000, deductions: 0, employerContributions: 0 });
    expect(lines.find((l) => l.code === 'HOUSING')!.explanation).toBe('20% of Basic Salary (150,000)');
  });

  it('uses the explicit base for each percentage — selected components, gross, taxable earnings', () => {
    const { lines, errors } = resolveCompensation([
      basic(100_000),
      rule({ code: 'COLA', value: 20_000, taxTreatment: 'TAXABLE' }),
      rule({ code: 'FUEL', value: 5_000, taxTreatment: 'NON_TAXABLE' }),
      rule({ code: 'SPECIAL', calculationMethod: 'PERCENTAGE', value: 10, percentageBase: 'SELECTED', baseComponents: ['BASIC', 'COLA'] }),
      rule({ code: 'WELFARE', type: 'DEDUCTION', category: 'OTHER_DEDUCTION', calculationMethod: 'PERCENTAGE', value: 1, percentageBase: 'GROSS' }),
      rule({ code: 'GRATUITY', type: 'EMPLOYER_CONTRIBUTION', category: 'OTHER_EMPLOYER_CONTRIBUTION', calculationMethod: 'PERCENTAGE', value: 5, percentageBase: 'TAXABLE_EARNINGS' }),
    ]);
    expect(errors).toEqual([]);
    // 10% of (100,000 + 20,000)
    expect(amounts(lines).SPECIAL).toBe(12_000);
    // 1% of every earning in gross: 100,000 + 20,000 + 5,000 + 12,000
    expect(amounts(lines).WELFARE).toBe(1_370);
    // 5% of the earnings marked taxable only: COLA
    expect(amounts(lines).GRATUITY).toBe(1_000);
  });

  it('evaluates formulas over other components', () => {
    const { lines, errors } = resolveCompensation([
      basic(80_000),
      rule({ code: 'UTILITY', calculationMethod: 'FORMULA', formula: 'min(BASIC * 10%, 5000) + 1000', value: null }),
      rule({ code: 'CLUB', type: 'DEDUCTION', category: 'OTHER_DEDUCTION', calculationMethod: 'FORMULA', formula: 'round(GROSS / 100)', value: null }),
    ]);
    expect(errors).toEqual([]);
    expect(amounts(lines)).toEqual({ BASIC: 80_000, UTILITY: 6_000, CLUB: 860 });
  });

  it('never guesses a base: missing references, circles and self-reference are errors', () => {
    expect(resolveCompensation([basic(1), rule({ code: 'AA', calculationMethod: 'PERCENTAGE', value: 5, percentageBase: 'SELECTED', baseComponents: ['NOPE'] })]).errors.join(' ')).toMatch(/NOPE/);
    expect(
      resolveCompensation([
        basic(1),
        rule({ code: 'AA', calculationMethod: 'FORMULA', formula: 'BB + 1', value: null }),
        rule({ code: 'BB', calculationMethod: 'FORMULA', formula: 'AA + 1', value: null }),
      ]).errors.join(' '),
    ).toMatch(/circle/);
    expect(validateComponentRule(rule({ code: 'AA', calculationMethod: 'PERCENTAGE', value: 5, percentageBase: 'SELECTED', baseComponents: ['AA'] }))).toContainEqual(
      expect.stringMatching(/itself/),
    );
    expect(validateComponentRule(rule({ code: 'AA', calculationMethod: 'PERCENTAGE', value: 5, percentageBase: null }))).toContainEqual(expect.stringMatching(/needs a base/));
  });

  it('refuses an earning based on gross — it would be part of its own base', () => {
    expect(validateComponentRule(rule({ code: 'X', calculationMethod: 'PERCENTAGE', value: 5, percentageBase: 'GROSS' }))).toContainEqual(expect.stringMatching(/own base/));
    expect(validateComponentRule(rule({ code: 'X', calculationMethod: 'FORMULA', formula: 'GROSS * 2%', value: null }))).toContainEqual(expect.stringMatching(/own base/));
  });

  it('needs exactly one basic salary, and keeps things paid elsewhere out', () => {
    expect(resolveCompensation([rule({ code: 'HOUSING', value: 1 })]).errors).toContainEqual(expect.stringMatching(/Basic Salary/));
    expect(resolveCompensation([basic(1), rule({ code: 'OT', category: 'OVERTIME', value: 1 })]).errors).toContainEqual(expect.stringMatching(/attendance/));
    expect(resolveCompensation([basic(1), rule({ code: 'EOBI_ER', type: 'EMPLOYER_CONTRIBUTION', category: 'EMPLOYER_EOBI', value: 1 })]).errors).toContainEqual(
      expect.stringMatching(/compliance rule/),
    );
  });

  it('rejects a formula that is not arithmetic', () => {
    expect(() => parseFormula('BASIC; drop')).toThrow();
    expect(() => parseFormula('(BASIC + 1')).toThrow(/Expected/);
    expect(() => parseFormula('')).toThrow(/empty/);
    expect(parseFormula('max(A, B) - 2').refs.sort()).toEqual(['A', 'B']);
  });

  it('keeps Phase 1 salaries readable as components, and back', () => {
    const lines = legacyCompensation({ basicSalary: 100_000, allowances: 20_000, recurringDeductions: 5_000 });
    expect(lines.map((l) => [l.code, l.monthlyAmount])).toEqual([
      ['BASIC', 100_000],
      ['ALLOWANCES', 20_000],
      ['RECURRING_DEDUCTIONS', 5_000],
    ]);
    expect(phase1Totals(lines)).toEqual({ basicSalary: 100_000, allowances: 20_000, recurringDeductions: 5_000 });
  });
});
