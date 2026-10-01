import PDFDocument = require('pdfkit');

/**
 * The annual salary tax certificate as an A4 PDF, printed from the summary
 * stored when it was issued — never recalculated. Layout only.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 44;
const CONTENT = A4.width - MARGIN * 2;
const INK = '#0f172a';
const MUTED = '#64748b';
const RULE = '#e2e8f0';
const BRAND = '#1d4ed8';
const SOFT = '#f1f5f9';

export interface TaxCertificateContent {
  certificateNumber: string;
  generatedAt: string | Date;
  taxYear: number;
  period: { start: string; end: string };
  employer: {
    name: string;
    legalName?: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  employee: {
    name: string;
    employeeCode: string;
    designation: string | null;
    department: string | null;
    cnic: string | null;
  };
  ntn: string | null;
  months: { month: string; gross: number; taxable: number; tax: number }[];
  grossSalary: number;
  taxableSalary: number;
  exemptSalary: number;
  taxDeducted: number;
  taxAdjustments: number;
  totalTax: number;
  previousEmployer: { taxableIncome: number; taxDeducted: number } | null;
}

const money = (value: number) =>
  `Rs. ${Number(value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (value: string | Date) =>
  new Date(
    typeof value === 'string' && value.length === 10
      ? `${value}T12:00:00Z`
      : value,
  ).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const isEmbeddable = (bytes?: Buffer | null) =>
  Boolean(
    bytes &&
    bytes.length > 8 &&
    ((bytes[0] === 0x89 && bytes[1] === 0x50) ||
      (bytes[0] === 0xff && bytes[1] === 0xd8)),
  );

export const renderTaxCertificatePdf = (
  c: TaxCertificateContent,
  options: { logo?: Buffer | null; compress?: boolean } = {},
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      compress: options.compress ?? true,
      info: {
        Title: `Tax certificate ${c.certificateNumber} — Tax Year ${c.taxYear}`,
        Author: c.employer.name,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      let y = MARGIN;
      if (isEmbeddable(options.logo)) {
        try {
          doc.image(options.logo, A4.width / 2 - 60, y, {
            fit: [120, 44],
            align: 'center',
            valign: 'center',
          });
          y += 52;
        } catch {
          // Decoration only.
        }
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(15)
        .fillColor(INK)
        .text(c.employer.legalName || c.employer.name, MARGIN, y, {
          width: CONTENT,
          align: 'center',
        });
      y = doc.y + 2;
      const contact = [c.employer.address, c.employer.phone, c.employer.email]
        .filter(Boolean)
        .join('  ·  ');
      if (contact) {
        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(contact, MARGIN, y, { width: CONTENT, align: 'center' });
        y = doc.y;
      }
      y += 10;
      doc.rect(MARGIN, y, CONTENT, 2).fill(BRAND);
      y += 16;

      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor(INK)
        .text('CERTIFICATE OF SALARY AND TAX DEDUCTED', MARGIN, y, {
          width: CONTENT,
          align: 'center',
        });
      y = doc.y + 4;
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(MUTED)
        .text(
          `Tax Year ${c.taxYear}  ·  ${day(c.period.start)} – ${day(c.period.end)}`,
          MARGIN,
          y,
          { width: CONTENT, align: 'center' },
        );
      y = doc.y + 4;
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(
          `Certificate No. ${c.certificateNumber}  ·  Issued ${day(c.generatedAt)}`,
          MARGIN,
          y,
          { width: CONTENT, align: 'center' },
        );
      y = doc.y + 14;

      const boxTop = y;
      doc.roundedRect(MARGIN, boxTop, CONTENT, 74, 6).fill(SOFT);
      const field = (label: string, value: string, x: number, rowY: number) => {
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(MUTED)
          .text(label.toUpperCase(), x, rowY, { width: CONTENT / 2 - 24 });
        doc
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .fillColor(INK)
          .text(value || '—', x, rowY + 10, {
            width: CONTENT / 2 - 24,
            lineBreak: false,
            ellipsis: true,
          });
      };
      field('Employee', c.employee.name, MARGIN + 14, boxTop + 10);
      field('Employee ID', c.employee.employeeCode, MARGIN + 14, boxTop + 40);
      field(
        'CNIC',
        c.employee.cnic ?? '—',
        MARGIN + CONTENT / 2 + 8,
        boxTop + 10,
      );
      field('NTN', c.ntn ?? '—', MARGIN + CONTENT / 2 + 8, boxTop + 40);
      y = boxTop + 90;

      const summary: [string, number][] = [
        ['Gross salary paid', c.grossSalary],
        ['Exempt salary', c.exemptSalary],
        ['Taxable salary', c.taxableSalary],
        ['Tax deducted', c.taxDeducted],
        ['Tax adjustments recovered', c.taxAdjustments],
      ];
      for (const [label, amount] of summary) {
        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor(INK)
          .text(label, MARGIN + 6, y, { width: CONTENT / 2 });
        doc.text(money(amount), MARGIN + CONTENT / 2, y, {
          width: CONTENT / 2 - 6,
          align: 'right',
        });
        y += 18;
        doc
          .moveTo(MARGIN, y - 4)
          .lineTo(MARGIN + CONTENT, y - 4)
          .lineWidth(0.5)
          .strokeColor(RULE)
          .stroke();
      }
      doc.roundedRect(MARGIN, y + 2, CONTENT, 34, 6).fill(BRAND);
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#ffffff')
        .text('TOTAL TAX DEDUCTED', MARGIN + 14, y + 13, {
          width: CONTENT / 2,
        });
      doc.text(money(c.totalTax), MARGIN + CONTENT / 2, y + 13, {
        width: CONTENT / 2 - 14,
        align: 'right',
      });
      y += 50;
      if (c.previousEmployer) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(
            `Not included above — previous employer this tax year: taxable income ${money(c.previousEmployer.taxableIncome)}, tax deducted ${money(c.previousEmployer.taxDeducted)}.`,
            MARGIN,
            y,
            { width: CONTENT },
          );
        y = doc.y + 8;
      }

      // Month by month.
      const cols = [
        CONTENT * 0.34,
        CONTENT * 0.22,
        CONTENT * 0.22,
        CONTENT * 0.22,
      ];
      const header = ['Month', 'Gross', 'Taxable', 'Tax'];
      doc.rect(MARGIN, y, CONTENT, 20).fill(INK);
      let x = MARGIN;
      header.forEach((h, i) => {
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .fillColor('#ffffff')
          .text(h, x + 8, y + 6, {
            width: cols[i] - 16,
            align: i ? 'right' : 'left',
          });
        x += cols[i];
      });
      y += 20;
      for (const m of c.months) {
        if (y > A4.height - MARGIN - 60) {
          doc.addPage();
          y = MARGIN;
        }
        x = MARGIN;
        [m.month, money(m.gross), money(m.taxable), money(m.tax)].forEach(
          (value, i) => {
            doc
              .font('Helvetica')
              .fontSize(8.5)
              .fillColor(INK)
              .text(value, x + 8, y + 5, {
                width: cols[i] - 16,
                align: i ? 'right' : 'left',
              });
            x += cols[i];
          },
        );
        y += 18;
        doc
          .moveTo(MARGIN, y)
          .lineTo(MARGIN + CONTENT, y)
          .lineWidth(0.5)
          .strokeColor(RULE)
          .stroke();
      }

      const footerY = A4.height - MARGIN - 34;
      doc
        .moveTo(MARGIN, footerY)
        .lineTo(MARGIN + CONTENT, footerY)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(
          `Issued from approved payroll records of ${c.employer.name}. This is a system-generated statement of salary paid and income tax deducted under section 149 of the Income Tax Ordinance, 2001; it is not a filing with the Federal Board of Revenue.`,
          MARGIN,
          footerY + 8,
          { width: CONTENT, align: 'center' },
        );
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
