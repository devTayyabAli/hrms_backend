import { Injectable, Logger } from '@nestjs/common';
import { PolicyType } from '@app/common';

// ==========================================
// VALIDATION RESULT
// ==========================================

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * `requireComplete` separates the two questions a policy configuration has to
 * answer, which used to be conflated:
 *
 *  - Is this well-formed? (types, ranges, cross-field consistency) — always
 *    checked, so a draft can never accumulate garbage.
 *  - Is this finished? (type-specific required fields) — only checked when the
 *    policy is about to go live.
 *
 * Policies are created as DRAFT by definition, so demanding every required
 * field up front made it impossible to start one; meanwhile activation
 * validated nothing at all and would happily publish an empty policy.
 */
type ValidatorFn = (config: Record<string, unknown>, requireComplete: boolean) => ValidationResult;

/** Records a missing required field only when the policy must be complete. */
function requireField(
  config: Record<string, unknown>,
  field: string,
  policyLabel: string,
  requireComplete: boolean,
  errors: string[],
): boolean {
  if (config[field] !== undefined) return true;
  if (requireComplete) {
    errors.push(`${field} is required for ${policyLabel} policy.`);
  }
  return false;
}

// ==========================================
// HELPER UTILITIES
// ==========================================

function ok(): ValidationResult {
  return { isValid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { isValid: false, errors };
}

function isPositiveInt(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return `${fieldName} must be a non-negative integer.`;
  }
  return null;
}

function isBoolean(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') return `${fieldName} must be a boolean.`;
  return null;
}

function isString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') return `${fieldName} must be a non-empty string.`;
  return null;
}

// ==========================================
// INDIVIDUAL POLICY VALIDATORS
// ==========================================

/**
 * LEAVE policy configuration validator.
 * Required: annualAllocation (integer >= 0)
 * Optional: isPaid, carryForward, maximumCarryForward, requiresApproval, noticePeriodDays
 */
function validateLeaveConfiguration(
  config: Record<string, unknown>,
  requireComplete: boolean,
): ValidationResult {
  const errors: string[] = [];

  if (requireField(config, 'annualAllocation', 'LEAVE', requireComplete, errors)) {
    const e = isPositiveInt(config.annualAllocation, 'annualAllocation');
    if (e) errors.push(e);
  }

  const boolFields = ['isPaid', 'carryForward', 'requiresApproval'] as const;
  for (const field of boolFields) {
    const e = isBoolean(config[field], field);
    if (e) errors.push(e);
  }

  if (config.maximumCarryForward !== undefined) {
    const e = isPositiveInt(config.maximumCarryForward, 'maximumCarryForward');
    if (e) errors.push(e);
    if (typeof config.annualAllocation === 'number' && typeof config.maximumCarryForward === 'number') {
      if (config.maximumCarryForward > config.annualAllocation) {
        errors.push('maximumCarryForward cannot exceed annualAllocation.');
      }
    }
  }

  if (config.noticePeriodDays !== undefined) {
    const e = isPositiveInt(config.noticePeriodDays, 'noticePeriodDays');
    if (e) errors.push(e);
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * ATTENDANCE policy configuration validator.
 * Required: trackingMode (string)
 * Optional: gracePeriodMinutes, lateThresholdMinutes, allowOvertime, requireBiometric
 */
function validateAttendanceConfiguration(
  config: Record<string, unknown>,
  requireComplete: boolean,
): ValidationResult {
  const errors: string[] = [];
  const VALID_TRACKING_MODES = ['WEB_CLOCK_IN', 'BIOMETRIC', 'GEOFENCE', 'MANUAL', 'QR_CODE'];

  if (
    requireField(config, 'trackingMode', 'ATTENDANCE', requireComplete, errors) &&
    !VALID_TRACKING_MODES.includes(config.trackingMode as string)
  ) {
    errors.push(`trackingMode must be one of: ${VALID_TRACKING_MODES.join(', ')}.`);
  }

  const intFields = ['gracePeriodMinutes', 'lateThresholdMinutes', 'earlyDepartureThresholdMinutes'] as const;
  for (const field of intFields) {
    const e = isPositiveInt(config[field], field);
    if (e) errors.push(e);
  }

  const boolFields = ['allowOvertime', 'requireBiometric', 'enforceGeofence'] as const;
  for (const field of boolFields) {
    const e = isBoolean(config[field], field);
    if (e) errors.push(e);
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * WORKING_HOURS policy configuration validator.
 * Required: startTime, endTime, workingDays (array)
 * Optional: breakDurationMinutes, timezone, isFlexible
 */
function validateWorkingHoursConfiguration(
  config: Record<string, unknown>,
  requireComplete: boolean,
): ValidationResult {
  const errors: string[] = [];
  const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
  const VALID_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

  if (requireField(config, 'startTime', 'WORKING_HOURS', requireComplete, errors)) {
    const startTimeErr = isString(config.startTime, 'startTime');
    if (startTimeErr) {
      errors.push(startTimeErr);
    } else if (!TIME_REGEX.test(config.startTime as string)) {
      errors.push('startTime must be in HH:MM format (e.g. 09:00).');
    }
  }

  if (
    requireField(config, 'endTime', 'WORKING_HOURS', requireComplete, errors) &&
    !TIME_REGEX.test(config.endTime as string)
  ) {
    errors.push('endTime must be in HH:MM format (e.g. 17:00).');
  }

  if (requireField(config, 'workingDays', 'WORKING_HOURS', requireComplete, errors)) {
    if (!Array.isArray(config.workingDays) || config.workingDays.length === 0) {
      errors.push('workingDays must be a non-empty array.');
    } else {
      const invalid = (config.workingDays as string[]).filter((d) => !VALID_DAYS.includes(d));
      if (invalid.length > 0) {
        errors.push(`Invalid working days: ${invalid.join(', ')}. Must be one of: ${VALID_DAYS.join(', ')}.`);
      }
    }
  }

  if (config.breakDurationMinutes !== undefined) {
    const e = isPositiveInt(config.breakDurationMinutes, 'breakDurationMinutes');
    if (e) errors.push(e);
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * OVERTIME policy configuration validator.
 * Required: enabled (boolean)
 * Optional: minimumMinutes, maximumHoursPerDay, maximumHoursPerWeek, multiplier, requiresApproval
 */
function validateOvertimeConfiguration(
  config: Record<string, unknown>,
  requireComplete: boolean,
): ValidationResult {
  const errors: string[] = [];

  if (requireField(config, 'enabled', 'OVERTIME', requireComplete, errors)) {
    const e = isBoolean(config.enabled, 'enabled');
    if (e) errors.push(e);
  }

  const intFields = ['minimumMinutes', 'maximumHoursPerDay', 'maximumHoursPerWeek'] as const;
  for (const field of intFields) {
    const e = isPositiveInt(config[field], field);
    if (e) errors.push(e);
  }

  if (config.multiplier !== undefined) {
    if (typeof config.multiplier !== 'number' || config.multiplier <= 0) {
      errors.push('multiplier must be a positive number (e.g. 1.5 for 1.5x pay).');
    }
  }

  const boolFields = ['requiresApproval', 'autoApprove'] as const;
  for (const field of boolFields) {
    const e = isBoolean(config[field], field);
    if (e) errors.push(e);
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * REMOTE_WORK policy configuration validator.
 * Optional: allowedDaysPerWeek, requiresApproval, eligibleAfterDays, allowedRoles
 */
function validateRemoteWorkConfiguration(config: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  if (config.allowedDaysPerWeek !== undefined) {
    const e = isPositiveInt(config.allowedDaysPerWeek, 'allowedDaysPerWeek');
    if (e) {
      errors.push(e);
    } else if (typeof config.allowedDaysPerWeek === 'number' && config.allowedDaysPerWeek > 7) {
      errors.push('allowedDaysPerWeek cannot exceed 7.');
    }
  }

  const boolFields = ['requiresApproval', 'allowFullRemote'] as const;
  for (const field of boolFields) {
    const e = isBoolean(config[field], field);
    if (e) errors.push(e);
  }

  if (config.eligibleAfterDays !== undefined) {
    const e = isPositiveInt(config.eligibleAfterDays, 'eligibleAfterDays');
    if (e) errors.push(e);
  }

  if (config.allowedRoles !== undefined && !Array.isArray(config.allowedRoles)) {
    errors.push('allowedRoles must be an array of role strings.');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * PAYROLL policy configuration validator.
 * Required: payFrequency (MONTHLY | BIWEEKLY | WEEKLY)
 * Optional: currency, taxRegion, overtimeMultiplier
 */
function validatePayrollConfiguration(
  config: Record<string, unknown>,
  requireComplete: boolean,
): ValidationResult {
  const errors: string[] = [];
  const VALID_FREQUENCIES = ['MONTHLY', 'BIWEEKLY', 'WEEKLY'];

  if (
    requireField(config, 'payFrequency', 'PAYROLL', requireComplete, errors) &&
    !VALID_FREQUENCIES.includes(config.payFrequency as string)
  ) {
    errors.push(`payFrequency must be one of: ${VALID_FREQUENCIES.join(', ')}.`);
  }

  if (config.currency !== undefined) {
    if (typeof config.currency !== 'string' || (config.currency as string).length !== 3) {
      errors.push('currency must be a 3-letter ISO 4217 code (e.g. USD).');
    }
  }

  if (config.overtimeMultiplier !== undefined) {
    if (typeof config.overtimeMultiplier !== 'number' || config.overtimeMultiplier <= 0) {
      errors.push('overtimeMultiplier must be a positive number.');
    }
  }

  // What overtime is paid on: the basic salary (default), or the earning
  // components marked as part of the overtime base.
  if (config.overtimeBase !== undefined && !['BASIC', 'COMPONENTS'].includes(config.overtimeBase as string)) {
    errors.push('overtimeBase must be BASIC or COMPONENTS.');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * GENERAL / CUSTOM policy configuration validator.
 * Accepts any JSON object, but enforces size limits and rejects dangerous patterns.
 * Has no required fields, so `requireComplete` makes no difference here.
 */
function validateGeneralConfiguration(
  config: Record<string, unknown>,
  _requireComplete = false,
): ValidationResult {
  const errors: string[] = [];

  const serialized = JSON.stringify(config);
  if (serialized.length > 32768) {
    errors.push('Policy configuration exceeds the maximum allowed size of 32KB.');
  }

  // Reject executable-looking patterns
  const dangerous = ['__proto__', 'constructor', 'prototype', 'eval(', 'Function('];
  for (const pattern of dangerous) {
    if (serialized.includes(pattern)) {
      errors.push(`Configuration contains disallowed pattern: "${pattern}".`);
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

// ==========================================
// VALIDATOR REGISTRY SERVICE
// ==========================================

@Injectable()
export class PolicyConfigurationValidatorService {
  private readonly logger = new Logger(PolicyConfigurationValidatorService.name);

  /**
   * Registry mapping PolicyType to its validator function.
   * To add a new policy type: add the entry here + the validator function above.
   */
  private readonly registry: Map<PolicyType, ValidatorFn> = new Map([
    [PolicyType.LEAVE, validateLeaveConfiguration],
    [PolicyType.ATTENDANCE, validateAttendanceConfiguration],
    [PolicyType.WORKING_HOURS, validateWorkingHoursConfiguration],
    [PolicyType.OVERTIME, validateOvertimeConfiguration],
    [PolicyType.REMOTE_WORK, validateRemoteWorkConfiguration],
    [PolicyType.PAYROLL, validatePayrollConfiguration],
    [PolicyType.GENERAL, validateGeneralConfiguration],
  ]);

  /**
   * Validate policy configuration against the type-specific schema.
   * Falls back to general validation if the type has no registered validator.
   *
   * `requireComplete` defaults to false so drafts can be saved partially
   * filled; pass true on activation, where the policy actually takes effect.
   */
  validate(
    policyType: PolicyType,
    configuration: Record<string, unknown>,
    requireComplete = false,
  ): ValidationResult {
    if (!configuration || typeof configuration !== 'object') {
      return fail(['configuration must be a non-null JSON object.']);
    }

    // Always run general safety checks first
    const generalResult = validateGeneralConfiguration(configuration, requireComplete);
    if (!generalResult.isValid) return generalResult;

    const validator = this.registry.get(policyType);
    if (!validator) {
      this.logger.warn(`No specific validator found for policy type: ${policyType}. Applying general validation.`);
      return ok();
    }

    return validator(configuration, requireComplete);
  }
}
