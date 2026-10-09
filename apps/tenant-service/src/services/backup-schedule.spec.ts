import { latestBackupSlot } from './backup.service';

// Karachi, UTC+5.
const slot = (frequency: string, time: string, iso: string) => latestBackupSlot(frequency, time, new Date(iso), 300).toISOString();

describe('latestBackupSlot', () => {
  it('daily: today at the time once passed, else yesterday', () => {
    // 10:00 local Thu 8 Oct; backups at 02:00 → today 02:00 local = 7 Oct 21:00Z.
    expect(slot('DAILY', '02:00', '2026-10-08T05:00:00Z')).toBe('2026-10-07T21:00:00.000Z');
    // 01:00 local → yesterday 02:00 local.
    expect(slot('DAILY', '02:00', '2026-10-07T20:00:00Z')).toBe('2026-10-06T21:00:00.000Z');
  });

  it('weekly: the latest Monday at the time', () => {
    expect(slot('WEEKLY', '02:00', '2026-10-08T05:00:00Z')).toBe('2026-10-04T21:00:00.000Z');
  });

  it('monthly: the 1st at the time', () => {
    expect(slot('MONTHLY', '02:00', '2026-10-08T05:00:00Z')).toBe('2026-09-30T21:00:00.000Z');
    // 1 Oct 01:00 local, before the slot → 1 Sep.
    expect(slot('MONTHLY', '02:00', '2026-09-30T20:00:00Z')).toBe('2026-08-31T21:00:00.000Z');
  });
});
