import type { ConfigService } from '@nestjs/config';

/**
 * Reads `JWT_SECRET`, refusing to start without it.
 *
 * Two call sites previously fell back to a hardcoded
 * `'temporary-fallback-for-tests-only'` string: the passport strategy that
 * *verifies* access tokens, and the `JwtModule` registration that signs and
 * verifies them. A literal committed to the repository is a published signing
 * key — anyone reading the source could mint a token with
 * `isSuperAdmin: true` and be accepted by every guard in the platform. Because
 * the fallback kept the app booting, a deployment missing the variable looked
 * healthy instead of failing.
 *
 * Exists as one function so a third consumer cannot quietly reintroduce the
 * default: the only supported way to obtain the secret also enforces it.
 *
 * Throwing from a module factory aborts bootstrap, which is the intended
 * behaviour — an auth service that cannot verify tokens has no safe degraded
 * mode to run in.
 */
export const requireJwtSecret = (config: ConfigService): string => {
  const secret = config.get<string>('JWT_SECRET');

  // Covers unset, empty and whitespace-only — all of which a shell can produce
  // from a misquoted or blank line in an env file.
  if (!secret || secret.trim() === '') {
    throw new Error(
      'SECURITY: JWT_SECRET is required and must not be empty. Refusing to start — ' +
        'without it, tokens would be signed and verified with a key that is public in source control.',
    );
  }

  return secret;
};
