/**
 * Payroll Phase 4 — compensation components. Free of I/O, like the Phase 1
 * calculation and the Phase 3 compliance engine it feeds.
 *
 * An employee's compensation is a list of components (basic, allowances,
 * fixed deductions, employer contributions). Each is worked out here into a
 * monthly amount **when the compensation is saved**, and that amount is what
 * payroll prorates. So a later edit to a component or a salary structure
 * never changes an employee's pay by itself, and never reaches a payroll
 * that has already been calculated.
 *
 * Calculation methods:
 * - FIXED       — the value is the monthly amount;
 * - PERCENTAGE  — value % of an explicit base: BASIC, SELECTED components,
 *                 GROSS or TAXABLE_EARNINGS (the last two only for deductions
 *                 and employer contributions — an earning based on gross
 *                 would be part of its own base);
 * - FORMULA     — an arithmetic expression over component codes (and, for
 *                 deductions and employer contributions, GROSS and
 *                 TAXABLE_EARNINGS): + − × ÷, brackets, min(), max(), round().
 *
 * Nothing here decides tax. A component carries a classification (TAXABLE,
 * NON_TAXABLE, RULE_DEPENDENT) that the Phase 3 compliance engine applies.
 */

export const COMPONENT_TYPES = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION'] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const COMPONENT_CATEGORIES: Record<ComponentType, readonly string[]> = {
  EARNING: ['BASIC', 'ALLOWANCE', 'BONUS', 'COMMISSION', 'OVERTIME', 'ARREARS', 'REIMBURSEMENT', 'OTHER'],
  DEDUCTION: ['LOAN', 'ADVANCE', 'RECOVERY', 'PENALTY', 'OTHER_DEDUCTION'],
  EMPLOYER_CONTRIBUTION: ['EMPLOYER_PF', 'EMPLOYER_EOBI', 'OTHER_EMPLOYER_CONTRIBUTION'],
};

/**
 * Categories paid or taken some other way, so they can't be part of a
 * monthly compensation: overtime from attendance, reimbursements through
 * their approval workflow, loans and advances from their schedules, and
 * employer PF / EOBI from the Phase 3 compliance rules.
 */
export const NOT_IN_COMPENSATION: Record<string, string> = {
  OVERTIME: 'Overtime is paid from attendance under the Payroll policy.',
  REIMBURSEMENT: 'Reimbursements are paid once approved, through the reimbursement workflow.',
  LOAN: 'Loan repayments are scheduled from the loan itself.',
  ADVANCE: 'Advance recoveries are scheduled from the advance itself.',
  EMPLOYER_PF: 'Employer provident fund is worked out by the active compliance rule.',
  EMPLOYER_EOBI: 'Employer EOBI is worked out by the active compliance rule.',
};

export const CALCULATION_METHODS = ['FIXED', 'PERCENTAGE', 'FORMULA'] as const;
export type CalculationMethod = (typeof CALCULATION_METHODS)[number];

export const PERCENTAGE_BASES = ['BASIC', 'SELECTED', 'GROSS', 'TAXABLE_EARNINGS'] as const;
export type PercentageBase = (typeof PERCENTAGE_BASES)[number];

export const TAX_TREATMENTS = ['TAXABLE', 'NON_TAXABLE', 'RULE_DEPENDENT'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/** How a component is worked out — on a catalog component or an employee's line. */
export interface ComponentRule {
  code: string;
  name: string;
  type: ComponentType;
  category: string;
  calculationMethod: CalculationMethod;
  /** FIXED: the monthly amount. PERCENTAGE: the percent. FORMULA: unused. */
  value: number | null;
  percentageBase: PercentageBase | null;
  /** PERCENTAGE of SELECTED: the component codes summed for the base. */
  baseComponents: string[];
  formula: string | null;
  taxTreatment: TaxTreatment;
  includedInGross: boolean;
  includedInOvertimeBase: boolean;
  includedInLeaveBase: boolean;
}

/** A component on an employee's compensation, with its worked-out monthly amount. */
export interface CompensationLine extends ComponentRule {
  componentId: string | null;
  monthlyAmount: number;
  /** "20% of Basic Salary (150,000)" — how the amount was reached. */
  explanation: string;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const fmt = (value: number) => round2(value).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const BASIC_CODE_FALLBACK = 'BASIC';
export const RESERVED_NAMES = ['GROSS', 'TAXABLE_EARNINGS'];

// ── Formulas ────────────────────────────────────────────────────────────────

type Token = { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

const tokenize = (formula: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const match = /^[0-9]*\.?[0-9]+|^[0-9]+\.?/.exec(formula.slice(i))!;
      tokens.push({ kind: 'num', value: Number(match[0]) });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(formula.slice(i))!;
      tokens.push({ kind: 'id', value: match[0].toUpperCase() });
      i += match[0].length;
    } else if ('+-*/(),%'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
    } else {
      throw new Error(`Unexpected "${ch}" in the formula.`);
    }
  }
  return tokens;
};

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  MIN: (...args) => Math.min(...args),
  MAX: (...args) => Math.max(...args),
  ROUND: (x) => Math.round(x),
};

/**
 * Parses a formula into an evaluator and the names it refers to. A small
 * recursive-descent parser — never `eval`, so a formula can only do
 * arithmetic on the values it is given.
 */
export const parseFormula = (formula: string): { refs: string[]; evaluate: (vars: Record<string, number>) => number } => {
  const tokens = tokenize(formula);
  let pos = 0;
  const refs = new Set<string>();
  const peek = () => tokens[pos];
  const take = (value?: string) => {
    const token = tokens[pos];
    if (!token || (value !== undefined && !(token.kind === 'op' && token.value === value))) {
      throw new Error(value ? `Expected "${value}" in the formula.` : 'The formula ends too early.');
    }
    pos++;
    return token;
  };

  type Node = (vars: Record<string, number>) => number;
  const expression = (): Node => {
    let left = term();
    while (peek()?.kind === 'op' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = take().value;
      const right = term();
      const l = left;
      left = op === '+' ? (v) => l(v) + right(v) : (v) => l(v) - right(v);
    }
    return left;
  };
  const term = (): Node => {
    let left = factor();
    while (peek()?.kind === 'op' && (peek()!.value === '*' || peek()!.value === '/')) {
      const op = take().value;
      const right = factor();
      const l = left;
      left =
        op === '*'
          ? (v) => l(v) * right(v)
          : (v) => {
              const divisor = right(v);
              if (divisor === 0) throw new Error('The formula divides by zero.');
              return l(v) / divisor;
            };
    }
    return left;
  };
  const factor = (): Node => {
    const token = peek();
    if (!token) throw new Error('The formula ends too early.');
    if (token.kind === 'op' && token.value === '-') {
      take();
      const inner = factor();
      return (v) => -inner(v);
    }
    if (token.kind === 'op' && token.value === '(') {
      take();
      const inner = expression();
      take(')');
      return inner;
    }
    if (token.kind === 'num') {
      take();
      // "20%" reads as 0.20.
      if (peek()?.kind === 'op' && peek()!.value === '%') {
        take();
        return () => token.value / 100;
      }
      return () => token.value;
    }
    if (token.kind === 'id') {
      take();
      const fn = FUNCTIONS[token.value];
      if (fn && peek()?.kind === 'op' && peek()!.value === '(') {
        take('(');
        const args: Node[] = [expression()];
        while (peek()?.kind === 'op' && peek()!.value === ',') {
          take(',');
          args.push(expression());
        }
        take(')');
        return (v) => fn(...args.map((arg) => arg(v)));
      }
      refs.add(token.value);
      return (v) => {
        if (!(token.value in v)) throw new Error(`"${token.value}" is not a component on this compensation.`);
        return v[token.value];
      };
    }
    throw new Error(`Unexpected "${token.value}" in the formula.`);
  };

  if (!tokens.length) throw new Error('The formula is empty.');
  const root = expression();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}" in the formula.`);
  return { refs: [...refs], evaluate: root };
};

// ── Validation ──────────────────────────────────────────────────────────────

/** Problems with one component's own settings, independent of any employee. */
export const validateComponentRule = (rule: Partial<ComponentRule>): string[] => {
  const errors: string[] = [];
  if (!rule.code || !/^[A-Z][A-Z0-9_]{1,31}$/.test(rule.code)) {
    errors.push('The code must be 2–32 capital letters, digits or underscores, starting with a letter (e.g. HOUSING).');
  } else if (RESERVED_NAMES.includes(rule.code)) {
    errors.push(`"${rule.code}" is reserved for formulas.`);
  }
  if (!rule.name?.trim()) errors.push('Give the component a name.');
  if (!rule.type || !COMPONENT_TYPES.includes(rule.type)) errors.push('Choose earning, deduction or employer contribution.');
  else if (!rule.category || !COMPONENT_CATEGORIES[rule.type].includes(rule.category)) {
    errors.push(`Choose a category for a ${rule.type.toLowerCase().replace('_', ' ')}.`);
  }
  if (!rule.calculationMethod || !CALCULATION_METHODS.includes(rule.calculationMethod)) {
    errors.push('Choose fixed amount, percentage or formula.');
  }
  if (rule.taxTreatment && !TAX_TREATMENTS.includes(rule.taxTreatment)) errors.push('Choose a tax treatment.');
  const isEarning = rule.type === 'EARNING';
  if (rule.calculationMethod === 'FIXED' && rule.value !== null && rule.value !== undefined && Number(rule.value) < 0) {
    errors.push('A fixed amount can’t be negative.');
  }
  if (rule.calculationMethod === 'PERCENTAGE') {
    if (rule.value === null || rule.value === undefined || !(Number(rule.value) >= 0) || Number(rule.value) > 1000) {
      errors.push('Enter the percentage (0–1000).');
    }
    if (!rule.percentageBase || !PERCENTAGE_BASES.includes(rule.percentageBase)) {
      errors.push('A percentage needs a base: Basic Salary, Selected Components, Gross Salary or Taxable Earnings.');
    } else if (isEarning && (rule.percentageBase === 'GROSS' || rule.percentageBase === 'TAXABLE_EARNINGS')) {
      errors.push('An earning can’t be a percentage of gross or taxable earnings — it would be part of its own base. Use Basic Salary or Selected Components.');
    } else if (rule.percentageBase === 'SELECTED') {
      if (!rule.baseComponents?.length) errors.push('Choose the components the percentage is of.');
      else if (rule.code && rule.baseComponents.includes(rule.code)) errors.push('A component can’t be a percentage of itself.');
    }
  }
  if (rule.calculationMethod === 'FORMULA') {
    if (!rule.formula?.trim()) errors.push('Enter the formula.');
    else {
      try {
        const { refs } = parseFormula(rule.formula);
        if (rule.code && refs.includes(rule.code)) errors.push('A formula can’t refer to its own component.');
        if (isEarning && refs.some((ref) => RESERVED_NAMES.includes(ref))) {
          errors.push('An earning’s formula can’t use GROSS or TAXABLE_EARNINGS — it would be part of its own base.');
        }
      } catch (error: any) {
        errors.push(error.message);
      }
    }
  }
  if (rule.type && rule.type !== 'EARNING' && (rule.includedInOvertimeBase || rule.includedInLeaveBase)) {
    errors.push('Only earnings can be part of the overtime or leave base.');
  }
  return errors;
};

// ── Resolution ──────────────────────────────────────────────────────────────

export interface ResolvedCompensation {
  lines: CompensationLine[];
  errors: string[];
  totals: { basic: number; allowances: number; gross: number; deductions: number; employerContributions: number };
}

const baseLabel: Record<PercentageBase, string> = {
  BASIC: 'Basic Salary',
  SELECTED: 'selected components',
  GROSS: 'Gross Salary',
  TAXABLE_EARNINGS: 'Taxable Earnings',
};

/**
 * Works out every line's monthly amount. Lines are resolved in dependency
 * order; a missing or circular reference is an error, never a guess.
 *
 * Exactly one earning must be the Basic Salary (category BASIC): the
 * payroll's basic, the base for "percentage of Basic" and — unless the
 * Payroll policy says otherwise — for overtime.
 */
export const resolveCompensation = (
  lines: (ComponentRule & { componentId?: string | null })[],
): ResolvedCompensation => {
  const errors: string[] = [];
  const codes = lines.map((line) => line.code);
  const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
  if (duplicates.length) errors.push(`Each component can be on a compensation once: ${[...new Set(duplicates)].join(', ')}.`);

  const basics = lines.filter((line) => line.type === 'EARNING' && line.category === 'BASIC');
  if (basics.length !== 1) errors.push(basics.length ? 'Only one component can be the Basic Salary.' : 'The compensation needs a Basic Salary component.');
  const basicCode = basics[0]?.code ?? null;

  for (const line of lines) {
    for (const problem of validateComponentRule(line)) errors.push(`${line.name || line.code}: ${problem}`);
    if (NOT_IN_COMPENSATION[line.category]) errors.push(`${line.name}: ${NOT_IN_COMPENSATION[line.category]}`);
  }

  const amounts = new Map<string, number>();
  const explanations = new Map<string, string>();
  const byCode = new Map(lines.map((line) => [line.code, line]));
  const isEarning = (line: ComponentRule) => line.type === 'EARNING';

  // What each line needs before it can be worked out.
  const needs = (line: ComponentRule): string[] => {
    if (line.calculationMethod === 'FIXED') return [];
    if (line.calculationMethod === 'PERCENTAGE') {
      if (line.percentageBase === 'BASIC') return basicCode ? [basicCode] : ['BASIC'];
      if (line.percentageBase === 'SELECTED') return line.baseComponents;
      // Gross and taxable earnings: every earning.
      return lines.filter(isEarning).map((l) => l.code);
    }
    try {
      const { refs } = parseFormula(line.formula ?? '');
      return refs.flatMap((ref) => (RESERVED_NAMES.includes(ref) ? lines.filter(isEarning).map((l) => l.code) : [ref]));
    } catch {
      return [];
    }
  };

  const grossOf = () =>
    lines.filter((l) => isEarning(l) && l.includedInGross).reduce((sum, l) => sum + (amounts.get(l.code) ?? 0), 0);
  const taxableOf = () =>
    lines
      .filter((l) => isEarning(l) && l.includedInGross && l.taxTreatment === 'TAXABLE')
      .reduce((sum, l) => sum + (amounts.get(l.code) ?? 0), 0);

  if (!errors.length) {
    const pending = new Set(lines.map((line) => line.code));
    let progressed = true;
    while (pending.size && progressed) {
      progressed = false;
      for (const code of [...pending]) {
        const line = byCode.get(code)!;
        const deps = needs(line);
        const missing = deps.filter((dep) => !byCode.has(dep));
        if (missing.length) {
          errors.push(`${line.name}: refers to ${missing.join(', ')}, which ${missing.length === 1 ? 'isn’t' : 'aren’t'} on this compensation.`);
          pending.delete(code);
          continue;
        }
        if (deps.some((dep) => dep !== code && pending.has(dep))) continue;
        try {
          let amount = 0;
          let explanation = '';
          if (line.calculationMethod === 'FIXED') {
            amount = Number(line.value ?? 0);
            explanation = 'Fixed amount';
          } else if (line.calculationMethod === 'PERCENTAGE') {
            const base =
              line.percentageBase === 'BASIC'
                ? (amounts.get(basicCode!) ?? 0)
                : line.percentageBase === 'SELECTED'
                  ? line.baseComponents.reduce((sum, dep) => sum + (amounts.get(dep) ?? 0), 0)
                  : line.percentageBase === 'GROSS'
                    ? grossOf()
                    : taxableOf();
            amount = (base * Number(line.value ?? 0)) / 100;
            const names = line.percentageBase === 'SELECTED' ? line.baseComponents.map((dep) => byCode.get(dep)?.name ?? dep).join(' + ') : baseLabel[line.percentageBase!];
            explanation = `${fmt(Number(line.value ?? 0))}% of ${names} (${fmt(base)})`;
          } else {
            const vars: Record<string, number> = Object.fromEntries([...amounts.entries()]);
            vars.GROSS = grossOf();
            vars.TAXABLE_EARNINGS = taxableOf();
            amount = parseFormula(line.formula!).evaluate(vars);
            explanation = `= ${line.formula}`;
          }
          if (!Number.isFinite(amount)) throw new Error('works out to an invalid amount.');
          if (amount < 0) throw new Error(`works out to a negative amount (${fmt(amount)}).`);
          amounts.set(code, round2(amount));
          explanations.set(code, explanation);
        } catch (error: any) {
          errors.push(`${line.name}: ${error.message}`);
        }
        pending.delete(code);
        progressed = true;
      }
    }
    if (pending.size) {
      errors.push(`These components depend on each other in a circle: ${[...pending].map((code) => byCode.get(code)?.name ?? code).join(', ')}.`);
    }
  }

  const resolved: CompensationLine[] = lines.map((line) => ({
    ...line,
    componentId: line.componentId ?? null,
    baseComponents: line.baseComponents ?? [],
    monthlyAmount: amounts.get(line.code) ?? 0,
    explanation: explanations.get(line.code) ?? '',
  }));
  const sum = (filter: (line: CompensationLine) => boolean) =>
    round2(resolved.filter(filter).reduce((total, line) => total + line.monthlyAmount, 0));
  return {
    lines: resolved,
    errors,
    totals: {
      basic: sum((l) => l.type === 'EARNING' && l.category === 'BASIC'),
      allowances: sum((l) => l.type === 'EARNING' && l.category !== 'BASIC' && l.includedInGross),
      gross: sum((l) => l.type === 'EARNING' && l.includedInGross),
      deductions: sum((l) => l.type === 'DEDUCTION'),
      employerContributions: sum((l) => l.type === 'EMPLOYER_CONTRIBUTION'),
    },
  };
};

/**
 * A compensation saved before components existed (Phase 1): basic,
 * allowances and a recurring-deduction total. Read as three components so
 * payroll works the same way for every employee.
 */
export const legacyCompensation = (salary: { basicSalary: number; allowances: number; recurringDeductions: number }): CompensationLine[] => {
  const line = (code: string, name: string, type: ComponentType, category: string, amount: number, leaveBase: boolean): CompensationLine => ({
    componentId: null,
    code,
    name,
    type,
    category,
    calculationMethod: 'FIXED',
    value: amount,
    percentageBase: null,
    baseComponents: [],
    formula: null,
    taxTreatment: 'RULE_DEPENDENT',
    includedInGross: type === 'EARNING',
    includedInOvertimeBase: category === 'BASIC',
    includedInLeaveBase: leaveBase,
    monthlyAmount: round2(Math.max(0, amount)),
    explanation: 'Fixed amount',
  });
  return [
    line('BASIC', 'Basic Salary', 'EARNING', 'BASIC', salary.basicSalary, true),
    ...(salary.allowances > 0 ? [line('ALLOWANCES', 'Allowances', 'EARNING', 'ALLOWANCE', salary.allowances, true)] : []),
    ...(salary.recurringDeductions > 0 ? [line('RECURRING_DEDUCTIONS', 'Recurring Deductions', 'DEDUCTION', 'OTHER_DEDUCTION', salary.recurringDeductions, false)] : []),
  ];
};

/** The three Phase 1 totals a compensation adds up to — kept on the revision for Phase 1–3 readers. */
export const phase1Totals = (lines: CompensationLine[]) => {
  const sum = (filter: (line: CompensationLine) => boolean) =>
    round2(lines.filter(filter).reduce((total, line) => total + line.monthlyAmount, 0));
  return {
    basicSalary: sum((l) => l.type === 'EARNING' && l.category === 'BASIC'),
    allowances: sum((l) => l.type === 'EARNING' && l.category !== 'BASIC' && l.includedInGross),
    recurringDeductions: sum((l) => l.type === 'DEDUCTION'),
  };
};
