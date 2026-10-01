import { BadRequestException, Injectable } from '@nestjs/common';
import { SecuritySettingsService } from './security-settings.service';

/**
 * Enforces the Security tab's *configured* password policy, in addition to
 * (not instead of) the static `@IsStrongPassword()` DTO decorator
 * (`libs/common/src/validators/strong-password.validator.ts`), which stays
 * as an unconditional baseline. That baseline can't be weakened by an admin
 * lowering the configured policy — only strengthened — so a misconfigured
 * (e.g. accidentally too-short) policy can never drop security below what
 * shipped by default. Rules the admin sets *stricter* than the baseline are
 * fully enforced here.
 */
@Injectable()
export class PasswordPolicyService {
  constructor(private readonly securitySettingsService: SecuritySettingsService) {}

  async validate(password: string): Promise<void> {
    const policy = await this.securitySettingsService.getOrCreate();
    const failures: string[] = [];

    if (password.length < policy.passwordMinLength) {
      failures.push(`at least ${policy.passwordMinLength} characters`);
    }
    if (policy.passwordRequireUppercase && !/[A-Z]/.test(password)) {
      failures.push('an uppercase letter');
    }
    if (policy.passwordRequireLowercase && !/[a-z]/.test(password)) {
      failures.push('a lowercase letter');
    }
    if (policy.passwordRequireNumbers && !/\d/.test(password)) {
      failures.push('a number');
    }
    if (policy.passwordRequireSpecialChars && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
      failures.push('a special character');
    }

    if (failures.length > 0) {
      throw new BadRequestException(`Password does not meet the platform's password policy: requires ${failures.join(', ')}.`);
    }
  }
}
