import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export enum TwoFactorMethod {
  TOTP = 'TOTP',
  EMAIL_OTP = 'EMAIL_OTP',
  SMS_OTP = 'SMS_OTP',
}

/**
 * Singleton row — platform-wide Security tab settings. Password-policy
 * fields are enforced for real (see PasswordPolicyService); `require2FA*`
 * flags are only enforced for `require2FASuperAdmins` today (the login
 * flows the other roles would need don't exist yet — see field comments on
 * UpdateSecuritySettingsDto). `ipWhitelistEnabled` is enforced for real via
 * IpAllowlistGuard on every `/superadmin/*` route.
 */
@Table({ tableName: 'security_settings' })
export class SecuritySettings extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Default(12)
  @Column
  declare passwordMinLength: number;

  @Default(true)
  @Column
  declare passwordRequireUppercase: boolean;

  @Default(true)
  @Column
  declare passwordRequireLowercase: boolean;

  @Default(true)
  @Column
  declare passwordRequireNumbers: boolean;

  @Default(true)
  @Column
  declare passwordRequireSpecialChars: boolean;

  @Default(false)
  @Column
  declare require2FASuperAdmins: boolean;

  @Default(false)
  @Column
  declare require2FAAdmins: boolean;

  @Default(false)
  @Column
  declare require2FAEditors: boolean;

  @Default(false)
  @Column
  declare require2FAHRUsers: boolean;

  @Default(false)
  @Column
  declare require2FAEmployees: boolean;

  @Default(TwoFactorMethod.TOTP)
  @Column({ type: DataType.ENUM(...Object.values(TwoFactorMethod)) })
  declare twoFactorMethod: TwoFactorMethod;

  @Default(false)
  @Column
  declare ipWhitelistEnabled: boolean;

  /** How long an account stays locked after too many failed logins. */
  @Default(15)
  @Column
  declare lockoutMinutes: number;

  @Default(5)
  @Column
  declare maxFailedLoginAttempts: number;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
