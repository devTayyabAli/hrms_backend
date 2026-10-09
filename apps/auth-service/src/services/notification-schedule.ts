/**
 * Clock arithmetic for Super Admin notifications: whose "now" it is (their
 * profile time zone), whether quiet hours cover it, and when a digest is due.
 * Pure functions, so the scheduling rules are tested without a database.
 */

import { localClock } from '@app/common';

// Time-zone helpers now live in @app/common (backups use them too); re-exported for existing callers.
export { utcOffsetMinutes, localClock } from '@app/common';

const DAY_MINUTES = 24 * 60;
/** Digests go out at this local time — or as soon after as quiet hours allow. */
export const DIGEST_LOCAL_MINUTES = 9 * 60;
/** Weekly digests go out on Monday. */
const DIGEST_WEEKDAY = 1;
export const toMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

/** Whether local `minutes` fall inside quiet hours; the window may cross midnight. */
export const inQuietHours = (quiet: QuietHours, minutes: number): boolean => {
  if (!quiet.enabled || !quiet.start || !quiet.end) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

export type DigestFrequency = 'daily' | 'weekly';

/**
 * The most recent digest send time at or before `now`: today's (or this
 * Monday's) 09:00 local, else the one before it. Notifications created before
 * this boundary and not yet emailed are owed a digest.
 */
export const latestDigestSlot = (frequency: DigestFrequency, now: Date, offset: number): Date => {
  const clock = localClock(now, offset);
  let daysBack = 0;
  if (frequency === 'daily') {
    if (clock.minutes < DIGEST_LOCAL_MINUTES) daysBack = 1;
  } else {
    daysBack = (clock.weekday - DIGEST_WEEKDAY + 7) % 7;
    if (daysBack === 0 && clock.minutes < DIGEST_LOCAL_MINUTES) daysBack = 7;
  }
  return new Date(clock.dayStart.getTime() - daysBack * DAY_MINUTES * 60_000 + DIGEST_LOCAL_MINUTES * 60_000);
};
