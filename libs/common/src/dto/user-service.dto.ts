import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { DataScope } from '../role-permissions';

// ==========================================
// Role DTOs
// ==========================================

export class CreateRoleDto {
  @ApiProperty({ example: 'Recruitment Manager', description: 'Name of the role' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Manages candidate recruitment and interview schedules' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isSystemRole?: boolean;

  @ApiPropertyOptional({
    example: ['perm-uuid-1', 'employee.view'],
    isArray: true,
    description: 'Array of permission IDs or permission keys (resource.action) to assign',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissionIds?: string[];

  @ApiPropertyOptional({
    enum: ['ORGANIZATION', 'DEPARTMENT', 'TEAM', 'SELF'],
    description: 'Whose records the role reaches: everyone, the managed department, the reporting team, or only the user.',
  })
  @IsOptional()
  @IsIn(['ORGANIZATION', 'DEPARTMENT', 'TEAM', 'SELF'])
  dataScope?: DataScope;
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'Senior HR Manager' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Updated description for HR Manager role' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    enum: ['ORGANIZATION', 'DEPARTMENT', 'TEAM', 'SELF'],
    description: 'Whose records the role reaches: everyone, the managed department, the reporting team, or only the user.',
  })
  @IsOptional()
  @IsIn(['ORGANIZATION', 'DEPARTMENT', 'TEAM', 'SELF'])
  dataScope?: DataScope;
}

/**
 * Shape of a signed envelope's `.data` for handlers that only need a single
 * entity id (role or user), e.g. GET_BY_ID / DELETE.
 */
export class IdParamDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  id: string;
}

export class UpdateRoleEnvelopeDataDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  id: string;

  @ApiProperty({ type: UpdateRoleDto })
  @ValidateNested()
  @Type(() => UpdateRoleDto)
  data: UpdateRoleDto;
}

export class SetRolePermissionsDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  roleId: string;

  @ApiProperty({
    example: ['employee.view', 'employee.create', 'payroll.view'],
    isArray: true,
    description: 'Array of permission IDs or permission keys to set on the role',
  })
  @IsArray()
  @IsString({ each: true })
  permissionIds: string[];
}

/** auth-service -> user-service, when minting an access token. */
export class ResolveCredentialPermissionsDto {
  @IsUUID()
  tenantId: string;

  @IsString()
  @IsNotEmpty()
  credentialRole: string;
}

export class ResolveEffectiveAuthorizationDto {
  @IsUUID()
  tenantId: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  credentialRole?: string;
}

export class RolePermissionActionDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  roleId: string;

  @ApiProperty({ example: 'employee.view', description: 'Permission ID or permission key' })
  @IsString()
  @IsNotEmpty()
  permissionId: string;
}

export class GetAvailablePermissionsDto {
  @ApiPropertyOptional({ example: ['recruitment', 'payroll'], isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledModules?: string[];
}

/** Empty signed-envelope data payload, e.g. ROLE.GET_ALL — no fields expected. */
export class EmptyDataDto {}

// ==========================================
// User DTOs
// ==========================================

export class CreateUserDto {
  @ApiProperty({ example: 'jane.doe@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ description: 'Pre-hashed password (already hashed upstream)' })
  @IsOptional()
  @IsString()
  passwordHash?: string;

  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({ isArray: true, example: ['a1b2c3d4-e5f6-4789-a012-3456789abcde'] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  roleIds?: string[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateUserPayloadDto extends CreateUserDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'jane.doe@acme.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Pre-hashed password (already hashed upstream)' })
  @IsOptional()
  @IsString()
  passwordHash?: string;

  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateUserPayloadDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  id: string;

  @ApiProperty({ type: UpdateUserDto })
  @ValidateNested()
  @Type(() => UpdateUserDto)
  data: UpdateUserDto;
}

export class DeleteUserDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  id: string;
}

/**
 * Paging accepted by every bounded list handler in this service.
 *
 * Both fields are optional: omitting them yields the first page at the
 * default size rather than the whole table, which is what makes leaving them
 * out safe. Out-of-range values are clamped by `resolveListBounds`, not
 * rejected here, so a careless client gets a cheap response instead of a 400.
 */
export class ListPagingDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, description: '1-based page number.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 50, minimum: 1, description: 'Rows per page. Clamped to the service maximum.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class GetAllUsersDto extends ListPagingDto {
  @ApiPropertyOptional({ example: 'tenant-uuid' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}

/** Paging for role/permission lists, whose tenant comes from the signed envelope. */
export class GetAllRolesDto extends ListPagingDto {}

export class UserRoleActionDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  userId: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  roleId: string;
}

export class SetUserRolesDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsUUID()
  userId: string;

  @ApiProperty({ isArray: true, example: ['a1b2c3d4-e5f6-4789-a012-3456789abcde'] })
  @IsArray()
  @IsUUID('4', { each: true })
  roleIds: string[];
}

// ==========================================
// Entity Audit Trail DTOs
// ==========================================

/**
 * Entity audit trail query filter. Deliberately has NO tenantId field: the
 * gateway signs this payload via MicroserviceSigningService, and the
 * microservice handler derives tenantId from the signed envelope's
 * (HMAC-verified) context — never from a client-suppliable field, which
 * would otherwise let any tenant admin read another tenant's audit trail
 * just by changing a query param.
 */
export class QueryEntityAuditLogsDto {
  @ApiPropertyOptional({ example: 'Role', description: 'Filter by model/table name' })
  @IsOptional()
  @IsString()
  tableName?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' })
  @IsOptional()
  @IsUUID()
  recordId?: string;

  @ApiPropertyOptional({ enum: ['CREATE', 'UPDATE', 'DELETE'] })
  @IsOptional()
  @IsIn(['CREATE', 'UPDATE', 'DELETE'])
  action?: 'CREATE' | 'UPDATE' | 'DELETE';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class CreateOrganizationAdminDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ example: 'Admin' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'User' })
  @IsOptional()
  @IsString()
  lastName?: string;
}

/**
 * Payload for MESSAGE_PATTERNS.USER.CREATE_EMPLOYEE_USER.
 *
 * Mirrors CreateOrganizationAdminDto plus the portal role the invitation
 * derived from the employee's designation, so the tenant-DB role row and the
 * auth credential agree on it.
 */
export class CreateEmployeeUserDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'naveed.ali@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ example: 'Naveed' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Ali' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiProperty({ example: 'HR', enum: ['HR', 'Employee'] })
  @IsString()
  @IsNotEmpty()
  role: string;
}
