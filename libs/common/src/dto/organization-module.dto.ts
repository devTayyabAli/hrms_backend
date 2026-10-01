import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export enum HRMSModuleKey {
  DASHBOARD = 'dashboard',
  EMPLOYEE = 'employee',
  DEPARTMENTS = 'departments',
  ATTENDANCE = 'attendance',
  LEAVE_MANAGEMENT = 'leave_management',
  PAYROLL = 'payroll',
  REPORTS = 'reports',
  SETTINGS = 'settings',
  USER_MANAGEMENT = 'user_management',
  PERFORMANCE = 'performance',

  // Extensible Future Modules
  RECRUITMENT = 'recruitment',
  ONBOARDING = 'onboarding',
  PROJECTS = 'projects',
  TIME_TRACKING = 'time_tracking',
  EXPENSES = 'expenses',
  ASSETS = 'assets',
  CALENDAR = 'calendar',
  MEETINGS = 'meetings',
  DOCUMENTS = 'documents',
  NOTIFICATIONS = 'notifications',
  GOALS = 'goals',
  WORKFLOWS = 'workflows',
  TICKETS = 'tickets',
  AI_ASSISTANT = 'ai_assistant',
}

export enum ModuleAction {
  ALL = 'all',
  VIEW = 'view',
  CREATE = 'create',
  EDIT = 'edit',
  DELETE = 'delete',
  EXPORT = 'export',
  MANAGE = 'manage',
}

export class ConfigureModuleAccessDto {
  @ApiProperty({ example: 'employee', enum: HRMSModuleKey })
  @IsString()
  @IsNotEmpty()
  moduleKey: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({
    example: ['all', 'create', 'edit', 'delete'],
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedActions?: string[];
}

export class InitialAdminDetailsDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ example: 'john.doe@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  workEmail: string;

  @ApiProperty({ example: '+1234567890', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ example: 'Technology', required: false })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiProperty({ example: 'https://example.com/photo.jpg', required: false })
  @IsString()
  @IsOptional()
  profilePhoto?: string;

  @ApiProperty({ example: '50-100', required: false })
  @IsString()
  @IsOptional()
  averageUsers?: string;

  @ApiProperty({ example: 'HR Director', required: false })
  @IsString()
  @IsOptional()
  jobTitle?: string;

  @ApiProperty({ example: 'Human Resources', required: false })
  @IsString()
  @IsOptional()
  initialDepartment?: string;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  sendInvitation?: boolean;

  @ApiProperty({
    example: 'Welcome to Acme HRMS! Please activate your admin account.',
    required: false,
  })
  @IsString()
  @IsOptional()
  customInvitationMessage?: string;
}

export class OrganizationScopeDto {
  @ApiProperty({ example: ['Engineering', 'HR'], isArray: true, required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  departments?: string[];

  @ApiProperty({ example: ['New York HQ', 'London Office'], isArray: true, required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  locations?: string[];

  @ApiProperty({ example: ['Backend Team', 'Frontend Team'], isArray: true, required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  teams?: string[];

  @ApiProperty({ example: ['Senior Engineer', 'HR Manager'], isArray: true, required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  designations?: string[];
}

export class CreateOrganizationOnboardingDto {
  @ApiProperty({ example: 'Acme Corporation' })
  @IsString()
  @IsNotEmpty()
  organizationName: string;

  @ApiProperty({ example: 'acme-corp', required: false })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiProperty({ type: InitialAdminDetailsDto })
  @ValidateNested()
  @Type(() => InitialAdminDetailsDto)
  adminDetails: InitialAdminDetailsDto;

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

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294', required: false })
  @IsString()
  @IsOptional()
  planId?: string;

  @ApiProperty({ example: 'MONTHLY', required: false })
  @IsString()
  @IsOptional()
  billingCycle?: string;
}

export class ValidateOrganizationOnboardingDto extends CreateOrganizationOnboardingDto { }

export class UpdateOrganizationModuleAccessDto {
  @ApiProperty({ type: [ConfigureModuleAccessDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfigureModuleAccessDto)
  modules: ConfigureModuleAccessDto[];
}

/**
 * Payload for MESSAGE_PATTERNS.ORGANIZATION.UPDATE_MODULE_ACCESS.
 */
export class UpdateModuleAccessMessageDto extends UpdateOrganizationModuleAccessDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;
}

/**
 * Payload for MESSAGE_PATTERNS.ORGANIZATION.CHECK_MODULE_ACCESS.
 */
export class CheckModuleAccessDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'employee', enum: HRMSModuleKey })
  @IsString()
  @IsNotEmpty()
  moduleKey: string;

  @ApiProperty({ example: 'view', required: false })
  @IsString()
  @IsOptional()
  action?: string;
}

// ==========================================
// 3-STEP ORGANIZATION ONBOARDING WIZARD DTOS
// ==========================================

export class OrganizationInfoDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @IsNotEmpty()
  organizationName: string;

  @ApiProperty({ example: 'Acme Corporation LLC', required: false })
  @IsString()
  @IsOptional()
  legalName?: string;

  @ApiProperty({ example: 'contact@acmecorp.com', required: false })
  @IsEmail()
  @IsOptional()
  businessEmail?: string;

  @ApiProperty({ example: 'contact@acmecorp.com', required: false })
  @IsEmail()
  @IsOptional()
  officialEmail?: string;

  @ApiProperty({ example: 'acme-corp', required: false })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiProperty({ example: 'acme-corp', required: false })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiProperty({ example: 'https://acmecorp.com', required: false })
  @IsString()
  @IsOptional()
  website?: string;

  @ApiProperty({ example: '+1 (555) 000-0000', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

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

  @ApiProperty({ example: '123 Main St', required: false })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiProperty({ example: 'Asia/Karachi', required: false })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({ example: 'USD', required: false })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty({ example: 'https://example.com/logo.png', required: false })
  @IsString()
  @IsOptional()
  logoUrl?: string;

  @ApiProperty({ example: 'Technology', required: false })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiProperty({ example: '50-100', required: false })
  @IsString()
  @IsOptional()
  companySize?: string;
}

export class OrganizationAdminInfoDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  adminName: string;

  @ApiProperty({ example: 'admin@acmecorp.com' })
  @IsEmail()
  @IsNotEmpty()
  adminEmail: string;

  @ApiProperty({ example: '+1 (555) 000-1111', required: false })
  @IsString()
  @IsOptional()
  adminPhone?: string;

  @ApiProperty({ example: 'https://example.com/avatar.jpg', required: false })
  @IsString()
  @IsOptional()
  profilePhoto?: string;

  @ApiProperty({ example: true, required: false, default: true })
  @IsBoolean()
  @IsOptional()
  sendInvitation?: boolean;

  @ApiProperty({ example: 'Welcome to Acme HRMS! Please setup your admin credentials.', required: false })
  @IsString()
  @IsOptional()
  customMessage?: string;
}

export class InitialOrganizationOnboardingDto {
  // Nested structure support
  @ApiProperty({ type: OrganizationInfoDto, required: false })
  @ValidateNested()
  @Type(() => OrganizationInfoDto)
  @IsOptional()
  organizationInfo?: OrganizationInfoDto;

  @ApiProperty({ type: OrganizationAdminInfoDto, required: false })
  @ValidateNested()
  @Type(() => OrganizationAdminInfoDto)
  @IsOptional()
  adminInfo?: OrganizationAdminInfoDto;

  @ApiProperty({ type: [ConfigureModuleAccessDto], required: false })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfigureModuleAccessDto)
  @IsOptional()
  modules?: ConfigureModuleAccessDto[];

  // Flat fields support (for ease of use)
  @ApiProperty({ example: 'Acme Corp', required: false })
  @IsString()
  @IsOptional()
  organizationName?: string;

  @ApiProperty({ example: 'Acme Corporation LLC', required: false })
  @IsString()
  @IsOptional()
  legalName?: string;

  @ApiProperty({ example: 'contact@acmecorp.com', required: false })
  @IsEmail()
  @IsOptional()
  businessEmail?: string;

  @ApiProperty({ example: '+1 (555) 000-0000', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ example: 'United States', required: false })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiProperty({ example: 'Technology', required: false })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiProperty({ example: '50-100', required: false })
  @IsString()
  @IsOptional()
  companySize?: string;

  @ApiProperty({ example: 'John Doe', required: false })
  @IsString()
  @IsOptional()
  adminName?: string;

  @ApiProperty({ example: 'admin@acmecorp.com', required: false })
  @IsEmail()
  @IsOptional()
  adminEmail?: string;

  @ApiProperty({ example: '+1 (555) 000-1111', required: false })
  @IsString()
  @IsOptional()
  adminPhone?: string;

  @ApiProperty({ example: 'https://example.com/avatar.jpg', required: false })
  @IsString()
  @IsOptional()
  profilePhoto?: string;

  @ApiProperty({ example: true, required: false, default: true })
  @IsBoolean()
  @IsOptional()
  sendInvitation?: boolean;

  @ApiProperty({ example: 'Welcome to Acme HRMS!', required: false })
  @IsString()
  @IsOptional()
  customMessage?: string;
}

export class ValidateInitialStepDto {
  @ApiProperty({ example: 1, description: 'Step number: 1 for Organization Info, 2 for Admin Details' })
  @IsNotEmpty()
  step: number;

  @ApiProperty({ description: 'Data object for the specific step being validated' })
  @IsNotEmpty()
  data: any;
}

