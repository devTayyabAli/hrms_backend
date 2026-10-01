import { calculatePayrollLine, monthBounds, salaryForPeriod, type PayrollLineInput } from './payroll-calculation';

/**
 * September 2026 on a Monday–Saturday shift has 26 working days, which makes
 * the spec's own example exact: 100,000 / 26 per day.
 */
const MON_SAT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SEPTEMBER = monthBounds('2026-09');

const input = (overrides: Partial<PayrollLineInput> = {}): PayrollLineInput => ({
  ...SEPTEMBER,
  workingWeekdays: MON_SAT,
  salary: { basicSalary: 100_000, allowances: 0, recurringDeductions: 0, effectiveFrom: '2026-01-01' },
  joiningDate: '2025-01-01',
  exitDate: null,
  attendance: [],
  leaves: [],
  adjustments: [],
  overtime: { multiplier: null, hoursPerDay: null },
  ...overrides,
});

const DAILY = 100_000 / 26;

describe('calculatePayrollLine', () => {
  it('counts working days from the shift, not a fixed 30', () => {
    const line = calculatePayrollLine(input());
    expect(line.workingDays).toBe(26);
    expect(calculatePayrollLine(input({ workingWeekdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] })).workingDays).toBe(22);
  });

  it('pays the full salary for a full month with nothing missed', () => {
    const line = calculatePayrollLine(input({ salary: { basicSalary: 80_000, allowances: 20_000, recurringDeductions: 0, effectiveFrom: null } }));
    expect(line.grossPay).toBe(100_000);
    expect(line.deductions).toBe(0);
    expect(line.netPay).toBe(100_000);
    expect(line.prorationFactor).toBe(1);
  });

  it('deducts a daily rate for each unpaid absence', () => {
    const line = calculatePayrollLine(
      input({
        attendance: [
          { date: '2026-09-02', status: 'ABSENT', overtimeMinutes: null },
          { date: '2026-09-03', status: 'ABSENT', overtimeMinutes: null },
          { date: '2026-09-04', status: 'PRESENT', overtimeMinutes: null },
        ],
      }),
    );
    expect(line.absenceDays).toBe(2);
    expect(line.absenceDeduction).toBeCloseTo(DAILY * 2, 2);
    expect(line.netPay).toBeCloseTo(100_000 - DAILY * 2, 2);
  });

  it('counts a half day as half an absence', () => {
    const line = calculatePayrollLine(input({ attendance: [{ date: '2026-09-02', status: 'HALF_DAY', overtimeMinutes: null }] }));
    expect(line.absenceDays).toBe(0.5);
    expect(line.absenceDeduction).toBeCloseTo(DAILY / 2, 2);
  });

  it('deducts approved unpaid leave, including a half day', () => {
    const line = calculatePayrollLine(
      input({
        leaves: [
          { fromDate: '2026-09-07', toDate: '2026-09-07', totalDays: 1, isPaid: false },
          { fromDate: '2026-09-08', toDate: '2026-09-08', totalDays: 0.5, isPaid: false },
        ],
      }),
    );
    expect(line.unpaidLeaveDays).toBe(1.5);
    expect(line.unpaidLeaveDeduction).toBeCloseTo(DAILY * 1.5, 2);
  });

  it('never deducts paid leave', () => {
    const line = calculatePayrollLine(
      input({ leaves: [{ fromDate: '2026-09-07', toDate: '2026-09-11', totalDays: 5, isPaid: true }] }),
    );
    expect(line.paidLeaveDays).toBe(5);
    expect(line.deductions).toBe(0);
    expect(line.netPay).toBe(100_000);
  });

  it('does not charge an Absent day that approved leave already covers', () => {
    const line = calculatePayrollLine(
      input({
        attendance: [{ date: '2026-09-07', status: 'ABSENT', overtimeMinutes: null }],
        leaves: [{ fromDate: '2026-09-07', toDate: '2026-09-07', totalDays: 1, isPaid: true }],
      }),
    );
    expect(line.absenceDays).toBe(0);
    expect(line.netPay).toBe(100_000);
  });

  it('ignores leave on non-working days', () => {
    // 2026-09-06 is a Sunday.
    const line = calculatePayrollLine(
      input({ leaves: [{ fromDate: '2026-09-06', toDate: '2026-09-06', totalDays: 1, isPaid: false }] }),
    );
    expect(line.unpaidLeaveDays).toBe(0);
  });

  it('prorates a joiner to the working days after their joining date', () => {
    const line = calculatePayrollLine(input({ joiningDate: '2026-09-15' }));
    // 15–30 Sep, Mon–Sat: 14 working days of 26.
    expect(line.eligibleDays).toBe(14);
    expect(line.grossPay).toBeCloseTo((100_000 * 14) / 26, 2);
    expect(line.notes.join(' ')).toMatch(/Joined 15 Sept?/);
  });

  it('prorates a leaver to their last working day', () => {
    const line = calculatePayrollLine(input({ exitDate: '2026-09-20' }));
    // 1–20 Sep, Mon–Sat: 17 working days.
    expect(line.eligibleDays).toBe(17);
    expect(line.employedTo).toBe('2026-09-20');
    expect(line.grossPay).toBeCloseTo((100_000 * 17) / 26, 2);
  });

  it('ignores absences outside the employment window', () => {
    const line = calculatePayrollLine(
      input({ joiningDate: '2026-09-15', attendance: [{ date: '2026-09-02', status: 'ABSENT', overtimeMinutes: null }] }),
    );
    expect(line.absenceDays).toBe(0);
  });

  it('takes recurring deductions in full', () => {
    const line = calculatePayrollLine(input({ salary: { basicSalary: 100_000, allowances: 0, recurringDeductions: 5_000, effectiveFrom: null } }));
    expect(line.recurringDeductions).toBe(5_000);
    expect(line.netPay).toBe(95_000);
  });

  it('applies manual adjustments on top of the calculation', () => {
    const line = calculatePayrollLine(
      input({
        adjustments: [
          { type: 'EARNING', amount: 5_000 },
          { type: 'DEDUCTION', amount: 1_500 },
        ],
      }),
    );
    expect(line.earningAdjustments).toBe(5_000);
    expect(line.deductionAdjustments).toBe(1_500);
    expect(line.grossPay).toBe(105_000);
    expect(line.netPay).toBe(103_500);
  });

  it('pays overtime only when the payroll policy sets a multiplier', () => {
    const attendance = [{ date: '2026-09-02', status: 'PRESENT', overtimeMinutes: 120 }];
    const unpaid = calculatePayrollLine(input({ attendance }));
    expect(unpaid.overtimeMinutes).toBe(120);
    expect(unpaid.overtimePay).toBe(0);
    expect(unpaid.notes.join(' ')).toMatch(/not paid/);

    const paid = calculatePayrollLine(input({ attendance, overtime: { multiplier: 1.5, hoursPerDay: 8 } }));
    // 2 h × (100,000 / 26 / 8) × 1.5
    expect(paid.overtimePay).toBeCloseTo(2 * (100_000 / 26 / 8) * 1.5, 2);
    expect(paid.grossPay).toBeCloseTo(100_000 + paid.overtimePay, 2);
  });

  it('flags working days with no attendance record without deducting them', () => {
    const line = calculatePayrollLine(input({ attendance: [{ date: '2026-09-01', status: 'PRESENT', overtimeMinutes: null }] }));
    expect(line.unrecordedDays).toBe(25);
    expect(line.deductions).toBe(0);
  });

  it('reports a negative net pay instead of hiding it', () => {
    const line = calculatePayrollLine(input({ salary: { basicSalary: 1_000, allowances: 0, recurringDeductions: 5_000, effectiveFrom: null } }));
    expect(line.netPay).toBe(-4_000);
    expect(line.notes.join(' ')).toMatch(/negative/);
  });
});

describe('salaryForPeriod', () => {
  const fallback = { basicSalary: 1, allowances: 1, recurringDeductions: 0, effectiveFrom: null };
  const revisions = [
    { effectiveFrom: '2026-01-01', basicSalary: 80_000, allowances: 0, recurringDeductions: 0 },
    { effectiveFrom: '2026-10-01', basicSalary: 90_000, allowances: 0, recurringDeductions: 0 },
  ];

  it('uses the revision in effect for the period, not a later raise', () => {
    expect(salaryForPeriod(revisions, '2026-09-30', fallback).basicSalary).toBe(80_000);
    expect(salaryForPeriod(revisions, '2026-10-31', fallback).basicSalary).toBe(90_000);
  });

  it('falls back to the employee’s figures when there is no history', () => {
    expect(salaryForPeriod([], '2026-09-30', fallback)).toBe(fallback);
  });
});

describe('monthBounds', () => {
  it('returns the first and last day of the month', () => {
    expect(monthBounds('2026-09')).toEqual({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(monthBounds('2028-02')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-02-29' });
  });
});
