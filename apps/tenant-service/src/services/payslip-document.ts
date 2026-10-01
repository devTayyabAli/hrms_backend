/**
 * What a payslip says, built from the locked payroll snapshot and nothing
 * else. There is no arithmetic here beyond labelling the stored figures: the
 * amounts are the payroll line's own, so a payslip always matches the payroll
 * it came from — whatever the employee's salary is today.
 *
 * Used for the on-screen payslip and the PDF alike, so the two can't differ.
 */

export interface PayslipLine {
  label: string;
  amount: number;
  /** "2 days", "Performance bonus" — context shown under the label. */
  note?: string;
}

export interface PayslipOrganization {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoUrl: string | null;
}

export interface PayslipDocument {
  payslipId: string;
  payslipNumber: string;
  generatedAt: string;
  currency: string | null;
  organization: PayslipOrganization;
  period: { label: string; start: string; end: string };
  employee: {
    name: string;
    employeeCode: string;
    designation: string | null;
    department: string | null;
    employmentType: string | null;
  };
  attendance: {
    workingDays: number;
    paidDays: number;
    unpaidDays: number;
    absenceDays: number;
    unpaidLeaveDays: number;
    paidLeaveDays: number;
    /** Set when the person joined or left during the period. */
    proration: { from: string; to: string; eligibleDays: number } | null;
  };
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  /** Income tax, EOBI and provident fund taken from pay. Empty before compliance existed. */
  statutoryDeductions: PayslipLine[];
  /**
   * What the employer pays on top (EOBI, provident fund) — shown for
   * information only; it is not part of gross, deductions or net.
   */
  employerContributions: PayslipLine[];
  /** Pakistan tax year the month falls in, when compliance ran. */
  taxYear: number | null;
  /**
   * `deductions` is everything taken from pay: normal plus statutory. The
   * two parts are given separately so the payslip can subtotal each.
   */
  totals: { gross: number; normalDeductions: number; statutoryDeductions: number; deductions: number; net: number; employerContributions: number };
  payment: { status: 'PAID'; date: string | null; reference: string | null };
  /** Masked — never the full account number. */
  bank: { bankName: string | null; account: string | null } | null;
}

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const dayCount = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)} ${value === 1 ? 'day' : 'days'}`;

/**
 * A line from before payroll kept its calculation (Phase 1) has no working
 * days on it. Its totals can't be broken down honestly, so it gets no payslip
 * rather than one re-derived from today's salary.
 */
export const isSnapshotComplete = (record: { workingDays?: unknown; eligibleDays?: unknown }) =>
  Number(record.workingDays) > 0 && Number(record.eligibleDays) > 0;

/** "0123-4567890-01" → "**** **** 9001": the last four characters, separators ignored. */
export const maskAccount = (value: string | null | undefined): string | null => {
  const compact = String(value ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (!compact) return null;
  return `**** **** ${compact.slice(-4)}`;
};

/** PS-2026-09-000123 — the period's month, then the organization-wide sequence. */
export const formatPayslipNumber = (periodStart: string, sequence: number) =>
  `PS-${String(periodStart).slice(0, 4)}-${String(periodStart).slice(5, 7)}-${String(sequence).padStart(6, '0')}`;

export const periodLabel = (periodStart: string) =>
  new Date(`${String(periodStart).slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const EMPLOYMENT_TYPES: Record<string, string> = {
  PERMANENT: 'Permanent',
  PROBATION: 'Probation',
  CONTRACT: 'Contract',
  INTERNSHIP: 'Internship',
  PART_TIME: 'Part-time',
  CONSULTANT: 'Consultant',
  TEMPORARY: 'Temporary',
};

const EARNING_LABELS: Record<string, string> = {
  BONUS: 'Bonus',
  ARREARS: 'Arrears',
  COMMISSION: 'Commission',
  REIMBURSEMENT: 'Reimbursement',
  OTHER: 'One-off Earning',
};

export interface PayslipSource {
  payslip: { id: string; payslipNumber: string; generatedAt: Date | string };
  run: { periodStart: string; periodEnd: string; currency?: string | null; paymentDate?: string | null; paymentReference?: string | null };
  record: Record<string, any>;
  adjustments: { type: string; amount: unknown; reason: string; category?: string | null }[];
  employee: {
    firstName?: string;
    lastName?: string;
    employeeCode?: string;
    employmentType?: string | null;
    designation?: { title?: string } | null;
    department?: { name?: string } | null;
  } | null;
  organization: PayslipOrganization;
}

/** A breakdown line's note on the payslip: why the amount is what it is, briefly. */
const breakdownNote = (line: any): string | undefined => {
  if (line.source === 'ADJUSTMENT') return line.detail || undefined;
  if (line.source === 'COMPENSATION' || line.source === 'RECURRING') {
    // "20% of Basic (150,000) · 13 of 26 working days" → only the proration part.
    const parts = String(line.detail ?? '')
      .split(';')
      .map((part) => part.split('·').pop()!.trim())
      .filter((part) => part && part !== 'full month');
    return parts.length ? parts.join('; ') : undefined;
  }
  return line.detail || undefined;
};

const buildBaseDocument = (source: PayslipSource): PayslipDocument => {
  const { record, run } = source;
  const absenceDays = num(record.absenceDays);
  const unpaidLeaveDays = num(record.unpaidLeaveDays);
  const workingDays = num(record.workingDays);
  const eligibleDays = num(record.eligibleDays);

  const earnings: PayslipLine[] = [
    { label: 'Basic Salary', amount: num(record.earnedBasic) },
    { label: 'Allowances', amount: num(record.earnedAllowances) },
  ];
  if (num(record.overtimePay) > 0) {
    const hours = Math.round((Number(record.overtimeMinutes ?? 0) / 60) * 10) / 10;
    earnings.push({ label: 'Overtime', amount: num(record.overtimePay), note: `${hours} hours` });
  }
  for (const adjustment of source.adjustments.filter((a) => a.type === 'EARNING')) {
    earnings.push({
      label: EARNING_LABELS[String(adjustment.category ?? 'OTHER')] ?? 'One-off Earning',
      amount: num(adjustment.amount),
      note: adjustment.reason,
    });
  }

  const deductions: PayslipLine[] = [];
  if (num(record.absenceDeduction) > 0) {
    deductions.push({ label: 'Unpaid Absence', amount: num(record.absenceDeduction), note: dayCount(absenceDays) });
  }
  if (num(record.unpaidLeaveDeduction) > 0) {
    deductions.push({ label: 'Unpaid Leave', amount: num(record.unpaidLeaveDeduction), note: dayCount(unpaidLeaveDays) });
  }
  if (num(record.recurringDeductions) > 0) {
    deductions.push({ label: 'Recurring Deductions', amount: num(record.recurringDeductions) });
  }
  for (const adjustment of source.adjustments.filter((a) => a.type === 'DEDUCTION')) {
    deductions.push({ label: 'One-off Deduction', amount: num(adjustment.amount), note: adjustment.reason });
  }

  // Statutory lines come only from the line's compliance snapshot columns.
  const hasCompliance = Boolean(record.complianceSnapshot);
  const statutoryDeductions: PayslipLine[] = [];
  const employerContributions: PayslipLine[] = [];
  if (hasCompliance) {
    const taxYear = record.taxYear ? `Tax year ${record.taxYear}` : undefined;
    if (num(record.incomeTax) > 0) statutoryDeductions.push({ label: 'Income Tax', amount: num(record.incomeTax), note: taxYear });
    if (num(record.eobiEmployee) > 0) statutoryDeductions.push({ label: 'EOBI (Employee)', amount: num(record.eobiEmployee) });
    if (num(record.pfEmployee) > 0) statutoryDeductions.push({ label: 'Provident Fund (Employee)', amount: num(record.pfEmployee) });
    if (num(record.eobiEmployer) > 0) employerContributions.push({ label: 'EOBI (Employer)', amount: num(record.eobiEmployer) });
    if (num(record.pfEmployer) > 0) employerContributions.push({ label: 'Provident Fund (Employer)', amount: num(record.pfEmployer) });
  }
  const statutoryTotal = hasCompliance ? num(record.statutoryDeductions) : 0;

  const prorated = Number(record.prorationFactor ?? 1) < 1 && record.employedFrom && record.employedTo;
  const account = maskAccount(record.bankAccountNumber) ?? maskAccount(record.iban);

  return {
    payslipId: source.payslip.id,
    payslipNumber: source.payslip.payslipNumber,
    generatedAt: new Date(source.payslip.generatedAt).toISOString(),
    currency: run.currency ?? null,
    organization: source.organization,
    period: { label: periodLabel(run.periodStart), start: String(run.periodStart).slice(0, 10), end: String(run.periodEnd).slice(0, 10) },
    employee: {
      name: [source.employee?.firstName, source.employee?.lastName].filter(Boolean).join(' ') || 'Employee',
      employeeCode: source.employee?.employeeCode ?? '',
      designation: source.employee?.designation?.title ?? null,
      department: source.employee?.department?.name ?? null,
      employmentType: source.employee?.employmentType ? (EMPLOYMENT_TYPES[source.employee.employmentType] ?? null) : null,
    },
    attendance: {
      workingDays,
      paidDays: num(record.paidDays),
      unpaidDays: Math.round((absenceDays + unpaidLeaveDays) * 100) / 100,
      absenceDays,
      unpaidLeaveDays,
      paidLeaveDays: num(record.paidLeaveDays),
      proration: prorated
        ? { from: String(record.employedFrom).slice(0, 10), to: String(record.employedTo).slice(0, 10), eligibleDays }
        : null,
    },
    earnings,
    deductions,
    statutoryDeductions,
    employerContributions,
    taxYear: hasCompliance && record.taxYear ? Number(record.taxYear) : null,
    // The line's stored totals — the source of truth, never re-summed.
    totals: {
      gross: num(record.grossPay),
      normalDeductions: hasCompliance ? num(record.normalDeductions) : num(record.deductions),
      statutoryDeductions: statutoryTotal,
      deductions: num(record.deductions),
      net: num(record.netPay),
      employerContributions: hasCompliance || record.components ? num(record.employerContributions) : 0,
    },
    payment: { status: 'PAID', date: run.paymentDate ? String(run.paymentDate).slice(0, 10) : null, reference: run.paymentReference ?? null },
    bank: record.bankName || account ? { bankName: record.bankName ?? null, account } : null,
  };
};

/**
 * The payslip for a line. A line calculated with components (Phase 4)
 * lists each earning, deduction and employer contribution from its stored
 * breakdown; an earlier line keeps its Phase 1–3 layout.
 */
export const buildPayslipDocument = (source: PayslipSource): PayslipDocument => {
  const base = buildBaseDocument(source);
  const breakdown = source.record.components;
  if (!breakdown?.earnings) return base;
  const toLine = (line: any): PayslipLine => {
    const note = breakdownNote(line);
    return { label: String(line.name), amount: num(line.amount), ...(note ? { note } : {}) };
  };
  return {
    ...base,
    earnings: (breakdown.earnings as any[]).filter((line) => !line.informational && num(line.amount) > 0).map(toLine),
    deductions: ((breakdown.deductions ?? []) as any[]).filter((line) => num(line.amount) > 0).map(toLine),
    employerContributions: [
      ...base.employerContributions,
      ...((breakdown.employer ?? []) as any[]).filter((line) => num(line.amount) > 0).map(toLine),
    ],
  };
};
