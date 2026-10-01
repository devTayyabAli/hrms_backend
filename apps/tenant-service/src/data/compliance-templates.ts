import type {
  EobiConfig,
  IncomeTaxConfig,
  ProvidentFundConfig,
} from '../services/payroll-compliance';

/**
 * Starting points an organization copies into its own compliance rules —
 * data, not logic. A template never applies by itself: it becomes a DRAFT
 * rule the organization reviews and activates, and payroll only ever reads
 * the organization's rules.
 *
 * Every figure below was taken from the official source cited with it.
 * Where a figure could not be confirmed from an official source it is left
 * unset and the template is marked `requiresReview`, so it cannot be
 * activated until someone who knows the current notification fills it in.
 */

export interface ComplianceTemplate {
  key: string;
  ruleType: 'INCOME_TAX' | 'EOBI' | 'PROVIDENT_FUND';
  country: 'PK';
  name: string;
  taxYear: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  requiresReview: boolean;
  reviewNotes: string | null;
  source: string;
  configuration: IncomeTaxConfig | EobiConfig | ProvidentFundConfig;
}

export const COMPLIANCE_TEMPLATES: ComplianceTemplate[] = [
  {
    key: 'PK_INCOME_TAX_SALARY_TY2027',
    ruleType: 'INCOME_TAX',
    country: 'PK',
    name: 'Pakistan salary income tax — Tax Year 2027',
    taxYear: 2027,
    effectiveFrom: '2026-07-01',
    effectiveTo: '2027-06-30',
    // The slabs, the surcharge and the medical allowance exemption are
    // quoted from the sources below. The teacher/researcher reduction is not
    // included: the consolidated Ordinance shows clause (3A) of Part III of
    // the Second Schedule ceasing after tax year 2025, and whether another
    // clause gives the same reduction for tax year 2027 could not be
    // confirmed — so it is left for review rather than guessed.
    requiresReview: true,
    reviewNotes:
      'Confirm before activating: (1) no salaried surcharge applies for tax year 2027; (2) whether any teacher/researcher tax reduction applies — none is configured; (3) which allowances your organization pays are taxable — all allowances are treated as taxable except the medical allowance recorded on each employee’s tax profile.',
    source:
      'FBR Withholding Tax Rate Card for Tax Year 2027 (updated up to 30-06-2026 as per Finance Act 2026), section 149 — Division I, Part I, First Schedule read with R.10(a), Tenth Schedule: https://download1.fbr.gov.pk/Docs/202681113864992WithholdingTaxRatesCard2027.pdf. ' +
      'Income Tax Ordinance 2001 amended up to 30.06.2026 — section 4AB proviso (no surcharge on salary income, Finance Act 2026) and Second Schedule Part I clause 139(a) (medical allowance up to 10% of basic): https://download1.fbr.gov.pk/Docs/2026724177725705IncomeTaxOrdinanace2001.pdf',
    configuration: {
      slabs: [
        { from: 0, to: 600_000, fixed: 0, rate: 0 },
        { from: 600_000, to: 1_200_000, fixed: 0, rate: 1 },
        { from: 1_200_000, to: 2_200_000, fixed: 6_000, rate: 11 },
        { from: 2_200_000, to: 3_200_000, fixed: 116_000, rate: 20 },
        { from: 3_200_000, to: 4_100_000, fixed: 316_000, rate: 25 },
        { from: 4_100_000, to: 5_600_000, fixed: 541_000, rate: 29 },
        { from: 5_600_000, to: 7_000_000, fixed: 976_000, rate: 32 },
        { from: 7_000_000, to: null, fixed: 1_424_000, rate: 35 },
      ],
      // Section 4AB as amended by Finance Act 2026: no surcharge on salary income.
      surcharge: null,
      componentTreatment: {
        BASIC: 'TAXABLE',
        ALLOWANCES: 'TAXABLE',
        OVERTIME: 'TAXABLE',
        ONE_OFF_BONUS: 'TAXABLE',
        ONE_OFF_ARREARS: 'TAXABLE',
        ONE_OFF_COMMISSION: 'TAXABLE',
        // Reimbursement of an expense actually incurred for the employer is not salary.
        ONE_OFF_REIMBURSEMENT: 'EXEMPT',
        ONE_OFF_OTHER: 'TAXABLE',
      },
      medicalAllowanceExemption: { maxPercentOfBasic: 10 },
      allowedReductions: [],
      rounding: 'NEAREST_RUPEE',
    } satisfies IncomeTaxConfig,
  },
  {
    key: 'PK_EOBI',
    ruleType: 'EOBI',
    country: 'PK',
    name: 'EOBI contributions',
    taxYear: null,
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    requiresReview: true,
    reviewNotes:
      'Enter the minimum wage currently notified for EOBI contributions — it is not pre-filled because it could not be confirmed from an official source. Confirm whether age limits apply to your employees; none are configured.',
    source:
      'EOBI — Contributions: employer 5% and employee 1% of the worker’s minimum wages: http://www.eobi.gov.pk/introduction/Contribution.html. ' +
      'Employees’ Old-Age Benefits (Contributions) Rules 1976, rule 3(3) — wages and contributions rounded to the nearest rupee: http://www.eobi.gov.pk/rules/Rule-3Contribution.html',
    configuration: {
      employeeRatePercent: 1,
      employerRatePercent: 5,
      wageBase: 'FIXED_MINIMUM_WAGE',
      minimumWage: null,
      wageCap: null,
      eligibility: { minAge: null, maxAgeMale: null, maxAgeFemale: null },
      rounding: 'NEAREST_RUPEE',
    } satisfies EobiConfig,
  },
  {
    key: 'PK_PROVIDENT_FUND',
    ruleType: 'PROVIDENT_FUND',
    country: 'PK',
    name: 'Provident fund',
    taxYear: null,
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    requiresReview: true,
    reviewNotes:
      'Provident fund rates are set by your fund’s rules, not by law — enter them before activating. The employer’s contribution is not added to the employee’s taxable income; confirm this with your tax adviser for your fund.',
    source: 'Organization provident fund rules (no statutory rate).',
    configuration: {
      employeeRatePercent: null,
      employerRatePercent: null,
      employeeFixedAmount: null,
      employerFixedAmount: null,
      base: 'BASIC',
      membership: 'OPT_IN',
      maxEmployeeMonthly: null,
      maxEmployerMonthly: null,
      rounding: 'NEAREST_RUPEE',
    } satisfies ProvidentFundConfig,
  },
];
