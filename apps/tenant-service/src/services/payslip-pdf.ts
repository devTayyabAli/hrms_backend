import PDFDocument = require('pdfkit');
import type { PayslipDocument, PayslipLine } from './payslip-document';

/**
 * Draws a payslip as an A4 PDF. Input is the finished PayslipDocument — this
 * only lays it out, it never works anything out.
 *
 * Uses the PDF standard fonts (Helvetica), so there is nothing to bundle and
 * the file stays small enough to email. Those fonts cover Latin script; names
 * in other scripts need an embedded font, which can come later.
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

export interface RenderOptions {
  /** PNG or JPEG bytes of the organization's logo. */
  logo?: Buffer | null;
  /** Off only for tests that read the text back out. */
  compress?: boolean;
}

const money = (value: number, currency: string | null) => {
  const plain = Number(value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${plain}` : plain;
};

const day = (iso: string | null) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '—';

const days = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** Only PNG and JPEG can be embedded; anything else falls back to a text header. */
const isEmbeddable = (bytes: Buffer | null | undefined) =>
  Boolean(
    bytes &&
      bytes.length > 8 &&
      ((bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) || (bytes[0] === 0xff && bytes[1] === 0xd8)),
  );

export const renderPayslipPdf = (payslip: PayslipDocument, options: RenderOptions = {}): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      compress: options.compress ?? true,
      info: {
        Title: `Payslip ${payslip.payslipNumber} — ${payslip.period.label}`,
        Author: payslip.organization.name,
        Subject: `Payslip for ${payslip.employee.name}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      draw(doc, payslip, options);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });

function draw(doc: PDFKit.PDFDocument, p: PayslipDocument, options: RenderOptions) {
  const cur = p.currency;
  let y = MARGIN;

  // ── Header: logo (or none), organization, contact ─────────────────────────
  if (isEmbeddable(options.logo)) {
    try {
      doc.image(options.logo as Buffer, A4.width / 2 - 60, y, { fit: [120, 44], align: 'center', valign: 'center' });
      y += 52;
    } catch {
      // A logo that won't decode is decoration — carry on with the text header.
    }
  }
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(p.organization.name, MARGIN, y, { width: CONTENT, align: 'center' });
  y = doc.y + 2;
  const contact = [p.organization.address, p.organization.phone, p.organization.email, p.organization.website].filter(Boolean).join('  ·  ');
  if (contact) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(contact, MARGIN, y, { width: CONTENT, align: 'center' });
    y = doc.y;
  }
  y += 10;
  doc.rect(MARGIN, y, CONTENT, 2).fill(BRAND);
  y += 14;

  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('PAYSLIP', MARGIN, y, { width: CONTENT / 2 });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(p.period.label, MARGIN, y + 17, { width: CONTENT / 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Payslip No.', MARGIN + CONTENT / 2, y, { width: CONTENT / 2, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(p.payslipNumber, MARGIN + CONTENT / 2, y + 12, { width: CONTENT / 2, align: 'right' });
  y += 40;

  // ── Employee ──────────────────────────────────────────────────────────────
  const infoTop = y;
  const ROW = 27;
  doc.roundedRect(MARGIN, infoTop, CONTENT, ROW * 3 + 18, 6).fill(SOFT);
  const left: [string, string][] = [
    ['Employee', p.employee.name],
    ['Employee ID', p.employee.employeeCode || '—'],
    ['Designation', p.employee.designation ?? '—'],
  ];
  const right: [string, string][] = [
    ['Department', p.employee.department ?? '—'],
    ['Employment Type', p.employee.employmentType ?? '—'],
    ['Pay Period', `${day(p.period.start)} – ${day(p.period.end)}`],
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
  y = infoTop + ROW * 3 + 32;

  // ── Attendance summary ───────────────────────────────────────────────────
  const stats: [string, string][] = [
    ['Working Days', days(p.attendance.workingDays)],
    ['Paid Days', days(p.attendance.paidDays)],
    ['Unpaid Days', days(p.attendance.unpaidDays)],
    ['Paid Leave', days(p.attendance.paidLeaveDays)],
  ];
  const cell = CONTENT / stats.length;
  stats.forEach(([label, value], i) => {
    const x = MARGIN + i * cell;
    // Equal boxes with a 6pt gutter between them.
    doc.roundedRect(x + (i === 0 ? 0 : 3), y, cell - (i === 0 || i === stats.length - 1 ? 3 : 6), 40, 4).lineWidth(0.7).strokeColor(RULE).stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(value, x, y + 7, { width: cell, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(label, x, y + 24, { width: cell, align: 'center' });
  });
  y += 48;
  if (p.attendance.proration) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Employed ${day(p.attendance.proration.from)} – ${day(p.attendance.proration.to)} this period: paid for ${days(p.attendance.proration.eligibleDays)} of ${days(p.attendance.workingDays)} working days.`,
        MARGIN,
        y,
        { width: CONTENT },
      );
    y = doc.y + 4;
  }
  y += 8;

  // ── Earnings | Deductions ────────────────────────────────────────────────
  const half = (CONTENT - 16) / 2;
  const table = (title: string, lines: PayslipLine[], total: [string, number], x: number, top: number) => {
    let rowY = top;
    doc.rect(x, rowY, half, 22).fill(INK);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff').text(title, x + 10, rowY + 7, { width: half / 2 });
    doc.text('AMOUNT', x + half / 2, rowY + 7, { width: half / 2 - 10, align: 'right' });
    rowY += 22;
    const rows = lines.length ? lines : [{ label: 'None', amount: 0 } as PayslipLine];
    for (const line of rows) {
      const height = line.note ? 28 : 20;
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(line.label, x + 10, rowY + 6, { width: half * 0.6, lineBreak: false, ellipsis: true });
      if (line.note) {
        doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(line.note, x + 10, rowY + 17, { width: half * 0.6, lineBreak: false, ellipsis: true });
      }
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(money(line.amount, cur), x + half * 0.45, rowY + 6, { width: half * 0.55 - 10, align: 'right' });
      rowY += height;
      doc.moveTo(x, rowY).lineTo(x + half, rowY).lineWidth(0.5).strokeColor(RULE).stroke();
    }
    doc.rect(x, rowY, half, 24).fill(SOFT);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(total[0], x + 10, rowY + 8, { width: half / 2 });
    doc.text(money(total[1], cur), x + half / 2, rowY + 8, { width: half / 2 - 10, align: 'right' });
    return rowY + 24;
  };
  const top = y;
  const statutory = p.statutoryDeductions ?? [];
  const rightX = MARGIN + half + 16;
  const leftEnd = table('EARNINGS', p.earnings, ['Gross Earnings', p.totals.gross], MARGIN, top);
  let rightEnd: number;
  if (statutory.length) {
    // Normal and statutory deductions each subtotalled, then everything taken from pay.
    rightEnd = table('DEDUCTIONS', p.deductions, ['Subtotal', p.totals.normalDeductions ?? p.totals.deductions], rightX, top);
    rightEnd = table('STATUTORY DEDUCTIONS', statutory, ['Subtotal', p.totals.statutoryDeductions ?? 0], rightX, rightEnd + 10);
    doc.rect(rightX, rightEnd + 6, half, 26).fill(INK);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff').text('Total Deductions', rightX + 10, rightEnd + 15, { width: half / 2 });
    doc.text(money(p.totals.deductions, cur), rightX + half / 2, rightEnd + 15, { width: half / 2 - 10, align: 'right' });
    rightEnd += 32;
  } else {
    rightEnd = table('DEDUCTIONS', p.deductions, ['Total Deductions', p.totals.deductions], rightX, top);
  }
  y = Math.max(leftEnd, rightEnd) + 16;

  // ── Net pay ──────────────────────────────────────────────────────────────
  doc.roundedRect(MARGIN, y, CONTENT, 52, 6).fill(BRAND);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text('NET PAY', MARGIN + 16, y + 20, { width: CONTENT / 2 });
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(p.totals.net < 0 ? '#fecaca' : '#ffffff')
    .text(money(p.totals.net, cur), MARGIN + CONTENT / 2, y + 16, { width: CONTENT / 2 - 16, align: 'right' });
  y += 68;

  // ── Employer contributions — information only, never deducted ────────────
  const employer = p.employerContributions ?? [];
  if (employer.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('EMPLOYER CONTRIBUTIONS', MARGIN, y);
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text('Paid by the employer in addition to your salary — not deducted from your pay.', MARGIN, y + 12, { width: CONTENT });
    y += 26;
    for (const line of employer) {
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(line.label, MARGIN, y, { width: CONTENT / 2 });
      doc.text(money(line.amount, cur), MARGIN + CONTENT / 2, y, { width: CONTENT / 2, align: 'right' });
      y += 15;
    }
    doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT, y).lineWidth(0.5).strokeColor(RULE).stroke();
    y += 14;
  }

  // ── Payment ──────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('PAYMENT', MARGIN, y);
  y += 14;
  const payment: [string, string][] = [
    ['Status', 'Paid'],
    ['Payment Date', day(p.payment.date)],
    ['Reference', p.payment.reference ?? '—'],
  ];
  if (p.bank) {
    payment.push(['Bank', p.bank.bankName ?? '—'], ['Account', p.bank.account ?? '—']);
  }
  payment.forEach(([label, value], i) => {
    const x = MARGIN + (i % 3) * (CONTENT / 3);
    const rowY = y + Math.floor(i / 3) * 26;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x, rowY, { width: CONTENT / 3 - 8 });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(label === 'Status' ? '#15803d' : INK)
      .text(value, x, rowY + 9, { width: CONTENT / 3 - 8, lineBreak: false, ellipsis: true });
  });
  y += Math.ceil(payment.length / 3) * 26 + 10;
  if (p.totals.net < 0) {
    doc.font('Helvetica').fontSize(8).fillColor(DANGER).text('Deductions exceed earnings for this period.', MARGIN, y, { width: CONTENT });
    y = doc.y + 6;
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  const footerY = A4.height - MARGIN - 26;
  doc.moveTo(MARGIN, footerY).lineTo(MARGIN + CONTENT, footerY).lineWidth(0.5).strokeColor(RULE).stroke();
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(
      `This is a system-generated payslip and does not require a signature.  ·  Generated ${day(p.generatedAt)}  ·  ${p.payslipNumber}`,
      MARGIN,
      footerY + 8,
      { width: CONTENT, align: 'center' },
    );
}
