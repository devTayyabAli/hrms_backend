import * as fs from 'fs';
import * as path from 'path';
import { Model, Sequelize } from 'sequelize-typescript';
import { bindModelsToConnection, resolveDbCredentials } from '@app/database';

/**
 * Shared connection factories, database-name derivation, ops-log
 * read/write, and CLI-flag parsing for the tenant-isolation cutover scripts
 * (migrate / backup-verify / rollback / archive). Kept in one place so a fix
 * to sanitization or connection options doesn't need to be hand-applied to
 * four near-identical copies.
 */

export function tenantDatabaseName(tenantId: string): string {
  const safeId = tenantId.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  return `hrms_${safeId}`;
}

export function createPlatformConnection(): Sequelize {
  const creds = resolveDbCredentials('platform');
  return new Sequelize({
    host: creds.host,
    port: creds.port,
    username: creds.username,
    password: creds.password,
    database: process.env.PLATFORM_DB_NAME || 'neondb',
    dialect: 'postgres',
    dialectOptions: creds.dialectOptions,
    logging: false,
  });
}

export function createTenantConnection(databaseName: string): Sequelize {
  const creds = resolveDbCredentials('tenant');
  return new Sequelize({
    host: creds.host,
    port: creds.port,
    username: creds.username,
    password: creds.password,
    database: databaseName,
    dialect: 'postgres',
    dialectOptions: creds.dialectOptions,
    logging: false,
  });
}

/**
 * Registers `models` on `connection` as independent per-connection
 * subclasses (see `bindModelsToConnection` in `@app/database`). Every script
 * here opens a platform connection plus one tenant connection per tenant in
 * the same process and registers the *same* imported model classes on each
 * — using `connection.addModels()` directly would silently repoint an
 * earlier connection's (e.g. the platform DB's) cached model handle at
 * whichever connection registers those classes next.
 */
export function bindOperationalModels(
  connection: Sequelize,
  models: Array<typeof Model>,
): void {
  bindModelsToConnection(models, connection);
}

export interface CliFlags {
  dryRun: boolean;
  force: boolean;
}

export function parseCliFlags(
  argv: string[] = process.argv.slice(2),
): CliFlags {
  return {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

const DEFAULT_OPS_LOG_DIR = path.join(process.cwd(), 'ops-logs');

/** Writes `data` as pretty-printed JSON under the (gitignored) ops-logs directory. */
export function writeOpsLog(
  filename: string,
  data: unknown,
  dir: string = DEFAULT_OPS_LOG_DIR,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

/** Reads a previously written ops log, or null if it doesn't exist / isn't valid JSON. */
export function readOpsLog<T = any>(
  filename: string,
  dir: string = DEFAULT_OPS_LOG_DIR,
): T | null {
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Throws if `name` is not a member of `allowlist` — for guarding raw-SQL identifier interpolation. */
export function assertKnownIdentifier(
  name: string,
  allowlist: readonly string[],
): void {
  if (!allowlist.includes(name)) {
    throw new Error(
      `Refusing to operate on unrecognized identifier "${name}" (not in the allowlist).`,
    );
  }
}
