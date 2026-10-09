import {
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  ValidateIf,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ==========================================
// GENERAL SETTINGS
// ==========================================

export enum SidebarStyle {
  EXPANDED = 'expanded',
  COLLAPSED = 'collapsed',
}

export enum ThemeMode {
  LIGHT = 'light',
  DARK = 'dark',
}

export enum TimeFormat {
  H12 = '12h',
  H24 = '24h',
}

/** Sidebar looks the Super Admin portal offers. */
export const SIDEBAR_VARIANTS = ['Dark', 'Light', 'Compact'] as const;
/** Default colour scheme; "System" follows each viewer's device. */
export const THEME_PREFERENCES = ['Light', 'Dark', 'System'] as const;

export class UpdateGeneralSettingsDto {
  @ApiPropertyOptional({ example: 'Fuutura HRMS', description: 'Sender name and header of every platform email; browser tab title.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  platformName?: string;

  @ApiPropertyOptional({ example: 'Smart HR, Simplified', description: 'Shown under the platform name in emails.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  platformTagline?: string;

  @ApiPropertyOptional({ example: '#3F93F6' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'primaryColor must be a hex color like #3F93F6' })
  primaryColor?: string;

  @ApiPropertyOptional({ example: '#0F1520' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'secondaryColor must be a hex color like #0F1520' })
  secondaryColor?: string;

  @ApiPropertyOptional({ example: 'Fuutura Technologies', description: 'Copyright line in email footers.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  companyName?: string;

  @ApiPropertyOptional({ example: 'support@fuutura.com', description: 'Reply-to and contact address in every email.' })
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsEmail({}, { message: 'supportEmail must be a valid email address.' })
  supportEmail?: string;

  @ApiPropertyOptional({ enum: SIDEBAR_VARIANTS })
  @IsOptional()
  @IsIn(SIDEBAR_VARIANTS as unknown as string[])
  sidebarVariant?: string;

  @ApiPropertyOptional({ enum: THEME_PREFERENCES })
  @IsOptional()
  @IsIn(THEME_PREFERENCES as unknown as string[])
  defaultTheme?: string;

  @ApiPropertyOptional({ enum: SidebarStyle })
  @IsOptional()
  @IsEnum(SidebarStyle)
  sidebarStyle?: SidebarStyle;

  @ApiPropertyOptional({ enum: ThemeMode })
  @IsOptional()
  @IsEnum(ThemeMode)
  themeMode?: ThemeMode;

  @ApiPropertyOptional({ example: 'DD MM YYYY' })
  @IsOptional()
  @IsString()
  dateFormat?: string;

  @ApiPropertyOptional({ enum: TimeFormat })
  @IsOptional()
  @IsEnum(TimeFormat)
  timeFormat?: TimeFormat;

  @ApiPropertyOptional({ example: 'PKR' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableMultiLanguage?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enable2FAForAllAdmins?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableMaintenanceModeNotifications?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowUsersToExportData?: boolean;
}

// ==========================================
// SECURITY SETTINGS
// ==========================================

/** Idle-timeout choices offered (minutes); 0 = sessions never time out for inactivity. */
export const SESSION_IDLE_TIMEOUT_OPTIONS = [0, 15, 30, 60, 120, 240, 480, 1440] as const;
/** Password-expiry choices offered (days); 0 = passwords never expire. */
export const PASSWORD_EXPIRY_OPTIONS = [0, 30, 60, 90, 180, 365] as const;

export enum TwoFactorMethod {
  TOTP = 'TOTP',
  EMAIL_OTP = 'EMAIL_OTP',
  SMS_OTP = 'SMS_OTP',
}

export class UpdateSecuritySettingsDto {
  @ApiPropertyOptional({ example: 12, minimum: 6, maximum: 64 })
  @IsOptional()
  @IsInt()
  @Min(6)
  @Max(64)
  passwordMinLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRequireUppercase?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRequireLowercase?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRequireNumbers?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRequireSpecialChars?: boolean;

  @ApiPropertyOptional({ description: 'Real enforcement on the SuperAdmin login flow.' })
  @IsOptional()
  @IsBoolean()
  require2FASuperAdmins?: boolean;

  @ApiPropertyOptional({ description: 'Stored only — tenant Admin login has no 2FA step implemented yet.' })
  @IsOptional()
  @IsBoolean()
  require2FAAdmins?: boolean;

  @ApiPropertyOptional({ description: 'Stored only — no "Editor" role or login path exists in this codebase yet.' })
  @IsOptional()
  @IsBoolean()
  require2FAEditors?: boolean;

  @ApiPropertyOptional({ description: 'Stored only — HR tenant users have no login path implemented yet.' })
  @IsOptional()
  @IsBoolean()
  require2FAHRUsers?: boolean;

  @ApiPropertyOptional({ description: 'Stored only — Employee tenant users have no login path implemented yet.' })
  @IsOptional()
  @IsBoolean()
  require2FAEmployees?: boolean;

  @ApiPropertyOptional({ enum: TwoFactorMethod, description: 'Only TOTP is actually implemented; EMAIL_OTP/SMS_OTP are stored as a preference only.' })
  @IsOptional()
  @IsEnum(TwoFactorMethod)
  twoFactorMethod?: TwoFactorMethod;

  @ApiPropertyOptional({ description: 'Real enforcement — gates all /superadmin/* routes via IpAllowlistGuard.' })
  @IsOptional()
  @IsBoolean()
  ipWhitelistEnabled?: boolean;

  @ApiPropertyOptional({
    example: 15,
    minimum: 1,
    maximum: 1440,
    description: 'Real enforcement — how long an account is locked after too many failed logins.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  lockoutMinutes?: number;

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 20, description: 'Failed attempts before lockout.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxFailedLoginAttempts?: number;

  @ApiPropertyOptional({
    example: 60,
    enum: SESSION_IDLE_TIMEOUT_OPTIONS,
    description: 'Sign out a session after this many minutes without activity. 0 = never.',
  })
  @IsOptional()
  @IsInt()
  @IsIn(SESSION_IDLE_TIMEOUT_OPTIONS as unknown as number[])
  sessionIdleTimeoutMinutes?: number;

  @ApiPropertyOptional({
    example: 90,
    enum: PASSWORD_EXPIRY_OPTIONS,
    description: 'Days before a password must be changed. 0 = never.',
  })
  @IsOptional()
  @IsInt()
  @IsIn(PASSWORD_EXPIRY_OPTIONS as unknown as number[])
  passwordExpiryDays?: number;
}

/**
 * The gateway's call to update security settings. `callerIp` is the address
 * the request came from, so an allowlist change that would shut the
 * administrator making it out can be refused.
 */
export class UpdateSecuritySettingsMessageDto {
  @ValidateNested()
  @Type(() => UpdateSecuritySettingsDto)
  @IsDefined()
  dto: UpdateSecuritySettingsDto;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  callerIp?: string;
}

export class AddAllowedIpDto {
  @ApiProperty({ example: '203.0.113.25', description: 'An IPv4/IPv6 address or CIDR block' })
  @IsString()
  @IsNotEmpty()
  ipOrCidr: string;
}

/** Internal RPC-only payload for the gateway's IpAllowlistGuard. */
export class CheckIpAllowedDto {
  @ApiProperty({ example: '203.0.113.25' })
  @IsString()
  @IsNotEmpty()
  ip: string;
}

// ==========================================
// CUSTOM DOMAINS
// ==========================================

export enum DomainStatus {
  PRIMARY = 'PRIMARY',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export const DOMAIN_NAME_REGEX = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export class AddDomainDto {
  @ApiProperty({ example: 'careers.fuutura.com' })
  @IsString()
  @Matches(DOMAIN_NAME_REGEX, { message: 'domain must be a valid domain name, e.g. hr.yourcompany.com' })
  domain: string;

  @ApiPropertyOptional({ enum: DomainStatus, default: DomainStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DomainStatus)
  status?: DomainStatus;
}

export class UpdateDomainDto {
  @ApiPropertyOptional({ enum: DomainStatus })
  @IsOptional()
  @IsEnum(DomainStatus)
  status?: DomainStatus;

  @ApiPropertyOptional({ description: 'Preference only — no certificate is actually issued or verified (no ACME/DNS integration exists).' })
  @IsOptional()
  @IsBoolean()
  sslEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Preference only — not enforced at any reverse proxy/gateway layer yet.' })
  @IsOptional()
  @IsBoolean()
  redirectHttpToHttps?: boolean;
}

// ==========================================
// Internal RPC-only payload DTOs (gateway -> auth-service)
// ==========================================

export class RemoveAllowedIpMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;

  /** See UpdateSecuritySettingsMessageDto.callerIp. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  callerIp?: string;
}

/** Checks a candidate password against the configured policy before anything is created with it. */
export class ValidatePasswordPolicyDto {
  @IsString()
  @MaxLength(256)
  password: string;
}

export class UpdateDomainMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;

  // Needs real nested-validation metadata: the microservice's global
  // ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so an
  // undecorated property is stripped and then rejected outright.
  @ApiProperty({ type: () => UpdateDomainDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateDomainDto)
  dto: UpdateDomainDto;
}

export class RemoveDomainMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;
}

// ==========================================
// MAINTENANCE
// ==========================================

export enum MaintenanceAllowedAdmins {
  SUPER_ADMINS_ONLY = 'SUPER_ADMINS_ONLY',
  ALL_ADMINS = 'ALL_ADMINS',
}

export enum UpdateChannel {
  STABLE = 'STABLE',
  BETA = 'BETA',
}

export class UpdateMaintenanceSettingsDto {
  @ApiPropertyOptional({ description: 'Real enforcement — MaintenanceModeGuard 503s non-SuperAdmin traffic when on.' })
  @IsOptional()
  @IsBoolean()
  maintenanceModeEnabled?: boolean;

  @ApiPropertyOptional({ maxLength: 400, example: 'We are currently under maintenance. Please try again later.' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  message?: string;

  @ApiPropertyOptional({ enum: MaintenanceAllowedAdmins })
  @IsOptional()
  @IsEnum(MaintenanceAllowedAdmins)
  allowedAdmins?: MaintenanceAllowedAdmins;

  @ApiPropertyOptional({ description: 'Stored only — no update/deployment automation exists in this codebase.' })
  @IsOptional()
  @IsBoolean()
  automaticUpdates?: boolean;

  @ApiPropertyOptional({ description: 'Stored only — no update notifier exists yet.' })
  @IsOptional()
  @IsBoolean()
  updateNotifications?: boolean;

  @ApiPropertyOptional({ example: '03:00', description: 'HH:MM, 24-hour clock. Stored only.' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'preferredUpdateTime must be in HH:MM 24-hour format' })
  preferredUpdateTime?: string;

  @ApiPropertyOptional({ enum: UpdateChannel, description: 'Stored only.' })
  @IsOptional()
  @IsEnum(UpdateChannel)
  updateChannel?: UpdateChannel;
}

// ==========================================
// RECENT ACTIVITY (Overview tab)
// ==========================================

export class GetRecentActivityQueryDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;
}
