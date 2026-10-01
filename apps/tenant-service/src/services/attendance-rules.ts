import { AttendanceStatus } from '@app/common';

/**
 * The Attendance Rules screen's arithmetic, kept free of I/O so check-in,
 * check-out, HR corrections and the auto check-out job all apply the same
 * rule the same way.
 */

export interface AttendanceRules {
  /** Default shift, or null when working hours aren't configured. */
  shift: { startTime: string; workingDays: string[]; timezone: string } | null;
  gracePeriodMinutes: number;
  halfDayHours: number | null;
  fullDayHours: number | null;
  allowOvertime: boolean;
  overtimeAfterHours: number | null;
  autoCheckoutTime: string | null;
  weekendWorkPolicy: 'COMP_OFF' | 'OVERTIME_PAY' | 'NOT_ALLOWED' | null;
  ipRestrictionEnabled: boolean;
  allowedIpRanges: string[];
}

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** DECIMAL columns come back as strings; normalize the saved policy once. */
export const rulesFrom = (shift: any, policy: any): AttendanceRules => ({
  shift: shift?.startTime
    ? {
        startTime: String(shift.startTime).slice(0, 5),
        workingDays: shift.workingDays ?? [],
        timezone: shift.timezone || 'UTC',
      }
    : null,
  gracePeriodMinutes: Number(policy?.gracePeriodMinutes ?? 0) || 0,
  halfDayHours: toNumber(policy?.halfDayHours),
  fullDayHours: toNumber(policy?.fullDayHours),
  allowOvertime: Boolean(policy?.allowOvertime),
  overtimeAfterHours: toNumber(policy?.overtimeAfterHours),
  autoCheckoutTime: policy?.autoCheckoutTime || null,
  weekendWorkPolicy: policy?.weekendWorkPolicy || null,
  ipRestrictionEnabled: Boolean(policy?.ipRestrictionEnabled),
  allowedIpRanges: policy?.allowedIpRanges ?? [],
});

/** Minutes a time zone is ahead of UTC at a given instant. */
const offsetMinutes = (instant: Date, timeZone: string): number => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - instant.getTime()) / 60000);
  } catch {
    return 0; // Unknown zone name: fall back to UTC rather than failing a punch.
  }
};

/**
 * The instant a wall-clock time happens on a date in the organization's time
 * zone — "09:00 on 2026-09-28 in Asia/Karachi" is 04:00Z.
 */
export const zonedDateTime = (date: string, hm: string, timeZone: string): Date => {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  const [hours, minutes] = hm.split(':').map(Number);
  const wallClock = Date.UTC(y, m - 1, d, hours || 0, minutes || 0);
  let instant = new Date(wallClock - offsetMinutes(new Date(wallClock), timeZone) * 60000);
  // Second pass settles a DST boundary between the guess and the answer.
  instant = new Date(wallClock - offsetMinutes(instant, timeZone) * 60000);
  return instant;
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Whether a calendar date is one of the shift's working days. Working days are
 * stored as "Mon" or "MONDAY", so compare on the first three letters. With no
 * configured days every day counts as working, so nothing is treated as weekend.
 */
export const isWorkingDay = (date: string, rules: AttendanceRules): boolean => {
  const days = (rules.shift?.workingDays ?? []).map((day) => String(day).slice(0, 3).toLowerCase());
  if (days.length === 0) return true;
  const weekday = WEEKDAYS[new Date(`${date.slice(0, 10)}T12:00:00Z`).getUTCDay()];
  return days.includes(weekday);
};

/** Present or Late from the shift start plus grace, in the shift's time zone. */
const arrivalStatus = (date: string, checkInAt: Date, rules: AttendanceRules): AttendanceStatus => {
  if (!rules.shift || !/^\d{1,2}:\d{2}$/.test(rules.shift.startTime)) return AttendanceStatus.PRESENT;
  const lateAfter = zonedDateTime(date, rules.shift.startTime, rules.shift.timezone);
  lateAfter.setTime(lateAfter.getTime() + rules.gracePeriodMinutes * 60000);
  return checkInAt.getTime() > lateAfter.getTime() ? AttendanceStatus.LATE : AttendanceStatus.PRESENT;
};

/**
 * The day's status from the rules:
 * - no check-in is Absent;
 * - on a weekend there's no shift to be late for, so it's Present;
 * - otherwise Late after shift start + grace, else Present;
 * - once checked out, fewer hours than the half-day threshold is Absent and
 *   fewer than the full-day threshold is Half Day.
 */
export const statusFor = (
  date: string,
  checkInAt: Date | null,
  workedMinutes: number | null,
  rules: AttendanceRules,
): AttendanceStatus => {
  if (!checkInAt) return AttendanceStatus.ABSENT;
  if (!isWorkingDay(date, rules)) return AttendanceStatus.PRESENT;

  const arrival = arrivalStatus(date, checkInAt, rules);
  if (workedMinutes === null || workedMinutes === undefined) return arrival;
  if (rules.halfDayHours !== null && workedMinutes < rules.halfDayHours * 60) return AttendanceStatus.ABSENT;
  if (rules.fullDayHours !== null && workedMinutes < rules.fullDayHours * 60) return AttendanceStatus.HALF_DAY;
  return arrival;
};

/**
 * Overtime the rules grant for a day, in minutes. Weekend work paid as
 * overtime counts every minute; otherwise only the time past the overtime
 * threshold, and only when overtime is allowed. Undefined means no rule
 * applies, so leave whatever is recorded alone.
 */
export const autoOvertimeMinutes = (
  date: string,
  workedMinutes: number | null,
  rules: AttendanceRules,
): number | null | undefined => {
  if (workedMinutes === null || workedMinutes === undefined) return undefined;
  if (!isWorkingDay(date, rules) && rules.weekendWorkPolicy === 'OVERTIME_PAY') {
    return workedMinutes > 0 ? workedMinutes : null;
  }
  if (rules.allowOvertime && rules.overtimeAfterHours !== null) {
    const extra = workedMinutes - Math.round(rules.overtimeAfterHours * 60);
    return extra > 0 ? extra : null;
  }
  return undefined;
};

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
};

/** "::ffff:10.0.0.5" → "10.0.0.5", so IPv4 rules match IPv4-mapped sockets. */
export const normalizeIp = (ip: string | null | undefined): string => {
  const trimmed = String(ip ?? '').trim();
  return trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
};

/** True when the address matches one of the allowed IPs or IPv4 CIDR ranges. */
export const ipAllowed = (ip: string | null | undefined, ranges: string[]): boolean => {
  const address = normalizeIp(ip);
  if (!address) return false;
  return ranges.some((range) => {
    const entry = range.trim();
    if (!entry.includes('/')) return normalizeIp(entry).toLowerCase() === address.toLowerCase();
    const [base, bitsText] = entry.split('/');
    const bits = Number(bitsText);
    const target = ipv4ToInt(address);
    const network = ipv4ToInt(base);
    if (target === null || network === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(target / size) === Math.floor(network / size);
  });
};
