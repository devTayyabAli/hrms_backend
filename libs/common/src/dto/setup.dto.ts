import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsBoolean,
  IsNumber,
  IsArray,
  IsUUID,
  IsEnum,
  ValidateNested,
  IsDefined,
  IsIn,
  Matches,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateOrganizationProfileDto {
  @ApiProperty({ example: 'Acme Enterprises Inc.', required: false })
  @IsString()
  @IsOptional()
  organizationName?: string;

  @ApiProperty({ example: 'CLS', required: false })
  @IsString()
  @IsOptional()
  shortName?: string;

  @ApiProperty({ example: 'admin@clariftstudio.com', required: false })
  @IsString()
  @IsOptional()
  officialEmail?: string;

  @ApiProperty({ example: '200-500', required: false })
  @IsString()
  @IsOptional()
  companySize?: string;

  @ApiProperty({ example: 'https://example.com/logo.png', required: false })
  @IsString()
  @IsOptional()
  logoUrl?: string;

  @ApiProperty({ example: 'Acme Enterprises Legal Ltd.', required: false })
  @IsString()
  @IsOptional()
  legalName?: string;

  @ApiProperty({ example: 'Information Technology', required: false })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiProperty({ example: '+1-555-0199', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ example: 'https://acme.example.com', required: false })
  @IsString()
  @IsOptional()
  website?: string;

  @ApiProperty({ example: 'United States', required: false })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiProperty({ example: 'California', required: false })
  @IsString()
  @IsOptional()
  state?: string;

  @ApiProperty({ example: 'San Francisco', required: false })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiProperty({ example: '100 Market Street, Suite 500', required: false })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiProperty({ example: 'America/Los_Angeles', required: false })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({ example: 'USD', required: false })
  @IsString()
  @IsOptional()
  currency?: string;
}

export class CreateDepartmentDto {
  @ApiProperty({ example: 'Engineering' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'ENG', required: false })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({ example: 'Software development and engineering department', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183', required: false })
  @IsUUID()
  @IsOptional()
  parentDepartmentId?: string;
}

export class UpdateDepartmentDto {
  @ApiProperty({ example: 'Engineering & Technology', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: 'ENG-TECH', required: false })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({ example: 'Updated department description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183', required: false })
  @IsUUID()
  @IsOptional()
  parentDepartmentId?: string;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateDesignationDto {
  @ApiProperty({ example: 'Senior Software Engineer' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'SR-ENG', required: false })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({ example: 'Senior level software engineering role', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183', required: false })
  @IsString()
  @IsOptional()
  departmentId?: string;
}

export class UpdateDesignationDto {
  @ApiProperty({ example: 'Lead Software Engineer', required: false })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({ example: 'LEAD-ENG', required: false })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({ example: 'Updated designation description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183', required: false })
  @IsString()
  @IsOptional()
  departmentId?: string;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateWorkingHoursDto {
  @ApiProperty({ example: 'Standard Office Shift', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] })
  @IsArray()
  @IsOptional()
  workingDays?: string[];

  @ApiProperty({ example: '09:00' })
  @IsString()
  @IsNotEmpty()
  startTime: string;

  @ApiProperty({ example: '17:00' })
  @IsString()
  @IsNotEmpty()
  endTime: string;

  @ApiProperty({ example: 60, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  breakDurationMinutes?: number;

  @ApiProperty({ example: 'UTC', required: false })
  @IsString()
  @IsOptional()
  timezone?: string;
}

/** How a leave type's allocation is granted. Shared with the `LeavePolicy` model, which imports this rather than declaring its own copy. */
export enum LeaveAccrualType {
  MONTHLY = 'MONTHLY',
  ANNUAL_GRANT = 'ANNUAL_GRANT',
  EVENT_BASED = 'EVENT_BASED',
}

/** Who a leave type applies to. */
export enum LeaveEligibility {
  ALL_EMPLOYEES = 'ALL_EMPLOYEES',
  FEMALE_EMPLOYEES = 'FEMALE_EMPLOYEES',
  MALE_EMPLOYEES = 'MALE_EMPLOYEES',
}

export class CreateLeavePolicyDto {
  @ApiProperty({ example: 'Annual Paid Leave' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Standard annual paid leave allocation', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 14 })
  @IsNumber()
  @Min(0)
  annualAllocation: number;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @ApiProperty({ enum: LeaveAccrualType, required: false })
  @IsEnum(LeaveAccrualType)
  @IsOptional()
  accrualType?: LeaveAccrualType;

  @ApiProperty({ example: 5, required: false, description: 'Days that carry into next year. Omit for none.' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  carryForwardDays?: number;

  @ApiProperty({ enum: LeaveEligibility, required: false })
  @IsEnum(LeaveEligibility)
  @IsOptional()
  eligibility?: LeaveEligibility;
}

export class UpdateLeavePolicyDto {
  @ApiProperty({ example: 'Annual Paid Leave', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: 'Updated description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 18, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  annualAllocation?: number;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @ApiProperty({ enum: LeaveAccrualType, required: false })
  @IsEnum(LeaveAccrualType)
  @IsOptional()
  accrualType?: LeaveAccrualType;

  @ApiProperty({ example: 5, required: false, description: 'Days that carry into next year. Omit for none.' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  carryForwardDays?: number;

  @ApiProperty({ enum: LeaveEligibility, required: false })
  @IsEnum(LeaveEligibility)
  @IsOptional()
  eligibility?: LeaveEligibility;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateAttendancePolicyDto {
  @ApiProperty({ example: 15, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  gracePeriodMinutes?: number;

  @ApiProperty({ example: 30, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  lateThresholdMinutes?: number;

  @ApiProperty({ example: 'WEB_CLOCK_IN', required: false })
  @IsString()
  @IsOptional()
  trackingMode?: string;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  allowOvertime?: boolean;

  // ── Attendance Rules screen ───────────────────────────────────────────────

  @ApiProperty({ example: 4.5, required: false, description: 'Minimum hours for a half day' })
  @IsNumber()
  @Min(0.5)
  @Max(24)
  @IsOptional()
  halfDayHours?: number;

  @ApiProperty({ example: 8.5, required: false, description: 'Minimum hours for a full day' })
  @IsNumber()
  @Min(0.5)
  @Max(24)
  @IsOptional()
  fullDayHours?: number;

  @ApiProperty({ example: 9, required: false, description: 'Hours after which work counts as overtime' })
  @IsNumber()
  @Min(0.5)
  @Max(24)
  @IsOptional()
  overtimeAfterHours?: number;

  @ApiProperty({ example: '23:00', required: false, description: 'Automatic check-out time, "HH:mm"' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'autoCheckoutTime must be a time like 23:00' })
  @IsOptional()
  autoCheckoutTime?: string;

  @ApiProperty({ enum: ['COMP_OFF', 'OVERTIME_PAY', 'NOT_ALLOWED'], required: false })
  @IsIn(['COMP_OFF', 'OVERTIME_PAY', 'NOT_ALLOWED'])
  @IsOptional()
  weekendWorkPolicy?: string;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  ipRestrictionEnabled?: boolean;

  @ApiProperty({ example: ['203.0.113.0/24'], required: false, isArray: true })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsOptional()
  allowedIpRanges?: string[];

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  geofencingEnabled?: boolean;
}

// ==========================================
// MICROSERVICE MESSAGE PAYLOAD WRAPPERS
// ==========================================

export class UpdateOrganizationProfileMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: UpdateOrganizationProfileDto })
  @ValidateNested()
  @Type(() => UpdateOrganizationProfileDto)
  @IsDefined()
  dto: UpdateOrganizationProfileDto;
}

export class UpdateAdminAvatarMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'https://cdn.example.com/files/abc123.png' })
  @IsString()
  @IsNotEmpty()
  avatarUrl: string;
}

export class CreateDepartmentMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: CreateDepartmentDto })
  @ValidateNested()
  @Type(() => CreateDepartmentDto)
  @IsDefined()
  dto: CreateDepartmentDto;
}

export class TenantDepartmentIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  departmentId: string;
}

export class UpdateDepartmentMessageDto extends TenantDepartmentIdDto {
  @ApiProperty({ type: UpdateDepartmentDto })
  @ValidateNested()
  @Type(() => UpdateDepartmentDto)
  @IsDefined()
  dto: UpdateDepartmentDto;
}

export class CreateDesignationMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: CreateDesignationDto })
  @ValidateNested()
  @Type(() => CreateDesignationDto)
  @IsDefined()
  dto: CreateDesignationDto;
}

export class TenantDesignationIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  designationId: string;
}

export class UpdateDesignationMessageDto extends TenantDesignationIdDto {
  @ApiProperty({ type: UpdateDesignationDto })
  @ValidateNested()
  @Type(() => UpdateDesignationDto)
  @IsDefined()
  dto: UpdateDesignationDto;
}

export class UpdateWorkingHoursMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: UpdateWorkingHoursDto })
  @ValidateNested()
  @Type(() => UpdateWorkingHoursDto)
  @IsDefined()
  dto: UpdateWorkingHoursDto;
}

export class CreateLeavePolicyMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: CreateLeavePolicyDto })
  @ValidateNested()
  @Type(() => CreateLeavePolicyDto)
  @IsDefined()
  dto: CreateLeavePolicyDto;
}

export class TenantLeavePolicyIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  policyId: string;
}

export class UpdateLeavePolicyMessageDto extends TenantLeavePolicyIdDto {
  @ApiProperty({ type: UpdateLeavePolicyDto })
  @ValidateNested()
  @Type(() => UpdateLeavePolicyDto)
  @IsDefined()
  dto: UpdateLeavePolicyDto;
}

export class UpdateAttendancePolicyMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: UpdateAttendancePolicyDto })
  @ValidateNested()
  @Type(() => UpdateAttendancePolicyDto)
  @IsDefined()
  dto: UpdateAttendancePolicyDto;
}
