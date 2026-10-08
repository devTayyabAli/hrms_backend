import { inQuietHours, latestDigestSlot, localClock, toMinutes, utcOffsetMinutes } from './notification-schedule';

describe('notification schedule', () => {
  describe('utcOffsetMinutes', () => {
    const at = new Date('2026-10-08T12:00:00Z');

    it('reads both profile time zone label styles', () => {
      expect(utcOffsetMinutes('UTC+05:00 (Asia/Karachi)', at)).toBe(300);
      expect(utcOffsetMinutes('(UTC + 05:00) Islamabad, Karachi', at)).toBe(300);
      expect(utcOffsetMinutes('(UTC + 04:00) Dubai', at)).toBe(240);
      expect(utcOffsetMinutes('(UTC - 05:00) New York', at)).toBe(-300);
      expect(utcOffsetMinutes('(UTC + 00:00) London', at)).toBe(0);
    });

    it('prefers an IANA name, which knows daylight saving', () => {
      // London is on BST (UTC+1) in October.
      expect(utcOffsetMinutes('Europe/London', at)).toBe(60);
    });

    it('falls back to the platform default for anything unreadable', () => {
      expect(utcOffsetMinutes('', at)).toBe(300);
      expect(utcOffsetMinutes(null, at)).toBe(300);
    });
  });

  describe('inQuietHours', () => {
    const overnight = { enabled: true, start: '22:00', end: '07:00' };
    const daytime = { enabled: true, start: '13:00', end: '14:30' };

    it('covers a window that crosses midnight', () => {
      expect(inQuietHours(overnight, toMinutes('23:30'))).toBe(true);
      expect(inQuietHours(overnight, toMinutes('03:00'))).toBe(true);
      expect(inQuietHours(overnight, toMinutes('07:00'))).toBe(false);
      expect(inQuietHours(overnight, toMinutes('21:59'))).toBe(false);
    });

    it('covers a same-day window, end exclusive', () => {
      expect(inQuietHours(daytime, toMinutes('13:00'))).toBe(true);
      expect(inQuietHours(daytime, toMinutes('14:29'))).toBe(true);
      expect(inQuietHours(daytime, toMinutes('14:30'))).toBe(false);
    });

    it('is never on when disabled or degenerate', () => {
      expect(inQuietHours({ ...overnight, enabled: false }, toMinutes('23:30'))).toBe(false);
      expect(inQuietHours({ enabled: true, start: '10:00', end: '10:00' }, toMinutes('10:00'))).toBe(false);
    });
  });

  describe('localClock', () => {
    it('shifts into the zone and finds local midnight', () => {
      // 20:30 UTC Wednesday = 01:30 Thursday in Karachi.
      const clock = localClock(new Date('2026-10-07T20:30:00Z'), 300);
      expect(clock.minutes).toBe(90);
      expect(clock.weekday).toBe(4);
      expect(clock.dayStart.toISOString()).toBe('2026-10-07T19:00:00.000Z');
    });
  });

  describe('latestDigestSlot (Karachi, UTC+5)', () => {
    const slot = (frequency: 'daily' | 'weekly', iso: string) => latestDigestSlot(frequency, new Date(iso), 300).toISOString();

    it('daily: today 09:00 once it has passed, else yesterday 09:00', () => {
      // 10:00 local Thursday 8 Oct → 09:00 local today = 04:00Z.
      expect(slot('daily', '2026-10-08T05:00:00Z')).toBe('2026-10-08T04:00:00.000Z');
      // 08:00 local → yesterday's 09:00.
      expect(slot('daily', '2026-10-08T03:00:00Z')).toBe('2026-10-07T04:00:00.000Z');
    });

    it('weekly: the most recent Monday 09:00', () => {
      // Thursday 8 Oct → Monday 5 Oct 09:00 local.
      expect(slot('weekly', '2026-10-08T05:00:00Z')).toBe('2026-10-05T04:00:00.000Z');
      // Monday 12 Oct 08:00 local → the Monday before.
      expect(slot('weekly', '2026-10-12T03:00:00Z')).toBe('2026-10-05T04:00:00.000Z');
      // Monday 12 Oct 09:30 local → this Monday.
      expect(slot('weekly', '2026-10-12T04:30:00Z')).toBe('2026-10-12T04:00:00.000Z');
    });
  });
});
