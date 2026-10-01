import type { Response } from 'express';

/**
 * Streams a PDF that came back over RPC as base64. Always an attachment and
 * never cached — a payslip is personal and shouldn't linger in a shared cache.
 */
export const sendPdf = (res: Response, pdf: { filename?: string; contentBase64?: string } | null | undefined) => {
  if (!pdf?.contentBase64) {
    return res.status(404).json({ message: 'The PDF is not available.' });
  }
  // Quotes or line breaks in a filename would break out of the header value.
  const filename = String(pdf.filename || 'document.pdf').replace(/["\r\n]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(Buffer.from(pdf.contentBase64, 'base64'));
};
