import { registerDecorator, ValidationOptions } from 'class-validator';

export const STRONG_PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{12,}$/;

export const STRONG_PASSWORD_MESSAGE =
  'Password must be at least 12 characters and include an uppercase letter, a lowercase letter, a number, and a symbol (@$!%*?&).';

/**
 * Enforces the platform password policy: 12+ chars, upper, lower, digit, symbol.
 */
export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options: {
        message: STRONG_PASSWORD_MESSAGE,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && STRONG_PASSWORD_REGEX.test(value);
        },
      },
    });
  };
}
