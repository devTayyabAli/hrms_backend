/**
 * Re-saves the platform's encrypted columns after secrets are rotated.
 *
 *   - tenant_database_configs.password: set to the NEW database password
 *     (TENANT_DB_PASSWORD), encrypted with the NEW ENCRYPTION_KEY. The backup
 *     job and the storage report connect with these.
 *   - super_admins."twoFactorSecret": decrypted with OLD_ENCRYPTION_KEY and
 *     re-encrypted with the NEW ENCRYPTION_KEY, so 2FA keeps working.
 *
 * Usage (environment already holds the NEW values):
 *   OLD_ENCRYPTION_KEY=<previous key> npm run db:rotate-secrets            # dry run
 *   OLD_ENCRYPTION_KEY=<previous key> npm run db:rotate-secrets -- --apply # write
 *
 * In Docker:
 *   docker compose --profile tools run --rm -e OLD_ENCRYPTION_KEY=<previous key> tools db:rotate-secrets -- --apply
 *
 * Nothing secret is printed — only counts and ids.
 */
import * as dotenv from 'dotenv';
import { CryptoUtils } from '@app/common';
import { createPlatformConnection } from './lib/tenant-script-utils';

dotenv.config();

const apply = process.argv.includes('--apply');

/** CryptoUtils reads ENCRYPTION_KEY on every call, so swapping it switches keys. */
const withKey = <T>(key: string, run: () => T): T => {
  const current = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = key;
  try {
    return run();
  } finally {
    process.env.ENCRYPTION_KEY = current;
  }
};

async function main() {
  const oldKey = process.env.OLD_ENCRYPTION_KEY;
  const newKey = process.env.ENCRYPTION_KEY;
  const newDbPassword = process.env.TENANT_DB_PASSWORD;
  if (!oldKey || !newKey)
    throw new Error(
      'Set OLD_ENCRYPTION_KEY (previous) and ENCRYPTION_KEY (new).',
    );
  if (!newDbPassword)
    throw new Error('Set TENANT_DB_PASSWORD to the new database password.');
  const problem = CryptoUtils.configurationProblem();
  if (problem)
    throw new Error(`The new ENCRYPTION_KEY can't be used: ${problem}`);

  const connection = createPlatformConnection();
  const transaction = await connection.transaction();
  try {
    const [configs]: any = await connection.query(
      'SELECT id, "tenantId" FROM tenant_database_configs',
      { transaction },
    );
    for (const config of configs) {
      if (apply) {
        await connection.query(
          'UPDATE tenant_database_configs SET password = :password, "updatedAt" = NOW() WHERE id = :id',
          {
            replacements: {
              id: config.id,
              password: withKey(newKey, () =>
                CryptoUtils.encrypt(newDbPassword),
              ),
            },
            transaction,
          },
        );
      }
    }
    console.log(
      `Organization database credentials: ${configs.length} ${apply ? 'updated' : 'to update'}.`,
    );

    const [admins]: any = await connection.query(
      'SELECT id, "twoFactorSecret" FROM super_admins WHERE "twoFactorSecret" IS NOT NULL AND "twoFactorSecret" <> \'\'',
      { transaction },
    );
    let reencrypted = 0;
    const failed: string[] = [];
    for (const admin of admins) {
      let plain: string;
      try {
        plain = withKey(oldKey, () =>
          CryptoUtils.decrypt(admin.twoFactorSecret),
        );
      } catch {
        failed.push(admin.id);
        continue;
      }
      if (apply) {
        await connection.query(
          'UPDATE super_admins SET "twoFactorSecret" = :secret WHERE id = :id',
          {
            replacements: {
              id: admin.id,
              secret: withKey(newKey, () => CryptoUtils.encrypt(plain)),
            },
            transaction,
          },
        );
      }
      reencrypted++;
    }
    console.log(
      `Super Admin 2FA secrets: ${reencrypted} ${apply ? 're-encrypted' : 'to re-encrypt'}.`,
    );
    if (failed.length) {
      console.warn(
        `${failed.length} could not be decrypted with OLD_ENCRYPTION_KEY (ids: ${failed.join(', ')}). ` +
          'They were left as they are; those Super Admins must turn 2FA off and on again.',
      );
    }

    if (apply) await transaction.commit();
    else await transaction.rollback();
    console.log(
      apply ? 'Done.' : 'Dry run — nothing was written. Re-run with --apply.',
    );
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
