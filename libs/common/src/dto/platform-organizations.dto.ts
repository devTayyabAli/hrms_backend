import {
  IsDefined,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** Real Tenant column names — keeps `sortBy` off the SQL ORDER BY injection surface. */
export const ORGANIZATION_SORTABLE_FIELDS = [
  'createdAt',
  'organizationName',
  'name',
  'domain',
  'planType',
  'status',
] as const;
export type OrganizationSortableField = (typeof ORGANIZATION_SORTABLE_FIELDS)[number];

export enum OrganizationStatusFilter {
  ALL = 'ALL',
  ACTIVE = 'ACTIVE',
  TRIAL = 'TRIAL',
  PENDING = 'PENDING',
  DEACTIVATED = 'DEACTIVATED',
}

export enum OrganizationActionStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export class GetPlatformOrganizationsQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiProperty({ required: false, description: 'Search by organization name or domain' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ enum: OrganizationStatusFilter, required: false, default: OrganizationStatusFilter.ALL })
  @IsOptional()
  @IsEnum(OrganizationStatusFilter)
  status?: OrganizationStatusFilter = OrganizationStatusFilter.ALL;

  @ApiProperty({ required: false, description: 'Filter by plan type e.g. Enterprise, Professional' })
  @IsOptional()
  @IsString()
  planType?: string;

  @ApiProperty({ required: false, enum: ORGANIZATION_SORTABLE_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(ORGANIZATION_SORTABLE_FIELDS)
  sortBy?: OrganizationSortableField = 'createdAt';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class UpdateOrganizationStatusDto {
  @ApiProperty({ enum: OrganizationActionStatus, example: OrganizationActionStatus.SUSPENDED })
  @IsEnum(OrganizationActionStatus)
  status: OrganizationActionStatus;
}

/**
 * Internal message-pattern payload (gateway -> tenant-service) for
 * PLATFORM_ORGANIZATIONS.UPDATE_STATUS — a real class so the microservice's
 * global ValidationPipe re-validates it (a plain type-literal is skipped).
 */
export class UpdateOrganizationStatusMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ enum: OrganizationActionStatus, example: OrganizationActionStatus.SUSPENDED })
  @IsEnum(OrganizationActionStatus)
  status: OrganizationActionStatus;
}

/**
 * The organization profile fields a SuperAdmin may correct from the platform
 * Organizations view.
 *
 * Deliberately narrow: lifecycle (`status`, `setupStatus`,
 * `provisioningStatus`, `isActive`) is owned by the onboarding flow and the
 * separate status route, `planType` is owned by billing, and `slug` is
 * referenced elsewhere — none of those are editable here. Every field is
 * optional so the client can PATCH just what changed.
 */
export class UpdateOrganizationDto {
  @ApiProperty({ required: false, example: 'CloudPeak Innovations' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  organizationName?: string;

  @ApiProperty({ required: false, example: 'CloudPeak Innovations (Private) Limited' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @ApiProperty({ required: false, example: 'cloudpeak.example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  domain?: string;

  @ApiProperty({ required: false, example: 'info@cloudpeakinnovations.com' })
  @IsOptional()
  @IsEmail()
  officialEmail?: string;

  @ApiProperty({ required: false, example: '+92 21 3897 4521' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiProperty({ required: false, example: 'Technology & IT' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;

  @ApiProperty({ required: false, example: '11-50 employees' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  companySize?: string;

  @ApiProperty({ required: false, example: 'Pakistan' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiProperty({ required: false, example: 'https://cloudpeak.example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  website?: string;
}

/**
 * Guards the irreversible delete route: the caller must echo the
 * organization's exact current name back, the same "type X to confirm"
 * pattern the frontend prompts for. Catches a stray click on the wrong row
 * far more reliably than a bare confirmation dialog would.
 */
export class DeleteOrganizationDto {
  @ApiProperty({
    description: "Must exactly match the organization's current name.",
    example: 'CloudPeak Innovations',
  })
  @IsString()
  @MaxLength(150)
  confirmName: string;
}

/** Internal message-pattern payload for PLATFORM_ORGANIZATIONS.DELETE. */
export class DeleteOrganizationMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: DeleteOrganizationDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => DeleteOrganizationDto)
  dto: DeleteOrganizationDto;
}

/** Internal message-pattern payload for PLATFORM_ORGANIZATIONS.UPDATE. */
export class UpdateOrganizationMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: UpdateOrganizationDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => UpdateOrganizationDto)
  dto: UpdateOrganizationDto;
}
