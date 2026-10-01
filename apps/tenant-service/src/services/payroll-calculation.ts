/**
 * Payroll Phase 1 arithmetic — the only place a salary is turned into a
 * payroll line. Free of I/O so every rule can be tested on its own and so
 * nothing else (frontend included) has a second copy of it.
 *
 *   Gross = Basic × proration + Allowances × proration + Overtime + Earning adjustments
 *   Deductions = Unpaid absence + Unpaid leave + Recurring + Deduction adjustments
 *   Net = Gross − Deductions
 *
 * Days are counted against the organization's working days (the default
 * shift), not a fixed 30:
 * - working days: scheduled days in the period;
 * - eligible days: working days the person was employed for (on or after
 *   joining, on or before their last day) — proration = eligible / working;
 * - daily rate: monthly (basic + allowances) / working days;
 * - an approved unpaid leave day, or an Absent attendance day not covered by
 *   approved leave, costs one daily rate (a half day, half).
 *
 * Statutory items (income tax, EOBI, provident fund) are out of scope here.
 *
 * Phase 4: pay comes from compensation components. Each part of the period
 * with its own compensation (a segment) is paid for its own eligible working
 * days, so a change on the 16th splits the month by the same working-day
 * rule. Recurring earnings are prorated the same way over their own dates;
 * recurring deductions and loan / advance instalments are taken in full.
 */

import { legacyCompensation, type CompensationLine, type TaxTreatment } from './payroll-components';

export interface PayrollSalary {
  basicSalary: number;
  allowances: number;
  recurringDeductions: number;
  effectiveFrom: string | null;
}

export interface PayrollAttendanceDay {
  date: string;
  /** AttendanceStatus — PRESENT, LATE, ABSENT, HALF_DAY, ON_LEAVE, HOLIDAY. */
  status: string;
  overtimeMinutes: number | null;
}

export interface PayrollLeave {
  fromDate: string;
  toDate: string;
  /** The days the request actually covers — 0.5 for a half day. */
  totalDays: number;
  isPaid: boolean;
}

export interface PayrollAdjustmentInput {
  type: 'EARNING' | 'DEDUCTION';
  amount: number;
  /** BONUS, ARREARS, COMMISSION, REIMBURSEMENT, OTHER — for the line label. */
  category?: string;
  label?: string;
  source?: 'ADJUSTMENT' | 'REIMBURSEMENT';
  sourceId?: string | null;
}

/**
 * The compensation in effect for part of the period (Phase 4). A change on
 * the 16th makes two segments; each is paid for its own working days.
 */
export interface CompensationSegment {
  from: string;
  to: string;
  revisionId: string | null;
  structureName: string | null;
  lines: CompensationLine[];
}

/** An employee's recurring earning or deduction with its own dates. */
export interface RecurringItemInput {
  id: string;
  kind: 'EARNING' | 'DEDUCTION';
  name: string;
  category: string;
  calculationMethod: 'FIXED' | 'PERCENTAGE';
  /** FIXED: monthly amount. PERCENTAGE: the percent. */
  amount: number;
  percentageBase: 'BASIC' | 'GROSS' | null;
  startDate: string;
  endDate: string | null;
  frequency: 'MONTHLY' | 'ONE_TIME';
  /** Deductions with a total: what is left to take, before this period. */
  remaining: number | null;
  taxTreatment: TaxTreatment;
}

/** A loan or advance instalment due this period. */
export interface RecoveryInput {
  id: string;
  kind: 'LOAN' | 'ADVANCE';
  name: string;
  installment: number;
  /** Balance left before this period — recovery never goes past it. */
  remaining: number;
}

export type PayLineSource = 'COMPENSATION' | 'RECURRING' | 'ADJUSTMENT' | 'REIMBURSEMENT' | 'ATTENDANCE' | 'LOAN' | 'ADVANCE';

/** One earning, deduction or employer contribution on a payroll line, explained. */
export interface PayLine {
  code: string | null;
  name: string;
  category: string;
  source: PayLineSource;
  sourceId: string | null;
  method: string | null;
  /** "20% of Basic Salary (150,000) · 13 of 26 working days" */
  detail: string;
  amount: number;
  taxTreatment?: TaxTreatment;
  /** Earnings shown for information and not paid (includedInGross false). */
  informational?: boolean;
}

export interface PayrollBreakdown {
  earnings: PayLine[];
  deductions: PayLine[];
  employer: PayLine[];
  segments: {
    from: string;
    to: string;
    eligibleDays: number;
    revisionId: string | null;
    structureName: string | null;
    monthlyBasic: number;
    monthlyGross: number;
  }[];
}

export interface PayrollLineInput {
  periodStart: string;
  periodEnd: string;
  /** The shift's working days, as stored ("Mon" or "MONDAY"). */
  workingWeekdays: string[];
  salary: PayrollSalary;
  joiningDate: string | null;
  exitDate: string | null;
  attendance: PayrollAttendanceDay[];
  /** Approved leave only — the caller filters by status. */
  leaves: PayrollLeave[];
  adjustments: PayrollAdjustmentInput[];
  /**
   * Overtime is paid only when the payroll policy sets a multiplier. `base`
   * is the policy's choice: BASIC (the default) or COMPONENTS — the earnings
   * marked as part of the overtime base.
   */
  overtime: { multiplier: number | null; hoursPerDay: number | null; base?: 'BASIC' | 'COMPONENTS' };
  /** Phase 4: the compensation in effect across the period. Without it, `salary` stands in. */
  segments?: CompensationSegment[];
  recurring?: RecurringItemInput[];
  recoveries?: RecoveryInput[];
}

export interface PayrollLineResult {
  workingDays: number;
  eligibleDays: number;
  absenceDays: number;
  unpaidLeaveDays: number;
  paidLeaveDays: number;
  paidDays: number;
  unrecordedDays: number;
  prorationFactor: number;
  employedFrom: string;
  employedTo: string;
  dailyRate: number;
  earnedBasic: number;
  earnedAllowances: number;
  overtimeMinutes: number;
  overtimePay: number;
  earningAdjustments: number;
  grossPay: number;
  absenceDeduction: number;
  unpaidLeaveDeduction: number;
  recurringDeductions: number;
  deductionAdjustments: number;
  /** Loan and advance instalments taken this period. */
  loanRecovery: number;
  deductions: number;
  netPay: number;
  /** Employer contribution components (not EOBI / PF, which Phase 3 adds). Never in net pay. */
  otherEmployerContributions: number;
  /** Every earning, deduction and employer contribution, explained. */
  breakdown: PayrollBreakdown;
  /**
   * What the compliance engine needs to classify earnings: the basic's and
   * each other earning's tax treatment, earned this month and at full rate.
   */
  taxBasis: {
    basicTreatment: TaxTreatment;
    month: { amount: number; treatment: TaxTreatment }[];
    monthly: { amount: number; treatment: TaxTreatment }[];
  };
  notes: string[];
}

export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const roundDays = (value: number): number => Math.round(value * 100) / 100;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Every calendar date from `from` to `to`, inclusive, as YYYY-MM-DD. */
export const eachDate = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const cursor = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
};

/** A date filter for the shift's working weekdays. */
export const workingDayFilter = (workingWeekdays: string[]) => {
  const days = new Set(workingWeekdays.map((day) => String(day).slice(0, 3).toLowerCase()));
  return (date: string) => days.has(WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]);
};

const maxDate = (a: string, b: string | null) => (b && b > a ? b.slice(0, 10) : a);
const minDate = (a: string, b: string | null) => (b && b < a ? b.slice(0, 10) : a);

const formatDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export const calculatePayrollLine = (input: PayrollLineInput): PayrollLineResult => {
  const notes: string[] = [];
  const isWorking = workingDayFilter(input.workingWeekdays);

  const workingDates = eachDate(input.periodStart, input.periodEnd).filter(isWorking);
  const employedFrom = maxDate(input.periodStart, input.joiningDate);
  const employedTo = minDate(input.periodEnd, input.exitDate);
  const eligibleDates = employedFrom <= employedTo
    ? workingDates.filter((date) => date >= employedFrom && date <= employedTo)
    : [];
  const eligible = new Set(eligibleDates);

  const workingDays = workingDates.length;
  const eligibleDays = eligibleDates.length;
  const prorationFactor = workingDays > 0 ? eligibleDays / workingDays : 0;

  if (input.joiningDate && input.joiningDate > input.periodStart && input.joiningDate <= input.periodEnd) {
    notes.push(`Joined ${formatDay(input.joiningDate)} — paid for ${eligibleDays} of ${workingDays} working days.`);
  }
  if (input.exitDate && input.exitDate >= input.periodStart && input.exitDate < input.periodEnd) {
    notes.push(`Last working day ${formatDay(input.exitDate)} — paid for ${eligibleDays} of ${workingDays} working days.`);
  }

  // Leave per eligible working day. A request's days are spread over the
  // working days it spans, so a half-day request weighs 0.5 on its one day.
  const paidLeave = new Map<string, number>();
  const unpaidLeave = new Map<string, number>();
  for (const leave of input.leaves) {
    const spanned = eachDate(leave.fromDate, leave.toDate).filter(isWorking);
    if (!spanned.length) continue;
    const weight = Math.min(1, Math.max(0, Number(leave.totalDays) || spanned.length) / spanned.length);
    const bucket = leave.isPaid ? paidLeave : unpaidLeave;
    for (const date of spanned) {
      if (!eligible.has(date)) continue;
      bucket.set(date, Math.min(1, (bucket.get(date) ?? 0) + weight));
    }
  }
  const leaveOn = (date: string) => Math.min(1, (paidLeave.get(date) ?? 0) + (unpaidLeave.get(date) ?? 0));

  // Absence: an Absent or Half Day record, less whatever approved leave
  // already covers that day — leave is never charged twice.
  const recorded = new Set<string>();
  const absentOn = new Map<string, number>();
  let absenceDays = 0;
  let overtimeMinutes = 0;
  for (const day of input.attendance) {
    const date = day.date.slice(0, 10);
    if (date < employedFrom || date > employedTo) continue;
    overtimeMinutes += Math.max(0, Number(day.overtimeMinutes) || 0);
    if (!eligible.has(date)) continue;
    recorded.add(date);
    const missed = day.status === 'ABSENT' ? 1 : day.status === 'HALF_DAY' ? 0.5 : 0;
    const charged = Math.max(0, missed - leaveOn(date));
    if (charged > 0) absentOn.set(date, (absentOn.get(date) ?? 0) + charged);
    absenceDays += charged;
  }

  const unpaidLeaveDays = [...unpaidLeave.values()].reduce((sum, days) => sum + days, 0);
  const paidLeaveDays = [...paidLeave.values()].reduce((sum, days) => sum + days, 0);
  const unrecordedDays = eligibleDates.filter((date) => !recorded.has(date) && leaveOn(date) === 0).length;
  if (unrecordedDays > 0) {
    notes.push(
      `${unrecordedDays} working ${unrecordedDays === 1 ? 'day has' : 'days have'} no attendance record and ${
        unrecordedDays === 1 ? 'was' : 'were'
      } paid.`,
    );
  }

  // ── Compensation, segment by segment ──────────────────────────────────────
  const segments: CompensationSegment[] = input.segments?.length
    ? [...input.segments].sort((a, b) => (a.from < b.from ? -1 : 1))
    : [
        {
          from: input.periodStart,
          to: input.periodEnd,
          revisionId: null,
          structureName: null,
          lines: legacyCompensation(input.salary),
        },
      ];
  const monthly = (lines: CompensationLine[], filter: (line: CompensationLine) => boolean) =>
    lines.filter(filter).reduce((sum, line) => sum + Math.max(0, line.monthlyAmount), 0);
  const isBasic = (line: CompensationLine) => line.type === 'EARNING' && line.category === 'BASIC';
  const inGross = (line: CompensationLine) => line.type === 'EARNING' && line.includedInGross;
  const segmentOf = (date: string) =>
    segments.find((s) => date >= s.from && date <= s.to) ?? segments[segments.length - 1];
  const segmentDays = segments.map((s) => eligibleDates.filter((date) => date >= s.from && date <= s.to).length);
  // The compensation in effect at the end of employment this period — for
  // fixed deductions, the overtime rate and the rest-of-year projection.
  const closing = segmentOf(eligibleDates[eligibleDates.length - 1] ?? input.periodEnd);
  const split = segments.length > 1;
  const daysNote = (days: number) => (days === workingDays ? 'full month' : `${days} of ${workingDays} working days`);

  const earnings: PayLine[] = [];
  const deductionsList: PayLine[] = [];
  const employer: PayLine[] = [];
  const definitionOf = new Map<string, CompensationLine>();

  // Earnings and employer contributions are paid for the days each segment covers.
  const earned = new Map<string, PayLine>();
  segments.forEach((segment, index) => {
    const days = segmentDays[index];
    for (const line of segment.lines) {
      if (line.type === 'DEDUCTION') continue;
      const key = `${line.type}:${line.code}`;
      definitionOf.set(key, line);
      if (!days || !workingDays) continue;
      const amount = (Math.max(0, line.monthlyAmount) * days) / workingDays;
      const part = `${line.explanation || 'Fixed amount'} · ${split ? `${formatDay(segment.from)}–${formatDay(segment.to)}: ` : ''}${daysNote(days)}`;
      const existing = earned.get(key);
      if (existing) {
        existing.amount += amount;
        existing.detail += `; ${part}`;
      } else {
        earned.set(key, {
          code: line.code,
          name: line.name,
          category: line.category,
          source: 'COMPENSATION',
          sourceId: line.componentId,
          method: line.calculationMethod,
          detail: part,
          amount,
          taxTreatment: line.taxTreatment,
          informational: line.type === 'EARNING' && !line.includedInGross,
        });
      }
    }
  });
  for (const [key, line] of earned) {
    line.amount = round2(line.amount);
    (key.startsWith('EARNING:') ? earnings : employer).push(line);
  }
  const isBasicLine = (line: PayLine) => {
    const def = line.source === 'COMPENSATION' ? definitionOf.get(`EARNING:${line.code}`) : undefined;
    return Boolean(def && isBasic(def));
  };
  const earnedBasic = round2(earnings.filter(isBasicLine).reduce((sum, line) => sum + line.amount, 0));
  const componentAllowances = round2(
    earnings.filter((line) => !isBasicLine(line) && !line.informational).reduce((sum, line) => sum + line.amount, 0),
  );

  // Recurring earnings over their own dates, prorated by working days.
  let recurringEarnings = 0;
  const monthlyRecurring: { amount: number; treatment: TaxTreatment }[] = [];
  const baseOf = (lines: CompensationLine[], base: 'BASIC' | 'GROSS' | null) => monthly(lines, base === 'GROSS' ? inGross : isBasic);
  for (const item of (input.recurring ?? []).filter((i) => i.kind === 'EARNING')) {
    if (item.frequency === 'ONE_TIME') {
      if (item.startDate < input.periodStart || item.startDate > input.periodEnd || !eligibleDays) continue;
      const amount = round2(Math.max(0, item.amount));
      if (!amount) continue;
      recurringEarnings += amount;
      earnings.push({ code: null, name: item.name, category: item.category, source: 'RECURRING', sourceId: item.id, method: 'FIXED', detail: 'One-time', amount, taxTreatment: item.taxTreatment });
      continue;
    }
    const from = item.startDate > employedFrom ? item.startDate : employedFrom;
    const to = item.endDate && item.endDate < employedTo ? item.endDate : employedTo;
    let amount = 0;
    const parts: string[] = [];
    segments.forEach((segment) => {
      const days = eligibleDates.filter((d) => d >= from && d <= to && d >= segment.from && d <= segment.to).length;
      if (!days || !workingDays) return;
      const full = item.calculationMethod === 'FIXED' ? item.amount : (item.amount / 100) * baseOf(segment.lines, item.percentageBase);
      amount += (Math.max(0, full) * days) / workingDays;
      parts.push(`${item.calculationMethod === 'PERCENTAGE' ? `${item.amount}% of ${item.percentageBase === 'GROSS' ? 'Gross' : 'Basic'}` : 'Fixed'} · ${daysNote(days)}`);
    });
    amount = round2(amount);
    if (amount <= 0) continue;
    recurringEarnings += amount;
    earnings.push({ code: null, name: item.name, category: item.category, source: 'RECURRING', sourceId: item.id, method: item.calculationMethod, detail: parts.join('; '), amount, taxTreatment: item.taxTreatment });
    if (!item.endDate || item.endDate >= input.periodEnd) {
      monthlyRecurring.push({
        amount: item.calculationMethod === 'FIXED' ? item.amount : (item.amount / 100) * baseOf(closing.lines, item.percentageBase),
        treatment: item.taxTreatment,
      });
    }
  }
  recurringEarnings = round2(recurringEarnings);
  const earnedAllowances = round2(componentAllowances + recurringEarnings);

  // Unpaid days cost the daily rate of the segment they fall in.
  const rateOn = (date: string) =>
    workingDays ? monthly(segmentOf(date).lines, (l) => l.type === 'EARNING' && l.includedInLeaveBase) / workingDays : 0;
  const dailyRate = rateOn(eligibleDates[eligibleDates.length - 1] ?? input.periodEnd);
  const absenceDeduction = round2([...absentOn.entries()].reduce((sum, [date, days]) => sum + rateOn(date) * days, 0));
  const unpaidLeaveDeduction = round2([...unpaidLeave.entries()].reduce((sum, [date, days]) => sum + rateOn(date) * days, 0));
  if (absenceDeduction > 0) {
    deductionsList.push({ code: null, name: 'Unpaid Absence', category: 'ABSENCE', source: 'ATTENDANCE', sourceId: null, method: null, detail: `${roundDays(absenceDays)} day(s) × daily rate`, amount: absenceDeduction });
  }
  if (unpaidLeaveDeduction > 0) {
    deductionsList.push({ code: null, name: 'Unpaid Leave', category: 'UNPAID_LEAVE', source: 'ATTENDANCE', sourceId: null, method: null, detail: `${roundDays(unpaidLeaveDays)} day(s) × daily rate`, amount: unpaidLeaveDeduction });
  }

  // Overtime, at the hourly rate of the base the Payroll policy chose.
  let overtimePay = 0;
  if (overtimeMinutes > 0) {
    const { multiplier, hoursPerDay } = input.overtime;
    if (multiplier && hoursPerDay && workingDays > 0) {
      const componentsBase = input.overtime.base === 'COMPONENTS';
      const base = monthly(closing.lines, componentsBase ? (l) => l.type === 'EARNING' && l.includedInOvertimeBase : isBasic);
      const hourlyRate = base / workingDays / hoursPerDay;
      overtimePay = round2((overtimeMinutes / 60) * hourlyRate * multiplier);
      earnings.push({
        code: null,
        name: 'Overtime',
        category: 'OVERTIME',
        source: 'ATTENDANCE',
        sourceId: null,
        method: null,
        detail: `${Math.round((overtimeMinutes / 60) * 10) / 10} h × ${multiplier} × hourly ${componentsBase ? 'overtime-base' : 'basic'} rate`,
        amount: overtimePay,
        taxTreatment: 'RULE_DEPENDENT',
      });
    } else {
      notes.push(
        `${Math.round((overtimeMinutes / 60) * 10) / 10} overtime hours recorded but not paid — set an overtime multiplier in the Payroll policy to pay them.`,
      );
    }
  }

  // One-off earnings and deductions (adjustments, approved reimbursements).
  const LABELS: Record<string, string> = {
    BONUS: 'Bonus',
    ARREARS: 'Arrears',
    COMMISSION: 'Commission',
    REIMBURSEMENT: 'Reimbursement',
    OTHER: 'One-off Earning',
  };
  for (const adjustment of input.adjustments) {
    const amount = round2(Math.max(0, Number(adjustment.amount) || 0));
    if (!amount) continue;
    (adjustment.type === 'EARNING' ? earnings : deductionsList).push({
      code: null,
      name:
        adjustment.label ||
        (adjustment.type === 'EARNING' ? (LABELS[adjustment.category ?? 'OTHER'] ?? 'One-off Earning') : 'One-off Deduction'),
      category: adjustment.category ?? 'OTHER',
      source: adjustment.source ?? 'ADJUSTMENT',
      sourceId: adjustment.sourceId ?? null,
      method: null,
      detail: adjustment.source === 'REIMBURSEMENT' ? 'Approved reimbursement' : 'Manual adjustment',
      amount,
    });
  }
  const sumOf = (type: PayrollAdjustmentInput['type']) =>
    round2(input.adjustments.filter((a) => a.type === type).reduce((sum, a) => sum + Math.max(0, Number(a.amount) || 0), 0));
  const earningAdjustments = sumOf('EARNING');
  const deductionAdjustments = sumOf('DEDUCTION');

  const grossPay = round2(earnedBasic + earnedAllowances + overtimePay + earningAdjustments);

  // Fixed deductions from the compensation in effect at month end, then the
  // employee's recurring deductions — each within its dates and total.
  let recurringDeductions = 0;
  if (eligibleDays > 0) {
    for (const line of closing.lines.filter((l) => l.type === 'DEDUCTION')) {
      const amount = round2(Math.max(0, line.monthlyAmount));
      if (!amount) continue;
      recurringDeductions += amount;
      deductionsList.push({ code: line.code, name: line.name, category: line.category, source: 'COMPENSATION', sourceId: line.componentId, method: line.calculationMethod, detail: line.explanation || 'Fixed amount', amount });
    }
    for (const item of (input.recurring ?? []).filter((i) => i.kind === 'DEDUCTION')) {
      const active =
        item.frequency === 'ONE_TIME'
          ? item.startDate >= input.periodStart && item.startDate <= input.periodEnd
          : item.startDate <= employedTo && (!item.endDate || item.endDate >= employedFrom);
      if (!active) continue;
      let amount = item.calculationMethod === 'FIXED' ? item.amount : (item.amount / 100) * baseOf(closing.lines, item.percentageBase);
      let detail = item.calculationMethod === 'FIXED' ? 'Fixed' : `${item.amount}% of ${item.percentageBase === 'GROSS' ? 'Gross' : 'Basic'}`;
      if (item.remaining !== null) {
        if (item.remaining <= 0) continue;
        if (amount >= item.remaining) {
          amount = item.remaining;
          detail += ' · final amount';
        }
      }
      amount = round2(Math.max(0, amount));
      if (!amount) continue;
      recurringDeductions += amount;
      deductionsList.push({ code: null, name: item.name, category: item.category, source: 'RECURRING', sourceId: item.id, method: item.calculationMethod, detail, amount });
    }
  }
  recurringDeductions = round2(recurringDeductions);

  // Loan and advance instalments: never past the balance, and never into
  // negative pay — what can't be taken now stays on the balance.
  let loanRecovery = 0;
  let available = Math.max(0, grossPay - absenceDeduction - unpaidLeaveDeduction - recurringDeductions - deductionAdjustments);
  for (const recovery of input.recoveries ?? []) {
    const due = round2(Math.min(recovery.installment, recovery.remaining));
    if (due <= 0 || !eligibleDays) continue;
    const amount = round2(Math.min(due, available));
    if (amount < due) {
      notes.push(
        `${recovery.name}: ${
          amount > 0 ? `only ${amount.toLocaleString('en-US')} of the ${due.toLocaleString('en-US')} instalment is` : `the ${due.toLocaleString('en-US')} instalment isn’t`
        } taken this month — it would make net pay negative. The rest stays on the balance.`,
      );
    }
    if (amount <= 0) continue;
    available -= amount;
    loanRecovery += amount;
    const left = round2(recovery.remaining - amount);
    deductionsList.push({
      code: null,
      name: recovery.name,
      category: recovery.kind,
      source: recovery.kind,
      sourceId: recovery.id,
      method: null,
      detail: left > 0 ? `Instalment · ${left.toLocaleString('en-US')} left after this` : 'Final instalment',
      amount,
    });
  }
  loanRecovery = round2(loanRecovery);

  const otherEmployerContributions = round2(employer.reduce((sum, line) => sum + line.amount, 0));
  const deductions = round2(absenceDeduction + unpaidLeaveDeduction + recurringDeductions + deductionAdjustments + loanRecovery);
  const netPay = round2(grossPay - deductions);
  if (netPay < 0) notes.push('Deductions are more than earnings — net pay is negative.');
  if (split) {
    notes.push(
      `Compensation changed during the period — paid ${segments
        .map((s, i) => `${formatDay(s.from)}–${formatDay(s.to)} (${segmentDays[i]} days)`)
        .join(' and ')} at each rate.`,
    );
  }

  const basicLine = closing.lines.find(isBasic);
  return {
    workingDays,
    eligibleDays,
    absenceDays: roundDays(absenceDays),
    unpaidLeaveDays: roundDays(unpaidLeaveDays),
    paidLeaveDays: roundDays(paidLeaveDays),
    paidDays: roundDays(Math.max(0, eligibleDays - absenceDays - unpaidLeaveDays)),
    unrecordedDays,
    prorationFactor: Math.round(prorationFactor * 1e6) / 1e6,
    employedFrom,
    employedTo,
    dailyRate: round2(dailyRate),
    earnedBasic,
    earnedAllowances,
    overtimeMinutes,
    overtimePay,
    earningAdjustments,
    grossPay,
    absenceDeduction,
    unpaidLeaveDeduction,
    recurringDeductions,
    deductionAdjustments,
    loanRecovery,
    deductions,
    netPay,
    otherEmployerContributions,
    breakdown: {
      earnings,
      deductions: deductionsList,
      employer,
      segments: segments.map((s, i) => ({
        from: s.from,
        to: s.to,
        eligibleDays: segmentDays[i],
        revisionId: s.revisionId,
        structureName: s.structureName,
        monthlyBasic: round2(monthly(s.lines, isBasic)),
        monthlyGross: round2(monthly(s.lines, inGross)),
      })),
    },
    taxBasis: {
      basicTreatment: basicLine?.taxTreatment ?? 'RULE_DEPENDENT',
      month: earnings
        .filter((l) => (l.source === 'COMPENSATION' && !l.informational && !isBasicLine(l)) || l.source === 'RECURRING')
        .map((l) => ({ amount: l.amount, treatment: l.taxTreatment ?? 'RULE_DEPENDENT' })),
      monthly: [
        ...closing.lines.filter((l) => inGross(l) && !isBasic(l)).map((l) => ({ amount: l.monthlyAmount, treatment: l.taxTreatment })),
        ...monthlyRecurring.map((r) => ({ amount: round2(r.amount), treatment: r.treatment })),
      ],
    },
    notes,
  };
};

/**
 * The salary in effect for a period: the latest revision that started on or
 * before its last day. Without revisions (salaries set before history was
 * kept) the employee's current figures stand in.
 */
export const salaryForPeriod = (
  revisions: { effectiveFrom: string; basicSalary: number; allowances: number; recurringDeductions: number }[],
  periodEnd: string,
  fallback: PayrollSalary,
): PayrollSalary => {
  const applicable = revisions
    .filter((revision) => revision.effectiveFrom.slice(0, 10) <= periodEnd)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  return applicable
    ? {
        basicSalary: applicable.basicSalary,
        allowances: applicable.allowances,
        recurringDeductions: applicable.recurringDeductions,
        effectiveFrom: applicable.effectiveFrom.slice(0, 10),
      }
    : fallback;
};

const dayBefore = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The compensation segments across a period, from an employee's revision
 * history. The revision in effect on the first day covers the start; each
 * revision that starts inside the period covers from its date. With no
 * revision before the period, the first one inside it covers the start too —
 * the same salary Phase 1 would have used for the whole month.
 */
export const compensationSegments = (
  revisions: { id: string; effectiveFrom: string; structureName?: string | null; lines: CompensationLine[] }[],
  periodStart: string,
  periodEnd: string,
): CompensationSegment[] => {
  const ordered = revisions
    .filter((r) => r.effectiveFrom.slice(0, 10) <= periodEnd)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  if (!ordered.length) return [];
  const opening = [...ordered].reverse().find((r) => r.effectiveFrom.slice(0, 10) <= periodStart);
  const inside = ordered.filter((r) => r.effectiveFrom.slice(0, 10) > periodStart);
  const starts = [...(opening ? [{ ...opening, from: periodStart }] : []), ...inside.map((r) => ({ ...r, from: r.effectiveFrom.slice(0, 10) }))];
  if (!opening) starts[0] = { ...starts[0], from: periodStart };
  return starts.map((r, index) => ({
    from: r.from,
    to: index + 1 < starts.length ? dayBefore(starts[index + 1].from) : periodEnd,
    revisionId: r.id,
    structureName: r.structureName ?? null,
    lines: r.lines,
  }));
};

/** "2026-09" → the first and last day of that month. */
export const monthBounds = (month: string): { periodStart: string; periodEnd: string } => {
  const [year, mon] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    periodStart: `${month}-01`,
    periodEnd: `${month}-${String(last).padStart(2, '0')}`,
  };
};
