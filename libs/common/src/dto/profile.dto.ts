import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  Matches,
  IsUUID,
  IsDefined,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsStrongPassword } from '../validators/strong-password.validator';

export enum NotificationFrequency {
  REALTIME = 'realtime',
  DAILY_DIGEST = 'daily_digest',
  WEEKLY_DIGEST = 'weekly_digest',
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Asma' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Aslam' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'Super Admin' })
  @IsOptional()
  @IsString()
  jobTitle?: string;

  @ApiPropertyOptional({ example: 'Administration' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ example: 'English' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ example: 'UTC+05:00 (Asia/Karachi)' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ example: 'Lahore, Pakistan' })
  @IsOptional()
  @IsString()
  location?: string;
}

export class UpdateAvatarDto {
  // Optional: the controller also accepts a multipart `file` upload (see
  // `SuperAdminProfileController.updateAvatar`), in which case no `avatarUrl`
  // form field is sent at all — requiring it here would 400 every file upload.
  @ApiPropertyOptional({
    example: 'https://example.com/avatars/superadmin.jpg',
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'CurrentPassword123!' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsStrongPassword()
  newPassword: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsNotEmpty()
  confirmPassword: string;
}

export class UpdateRecoveryDto {
  @ApiPropertyOptional({ example: 'recovery@example.com' })
  @IsOptional()
  @IsEmail()
  recoveryEmail?: string;

  @ApiPropertyOptional({ example: '+15559876543' })
  @IsOptional()
  @IsString()
  recoveryPhone?: string;
}

export class ToggleTwoFactorDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enable: boolean;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ example: 'CurrentPassword123!' })
  @IsOptional()
  @IsString()
  password?: string;
}

export class UpdateNotificationsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  accountUpdates?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  securityAlerts?: boolean;

  @ApiPropertyOptional({ description: 'Notify on new sign-in attempts (Security tab "Login Alerts").' })
  @IsOptional()
  @IsBoolean()
  loginAlerts?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  systemAnnouncements?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  reportsAnalytics?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pushNotifications?: boolean;

  @ApiPropertyOptional({ enum: NotificationFrequency, example: NotificationFrequency.REALTIME })
  @IsOptional()
  @IsEnum(NotificationFrequency)
  notificationFrequency?: NotificationFrequency;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  quietHoursEnabled?: boolean;

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'quietHoursStartTime must be in HH:mm 24-hour format',
  })
  quietHoursStartTime?: string;

  @ApiPropertyOptional({ example: '07:00' })
  @IsOptional()
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'quietHoursEndTime must be in HH:mm 24-hour format',
  })
  quietHoursEndTime?: string;
}

export class RevokeSessionDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;
}

// ==========================================
// TCP payload wrapper DTOs (superAdminId + nested dto), used by the
// auth-service message-pattern handlers that receive a SuperAdmin actor id
// alongside a body DTO.
// ==========================================

export class SuperAdminIdPayloadDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  @IsNotEmpty()
  superAdminId: string;
}

/** HTTP body for the 2FA generate route — see GenerateTwoFactorPayloadDto. */
export class GenerateTwoFactorDto {
  @ApiPropertyOptional({
    example: '123456',
    description:
      'Current authenticator code. Required when 2FA is already enabled.',
  })
  @IsOptional()
  @IsString()
  code?: string;
}

/**
 * Payload for generating a TOTP secret.
 *
 * `code` is required only when the account already has 2FA enabled — see
 * ProfileService.generateTwoFactor: rotating a live second factor has to be
 * proved with the current one, or a hijacked session could replace it.
 */
export class GenerateTwoFactorPayloadDto extends SuperAdminIdPayloadDto {
  @ApiPropertyOptional({
    example: '123456',
    description:
      'Current authenticator code. Required when 2FA is already enabled.',
  })
  @IsOptional()
  @IsString()
  code?: string;
}

/** Carries the caller's own session id so the list can flag the "Current" row. */
export class GetSessionsPayloadDto extends SuperAdminIdPayloadDto {
  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsString()
  currentSessionId?: string;
}

export class UpdateProfilePayloadDto extends SuperAdminIdPayloadDto {
  @ApiProperty({ type: () => UpdateProfileDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => UpdateProfileDto)
  dto: UpdateProfileDto;
}

export class UpdateAvatarPayloadDto extends SuperAdminIdPayloadDto {
  @ApiProperty({ example: 'https://example.com/avatars/superadmin.jpg' })
  @IsString()
  @IsNotEmpty()
  avatarUrl: string;
}

export class ChangePasswordPayloadDto extends SuperAdminIdPayloadDto {
  @ApiProperty({ type: () => ChangePasswordDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ChangePasswordDto)
  dto: ChangePasswordDto;
}

export class UpdateRecoveryPayloadDto extends SuperAdminIdPayloadDto {
  @ApiProperty({ type: () => UpdateRecoveryDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => UpdateRecoveryDto)
  dto: UpdateRecoveryDto;
}

export class ToggleTwoFactorPayloadDto extends SuperAdminIdPayloadDto {
  @ApiProperty({ type: () => ToggleTwoFactorDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ToggleTwoFactorDto)
  dto: ToggleTwoFactorDto;
}

export class UpdateNotificationsPayloadDto extends SuperAdminIdPayloadDto {
  @ApiProperty({ type: () => UpdateNotificationsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => UpdateNotificationsDto)
  dto: UpdateNotificationsDto;
}

export class RevokeSessionPayloadDto extends SuperAdminIdPayloadDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;
}

export class RevokeOtherSessionsPayloadDto extends SuperAdminIdPayloadDto {
  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsString()
  currentSessionId?: string;
}

// ==========================================
// Tenant self-profile — a signed-in tenant user (org admin today; HR/Employee
// once their own login exists) managing their own `AuthCredential` row.
// Identified by `authCredentialId` (the JWT's `sub`), with `tenantId` kept
// alongside as the same defense-in-depth scoping every tenant query in this
// codebase applies, even though the primary-key lookup alone is unambiguous.
// ==========================================

export class UpdateTenantProfileDto {
  @ApiPropertyOptional({ example: 'Ayesha' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Khan' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: '+92 300 1234567' })
  @IsOptional()
  @IsString()
  phone?: string;
}

export class TenantProfileActorDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  @IsNotEmpty()
  authCredentialId: string;

  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;
}

export class UpdateTenantProfilePayloadDto extends TenantProfileActorDto {
  @ApiProperty({ type: () => UpdateTenantProfileDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => UpdateTenantProfileDto)
  dto: UpdateTenantProfileDto;
}

export class ChangeTenantPasswordPayloadDto extends TenantProfileActorDto {
  @ApiProperty({ type: () => ChangePasswordDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ChangePasswordDto)
  dto: ChangePasswordDto;
}
