export interface ParsedUserAgent {
  /** Human-readable device, e.g. 'MacBook Pro', 'iPhone', 'Windows 11'. */
  device: string;
  /** Browser plus major version, e.g. 'Chrome 126'. */
  browser: string;
  /** Operating system, e.g. 'macOS', 'Windows 11', 'iOS 17'. */
  operatingSystem: string;
}

const UNKNOWN: ParsedUserAgent = {
  device: 'Unknown Device',
  browser: 'Unknown Browser',
  operatingSystem: 'Unknown OS',
};

/**
 * Minimal User-Agent parser for the Sessions screen, which lists entries as
 * "<device> / <browser>" (e.g. "MacBook Pro / Chrome 126").
 *
 * Hand-rolled rather than pulling in a dependency: this only needs to name
 * mainstream desktop/mobile browsers well enough for a human to recognise
 * their own session, and it degrades to "Unknown ..." rather than guessing.
 * Order matters throughout — several browsers impersonate others in their
 * UA string (Edge and Opera both contain "Chrome", Chrome contains "Safari"),
 * so the more specific token is always tested first.
 */
export function parseUserAgent(userAgent?: string | null): ParsedUserAgent {
  if (!userAgent || typeof userAgent !== 'string' || !userAgent.trim()) {
    return { ...UNKNOWN };
  }

  const ua = userAgent;

  const version = (pattern: RegExp): string => {
    const match = ua.match(pattern);
    return match?.[1] ? ` ${match[1].split('.')[0]}` : '';
  };

  // Browser — most specific first.
  let browser = 'Unknown Browser';
  if (/Edg[A-Z]?\//i.test(ua)) browser = `Edge${version(/Edg[A-Z]?\/([\d.]+)/i)}`;
  else if (/OPR\/|Opera/i.test(ua)) browser = `Opera${version(/(?:OPR|Opera)\/([\d.]+)/i)}`;
  else if (/SamsungBrowser\//i.test(ua)) browser = `Samsung Internet${version(/SamsungBrowser\/([\d.]+)/i)}`;
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = `Firefox${version(/(?:Firefox|FxiOS)\/([\d.]+)/i)}`;
  else if (/CriOS\//i.test(ua)) browser = `Chrome${version(/CriOS\/([\d.]+)/i)}`;
  else if (/Chrome\//i.test(ua)) browser = `Chrome${version(/Chrome\/([\d.]+)/i)}`;
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = `Safari${version(/Version\/([\d.]+)/i)}`;
  else if (/PostmanRuntime|curl\/|insomnia/i.test(ua)) browser = 'API Client';

  // Operating system.
  let operatingSystem = 'Unknown OS';
  let device = 'Unknown Device';

  if (/iPhone/i.test(ua)) {
    operatingSystem = `iOS${version(/OS (\d+[_\d]*) like Mac/i).replace(/_/g, '.')}`;
    device = 'iPhone';
  } else if (/iPad/i.test(ua)) {
    operatingSystem = `iPadOS${version(/OS (\d+[_\d]*) like Mac/i).replace(/_/g, '.')}`;
    device = 'iPad';
  } else if (/Android/i.test(ua)) {
    operatingSystem = `Android${version(/Android ([\d.]+)/i)}`;
    // Android UAs carry the model between the last ';' and ')'.
    const model = ua.match(/;\s*([^;)]+)\s*(?:Build\/[^)]*)?\)/i)?.[1]?.trim();
    device = model && !/^Android/i.test(model) ? model : 'Android Device';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    operatingSystem = 'macOS';
    device = 'Mac';
  } else if (/Windows NT/i.test(ua)) {
    // Windows 11 is indistinguishable from 10 in the classic UA string; it
    // only surfaces via Client Hints, which aren't captured here. Reported as
    // "Windows 10/11" rather than picking one and being wrong half the time.
    const nt = ua.match(/Windows NT ([\d.]+)/i)?.[1];
    operatingSystem = nt === '10.0' ? 'Windows 10/11' : nt ? `Windows NT ${nt}` : 'Windows';
    device = operatingSystem;
  } else if (/Linux/i.test(ua)) {
    operatingSystem = 'Linux';
    device = 'Linux Device';
  }

  return { device, browser, operatingSystem };
}
