/**
 * Time-zone arithmetic shared by anything that runs "at 09:00 local": the
 * platform's notification digests and quiet hours, and scheduled backups.
 */

export const DEFAULT_PLATFORM_TIME_ZONE = 'Asia/Karachi';

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
  return ianaOffsetMinutes(process.env.NOTIFICATIONS_DEFAULT_PLATFORM_TIME_ZONE || DEFAULT_PLATFORM_TIME_ZONE, at) ?? 0;
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
