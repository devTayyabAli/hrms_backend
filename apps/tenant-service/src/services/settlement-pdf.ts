import PDFDocument = require('pdfkit');
import type { PayslipOrganization } from './payslip-document';

/**
 * Draws a final settlement statement as an A4 PDF. Input is the finished
 * document: this only lays it out and never works anything out. Like the
 * payslip it uses the PDF standard fonts, so nothing is bundled.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 44;
const CONTENT = A4.width - MARGIN * 2;

const INK = '#0f172a';
const MUTED = '#64748b';
const RULE = '#e2e8f0';
const BRAND = '#1d4ed8';
const SOFT = '#f1f5f9';
const DANGER = '#b91c1c';
const GOOD = '#15803d';

export interface SettlementLineView {
  label: string;
  type: 'EARNING' | 'DEDUCTION';
  amount: number;
  category?: string | null;
}

export interface SettlementDocument {
  organization: PayslipOrganization;
  currency: string | null;
  status: string;
  generatedAt: string;
  payrollPeriod: string;
  lastWorkingDay: string | null;
  employee: {
    name: string;
    employeeCode: string | null;
    designation: string | null;
    department: string | null;
    joiningDate: string | null;
  };
  lines: SettlementLineView[];
  totals: { earnings: number; deductions: number; net: number };
  approval: { statusText: string; workflow: { title: string; description: string; status: string; at?: string }[] } | null;
  preparedBy: string | null;
  decidedBy: string | null;
  paidAt: string | null;
}

export interface SettlementRenderOptions {
  logo?: Buffer | null;
  /** Off only for tests that read the text back out. */
  compress?: boolean;
}

const money = (value: number, currency: string | null) => {
  const plain = Number(value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${plain}` : plain;
};

const day = (iso: string | null | undefined) =>
  iso
    ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '—';

const monthLabel = (period: string) =>
  /^\d{4}-\d{2}$/.test(period) ? new Date(`${period}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : period;

const isEmbeddable = (bytes: Buffer | null | undefined) =>
  Boolean(bytes && bytes.length > 8 && ((bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) || (bytes[0] === 0xff && bytes[1] === 0xd8)));

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft — not yet sent for approval',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
};

export const renderSettlementPdf = (settlement: SettlementDocument, options: SettlementRenderOptions = {}): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      compress: options.compress ?? true,
      info: {
        Title: `Final settlement — ${settlement.employee.name}`,
        Author: settlement.organization.name,
        Subject: `Final settlement for ${settlement.employee.name}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc, settlement, options);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });

function draw(doc: PDFKit.PDFDocument, s: SettlementDocument, options: SettlementRenderOptions) {
  const cur = s.currency;
  let y = MARGIN;

  // ── Header ────────────────────────────────────────────────────────────────
  if (isEmbeddable(options.logo)) {
    try {
      doc.image(options.logo as Buffer, A4.width / 2 - 60, y, { fit: [120, 44], align: 'center', valign: 'center' });
      y += 52;
    } catch {
      // A logo that will not decode is decoration: carry on with the text header.
    }
  }
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(s.organization.name, MARGIN, y, { width: CONTENT, align: 'center' });
  y = doc.y + 2;
  const contact = [s.organization.address, s.organization.phone, s.organization.email, s.organization.website].filter(Boolean).join('  ·  ');
  if (contact) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(contact, MARGIN, y, { width: CONTENT, align: 'center' });
    y = doc.y;
  }
  y += 10;
  doc.rect(MARGIN, y, CONTENT, 2).fill(BRAND);
  y += 14;

  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('FINAL SETTLEMENT', MARGIN, y, { width: CONTENT / 2 });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`Paid with the ${monthLabel(s.payrollPeriod)} payroll`, MARGIN, y + 17, { width: CONTENT / 2 });
  const statusColor = s.status === 'PAID' || s.status === 'APPROVED' ? GOOD : s.status === 'CANCELLED' ? DANGER : MUTED;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(statusColor).text(STATUS_LABELS[s.status] ?? s.status, MARGIN + CONTENT / 2, y + 2, { width: CONTENT / 2, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`Issued ${day(s.generatedAt)}`, MARGIN + CONTENT / 2, y + 17, { width: CONTENT / 2, align: 'right' });
  y += 42;

  // ── Employee ──────────────────────────────────────────────────────────────
  const infoTop = y;
  const ROW = 27;
  doc.roundedRect(MARGIN, infoTop, CONTENT, ROW * 3 + 18, 6).fill(SOFT);
  const left: [string, string][] = [
    ['Employee', s.employee.name],
    ['Employee ID', s.employee.employeeCode || '—'],
    ['Designation', s.employee.designation ?? '—'],
  ];
  const right: [string, string][] = [
    ['Department', s.employee.department ?? '—'],
    ['Joined', day(s.employee.joiningDate)],
    ['Last working day', day(s.lastWorkingDay)],
  ];
  const col = (rows: [string, string][], x: number) => {
    rows.forEach(([label, value], i) => {
      const rowY = infoTop + 11 + i * ROW;
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, rowY, { width: CONTENT / 2 - 24, characterSpacing: 0.3 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(value, x, rowY + 10, { width: CONTENT / 2 - 24, ellipsis: true, lineBreak: false });
    });
  };
  col(left, MARGIN + 14);
  col(right, MARGIN + CONTENT / 2 + 8);
  y = infoTop + ROW * 3 + 34;

  // ── Lines ─────────────────────────────────────────────────────────────────
  const table = (title: string, lines: SettlementLineView[], total: number, color: string) => {
    if (y > A4.height - 140) {
      doc.addPage();
      y = MARGIN;
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(color).text(title.toUpperCase(), MARGIN, y, { width: CONTENT, characterSpacing: 0.4 });
    y += 16;
    doc.rect(MARGIN, y, CONTENT, 0.7).fill(RULE);
    y += 6;
    if (!lines.length) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text('None', MARGIN, y, { width: CONTENT });
      y = doc.y + 8;
    }
    for (const line of lines) {
      if (y > A4.height - 90) {
        doc.addPage();
        y = MARGIN;
      }
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(line.label, MARGIN, y, { width: CONTENT - 130 });
      const bottom = doc.y;
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(money(line.amount, cur), MARGIN + CONTENT - 120, y, { width: 120, align: 'right' });
      y = Math.max(bottom, y + 12) + 5;
    }
    doc.rect(MARGIN, y, CONTENT, 0.7).fill(RULE);
    y += 6;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(`Total ${title.toLowerCase()}`, MARGIN, y, { width: CONTENT - 130 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(money(total, cur), MARGIN + CONTENT - 120, y, { width: 120, align: 'right' });
    y += 26;
  };
  table('Earnings', s.lines.filter((line) => line.type === 'EARNING'), s.totals.earnings, GOOD);
  table('Deductions', s.lines.filter((line) => line.type === 'DEDUCTION'), s.totals.deductions, DANGER);

  // ── Net ───────────────────────────────────────────────────────────────────
  if (y > A4.height - 170) {
    doc.addPage();
    y = MARGIN;
  }
  const owed = s.totals.net >= 0;
  doc.roundedRect(MARGIN, y, CONTENT, 44, 6).fill(owed ? '#eff6ff' : '#fef2f2');
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(owed ? 'NET PAYABLE TO EMPLOYEE' : 'NET RECOVERABLE FROM EMPLOYEE', MARGIN + 14, y + 15, { width: CONTENT / 2 });
  doc.font('Helvetica-Bold').fontSize(14).fillColor(owed ? BRAND : DANGER).text(money(Math.abs(s.totals.net), cur), MARGIN + CONTENT / 2, y + 13, { width: CONTENT / 2 - 14, align: 'right' });
  y += 62;

  // ── Approval trail ────────────────────────────────────────────────────────
  if (s.approval) {
    if (y > A4.height - 150) {
      doc.addPage();
      y = MARGIN;
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('APPROVAL', MARGIN, y, { width: CONTENT, characterSpacing: 0.4 });
    y += 15;
    for (const step of s.approval.workflow) {
      if (y > A4.height - 80) {
        doc.addPage();
        y = MARGIN;
      }
      const when = step.at ? `  ·  ${day(step.at)}` : '';
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(`${step.title}${when}`, MARGIN, y, { width: CONTENT });
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(step.description, MARGIN, doc.y, { width: CONTENT });
      y = doc.y + 5;
    }
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(INK).text(s.approval.statusText, MARGIN, y, { width: CONTENT });
    y = doc.y + 14;
  }

  // ── Signatures ────────────────────────────────────────────────────────────
  if (y > A4.height - 110) {
    doc.addPage();
    y = MARGIN;
  }
  const signY = Math.max(y + 24, A4.height - 120);
  const half = CONTENT / 2 - 20;
  doc.rect(MARGIN, signY, half, 0.7).fill(INK);
  doc.rect(MARGIN + CONTENT / 2 + 20, signY, half, 0.7).fill(INK);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Employee signature', MARGIN, signY + 5, { width: half });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Authorised signatory', MARGIN + CONTENT / 2 + 20, signY + 5, { width: half });

  const footer = [s.preparedBy ? `Prepared by ${s.preparedBy}` : null, s.decidedBy ? `Approved by ${s.decidedBy}` : null, s.paidAt ? `Paid ${day(s.paidAt)}` : null].filter(Boolean).join('  ·  ');
  if (footer) doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(footer, MARGIN, A4.height - 52, { width: CONTENT, align: 'center' });
}
