import { AttendanceStatus } from '@app/common';
import {
  autoOvertimeMinutes,
  ipAllowed,
  isWorkingDay,
  rulesFrom,
  statusFor,
  zonedDateTime,
} from './attendance-rules';

describe('attendance rules', () => {
  // 2026-09-28 is a Monday; 2026-09-27 a Sunday.
  const MONDAY = '2026-09-28';
  const SUNDAY = '2026-09-27';
  const shift = { startTime: '09:00', workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], timezone: 'Asia/Karachi' };
  const rules = (policy: Record<string, unknown> = {}) =>
    rulesFrom(shift, { gracePeriodMinutes: 10, ...policy });

  it('reads wall-clock times in the shift time zone', () => {
    expect(zonedDateTime(MONDAY, '09:00', 'Asia/Karachi').toISOString()).toBe('2026-09-28T04:00:00.000Z');
    expect(zonedDateTime(MONDAY, '23:00', 'UTC').toISOString()).toBe('2026-09-28T23:00:00.000Z');
  });

  it('marks late only after shift start plus grace, in local time', () => {
    const r = rules();
    expect(statusFor(MONDAY, new Date('2026-09-28T04:10:00Z'), null, r)).toBe(AttendanceStatus.PRESENT);
    expect(statusFor(MONDAY, new Date('2026-09-28T04:11:00Z'), null, r)).toBe(AttendanceStatus.LATE);
  });

  it('applies the half-day and full-day hour thresholds once checked out', () => {
    const r = rules({ halfDayHours: '4.50', fullDayHours: '8.50' });
    const onTime = new Date('2026-09-28T04:00:00Z');
    expect(statusFor(MONDAY, onTime, 4 * 60, r)).toBe(AttendanceStatus.ABSENT);
    expect(statusFor(MONDAY, onTime, 6 * 60, r)).toBe(AttendanceStatus.HALF_DAY);
    expect(statusFor(MONDAY, onTime, 9 * 60, r)).toBe(AttendanceStatus.PRESENT);
    expect(statusFor(MONDAY, new Date('2026-09-28T05:00:00Z'), 9 * 60, r)).toBe(AttendanceStatus.LATE);
  });

  it('treats a non-working day as present with no late or hour rules', () => {
    const r = rules({ halfDayHours: 4.5 });
    expect(isWorkingDay(SUNDAY, r)).toBe(false);
    expect(statusFor(SUNDAY, new Date('2026-09-27T10:00:00Z'), 60, r)).toBe(AttendanceStatus.PRESENT);
  });

  it('computes overtime past the threshold, or all weekend hours when paid as overtime', () => {
    expect(autoOvertimeMinutes(MONDAY, 600, rules({ allowOvertime: true, overtimeAfterHours: '9.00' }))).toBe(60);
    expect(autoOvertimeMinutes(MONDAY, 500, rules({ allowOvertime: true, overtimeAfterHours: 9 }))).toBeNull();
    expect(autoOvertimeMinutes(MONDAY, 600, rules({ allowOvertime: false, overtimeAfterHours: 9 }))).toBeUndefined();
    expect(autoOvertimeMinutes(SUNDAY, 240, rules({ weekendWorkPolicy: 'OVERTIME_PAY' }))).toBe(240);
    expect(autoOvertimeMinutes(MONDAY, null, rules({ allowOvertime: true, overtimeAfterHours: 9 }))).toBeUndefined();
  });

  it('matches exact IPs and IPv4 CIDR ranges', () => {
    const ranges = ['203.0.113.0/24', '198.51.100.7', '::1'];
    expect(ipAllowed('203.0.113.200', ranges)).toBe(true);
    expect(ipAllowed('::ffff:198.51.100.7', ranges)).toBe(true);
    expect(ipAllowed('::1', ranges)).toBe(true);
    expect(ipAllowed('203.0.114.1', ranges)).toBe(false);
    expect(ipAllowed(undefined, ranges)).toBe(false);
  });
});
