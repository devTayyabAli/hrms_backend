import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsObject,
  IsDateString,
  IsUUID,
  IsBoolean,
  ValidateNested,
  IsDefined,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

// ==========================================
// ENUMS
// ==========================================

export enum PolicyType {
  LEAVE = 'LEAVE',
  ATTENDANCE = 'ATTENDANCE',
  WORKING_HOURS = 'WORKING_HOURS',
  OVERTIME = 'OVERTIME',
  REMOTE_WORK = 'REMOTE_WORK',
  PAYROLL = 'PAYROLL',
  GENERAL = 'GENERAL',
}

export enum PolicyStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum PolicySource {
  SYSTEM = 'SYSTEM',
  CUSTOM = 'CUSTOM',
}

// ==========================================
// DTOs
// ==========================================

export class CreateOrganizationPolicyDto {
  @ApiProperty({ enum: PolicyType, example: PolicyType.LEAVE })
  @IsEnum(PolicyType)
  @IsNotEmpty()
  policyType: PolicyType;

  @ApiProperty({ enum: PolicySource, example: PolicySource.SYSTEM, required: false, default: PolicySource.SYSTEM })
  @IsEnum(PolicySource)
  @IsOptional()
  source?: PolicySource;

  @ApiProperty({ example: 'Annual Leave Policy 2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'Standard annual leave allocation for all employees', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({
    description: 'Policy configuration as a JSON object. Schema depends on policyType.',
    example: {
      annualAllocation: 20,
      isPaid: true,
      carryForward: true,
      maximumCarryForward: 10,
      requiresApproval: true,
    },
  })
  @IsObject()
  @IsNotEmpty()
  configuration: Record<string, unknown>;

  @ApiProperty({ example: '2026-01-01', required: false })
  @IsDateString()
  @IsOptional()
  effectiveFrom?: string;

  @ApiProperty({ example: '2026-12-31', required: false })
  @IsDateString()
  @IsOptional()
  @ValidateIf((o) => o.effectiveFrom !== undefined)
  effectiveTo?: string;
}

export class UpdateOrganizationPolicyDto {
  @ApiProperty({ example: 'Updated Annual Leave Policy 2026', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ required: false })
  @IsObject()
  @IsOptional()
  configuration?: Record<string, unknown>;

  @ApiProperty({ example: '2026-01-01', required: false })
  @IsDateString()
  @IsOptional()
  effectiveFrom?: string;

  @ApiProperty({ example: '2026-12-31', required: false })
  @IsDateString()
  @IsOptional()
  effectiveTo?: string;
}

export class ActivatePolicyDto {
  @ApiProperty({ example: '2026-01-01', required: false, description: 'If not provided, defaults to today' })
  @IsDateString()
  @IsOptional()
  effectiveFrom?: string;
}

export class CreateNewPolicyVersionDto {
  @ApiProperty({ example: 'Updated Annual Leave Policy 2026 v2' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiProperty()
  @IsObject()
  @IsNotEmpty()
  configuration: Record<string, unknown>;

  @ApiProperty({ example: '2026-07-01', required: false })
  @IsDateString()
  @IsOptional()
  effectiveFrom?: string;

  @ApiProperty({ example: '2026-12-31', required: false })
  @IsDateString()
  @IsOptional()
  effectiveTo?: string;
}

export class GetPoliciesQueryDto {
  @ApiProperty({ enum: PolicyType, required: false })
  @IsEnum(PolicyType)
  @IsOptional()
  policyType?: PolicyType;

  @ApiProperty({ enum: PolicyStatus, required: false })
  @IsEnum(PolicyStatus)
  @IsOptional()
  status?: PolicyStatus;

  @ApiProperty({ enum: PolicySource, required: false })
  @IsEnum(PolicySource)
  @IsOptional()
  source?: PolicySource;
}

// ==========================================
// MICROSERVICE MESSAGE PAYLOAD WRAPPERS
// ==========================================

export class CreatePolicyMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: CreateOrganizationPolicyDto })
  @ValidateNested()
  @Type(() => CreateOrganizationPolicyDto)
  @IsDefined()
  dto: CreateOrganizationPolicyDto;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  createdBy?: string;
}

export class GetPoliciesMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: GetPoliciesQueryDto, required: false })
  @ValidateNested()
  @Type(() => GetPoliciesQueryDto)
  @IsOptional()
  query?: GetPoliciesQueryDto;
}

export class TenantPolicyIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  policyId: string;
}

export class UpdatePolicyMessageDto extends TenantPolicyIdDto {
  @ApiProperty({ type: UpdateOrganizationPolicyDto })
  @ValidateNested()
  @Type(() => UpdateOrganizationPolicyDto)
  @IsDefined()
  dto: UpdateOrganizationPolicyDto;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  updatedBy?: string;
}

export class ActivatePolicyMessageDto extends TenantPolicyIdDto {
  @ApiProperty({ type: ActivatePolicyDto, required: false })
  @ValidateNested()
  @Type(() => ActivatePolicyDto)
  @IsOptional()
  dto?: ActivatePolicyDto;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  activatedBy?: string;
}

export class DeactivatePolicyMessageDto extends TenantPolicyIdDto {
  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  updatedBy?: string;
}

export class ArchivePolicyMessageDto extends TenantPolicyIdDto {
  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  updatedBy?: string;
}

export class GetActivePolicyMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ enum: PolicyType, example: PolicyType.LEAVE })
  @IsEnum(PolicyType)
  @IsNotEmpty()
  policyType: PolicyType;
}

export class CreateNewVersionMessageDto extends TenantPolicyIdDto {
  @ApiProperty({ type: CreateNewPolicyVersionDto })
  @ValidateNested()
  @Type(() => CreateNewPolicyVersionDto)
  @IsDefined()
  dto: CreateNewPolicyVersionDto;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  createdBy?: string;
}
