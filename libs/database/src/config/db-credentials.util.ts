export interface ResolvedDbCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  dialectOptions?: { ssl: { require: true; rejectUnauthorized: boolean } };
}

/**
 * Resolves database connection credentials strictly from environment
 * variables — never a hardcoded fallback password. Throws immediately if
 * the password is missing, so a misconfigured deployment fails loudly at
 * the point of connecting instead of silently using a guessable default
 * ('password') that an attacker could try against any exposed DB port.
 *
 * `kind` selects which *_DB_* variable prefix to read: 'platform' for the
 * shared platform/superadmin database, 'tenant' for the per-tenant database
 * template (host/user/password only — the actual per-tenant database NAME
 * is generated separately, see TenantConnectionManager).
 */
export function resolveDbCredentials(kind: 'platform' | 'tenant'): ResolvedDbCredentials {
  const prefix = kind === 'platform' ? 'PLATFORM_DB' : 'TENANT_DB';
  const host = process.env[`${prefix}_HOST`] || 'localhost';
  const port = parseInt(process.env[`${prefix}_PORT`] || '5432', 10);
  const username = process.env[`${prefix}_USER`] || 'postgres';
  const password = process.env[`${prefix}_PASSWORD`];

  if (!password) {
    throw new Error(
      `SECURITY CONFIGURATION ERROR: ${prefix}_PASSWORD environment variable is required and must not be empty.`,
    );
  }

  const dbUrl = process.env.PLATFORM_DB_URL || process.env.DATABASE_URL;
  const isSSL =
    host.includes('neon.tech') ||
    process.env.PLATFORM_DB_HOST?.includes('neon.tech') ||
    process.env.TENANT_DB_HOST?.includes('neon.tech') ||
    dbUrl?.includes('sslmode=require') ||
    process.env.DB_SSL === 'true';

  return {
    host,
    port,
    username,
    password,
    // Strict certificate validation in production; permissive in
    // dev/staging where DB providers (e.g. local Docker Postgres) commonly
    // present self-signed certs that would otherwise block every connection.
    dialectOptions: isSSL
      ? { ssl: { require: true, rejectUnauthorized: process.env.NODE_ENV === 'production' } }
      : undefined,
  };
}
