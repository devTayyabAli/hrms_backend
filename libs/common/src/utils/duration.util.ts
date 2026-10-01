const UNIT_TO_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parses a short duration string (e.g. '15m', '7d', '30s') into milliseconds.
 */
export function parseDurationMs(duration: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected e.g. "15m", "24h", "7d".`);
  }
  const [, value, unit] = match;
  return parseInt(value, 10) * UNIT_TO_MS[unit];
}
