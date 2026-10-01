import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsArray,
  IsInt,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  InitialAdminDetailsDto,
  ConfigureModuleAccessDto,
  OrganizationScopeDto,
} from './organization-module.dto';

export * from './organization-module.dto';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Enterprises' })
  @IsString()
  @IsNotEmpty()
  organizationName: string;

  @ApiProperty({ example: 'admin@acme-enterprises.com' })
  @IsEmail()
  @IsNotEmpty()
  adminEmail: string;

  @ApiProperty({ example: 'John Doe', required: false })
  @IsString()
  @IsOptional()
  adminName?: string;

  @ApiProperty({ example: 'John', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ example: 'Doe', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ example: 'acme-enterprises', required: false })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiProperty({ example: '50-100', required: false })
  @IsString()
  @IsOptional()
  teamStrength?: string;

  @ApiProperty({ example: '50-100', required: false })
  @IsString()
  @IsOptional()
  averageUsers?: string;

  @ApiProperty({ example: 'Technology', required: false })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiProperty({ example: '+1234567890', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  sendInvitation?: boolean;

  @ApiProperty({ example: 'Welcome to HRMS', required: false })
  @IsString()
  @IsOptional()
  customInvitationMessage?: string;

  @ApiProperty({ example: 'acme-enterprises', required: false })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiProperty({ example: 'Enterprise', required: false })
  @IsString()
  @IsOptional()
  planType?: string;

  @ApiProperty({ example: 'Pakistan', required: false })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiProperty({ example: 'Punjab', required: false })
  @IsString()
  @IsOptional()
  state?: string;

  @ApiProperty({ example: 'Lahore', required: false })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiProperty({ example: '123 Main Street', required: false })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiProperty({ example: 'Asia/Karachi', required: false })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({ example: 'PKR', required: false })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294', required: false })
  @IsString()
  @IsOptional()
  planId?: string;

  @ApiProperty({ example: 'MONTHLY', required: false })
  @IsString()
  @IsOptional()
  billingCycle?: string;
}

/**
 * Generic tenant-scoped microservice message payload.
 * Reused across many @MessagePattern handlers that only need the target tenantId.
 */
export class TenantIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;
}

export class ApplyIndustryTemplateMessageDto extends TenantIdDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', required: false })
  @IsUUID()
  @IsOptional()
  actorUserId?: string;
}

/**
 * Payload accepted by MESSAGE_PATTERNS.TENANT.GET_ALL_TENANTS — an internal,
 * service-to-service call (e.g. PlatformClientsService enumerating tenants
 * to fan out across), so every field stays optional.
 */
export class GetAllTenantsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;
}

/**
 * Payload accepted by MESSAGE_PATTERNS.ORGANIZATION.CREATE_ORGANIZATION.
 * The gateway sends either a flat CreateOrganizationDto or a nested
 * CreateOrganizationOnboardingDto to this same pattern, so this DTO is a
 * superset covering both accepted shapes (see TenantProvisioningService.createOrganizationAndProvision).
 */
export class CreateOrganizationProvisionDto {
  @ApiProperty({ example: 'Acme Enterprises' })
  @IsString()
  @IsNotEmpty()
  organizationName: string;

  @ApiProperty({ example: 'admin@acme-enterprises.com', required: false })
  @IsEmail()
  @IsOptional()
  adminEmail?: string;

  @ApiProperty({ example: 'John Doe', required: false })
  @IsString()
  @IsOptional()
  adminName?: string;

  @ApiProperty({ example: 'John', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ example: 'Doe', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ example: 'acme-enterprises', required: false })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiProperty({ example: '50-100', required: false })
  @IsString()
  @IsOptional()
  teamStrength?: string;

  @ApiProperty({ example: '50-100', required: false })
  @IsString()
  @IsOptional()
  averageUsers?: string;

  @ApiProperty({ example: 'Technology', required: false })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiProperty({ example: '+1234567890', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  sendInvitation?: boolean;

  @ApiProperty({ example: 'Welcome to HRMS', required: false })
  @IsString()
  @IsOptional()
  customInvitationMessage?: string;

  @ApiProperty({ example: 'acme-enterprises', required: false })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiProperty({ example: 'Enterprise', required: false })
  @IsString()
  @IsOptional()
  planType?: string;

  @ApiProperty({ example: 'Pakistan', required: false })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiProperty({ example: 'Punjab', required: false })
  @IsString()
  @IsOptional()
  state?: string;

  @ApiProperty({ example: 'Lahore', required: false })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiProperty({ example: '123 Main Street', required: false })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiProperty({ example: 'Asia/Karachi', required: false })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({ example: 'PKR', required: false })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294', required: false })
  @IsString()
  @IsOptional()
  planId?: string;

  @ApiProperty({ example: 'MONTHLY', required: false })
  @IsString()
  @IsOptional()
  billingCycle?: string;

  @ApiProperty({ type: InitialAdminDetailsDto, required: false })
  @ValidateNested()
  @Type(() => InitialAdminDetailsDto)
  @IsOptional()
  adminDetails?: InitialAdminDetailsDto;

  @ApiProperty({ type: [ConfigureModuleAccessDto], required: false })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfigureModuleAccessDto)
  @IsOptional()
  modules?: ConfigureModuleAccessDto[];

  @ApiProperty({ type: OrganizationScopeDto, required: false })
  @ValidateNested()
  @Type(() => OrganizationScopeDto)
  @IsOptional()
  scope?: OrganizationScopeDto;
}
