/**
 * The leave year: April to March. Shared by every screen that reports leave
 * balances, so My Leave and the organization-wide Balances table can never
 * disagree about which requests belong to "this year".
 */

/** The April–March fiscal year that begins in `startYear`. */
export function fiscalYearStarting(startYear: number) {
  return {
    label: `FY ${startYear}-${String(startYear + 1).slice(2)}`,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

/** The fiscal year that contains `now`. */
export function fiscalYear(now = new Date()) {
  return fiscalYearStarting(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
}

/** The fiscal year a 'YYYY-MM-DD' date falls in — what a leave request draws on. */
export function fiscalYearContaining(iso: string) {
  const [year, month] = iso.slice(0, 10).split('-').map(Number);
  return fiscalYearStarting(month >= 4 ? year : year - 1);
}

/** Leave days are kept to one decimal place so a half day reads as 0.5. */
export function roundDays(value: number): number {
  return Math.round(value * 10) / 10;
}
