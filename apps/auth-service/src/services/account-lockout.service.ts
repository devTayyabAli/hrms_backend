import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { SecuritySettingsService } from './security-settings.service';

/** Any account record carrying the lockout columns (SuperAdmin or AuthCredential). */
interface LockableAccount {
  email: string;
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
  update(values: Record<string, unknown>): Promise<unknown>;
}

/**
 * Real enforcement of the Security tab's "Lockout Time" setting: repeated
 * failed logins lock an account for the configured number of minutes. Shared
 * by the SuperAdmin and tenant-admin login paths so both behave identically.
 */
@Injectable()
export class AccountLockoutService {
  private readonly logger = new Logger(AccountLockoutService.name);

  constructor(private readonly securitySettingsService: SecuritySettingsService) {}

  /** Throws while the account is still within its lockout window. */
  assertNotLocked(account: LockableAccount): void {
    if (!account.lockedUntil) return;

    const remainingMs = new Date(account.lockedUntil).getTime() - Date.now();
    if (remainingMs <= 0) return;

    const remainingMinutes = Math.ceil(remainingMs / 60000);
    throw new ForbiddenException(
      `Account is temporarily locked after too many failed login attempts. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
    );
  }

  /**
   * Records a failed attempt and locks the account once the configured
   * threshold is reached. An expired lockout window resets the counter first,
   * so old failures never accumulate into a surprise lock much later.
   */
  async registerFailedAttempt(account: LockableAccount): Promise<void> {
    const settings = await this.securitySettingsService.getOrCreate();

    const windowExpired = account.lockedUntil && new Date(account.lockedUntil).getTime() <= Date.now();
    const previous = windowExpired ? 0 : account.failedLoginAttempts || 0;
    const attempts = previous + 1;

    if (attempts >= settings.maxFailedLoginAttempts) {
      const lockedUntil = new Date(Date.now() + settings.lockoutMinutes * 60000);
      await account.update({ failedLoginAttempts: attempts, lockedUntil });
      this.logger.warn(
        `Locked account ${account.email} until ${lockedUntil.toISOString()} after ${attempts} failed attempts.`,
      );
      return;
    }

    await account.update({ failedLoginAttempts: attempts, lockedUntil: null });
  }

  /** Clears lockout state after a successful authentication. */
  async registerSuccess(account: LockableAccount): Promise<void> {
    if (!account.failedLoginAttempts && !account.lockedUntil) return;
    await account.update({ failedLoginAttempts: 0, lockedUntil: null });
  }
}
