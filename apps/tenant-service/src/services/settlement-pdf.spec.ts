import { SettlementDocument, renderSettlementPdf } from './settlement-pdf';

const document = (over: Partial<SettlementDocument> = {}): SettlementDocument => ({
  organization: { name: 'TechNova', address: 'Lahore', phone: null, email: 'hr@technova.com', website: null, logoUrl: null },
  currency: 'PKR',
  status: 'APPROVED',
  generatedAt: '2027-01-05T10:00:00Z',
  payrollPeriod: '2026-12',
  lastWorkingDay: '2026-12-15',
  employee: { name: 'Anna Khan', employeeCode: 'E-1', designation: 'Engineer', department: 'Engineering', joiningDate: '2023-02-01' },
  lines: [
    { label: 'Annual Leave: 14 unused days', type: 'EARNING', amount: 42000, category: 'ALLOWANCE' },
    { label: 'Advance balance', type: 'DEDUCTION', amount: 12000 },
  ],
  totals: { earnings: 42000, deductions: 12000, net: 30000 },
  approval: { statusText: 'Approved by Finance.', workflow: [{ title: 'Request submitted', description: 'Submitted by HR', status: 'COMPLETED', at: '2026-12-16T09:00:00Z' }] },
  preparedBy: 'hr@x.com',
  decidedBy: 'fin@x.com',
  paidAt: null,
  ...over,
});

/** The text a PDF draws: pdfkit writes each run of glyphs as hex in a TJ array. */
const pdfText = (bytes: Buffer) =>
  [...bytes.toString('latin1').matchAll(/\[(.*?)\]\s*TJ/g)]
    .map(([, inner]) => [...inner.matchAll(/<([0-9a-f]+)>/gi)].map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')).join(''))
    .join(' ');

const text = async (over: Partial<SettlementDocument> = {}) => pdfText(await renderSettlementPdf(document(over), { compress: false }));

describe('renderSettlementPdf', () => {
  it('draws a PDF', async () => {
    const bytes = await renderSettlementPdf(document());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('shows who it is for, what is owed and by whom, and the net', async () => {
    const out = await text();
    for (const expected of ['FINAL SETTLEMENT', 'TechNova', 'Anna Khan', 'Engineer', 'Annual Leave: 14 unused days', 'Advance balance', 'PKR 42,000.00', 'PKR 12,000.00', 'NET PAYABLE TO EMPLOYEE', 'PKR 30,000.00', 'Approved by Finance.']) {
      expect(out).toContain(expected);
    }
  });

  it('says so when it is a draft, and shows a negative net as an amount to recover', async () => {
    expect(await text({ status: 'DRAFT', approval: null })).toContain('Draft');
    const out = await text({ totals: { earnings: 1000, deductions: 4000, net: -3000 } });
    expect(out).toContain('NET RECOVERABLE FROM EMPLOYEE');
    expect(out).toContain('PKR 3,000.00');
  });

  it('copes with no lines and a long list of them', async () => {
    expect(await text({ lines: [], totals: { earnings: 0, deductions: 0, net: 0 } })).toContain('None');
    const many = Array.from({ length: 80 }, (_, i) => ({ label: `Manual item ${i + 1}`, type: 'EARNING' as const, amount: 100 + i }));
    const out = await text({ lines: many });
    expect(out).toContain('Manual item 80');
  });
});
