import type { Request } from 'express';

/**
 * The signed-in user's approximate location, as the edge proxy in front of
 * the gateway reports it — "Lahore, Punjab, PK".
 *
 * Vercel (`x-vercel-ip-city` / `-country-region` / `-country`) and Cloudflare
 * (`cf-ipcity` / `cf-region` / `cf-ipcountry`) geolocate every request at
 * their edge and attach the result as headers, so no geo-IP database or
 * third-party lookup is needed here — and the user's IP is never sent
 * anywhere to get it.
 *
 * Only read when TRUST_PROXY is set: the same setting that makes the
 * gateway trust X-Forwarded-For. Without a trusted proxy in front, anyone
 * could send these headers themselves.
 */
export const requestLocation = (req: Request): string | undefined => {
  if (!process.env.TRUST_PROXY?.trim()) return undefined;

  const header = (name: string): string | undefined => {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value?.trim()) return undefined;
    try {
      // Vercel URL-encodes the city ("S%C3%A3o%20Paulo").
      return decodeURIComponent(value.trim());
    } catch {
      return value.trim();
    }
  };

  const city = header('x-vercel-ip-city') ?? header('cf-ipcity');
  const region = header('x-vercel-ip-country-region') ?? header('cf-region');
  const country = header('x-vercel-ip-country') ?? header('cf-ipcountry');
  // Cloudflare's "unknown" (XX) and Tor (T1) codes aren't places.
  const usableCountry = country && !['XX', 'T1'].includes(country.toUpperCase()) ? country.toUpperCase() : undefined;

  // A region code is noise next to the same city name ("Karachi, SD").
  const parts = [city, region && region !== city ? region : undefined, usableCountry].filter(Boolean);
  return parts.length ? parts.join(', ').slice(0, 120) : undefined;
};
