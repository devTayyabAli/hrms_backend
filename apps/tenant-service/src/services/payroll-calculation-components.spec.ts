import { calculatePayrollLine, compensationSegments, type PayrollLineInput } from './payroll-calculation';
import { resolveCompensation, type ComponentRule } from './payroll-components';

/**
 * Phase 4 in the Phase 1 calculation: components, segments (mid-month
 * changes), recurring items, loan / advance recovery and employer
 * contributions. Working days are Mon–Sat, as in the Phase 1 tests:
 * September 2026 has 26, October 2026 has 27 (13 up to the 15th).
 */

const MON_SAT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
  includedInLeaveBase: true,
  ...over,
});
const compensation = (rules: ComponentRule[]) => {
  const resolved = resolveCompensation(rules);
  if (resolved.errors.length) throw new Error(resolved.errors.join(' '));
  return resolved.lines;
};
const basic = (value: number) => rule({ code: 'BASIC', name: 'Basic Salary', category: 'BASIC', value, includedInOvertimeBase: true });

const input = (over: Partial<PayrollLineInput> = {}): PayrollLineInput => ({
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  workingWeekdays: MON_SAT,
  salary: { basicSalary: 0, allowances: 0, recurringDeductions: 0, effectiveFrom: null },
  joiningDate: '2025-01-01',
  exitDate: null,
  attendance: [],
  leaves: [],
  adjustments: [],
  overtime: { multiplier: null, hoursPerDay: 8 },
  ...over,
});
const whole = (lines: ReturnType<typeof compensation>, from = '2026-09-01', to = '2026-09-30') => [{ from, to, revisionId: 'r1', structureName: 'Management Package', lines }];

describe('Phase 4 payroll line', () => {
  const package205 = compensation([
    basic(150_000),
    rule({ code: 'HOUSING', name: 'Housing Allowance', calculationMethod: 'PERCENTAGE', value: 20, percentageBase: 'BASIC' }),
    rule({ code: 'TRANSPORT', name: 'Transport Allowance', value: 15_000 }),
    rule({ code: 'MEDICAL', name: 'Medical Allowance', value: 10_000 }),
  ]);

  it('pays each component and lists it', () => {
    const r = calculatePayrollLine(input({ segments: whole(package205) }));
    expect(r.earnedBasic).toBe(150_000);
    expect(r.earnedAllowances).toBe(55_000);
    expect(r.grossPay).toBe(205_000);
    expect(r.breakdown.earnings.map((l) => [l.name, l.amount])).toEqual([
      ['Basic Salary', 150_000],
      ['Housing Allowance', 30_000],
      ['Transport Allowance', 15_000],
      ['Medical Allowance', 10_000],
    ]);
  });

  it('prorates every component for a joiner by working days', () => {
    // Joined Tue 15 Sep: 14 of 26 working days.
    const r = calculatePayrollLine(input({ joiningDate: '2026-09-15', segments: whole(package205) }));
    expect(r.eligibleDays).toBe(14);
    expect(r.breakdown.earnings.find((l) => l.name === 'Housing Allowance')!.amount).toBe(16_153.85);
    expect(r.grossPay).toBe(110_384.62);
  });

  it('splits a mid-month change by the Phase 1 working days, not calendar days', () => {
    const before = compensation([basic(100_000)]);
    const after = compensation([basic(125_000)]);
    const segments = compensationSegments(
      [
        { id: 'a', effectiveFrom: '2026-07-01', lines: before },
        { id: 'b', effectiveFrom: '2026-10-16', lines: after },
      ],
      '2026-10-01',
      '2026-10-31',
    );
    expect(segments.map((s) => [s.from, s.to, s.revisionId])).toEqual([
      ['2026-10-01', '2026-10-15', 'a'],
      ['2026-10-16', '2026-10-31', 'b'],
    ]);
    const r = calculatePayrollLine(input({ periodStart: '2026-10-01', periodEnd: '2026-10-31', segments }));
    // 100,000 × 13/27 + 125,000 × 14/27
    expect(r.earnedBasic).toBe(112_962.96);
    expect(r.breakdown.segments.map((s) => s.eligibleDays)).toEqual([13, 14]);
    expect(r.notes.join(' ')).toMatch(/Compensation changed during the period/);
  });

  it('uses the rate in effect on each unpaid day', () => {
    const segments = compensationSegments(
      [
        { id: 'a', effectiveFrom: '2026-07-01', lines: compensation([basic(27_000)]) },
        { id: 'b', effectiveFrom: '2026-10-16', lines: compensation([basic(54_000)]) },
      ],
      '2026-10-01',
      '2026-10-31',
    );
    const r = calculatePayrollLine(
      input({
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        segments,
        attendance: [
          { date: '2026-10-05', status: 'ABSENT', overtimeMinutes: null },
          { date: '2026-10-20', status: 'ABSENT', overtimeMinutes: null },
        ],
      }),
    );
    // 27,000 / 27 + 54,000 / 27
    expect(r.absenceDeduction).toBe(3_000);
  });

  it('keeps September on the salary that applied then, and October on the raise', () => {
    const revisions = [
      { id: 'a', effectiveFrom: '2026-07-01', lines: compensation([basic(100_000)]) },
      { id: 'b', effectiveFrom: '2026-10-01', lines: compensation([basic(125_000)]) },
    ];
    const september = calculatePayrollLine(input({ segments: compensationSegments(revisions, '2026-09-01', '2026-09-30') }));
    const october = calculatePayrollLine(input({ periodStart: '2026-10-01', periodEnd: '2026-10-31', segments: compensationSegments(revisions, '2026-10-01', '2026-10-31') }));
    expect(september.earnedBasic).toBe(100_000);
    expect(october.earnedBasic).toBe(125_000);
  });

  it('includes a recurring earning only for its own working days', () => {
    const lines = compensation([basic(100_000)]);
    const mobile = { id: 'm', kind: 'EARNING' as const, name: 'Mobile Allowance', category: 'ALLOWANCE', calculationMethod: 'FIXED' as const, amount: 2_600, percentageBase: null, frequency: 'MONTHLY' as const, remaining: null, taxTreatment: 'RULE_DEPENDENT' as const };
    // Starts Tue 15 Sep: 14 of 26 days.
    const starts = calculatePayrollLine(input({ segments: whole(lines), recurring: [{ ...mobile, startDate: '2026-09-15', endDate: null }] }));
    expect(starts.breakdown.earnings.find((l) => l.name === 'Mobile Allowance')!.amount).toBe(1_400);
    // Ends Sat 12 Sep: 11 of 26 days.
    const ends = calculatePayrollLine(input({ segments: whole(lines), recurring: [{ ...mobile, startDate: '2026-01-01', endDate: '2026-09-12' }] }));
    expect(ends.breakdown.earnings.find((l) => l.name === 'Mobile Allowance')!.amount).toBe(1_100);
    // Ended before the month: nothing.
    const over = calculatePayrollLine(input({ segments: whole(lines), recurring: [{ ...mobile, startDate: '2026-01-01', endDate: '2026-08-31' }] }));
    expect(over.breakdown.earnings.some((l) => l.name === 'Mobile Allowance')).toBe(false);
    expect(starts.earnedAllowances).toBe(1_400);
  });

  it('takes a recurring deduction in full, and never past its total', () => {
    const deduction = { id: 'd', kind: 'DEDUCTION' as const, name: 'Salary Deduction', category: 'OTHER_DEDUCTION', calculationMethod: 'FIXED' as const, amount: 5_000, percentageBase: null, frequency: 'MONTHLY' as const, startDate: '2026-09-20', endDate: null, taxTreatment: 'RULE_DEPENDENT' as const };
    const r = calculatePayrollLine(input({ segments: whole(compensation([basic(100_000)])), recurring: [{ ...deduction, remaining: null }] }));
    expect(r.recurringDeductions).toBe(5_000);
    const last = calculatePayrollLine(input({ segments: whole(compensation([basic(100_000)])), recurring: [{ ...deduction, remaining: 1_200 }] }));
    expect(last.recurringDeductions).toBe(1_200);
    expect(last.breakdown.deductions.find((l) => l.name === 'Salary Deduction')!.detail).toMatch(/final/);
    const done = calculatePayrollLine(input({ segments: whole(compensation([basic(100_000)])), recurring: [{ ...deduction, remaining: 0 }] }));
    expect(done.recurringDeductions).toBe(0);
  });

  it('recovers a loan instalment, the final one only what is left', () => {
    const lines = compensation([basic(100_000)]);
    const monthly = calculatePayrollLine(input({ segments: whole(lines), recoveries: [{ id: 'l', kind: 'LOAN', name: 'Loan Recovery', installment: 20_000, remaining: 120_000 }] }));
    expect(monthly.loanRecovery).toBe(20_000);
    expect(monthly.netPay).toBe(80_000);
    const final = calculatePayrollLine(input({ segments: whole(lines), recoveries: [{ id: 'l', kind: 'LOAN', name: 'Loan Recovery', installment: 20_000, remaining: 5_000 }] }));
    expect(final.loanRecovery).toBe(5_000);
    expect(final.breakdown.deductions.find((l) => l.source === 'LOAN')!.detail).toBe('Final instalment');
  });

  it('never lets a recovery make net pay negative — the rest stays on the balance', () => {
    const r = calculatePayrollLine(
      input({
        segments: whole(compensation([basic(30_000)])),
        recoveries: [{ id: 'a', kind: 'ADVANCE', name: 'Advance Recovery', installment: 50_000, remaining: 50_000 }],
      }),
    );
    expect(r.loanRecovery).toBe(30_000);
    expect(r.netPay).toBe(0);
    expect(r.notes.join(' ')).toMatch(/stays on the balance/);
  });

  it('keeps employer contributions out of gross and net', () => {
    const lines = compensation([
      basic(100_000),
      rule({ code: 'HEALTH', type: 'EMPLOYER_CONTRIBUTION', category: 'OTHER_EMPLOYER_CONTRIBUTION', value: 4_000, includedInLeaveBase: false }),
    ]);
    const r = calculatePayrollLine(input({ segments: whole(lines) }));
    expect(r.otherEmployerContributions).toBe(4_000);
    expect(r.grossPay).toBe(100_000);
    expect(r.netPay).toBe(100_000);
  });

  it('pays overtime on the base the payroll policy chose', () => {
    const lines = compensation([basic(104_000), rule({ code: 'COLA', value: 20_800, includedInOvertimeBase: true })]);
    const overtime = { multiplier: 2, hoursPerDay: 8 };
    const attendance = [{ date: '2026-09-02', status: 'PRESENT', overtimeMinutes: 60 }];
    // Basic only: 104,000 / 26 / 8 = 500 an hour → 1 h × 2 = 1,000.
    expect(calculatePayrollLine(input({ segments: whole(lines), attendance, overtime })).overtimePay).toBe(1_000);
    // Components marked for overtime: (104,000 + 20,800) / 26 / 8 = 600 → 1,200.
    expect(calculatePayrollLine(input({ segments: whole(lines), attendance, overtime: { ...overtime, base: 'COMPONENTS' } })).overtimePay).toBe(1_200);
  });

  it('hands the compliance engine each earning with its tax classification', () => {
    const lines = compensation([basic(100_000), rule({ code: 'FUEL', value: 10_000, taxTreatment: 'NON_TAXABLE' })]);
    const r = calculatePayrollLine(input({ segments: whole(lines) }));
    expect(r.taxBasis.month).toEqual([{ amount: 10_000, treatment: 'NON_TAXABLE' }]);
    expect(r.taxBasis.monthly).toEqual([{ amount: 10_000, treatment: 'NON_TAXABLE' }]);
  });

  it('gives exactly the Phase 1 result without components', () => {
    const r = calculatePayrollLine(input({ salary: { basicSalary: 100_000, allowances: 20_000, recurringDeductions: 5_000, effectiveFrom: null } }));
    expect([r.earnedBasic, r.earnedAllowances, r.recurringDeductions, r.netPay]).toEqual([100_000, 20_000, 5_000, 115_000]);
  });
});
