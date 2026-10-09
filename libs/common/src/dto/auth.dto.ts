import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsString,
  MinLength,
  IsInt,
  Min,
  Max,
  IsDefined,
  ValidateNested,
  IsArray,
  ArrayNotEmpty,
  IsUUID,
  MaxLength,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsStrongPassword } from '../validators/strong-password.validator';

export class RegisterTenantDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @IsNotEmpty()
  companyName: string;

  @ApiProperty({ example: 'acme' })
  @IsString()
  @IsNotEmpty()
  domain: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  adminEmail: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsStrongPassword()
  password: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  lastName: string;
}

export class LoginDto {
  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class SuperAdminLoginDto {
  @ApiProperty({ example: 'superadmin@system.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'SuperSecret123!' })
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class OnboardOrganizationDto {
  @ApiProperty({ example: 'Acme Global' })
  @IsString()
  @IsNotEmpty()
  companyName: string;

  @ApiProperty({ example: 'acme-global' })
  @IsString()
  @IsNotEmpty()
  domain: string;

  @ApiProperty({ example: 'orgadmin@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  adminEmail: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsStrongPassword()
  password: string;

  @ApiProperty({ example: 'Alice' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Smith' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ example: 'localhost', required: false })
  @IsString()
  dbHost?: string;

  @ApiProperty({ example: 5432, required: false })
  dbPort?: number;

  @ApiProperty({ example: 'hrms_acme_db', required: false })
  @IsString()
  dbName?: string;

  @ApiProperty({ example: 'postgres', required: false })
  @IsString()
  dbUsername?: string;

  @ApiProperty({ example: 'postgres', required: false })
  @IsString()
  dbPassword?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'aasma@astraprotocol.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'aasma@astraprotocol.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  otp: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'aasma@astraprotocol.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  otp: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsStrongPassword()
  newPassword: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsNotEmpty()
  confirmPassword: string;
}

export class VerifyTwoFactorChallengeDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  @IsString()
  @IsNotEmpty()
  challengeToken: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  code: string;
}

export class RefreshTokenDto {
  /**
   * Optional: browsers send the refresh token as an httpOnly cookie, which the
   * gateway reads instead (see api-gateway/src/auth/refresh-token-cookie.ts).
   * The body field remains for non-browser callers that hold their own token.
   */
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  refreshToken?: string;
}

export class LogoutDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    required: false,
  })
  @IsString()
  refreshToken?: string;
}

export class AuditLogQueryDto {
  @ApiPropertyOptional({
    example: 'Oppo',
    description: 'Search across organization, user, action, email, IP',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'admin@acme.com', required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ example: 'LOGIN_FAILED', required: false })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({
    example: 'Roles & Permissions',
    description:
      'Filter by module: Subscriptions, Users, Roles & Permissions, Authentication, Reports, etc.',
  })
  @IsOptional()
  @IsString()
  module?: string;

  @ApiPropertyOptional({
    example: 'Failed',
    description: 'Filter by status: Success or Failed',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    enum: ['security'],
    description: 'security = failed sign-ins and access-control changes',
  })
  @IsOptional()
  @IsIn(['security'])
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by tenant ID' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Alias for tenantId' })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({ required: false })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z', required: false })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z', required: false })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ required: false, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    example: 'csv',
    enum: ['csv', 'json'],
    required: false,
  })
  @IsOptional()
  @IsString()
  format?: 'csv' | 'json';
}

export class CreateAdminCredentialDto {
  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsStrongPassword()
  password: string;

  @ApiProperty({ example: 'tenant-acme' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @IsString()
  tenantName?: string;

  @ApiPropertyOptional({ example: 'Admin' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: 'Tayyab' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Akhtar' })
  @IsOptional()
  @IsString()
  lastName?: string;
}

/**
 * Scoped by both email and tenantId — like `createAdminCredential`'s
 * "never hijack a credential that belongs to another tenant" guard, this
 * must never deactivate a credential outside the tenant that asked for it.
 */
/** Can this email become a login in `tenantId`? Logins are unique per email platform-wide. */
export class CheckEmailAvailableDto {
  @ApiProperty({ example: 'ayesha@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;
}

export class DeactivateTenantCredentialDto {
  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'tenant-acme' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  /**
   * `true` switches a suspended login back on (an employee reactivated);
   * omitted or `false` suspends it, as this message always has.
   */
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class LoginPayloadDto {
  @ApiProperty({ type: () => LoginDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => LoginDto)
  dto: LoginDto;

  @ApiPropertyOptional({ example: '203.0.113.10' })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: 'Mozilla/5.0' })
  @IsOptional()
  @IsString()
  userAgent?: string;

  /** "Lahore, Punjab, PK" from the edge proxy's geo headers; absent when untrusted. */
  @ApiPropertyOptional({ example: 'Lahore, Punjab, PK' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;
}

export class SuperAdminLoginPayloadDto {
  @ApiProperty({ type: () => SuperAdminLoginDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SuperAdminLoginDto)
  dto: SuperAdminLoginDto;

  @ApiPropertyOptional({ example: '203.0.113.10' })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: 'Mozilla/5.0' })
  @IsOptional()
  @IsString()
  userAgent?: string;

  /** "Lahore, Punjab, PK" from the edge proxy's geo headers; absent when untrusted. */
  @ApiPropertyOptional({ example: 'Lahore, Punjab, PK' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;
}

export class VerifyTwoFactorChallengePayloadDto {
  @ApiProperty({ type: () => VerifyTwoFactorChallengeDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => VerifyTwoFactorChallengeDto)
  dto: VerifyTwoFactorChallengeDto;

  @ApiPropertyOptional({ example: '203.0.113.10' })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: 'Mozilla/5.0' })
  @IsOptional()
  @IsString()
  userAgent?: string;

  /** "Lahore, Punjab, PK" from the edge proxy's geo headers; absent when untrusted. */
  @ApiPropertyOptional({ example: 'Lahore, Punjab, PK' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;
}

export class RefreshTokenPayloadDto {
  @ApiProperty({ type: () => RefreshTokenDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => RefreshTokenDto)
  dto: RefreshTokenDto;

  @ApiPropertyOptional({ example: '203.0.113.10' })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: 'Mozilla/5.0' })
  @IsOptional()
  @IsString()
  userAgent?: string;
}

export class LogoutPayloadDto {
  @ApiProperty({ type: () => LogoutDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => LogoutDto)
  dto: LogoutDto;

  @ApiPropertyOptional({ example: '203.0.113.10' })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: 'Mozilla/5.0' })
  @IsOptional()
  @IsString()
  userAgent?: string;
}

/**
 * Bulk last-login lookup for the platform Clients directory. Only tenants'
 * Admin accounts have an AuthCredential row today (HR/Employee tenant users
 * have no login path implemented anywhere in this codebase yet), so this
 * can only ever return an entry for that one admin per tenant.
 */
export class GetLastLoginsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  tenantIds: string[];
}

/** `auth.get_session_state` — the session id carried in an access token's `sid` claim. */
export class SessionStateQueryDto {
  @IsUUID()
  sessionId: string;
}
