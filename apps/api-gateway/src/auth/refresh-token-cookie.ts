import type { CookieOptions, Request, Response } from 'express';

/**
 * The refresh token is delivered to browsers as an httpOnly cookie rather than
 * in the response body.
 *
 * It used to be returned in the body, which left the client no choice but to
 * keep it in `localStorage` — readable by any script on the page, so a single
 * XSS payload could exfiltrate a long-lived credential and silently hold the
 * session open. An httpOnly cookie is not readable from JavaScript at all, so
 * the same payload cannot steal it; the access token stays in the body and
 * lives only in memory, where its short lifetime bounds the damage.
 */
export const REFRESH_COOKIE_NAME = 'hrms_refresh_token';

/**
 * Restricting the cookie to the auth routes means it is not attached to the
 * hundreds of ordinary API calls that have no use for it — it only travels
 * where it is actually redeemed. Includes the global `api/v1` prefix.
 */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Mirrors JWT_REFRESH_EXPIRES_IN (7d) so the cookie dies with the token. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `sameSite` is configurable because it depends on how the app is deployed.
 * Same-site (app.example.com + api.example.com, or localhost:5173 +
 * localhost:3000 — ports don't affect site) works with the `lax` default.
 * A genuinely cross-site API needs `none`, which browsers only accept
 * alongside `secure`, so that combination is forced rather than left to
 * produce a cookie the browser silently drops.
 */
const resolveSameSite = (): CookieOptions['sameSite'] => {
  const configured = (process.env.REFRESH_COOKIE_SAMESITE || 'lax').toLowerCase();
  return configured === 'none' ? 'none' : configured === 'strict' ? 'strict' : 'lax';
};

export const refreshCookieOptions = (): CookieOptions => {
  const sameSite = resolveSameSite();
  return {
    httpOnly: true,
    // `sameSite: 'none'` is rejected by browsers unless the cookie is secure.
    secure: sameSite === 'none' || process.env.NODE_ENV === 'production',
    sameSite,
    path: REFRESH_COOKIE_PATH,
    maxAge: Number(process.env.REFRESH_COOKIE_MAX_AGE_MS) || DEFAULT_MAX_AGE_MS,
  };
};

export const setRefreshCookie = (res: Response, refreshToken: string): void => {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
};

export const clearRefreshCookie = (res: Response): void => {
  // `maxAge` is dropped deliberately: clearCookie must match the cookie's
  // name/path/flags to remove it, and carrying an expiry would set a new one.
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options);
};

/**
 * Prefers the cookie, falling back to the request body.
 *
 * The fallback keeps non-browser callers — Swagger, service-to-service scripts,
 * mobile clients that hold their own secure storage — working. It is not a way
 * back into the vulnerability: the browser path never puts the token anywhere
 * a script can read, so nothing in the browser has a token to send in a body.
 */
export const readRefreshToken = (req: Request, bodyToken?: string): string | undefined =>
  (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME] || bodyToken;

/**
 * Splits an auth-service token pair into the part the browser may see and the
 * part that only belongs in the cookie.
 */
export const withoutRefreshToken = <T extends Record<string, any>>(payload: T): Omit<T, 'refreshToken'> => {
  const { refreshToken: _refreshToken, ...rest } = payload ?? ({} as T);
  return rest;
};
