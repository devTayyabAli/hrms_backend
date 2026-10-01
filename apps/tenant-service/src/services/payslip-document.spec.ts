import {
  buildPayslipDocument,
  formatPayslipNumber,
  isSnapshotComplete,
  maskAccount,
  type PayslipSource,
} from './payslip-document';
import { renderPayslipPdf } from './payslip-pdf';

const source = (over: Partial<PayslipSource> = {}): PayslipSource => ({
  payslip: { id: 'p1', payslipNumber: 'PS-2026-09-000001', generatedAt: '2026-10-05T10:00:00Z' },
  run: { periodStart: '2026-09-01', periodEnd: '2026-09-30', currency: 'PKR', paymentDate: '2026-10-01', paymentReference: 'HBL 12' },
  record: {
    basicSalary: '100000',
    allowances: '20000',
    workingDays: '26',
    eligibleDays: '26',
    paidDays: '25',
    absenceDays: '1',
    unpaidLeaveDays: '0',
    paidLeaveDays: '2',
    prorationFactor: '1',
    earnedBasic: '100000',
    earnedAllowances: '20000',
    overtimePay: '0',
    overtimeMinutes: 0,
    absenceDeduction: '4615.38',
    unpaidLeaveDeduction: '0',
    recurringDeductions: '5000',
    grossPay: '125000',
    deductions: '9615.38',
    netPay: '115384.62',
    bankName: 'HBL',
    bankAccountNumber: '0123-4567890-01',
  },
  adjustments: [{ type: 'EARNING', amount: '5000', reason: 'Performance bonus' }],
  employee: { firstName: 'Ayesha', lastName: 'Khan', employeeCode: 'EMP001', employmentType: 'PERMANENT', designation: { title: 'Engineer' }, department: { name: 'Engineering' } },
  organization: { name: 'Silicon Nexus', address: 'Lahore', phone: null, email: null, website: null, logoUrl: null },
  ...over,
});

/** The text a PDF draws — pdfkit writes each run of glyphs as hex in a TJ array. */
const pdfText = (bytes: Buffer) =>
  [...bytes.toString('latin1').matchAll(/\[(.*?)\]\s*TJ/g)]
    .map(([, inner]) => [...inner.matchAll(/<([0-9a-f]+)>/gi)].map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')).join(''))
    .join('\n');

describe('buildPayslipDocument', () => {
  it('takes every amount from the payroll snapshot, and its totals as stored', () => {
    const doc = buildPayslipDocument(source());
    expect(doc.earnings).toEqual([
      { label: 'Basic Salary', amount: 100_000 },
      { label: 'Allowances', amount: 20_000 },
      { label: 'One-off Earning', amount: 5_000, note: 'Performance bonus' },
    ]);
    expect(doc.deductions.map((d) => [d.label, d.amount])).toEqual([
      ['Unpaid Absence', 4_615.38],
      ['Recurring Deductions', 5_000],
    ]);
    // A line from before compliance: all of its deduction is the normal kind.
    expect(doc.totals).toEqual({
      gross: 125_000,
      normalDeductions: 9_615.38,
      statutoryDeductions: 0,
      deductions: 9_615.38,
      net: 115_384.62,
      employerContributions: 0,
    });
    expect(doc.statutoryDeductions).toEqual([]);
    expect(doc.employerContributions).toEqual([]);
    expect(doc.attendance).toEqual(expect.objectContaining({ workingDays: 26, paidDays: 25, unpaidDays: 1, proration: null }));
  });

  it('shows statutory deductions and employer contributions from the compliance columns', () => {
    const doc = buildPayslipDocument(
      source({
        record: {
          ...source().record,
          complianceSnapshot: { version: 1 },
          taxYear: 2027,
          normalDeductions: '9615.38',
          incomeTax: '4250',
          eobiEmployee: '370',
          eobiEmployer: '1850',
          pfEmployee: '0',
          pfEmployer: '0',
          statutoryDeductions: '4620',
          employerContributions: '1850',
          deductions: '14235.38',
          netPay: '110764.62',
        },
        adjustments: [{ type: 'EARNING', amount: '5000', reason: 'Q3', category: 'BONUS' }],
      }),
    );
    expect(doc.earnings[doc.earnings.length - 1]).toEqual({ label: 'Bonus', amount: 5_000, note: 'Q3' });
    expect(doc.statutoryDeductions.map((d) => [d.label, d.amount])).toEqual([
      ['Income Tax', 4_250],
      ['EOBI (Employee)', 370],
    ]);
    expect(doc.employerContributions).toEqual([{ label: 'EOBI (Employer)', amount: 1_850 }]);
    expect(doc.taxYear).toBe(2027);
    expect(doc.totals).toEqual({
      gross: 125_000,
      normalDeductions: 9_615.38,
      statutoryDeductions: 4_620,
      deductions: 14_235.38,
      // Employer contributions never reach net pay.
      net: 110_764.62,
      employerContributions: 1_850,
    });
  });

  it('shows proration when the person joined or left in the period', () => {
    const doc = buildPayslipDocument(
      source({ record: { ...source().record, prorationFactor: '0.538462', eligibleDays: '14', employedFrom: '2026-09-15', employedTo: '2026-09-30' } }),
    );
    expect(doc.attendance.proration).toEqual({ from: '2026-09-15', to: '2026-09-30', eligibleDays: 14 });
  });

  it('never carries a full account number', () => {
    const doc = buildPayslipDocument(source());
    expect(doc.bank).toEqual({ bankName: 'HBL', account: '**** **** 9001' });
    expect(JSON.stringify(doc)).not.toContain('4567890');
  });
});

describe('payslip helpers', () => {
  it('numbers payslips by period and a zero-padded sequence', () => {
    expect(formatPayslipNumber('2026-09-01', 123)).toBe('PS-2026-09-000123');
  });

  it('masks to the last four characters', () => {
    expect(maskAccount('PK36SCBL0000001123456702')).toBe('**** **** 6702');
    expect(maskAccount('')).toBeNull();
  });

  it('treats a line without working days as a missing snapshot', () => {
    expect(isSnapshotComplete({ workingDays: '26', eligibleDays: '26' })).toBe(true);
    expect(isSnapshotComplete({ workingDays: '0', eligibleDays: '0' })).toBe(false);
  });
});

describe('renderPayslipPdf', () => {
  it('produces an A4 PDF with the payslip on it', async () => {
    const bytes = await renderPayslipPdf(buildPayslipDocument(source()), { compress: false });
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/);
    const text = pdfText(bytes);
    for (const expected of ['Silicon Nexus', 'PS-2026-09-000001', 'Ayesha Khan', 'NET PAY', 'PKR 115,384.62', '**** **** 9001']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('4567890');
  });

  it('prints the statutory and employer sections when the line has them', async () => {
    const record = {
      ...source().record,
      complianceSnapshot: { version: 1 },
      taxYear: 2027,
      normalDeductions: '9615.38',
      incomeTax: '4250',
      eobiEmployee: '370',
      eobiEmployer: '1850',
      statutoryDeductions: '4620',
      employerContributions: '1850',
      deductions: '14235.38',
      netPay: '110764.62',
    };
    const text = pdfText(await renderPayslipPdf(buildPayslipDocument(source({ record })), { compress: false }));
    for (const expected of ['STATUTORY DEDUCTIONS', 'Income Tax', 'EOBI (Employee)', 'EMPLOYER CONTRIBUTIONS', 'EOBI (Employer)', 'PKR 14,235.38', 'PKR 110,764.62']) {
      expect(text).toContain(expected);
    }
  });

  it('falls back to a text header when the logo isn’t a PNG or JPEG', async () => {
    const bytes = await renderPayslipPdf(buildPayslipDocument(source()), { logo: Buffer.from('<svg/>'), compress: false });
    expect(pdfText(bytes)).toContain('Silicon Nexus');
  });
});
