/**
 * bcrypt cost factor for password hashing.
 * NIST/OWASP minimum recommendation is 12 rounds.
 */
export const BCRYPT_SALT_ROUNDS = 12;

/** Number of previous password hashes retained to block reuse. */
export const PASSWORD_HISTORY_LIMIT = 5;

/** Default password max age, in days, before it's flagged as expired. */
export const DEFAULT_PASSWORD_EXPIRY_DAYS = 90;
