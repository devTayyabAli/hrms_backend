/**
 * Clock arithmetic for Super Admin notifications: whose "now" it is (their
 * profile time zone), whether quiet hours cover it, and when a digest is due.
 * Pure functions, so the scheduling rules are tested without a database.
 */

const DAY_MINUTES = 24 * 60;
/** Digests go out at this local time — or as soon after as quiet hours allow. */
export const DIGEST_LOCAL_MINUTES = 9 * 60;
/** Weekly digests go out on Monday. */
const DIGEST_WEEKDAY = 1;
const DEFAULT_TIME_ZONE = 'Asia/Karachi';

const ianaOffsetMinutes = (timeZone: string, at: Date): number | null => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
  } catch {
    return null;
  }
};

/**
 * Minutes east of UTC for a profile time zone. The profile stores labels such
 * as "UTC+05:00 (Asia/Karachi)" or "(UTC + 05:00) Islamabad, Karachi": an IANA
 * name wins (it knows about daylight saving), then an explicit offset, then
 * the platform default.
 */
export const utcOffsetMinutes = (timeZone: string | null | undefined, at: Date = new Date()): number => {
  const label = timeZone ?? '';
  const iana = /[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/.exec(label)?.[0];
  if (iana) {
    const offset = ianaOffsetMinutes(iana, at);
    if (offset !== null) return offset;
  }
  const explicit = /UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i.exec(label);
  if (explicit) {
    const minutes = Number(explicit[2]) * 60 + Number(explicit[3] ?? 0);
    return explicit[1] === '-' ? -minutes : minutes;
  }
  return ianaOffsetMinutes(process.env.NOTIFICATIONS_DEFAULT_TIME_ZONE || DEFAULT_TIME_ZONE, at) ?? 0;
};

/** Wall-clock view of `at` in a zone `offset` minutes east of UTC. */
export const localClock = (at: Date, offset: number) => {
  const shifted = new Date(at.getTime() + offset * 60_000);
  return {
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
    /** UTC instant of local midnight that started this local day. */
    dayStart: new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offset * 60_000),
  };
};

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
