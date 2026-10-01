/**
 * Payroll compliance arithmetic — income tax, EOBI and provident fund — kept
 * free of I/O and free of law. Every rate, slab, threshold and eligibility
 * limit arrives in the rule configurations; this file only knows how to
 * apply them. New Finance Act rates are a new rule, never a code change.
 *
 * It runs after the Phase 1 calculation and takes that month's earned
 * figures as given:
 *
 *   Taxable income  = taxable share of each earning − unpaid-day deductions − exempt allowances
 *   Income tax      = monthly withholding from the projected annual liability
 *   Statutory       = income tax + EOBI (employee) + PF (employee)
 *   Employer        = EOBI (employer) + PF (employer)   — never reduces net pay
 */

// ── Rule configuration shapes ────────────────────────────────────────────────

export type Treatment =
  'TAXABLE' | 'EXEMPT' | { type: 'PARTIAL'; taxablePercent: number };

/** Earnings the payroll produces, by the key their tax treatment is looked up under. */
export const COMPONENT_KEYS = [
  'BASIC',
  'ALLOWANCES',
  'OVERTIME',
  'ONE_OFF_BONUS',
  'ONE_OFF_ARREARS',
  'ONE_OFF_COMMISSION',
  'ONE_OFF_REIMBURSEMENT',
  'ONE_OFF_OTHER',
] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export interface TaxSlab {
  /** Annual taxable income above which this slab starts (exclusive). */
  from: number;
  /** Upper bound (inclusive); null for the top slab. */
  to: number | null;
  /** Tax on everything up to `from`. */
  fixed: number;
  /** Percent of the amount exceeding `from`. */
  rate: number;
}

export interface IncomeTaxConfig {
  slabs: TaxSlab[];
  /** Percent of tax where annual taxable income exceeds the threshold; rate 0 or null for none. */
  surcharge?: {
    thresholdAnnualIncome: number;
    ratePercentOfTax: number;
  } | null;
  componentTreatment: Partial<Record<ComponentKey, Treatment>>;
  /** Medical allowance exempt up to this percent of basic, where the employer gives no free treatment. */
  medicalAllowanceExemption?: { maxPercentOfBasic: number } | null;
  /** Reductions an employee's profile may claim, by code. None unless the rule lists them. */
  allowedReductions?: { code: string; label: string; percentOfTax: number }[];
  rounding?: 'NEAREST_RUPEE' | 'NONE';
}

export interface EobiConfig {
  employeeRatePercent: number;
  employerRatePercent: number;
  /** FIXED_MINIMUM_WAGE: contribute on the notified minimum wage. ACTUAL_WAGE_CAPPED: on actual wage, capped. */
  wageBase: 'FIXED_MINIMUM_WAGE' | 'ACTUAL_WAGE_CAPPED';
  minimumWage?: number | null;
  wageCap?: number | null;
  eligibility?: {
    minAge?: number | null;
    maxAgeMale?: number | null;
    maxAgeFemale?: number | null;
  };
  rounding?: 'NEAREST_RUPEE' | 'NONE';
}

export interface ProvidentFundConfig {
  employeeRatePercent?: number | null;
  employerRatePercent?: number | null;
  employeeFixedAmount?: number | null;
  employerFixedAmount?: number | null;
  /** What the percentages apply to — this month's earned basic, or basic + allowances. */
  base: 'BASIC' | 'GROSS';
  /** ALL_EMPLOYEES: everyone except those opted out; OPT_IN: only members. */
  membership: 'ALL_EMPLOYEES' | 'OPT_IN';
  maxEmployeeMonthly?: number | null;
  maxEmployerMonthly?: number | null;
  rounding?: 'NEAREST_RUPEE' | 'NONE';
}

export interface RuleRef<C> {
  id: string;
  name: string;
  taxYear: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  configuration: C;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ComplianceProfile {
  /** True when a profile exists for this tax year (false = defaults or an earlier year's settings). */
  forThisYear: boolean;
  residency: 'RESIDENT' | 'NON_RESIDENT';
  previousEmployerTaxableIncome: number;
  previousEmployerTaxDeducted: number;
  annualDeductibleAllowances: number;
  annualTaxCredits: number;
  /** Extra tax to recover this year (+) or over-deduction to give back (−). */
  taxAdjustment: number;
  reductionCode: string | null;
  medicalAllowanceMonthly: number;
  freeMedicalProvided: boolean;
  eobiCovered: boolean;
  pfMember: boolean | null;
  pfJoinDate: string | null;
}

/** A Phase 4 component's classification; RULE_DEPENDENT follows the income tax rule. */
export type ComponentTaxTreatment = 'TAXABLE' | 'NON_TAXABLE' | 'RULE_DEPENDENT';

export interface ComplianceInput {
  periodStart: string;
  periodEnd: string;
  /** This month's figures, exactly as Phase 1 calculated them. */
  month: {
    earnedBasic: number;
    earnedAllowances: number;
    overtimePay: number;
    absenceDeduction: number;
    unpaidLeaveDeduction: number;
    prorationFactor: number;
    /** One-off earnings. `source` marks an approved reimbursement (not an adjustment row). */
    adjustments: { category: string; amount: number; source?: string; sourceId?: string | null }[];
    /** Phase 4: the basic component's tax classification. */
    basicTreatment?: ComponentTaxTreatment;
    /** Phase 4: this month's earned allowances by classification (sums to earnedAllowances). */
    allowances?: { amount: number; treatment: ComponentTaxTreatment }[];
  };
  /** The full monthly salary, for projecting the rest of the tax year. */
  monthlySalary: {
    basic: number;
    allowances: number;
    basicTreatment?: ComponentTaxTreatment;
    allowanceItems?: { amount: number; treatment: ComponentTaxTreatment }[];
  };
  /** Locked months earlier in this tax year. */
  ytd: { taxableIncome: number; incomeTax: number; months: number };
  exitDate: string | null;
  person: { dateOfBirth: string | null; gender: string | null };
  profile: ComplianceProfile;
  rules: {
    incomeTax: RuleRef<IncomeTaxConfig> | null;
    eobi: RuleRef<EobiConfig> | null;
    pf: RuleRef<ProvidentFundConfig> | null;
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface ComplianceStep {
  label: string;
  amount: number;
  /** "12 × 150,000", "slab 3: 116,000 + 20% over 2,200,000". */
  detail?: string;
}

export interface ComplianceResult {
  taxYear: number;
  taxYearMonth: number;
  remainingMonths: number;
  taxableIncome: number;
  exemptIncome: number;
  annualTaxableIncome: number;
  annualTax: number;
  incomeTax: number;
  /** The part of this month's tax that recovers (or returns) a profile adjustment. */
  taxAdjustmentPortion: number;
  eobiWage: number;
  eobiEmployee: number;
  eobiEmployer: number;
  pfBase: number;
  pfEmployee: number;
  pfEmployer: number;
  statutoryDeductions: number;
  employerContributions: number;
  taxSteps: ComplianceStep[];
  notes: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
const rounder = (mode?: 'NEAREST_RUPEE' | 'NONE') => (value: number) =>
  mode === 'NONE' ? round2(value) : Math.round(value);
const fmt = (value: number) => Math.round(value).toLocaleString('en-US');

/** Pakistan's tax year runs July–June and is named for the June it ends in. */
export const taxYearOf = (date: string): number => {
  const [year, month] = date.slice(0, 7).split('-').map(Number);
  return month >= 7 ? year + 1 : year;
};

export const taxYearBounds = (taxYear: number) => ({
  start: `${taxYear - 1}-07-01`,
  end: `${taxYear}-06-30`,
});

/** July = 1 … June = 12. */
export const taxYearMonth = (date: string): number => {
  const month = Number(date.slice(5, 7));
  return ((month - 7 + 12) % 12) + 1;
};

const treatmentShare = (treatment: Treatment | undefined): number => {
  if (!treatment || treatment === 'TAXABLE') return 1;
  if (treatment === 'EXEMPT') return 0;
  return Math.min(1, Math.max(0, Number(treatment.taxablePercent) / 100));
};

/** Tax on an annual taxable income from the slabs. */
export const slabTax = (
  income: number,
  slabs: TaxSlab[],
): { tax: number; slab: TaxSlab | null; index: number } => {
  const ordered = [...slabs].sort((a, b) => a.from - b.from);
  for (let index = ordered.length - 1; index >= 0; index--) {
    const slab = ordered[index];
    if (income > slab.from || (index === 0 && income >= slab.from)) {
      return {
        tax: slab.fixed + ((income - slab.from) * slab.rate) / 100,
        slab,
        index,
      };
    }
  }
  return { tax: 0, slab: null, index: -1 };
};

const ageOn = (dateOfBirth: string | null, on: string): number | null => {
  if (!dateOfBirth) return null;
  const [by, bm, bd] = dateOfBirth.slice(0, 10).split('-').map(Number);
  const [y, m, d] = on.slice(0, 10).split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};

const categoryKey = (category: string): ComponentKey => {
  const key =
    `ONE_OFF_${String(category || 'OTHER').toUpperCase()}` as ComponentKey;
  return (COMPONENT_KEYS as readonly string[]).includes(key)
    ? key
    : 'ONE_OFF_OTHER';
};

// ── The engine ───────────────────────────────────────────────────────────────

export const calculateCompliance = (
  input: ComplianceInput,
): ComplianceResult => {
  const notes: string[] = [];
  const steps: ComplianceStep[] = [];
  const taxYear = taxYearOf(input.periodStart);
  const monthIndex = taxYearMonth(input.periodStart);
  const { end: taxYearEnd } = taxYearBounds(taxYear);

  // Months left to spread the year's tax over: to June, or to the exit month.
  let remainingMonths = 13 - monthIndex;
  if (
    input.exitDate &&
    input.exitDate >= input.periodStart &&
    input.exitDate <= taxYearEnd
  ) {
    remainingMonths = Math.max(
      1,
      taxYearMonth(input.exitDate) - monthIndex + 1,
    );
  }

  const m = input.month;
  const profile = input.profile;

  // ── Taxable income this month ─────────────────────────────────────────────
  let taxableIncome = 0;
  let exemptIncome = 0;
  let annualTaxableIncome = 0;
  let annualTax = 0;
  let incomeTax = 0;
  let taxAdjustmentPortion = 0;

  const taxRule = input.rules.incomeTax;
  if (taxRule) {
    const config = taxRule.configuration;
    const round = rounder(config.rounding);
    const share = (key: ComponentKey) =>
      treatmentShare(config.componentTreatment?.[key]);

    // Unpaid days reduce salary actually earned — spread over basic and allowances.
    const salaryEarned = m.earnedBasic + m.earnedAllowances;
    const unpaid = m.absenceDeduction + m.unpaidLeaveDeduction;
    const kept =
      salaryEarned > 0 ? Math.max(0, salaryEarned - unpaid) / salaryEarned : 0;
    const basicPaid = m.earnedBasic * kept;
    const allowancesPaid = m.earnedAllowances * kept;
    // Phase 4: a component's own classification, when it has one; a
    // RULE_DEPENDENT component (and everything before Phase 4) follows the
    // rule's treatment for basic or allowances.
    const classified = (treatment: ComponentTaxTreatment | undefined, key: ComponentKey) =>
      treatment === 'TAXABLE' ? 1 : treatment === 'NON_TAXABLE' ? 0 : share(key);
    const basicShare = classified(m.basicTreatment, 'BASIC');
    const allowanceShare = (items: { amount: number; treatment: ComponentTaxTreatment }[] | undefined, total: number) =>
      items?.length
        ? items.reduce((sum, item) => sum + item.amount * classified(item.treatment, 'ALLOWANCES'), 0) / Math.max(1e-9, total)
        : share('ALLOWANCES');
    const monthAllowanceShare = allowanceShare(m.allowances, m.earnedAllowances);

    const medicalRule = config.medicalAllowanceExemption;
    const medicalExempt = (
      basic: number,
      allowances: number,
      factor: number,
    ) => {
      if (
        !medicalRule ||
        profile.freeMedicalProvided ||
        profile.medicalAllowanceMonthly <= 0
      )
        return 0;
      return Math.min(
        profile.medicalAllowanceMonthly * factor,
        (basic * medicalRule.maxPercentOfBasic) / 100,
        allowances,
      );
    };

    const earningsTaxable =
      basicPaid * basicShare +
      allowancesPaid * monthAllowanceShare +
      m.overtimePay * share('OVERTIME');
    const earningsTotal = basicPaid + allowancesPaid + m.overtimePay;
    const oneOffTaxable = m.adjustments.reduce(
      (sum, a) => sum + a.amount * share(categoryKey(a.category)),
      0,
    );
    const oneOffTotal = m.adjustments.reduce((sum, a) => sum + a.amount, 0);
    const medical = medicalExempt(
      basicPaid,
      allowancesPaid * monthAllowanceShare,
      m.prorationFactor * kept,
    );

    taxableIncome = round2(
      Math.max(0, earningsTaxable + oneOffTaxable - medical),
    );
    exemptIncome = round2(
      Math.max(0, earningsTotal + oneOffTotal - taxableIncome),
    );
    steps.push({ label: 'Taxable income this month', amount: taxableIncome });
    if (medical > 0)
      steps.push({
        label: 'Medical allowance exempt',
        amount: round2(medical),
        detail: `up to ${medicalRule.maxPercentOfBasic}% of basic`,
      });

    // The rest of the year at the full monthly salary — one-offs are not projected.
    const monthlyBasicShare = classified(input.monthlySalary.basicTreatment ?? m.basicTreatment, 'BASIC');
    const monthlyAllowanceShare = allowanceShare(input.monthlySalary.allowanceItems, input.monthlySalary.allowances);
    const monthlyTaxable =
      input.monthlySalary.basic * monthlyBasicShare +
      input.monthlySalary.allowances * monthlyAllowanceShare -
      medicalExempt(
        input.monthlySalary.basic,
        input.monthlySalary.allowances * monthlyAllowanceShare,
        1,
      );
    const projected = Math.max(0, monthlyTaxable) * (remainingMonths - 1);

    const gross =
      input.ytd.taxableIncome +
      profile.previousEmployerTaxableIncome +
      taxableIncome +
      projected -
      profile.annualDeductibleAllowances;
    if (gross < 0)
      notes.push(
        'Deductible allowances are more than the projected income — taxable income taken as zero.',
      );
    annualTaxableIncome = round2(Math.max(0, gross));
    if (input.ytd.taxableIncome)
      steps.push({
        label: 'Taxable income earlier this tax year',
        amount: round2(input.ytd.taxableIncome),
        detail: `${input.ytd.months} month(s)`,
      });
    if (profile.previousEmployerTaxableIncome)
      steps.push({
        label: 'Previous employer (this tax year)',
        amount: profile.previousEmployerTaxableIncome,
      });
    if (projected)
      steps.push({
        label: 'Projected for the rest of the year',
        amount: round2(projected),
        detail: `${remainingMonths - 1} × ${fmt(monthlyTaxable)}`,
      });
    if (profile.annualDeductibleAllowances)
      steps.push({
        label: 'Deductible allowances',
        amount: -profile.annualDeductibleAllowances,
      });
    steps.push({
      label: 'Projected annual taxable income',
      amount: annualTaxableIncome,
    });

    const {
      tax: baseTax,
      slab,
      index,
    } = slabTax(annualTaxableIncome, config.slabs);
    steps.push({
      label: 'Annual tax from the slabs',
      amount: round2(baseTax),
      detail: slab
        ? slab.rate || slab.fixed
          ? `slab ${index + 1}: ${fmt(slab.fixed)} + ${slab.rate}% over ${fmt(slab.from)}`
          : `slab ${index + 1}: no tax`
        : undefined,
    });
    let tax = baseTax;
    const surcharge = config.surcharge;
    if (
      surcharge &&
      surcharge.ratePercentOfTax > 0 &&
      annualTaxableIncome > surcharge.thresholdAnnualIncome
    ) {
      const amount = (baseTax * surcharge.ratePercentOfTax) / 100;
      tax += amount;
      steps.push({
        label: 'Surcharge',
        amount: round2(amount),
        detail: `${surcharge.ratePercentOfTax}% of tax`,
      });
    }
    if (profile.reductionCode) {
      const reduction = config.allowedReductions?.find(
        (r) => r.code === profile.reductionCode,
      );
      if (reduction) {
        const amount = (tax * reduction.percentOfTax) / 100;
        tax -= amount;
        steps.push({
          label: `Reduction: ${reduction.label}`,
          amount: -round2(amount),
          detail: `${reduction.percentOfTax}% of tax`,
        });
      } else {
        notes.push(
          `The tax reduction "${profile.reductionCode}" is not allowed by the ${taxRule.name} rule — not applied.`,
        );
      }
    }
    if (profile.annualTaxCredits) {
      tax -= profile.annualTaxCredits;
      steps.push({ label: 'Tax credits', amount: -profile.annualTaxCredits });
    }
    annualTax = round2(Math.max(0, tax));
    steps.push({ label: 'Annual tax', amount: annualTax });

    const paid = input.ytd.incomeTax + profile.previousEmployerTaxDeducted;
    if (paid)
      steps.push({
        label: 'Tax already deducted this year',
        amount: -round2(paid),
      });

    const baseMonthly = Math.max(0, (annualTax - paid) / remainingMonths);
    const withAdjustment = Math.max(
      0,
      (annualTax + profile.taxAdjustment - paid) / remainingMonths,
    );
    incomeTax = round(withAdjustment);
    taxAdjustmentPortion = round2(incomeTax - round(baseMonthly));
    if (profile.taxAdjustment)
      steps.push({
        label: 'Tax adjustment (annual)',
        amount: profile.taxAdjustment,
      });
    steps.push({
      label: 'Income tax this month',
      amount: incomeTax,
      detail: `÷ ${remainingMonths} month(s) left in the tax year`,
    });
    if (annualTax + profile.taxAdjustment - paid < 0) {
      notes.push(
        'More tax has already been deducted than the year’s liability — nothing deducted this month; the excess needs an adjustment or refund.',
      );
    }
    if (profile.residency === 'NON_RESIDENT') {
      notes.push(
        'Non-resident employee — resident salary slabs were applied; review the tax treatment.',
      );
    }
    if (!profile.forThisYear) {
      notes.push(
        `No tax profile for tax year ${taxYear} — calculated without previous-employer income, credits or adjustments.`,
      );
    }
  } else {
    notes.push(
      'No active income tax rule covers this period — no income tax deducted.',
    );
  }

  // ── EOBI ──────────────────────────────────────────────────────────────────
  let eobiWage = 0;
  let eobiEmployee = 0;
  let eobiEmployer = 0;
  const eobi = input.rules.eobi;
  if (eobi && profile.eobiCovered) {
    const config = eobi.configuration;
    const round = rounder(config.rounding);
    const age = ageOn(input.person.dateOfBirth, input.periodStart);
    const limits = config.eligibility ?? {};
    const maxAge =
      input.person.gender === 'FEMALE'
        ? limits.maxAgeFemale
        : limits.maxAgeMale;
    let eligible = true;
    if (age === null && (limits.minAge || maxAge)) {
      notes.push(
        'Date of birth missing — EOBI age limits could not be checked.',
      );
    } else if (age !== null && limits.minAge && age < limits.minAge) {
      eligible = false;
      notes.push(
        `EOBI not deducted: under the minimum age (${limits.minAge}).`,
      );
    } else if (age !== null && maxAge && age >= maxAge) {
      eligible = false;
      notes.push(`EOBI not deducted: at or past the age limit (${maxAge}).`);
    }
    if (eligible) {
      const actual =
        m.earnedBasic +
        m.earnedAllowances -
        m.absenceDeduction -
        m.unpaidLeaveDeduction;
      eobiWage =
        config.wageBase === 'FIXED_MINIMUM_WAGE'
          ? Number(config.minimumWage ?? 0)
          : Math.min(
              Math.max(0, actual),
              config.wageCap ?? Number.POSITIVE_INFINITY,
            );
      eobiWage = round(eobiWage);
      eobiEmployee = round((eobiWage * config.employeeRatePercent) / 100);
      eobiEmployer = round((eobiWage * config.employerRatePercent) / 100);
    }
  } else if (eobi && !profile.eobiCovered) {
    notes.push('Not covered by EOBI (tax profile) — no EOBI contribution.');
  }

  // ── Provident fund ────────────────────────────────────────────────────────
  let pfBase = 0;
  let pfEmployee = 0;
  let pfEmployer = 0;
  const pf = input.rules.pf;
  if (pf) {
    const config = pf.configuration;
    const round = rounder(config.rounding);
    const member =
      config.membership === 'ALL_EMPLOYEES'
        ? profile.pfMember !== false
        : profile.pfMember === true;
    const joined = !profile.pfJoinDate || profile.pfJoinDate <= input.periodEnd;
    if (member && joined) {
      pfBase = round2(
        config.base === 'GROSS'
          ? m.earnedBasic + m.earnedAllowances
          : m.earnedBasic,
      );
      const part = (
        rate?: number | null,
        fixed?: number | null,
        cap?: number | null,
      ) => {
        const amount = fixed
          ? Number(fixed)
          : (pfBase * Number(rate ?? 0)) / 100;
        return round(cap ? Math.min(amount, Number(cap)) : amount);
      };
      pfEmployee = part(
        config.employeeRatePercent,
        config.employeeFixedAmount,
        config.maxEmployeeMonthly,
      );
      pfEmployer = part(
        config.employerRatePercent,
        config.employerFixedAmount,
        config.maxEmployerMonthly,
      );
    } else if (member && !joined) {
      notes.push(
        `Provident fund membership starts ${profile.pfJoinDate} — no contribution this month.`,
      );
    }
  }

  return {
    taxYear,
    taxYearMonth: monthIndex,
    remainingMonths,
    taxableIncome,
    exemptIncome,
    annualTaxableIncome,
    annualTax,
    incomeTax,
    taxAdjustmentPortion,
    eobiWage,
    eobiEmployee,
    eobiEmployer,
    pfBase,
    pfEmployee,
    pfEmployer,
    statutoryDeductions: round2(incomeTax + eobiEmployee + pfEmployee),
    employerContributions: round2(eobiEmployer + pfEmployer),
    taxSteps: steps,
    notes,
  };
};

// ── Validation ───────────────────────────────────────────────────────────────

/** Problems that make a rule unusable. Empty when it can be activated. */
export const validateRuleConfiguration = (
  ruleType: string,
  config: any,
): string[] => {
  const errors: string[] = [];
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value);
  const pct = (value: unknown, label: string) => {
    if (value === null || value === undefined) return;
    if (!num(value) || (value as number) < 0 || (value as number) > 100)
      errors.push(`${label} must be a percentage between 0 and 100.`);
  };

  if (!config || typeof config !== 'object')
    return ['The configuration is missing.'];

  if (ruleType === 'INCOME_TAX') {
    const slabs: TaxSlab[] = Array.isArray(config.slabs) ? config.slabs : [];
    if (!slabs.length) errors.push('Add at least one tax slab.');
    const ordered = [...slabs].sort((a, b) => a.from - b.from);
    ordered.forEach((slab, i) => {
      if (!num(slab.from) || slab.from < 0)
        errors.push(`Slab ${i + 1}: "from" must be zero or more.`);
      if (slab.to !== null && (!num(slab.to) || slab.to <= slab.from))
        errors.push(`Slab ${i + 1}: "to" must be above "from".`);
      if (!num(slab.fixed) || slab.fixed < 0)
        errors.push(`Slab ${i + 1}: the fixed amount must be zero or more.`);
      pct(slab.rate, `Slab ${i + 1} rate`);
      const next = ordered[i + 1];
      if (next && slab.to !== next.from)
        errors.push(
          `Slab ${i + 1} ends at ${slab.to} but slab ${i + 2} starts at ${next.from} — slabs must join up.`,
        );
      if (!next && slab.to !== null)
        errors.push('The last slab must have no upper limit.');
      // The fixed amount carried into the next slab must equal this slab's maximum tax.
      if (next && slab.to !== null && num(next.fixed)) {
        const max = slab.fixed + ((slab.to - slab.from) * slab.rate) / 100;
        if (Math.abs(max - next.fixed) > 1)
          errors.push(
            `Slab ${i + 2}'s fixed amount (${next.fixed}) doesn't match slab ${i + 1}'s maximum tax (${Math.round(max)}).`,
          );
      }
    });
    if (ordered[0] && ordered[0].from !== 0)
      errors.push('The first slab must start at 0.');
    if (config.surcharge) {
      if (
        !num(config.surcharge.thresholdAnnualIncome) ||
        config.surcharge.thresholdAnnualIncome < 0
      )
        errors.push('Surcharge threshold must be zero or more.');
      pct(config.surcharge.ratePercentOfTax, 'Surcharge rate');
    }
    for (const [key, value] of Object.entries(
      config.componentTreatment ?? {},
    )) {
      if (!(COMPONENT_KEYS as readonly string[]).includes(key))
        errors.push(`Unknown earning "${key}".`);
      if (
        value !== 'TAXABLE' &&
        value !== 'EXEMPT' &&
        !(typeof value === 'object' && (value as any)?.type === 'PARTIAL')
      )
        errors.push(`${key}: treatment must be TAXABLE, EXEMPT or PARTIAL.`);
      if (typeof value === 'object')
        pct((value as any).taxablePercent, `${key} taxable share`);
    }
    if (config.medicalAllowanceExemption)
      pct(
        config.medicalAllowanceExemption.maxPercentOfBasic,
        'Medical allowance exemption',
      );
    for (const reduction of config.allowedReductions ?? []) {
      if (!reduction.code || !reduction.label)
        errors.push('Each reduction needs a code and a label.');
      pct(reduction.percentOfTax, `Reduction ${reduction.code}`);
    }
  } else if (ruleType === 'EOBI') {
    pct(config.employeeRatePercent, 'Employee rate');
    pct(config.employerRatePercent, 'Employer rate');
    if (!num(config.employeeRatePercent) || !num(config.employerRatePercent))
      errors.push('Set both the employee and employer rates.');
    if (config.wageBase === 'FIXED_MINIMUM_WAGE') {
      if (!num(config.minimumWage) || config.minimumWage <= 0)
        errors.push(
          'Enter the minimum wage currently notified for EOBI contributions.',
        );
    } else if (config.wageBase === 'ACTUAL_WAGE_CAPPED') {
      if (
        config.wageCap !== null &&
        config.wageCap !== undefined &&
        (!num(config.wageCap) || config.wageCap <= 0)
      )
        errors.push('The wage cap must be above zero.');
    } else {
      errors.push('Choose how the EOBI wage is worked out.');
    }
  } else if (ruleType === 'PROVIDENT_FUND') {
    if (!['BASIC', 'GROSS'].includes(config.base))
      errors.push('Choose the contribution base (basic or gross).');
    if (!['ALL_EMPLOYEES', 'OPT_IN'].includes(config.membership))
      errors.push('Choose who is a member.');
    pct(config.employeeRatePercent, 'Employee rate');
    pct(config.employerRatePercent, 'Employer rate');
    const has = (rate: unknown, fixed: unknown) =>
      (num(rate) && (rate as number) > 0) ||
      (num(fixed) && (fixed as number) > 0);
    if (
      !has(config.employeeRatePercent, config.employeeFixedAmount) &&
      !has(config.employerRatePercent, config.employerFixedAmount)
    ) {
      errors.push('Set an employee or employer contribution.');
    }
  } else {
    errors.push(`Unknown rule type "${ruleType}".`);
  }
  return errors;
};
