import type { Response } from 'express';

/**
 * Must match `FileStorageService.maxFileSizeBytes` in auth-service. That
 * check is the authoritative one, but it only runs after the gateway has
 * buffered the whole body in memory and serialized it over RPC — so the
 * same ceiling is enforced here, where Multer can abort the stream before
 * any of that happens.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * MIME types safe to hand a browser with `Content-Disposition: inline`.
 *
 * Deliberately narrower than the upload allowlist: `text/plain`,
 * `application/json` and the office formats are all fine to *store*, but
 * serving them inline from the gateway's own origin invites MIME sniffing to
 * reinterpret attacker-supplied bytes as markup. Anything not listed here is
 * still downloadable — it just arrives as an attachment.
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

/**
 * Send a file body with headers that cannot be turned against the viewer.
 *
 * `nosniff` is the important one: without it a browser is free to ignore
 * the declared Content-Type and sniff the bytes instead, so a file stored
 * as `text/plain` whose contents are markup can execute as HTML on this
 * origin. Inline rendering is additionally limited to image and PDF types;
 * everything else is forced to download.
 */
export function sendFileResponse(
  res: Response,
  result: { buffer: any; mimeType?: string; originalName?: string },
  preferInline: boolean,
) {
  const buffer = Buffer.from(result.buffer.data || result.buffer);
  const mimeType = result.mimeType || 'application/octet-stream';
  const inline = preferInline && INLINE_SAFE_MIME_TYPES.has(mimeType);

  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Quotes in a filename would terminate the header's quoted-string early
  // and let the rest be read as additional parameters.
  const safeName = (result.originalName || 'download').replace(/["\r\n]/g, '');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
  );
  return res.send(buffer);
}
