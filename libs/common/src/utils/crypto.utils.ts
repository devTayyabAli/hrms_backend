import * as crypto from 'crypto';

/**
 * AES-256-GCM field-level encryption for sensitive column values (DB
 * credentials, 2FA secrets, ...). Format: `iv:authTag:ciphertext` (hex).
 *
 * The key is derived from ENCRYPTION_KEY via SHA-256 — there is
 * deliberately no fallback default: encrypting sensitive data with a key
 * that's hardcoded in source (and therefore in every clone of this repo)
 * is equivalent to not encrypting it at all, so a missing key fails loudly
 * at first use instead of silently protecting nothing.
 *
 * Because the IV is random per call, the same plaintext never produces the
 * same ciphertext twice — an encrypted column can never be used in an
 * exact-match SQL WHERE clause, unique constraint, or JOIN. Only apply this
 * to fields that are always read back by a different key (row id, foreign
 * key, ...), never searched by their own value.
 */
export class CryptoUtils {
  private static readonly ALGORITHM = 'aes-256-gcm';

  /**
   * Minimum accepted ENCRYPTION_KEY length.
   *
   * SHA-256 is a fast hash, not a password KDF: it applies no work factor and
   * no salt, so an attacker holding ciphertext can test candidate keys at
   * billions per second. That is a perfectly good key-derivation step for a
   * key with real entropy behind it, and no protection at all for a
   * human-chosen passphrase.
   *
   * Switching to scrypt/PBKDF2 is not available as a fix: the derivation is
   * baked into every value already encrypted with it (tenant DB passwords,
   * 2FA secrets), so changing it would make all of them undecryptable without
   * a migration that re-encrypts every row. The workable guarantee is the
   * other side of the same inequality — require that ENCRYPTION_KEY actually
   * has the entropy SHA-256 assumes it has.
   *
   * 32 characters is the floor for a random hex or base64 key, which is what
   * this variable is meant to hold.
   */
  private static readonly MIN_KEY_LENGTH = 32;

  /** Validated once per process; revalidated if the variable is changed. */
  private static validatedKey: string | null = null;

  private static getSecretKey(): Buffer {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error(
        'SECURITY CONFIGURATION ERROR: ENCRYPTION_KEY environment variable is required and must not be empty.',
      );
    }

    if (this.validatedKey !== encryptionKey) {
      this.assertKeyStrength(encryptionKey);
      this.validatedKey = encryptionKey;
    }

    return crypto.createHash('sha256').update(encryptionKey).digest();
  }

  /**
   * Rejects a key weak enough that the SHA-256 derivation above cannot carry
   * it — short, or drawn from too small an alphabet to reach the length's
   * nominal entropy (`aaaaaaaa...`, `password_password_password_pass`).
   *
   * Deliberately thrown at first use rather than warned about: a weak key
   * means the encrypted columns are not meaningfully encrypted, and a warning
   * in a log nobody reads would leave that true indefinitely.
   */
  private static assertKeyStrength(key: string): void {
    if (key.length < this.MIN_KEY_LENGTH) {
      throw new Error(
        `SECURITY CONFIGURATION ERROR: ENCRYPTION_KEY must be at least ${this.MIN_KEY_LENGTH} characters (got ${key.length}). ` +
          'It is used as raw key material, not a passphrase — generate one with `openssl rand -hex 32`.',
      );
    }

    // A key of the required length built from three or four distinct
    // characters has nowhere near the entropy its length suggests. This is a
    // floor against obviously-placeholder values, not an entropy estimator.
    const distinctChars = new Set(key).size;
    if (distinctChars < 12) {
      throw new Error(
        `SECURITY CONFIGURATION ERROR: ENCRYPTION_KEY is long enough but uses only ${distinctChars} distinct characters, ` +
          'so it carries far less entropy than its length implies. Generate a random key with `openssl rand -hex 32`.',
      );
    }
  }

  /**
   * Encrypt a sensitive text (e.g. tenant DB password, 2FA secret)
   */
  /**
   * Why ENCRYPTION_KEY can't be used, or null when it can. For a startup
   * check: a bad key otherwise surfaces only as a 500 the first time
   * something is encrypted (e.g. 2FA setup).
   */
  static configurationProblem(): string | null {
    try {
      this.getSecretKey();
      return null;
    } catch (error: any) {
      return error?.message ?? String(error);
    }
  }

  static encrypt(text: string): string {
    if (!text) return text;
    const key = this.getSecretKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypt an encrypted text. A value that doesn't match the
   * `iv:authTag:ciphertext` shape is treated as legacy plaintext (written
   * before field encryption was introduced) and returned as-is. A value
   * that DOES match the shape but fails to decrypt — wrong key, or
   * tampered/corrupted ciphertext (GCM's auth tag won't verify) — throws,
   * rather than silently handing back undecryptable ciphertext as if it
   * were valid plaintext.
   */
  static decrypt(cipherText: string): string {
    if (!cipherText || !cipherText.includes(':')) return cipherText;

    const parts = cipherText.split(':');
    if (parts.length !== 3) return cipherText;
    const [ivHex, authTagHex, encryptedText] = parts;

    const key = this.getSecretKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
