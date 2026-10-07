/**
 * Everything a tool returns passes through here before the model sees it.
 *
 * Redaction is by field name, so it covers every tool at once — including
 * ones added later — instead of relying on each tool to remember. Trimming
 * keeps one tool result from flooding the context (and the bill): long lists
 * are cut with a note telling the model to filter instead.
 */

/** Never sent to the model, whatever the tool or the caller's role. */
const REDACTED_KEYS = new Set(
  [
    'nationalId',
    'cnic',
    'bankName',
    'bankAccountTitle',
    'bankAccountNumber',
    'iban',
    'ntn',
    'eobiRegistrationNumber',
    'currentAddress',
    'permanentAddress',
    'dateOfBirth',
    'religion',
    'basicSalary',
    'password',
    'passwordHash',
    'passwordHistory',
    'tokenHash',
    'refreshToken',
    'accessToken',
    'secret',
    'twoFactorSecret',
    'otp',
    'otpHash',
    'apiKey',
  ].map((k) => k.toLowerCase()),
);

/** Prefixes that cover families of fields, e.g. emergencyContactName / emergencyContactPhone. */
const REDACTED_PREFIXES = ['emergencycontact', 'password', 'bankaccount'];

/** Image URLs and similar noise: no use to the model, and they cost tokens. */
const DROPPED_KEYS = new Set(['avatarurl', 'logourl', 'adminavatarurl', 'organizationlogo', 'useravatar', 'signature']);

const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;
const MAX_RESULT_CHARS = 60000;

const isRedacted = (key: string): boolean => {
  const k = key.toLowerCase();
  return REDACTED_KEYS.has(k) || REDACTED_PREFIXES.some((p) => k.startsWith(p));
};

const sanitize = (value: unknown, depth: number): unknown => {
  if (value === null || value === undefined) return value;
  if (depth > 8) return '[nested data omitted]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}… [truncated]` : value;
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items not shown — narrow the query with filters or paging]`);
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(key.toLowerCase())) continue;
    out[key] = isRedacted(key) ? '[redacted]' : sanitize(child, depth + 1);
  }
  return out;
};

/** Redacted, trimmed JSON text ready to hand back as a tool_result. */
export const toToolResultText = (data: unknown): string => {
  const text = JSON.stringify(sanitize(data, 0) ?? null);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    '… [result truncated — ask for a smaller page or add filters to see the rest]'
  );
};
