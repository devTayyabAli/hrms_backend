/** "require2FASuperAdmins" → "Require 2FA super admins". */
const humanize = (key: string): string =>
  key
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([A-Z0-9]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .map((word, i) => (/^[A-Z0-9]{2,}$/.test(word) ? word : i === 0 ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase()))
    .join(' ');

/**
 * "Session timeout minutes, Require 2FA super admins" — the settings a
 * partial update actually changed, for the notification that reports it.
 */
export const describeChangedSettings = (before: Record<string, unknown>, patch: object): string | null => {
  const labels = Object.entries(patch)
    .filter(([key, value]) => value !== undefined && JSON.stringify(before[key]) !== JSON.stringify(value))
    .map(([key]) => humanize(key));
  return labels.length ? labels.join(', ') : null;
};
