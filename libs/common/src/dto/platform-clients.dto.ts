import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** Real PlatformClientRow field names — keeps `sortBy` a closed set. */
export const CLIENT_SORTABLE_FIELDS = [
  'createdAt',
  'name',
  'email',
  'organizationName',
  'role',
  'department',
] as const;
export type ClientSortableField = (typeof CLIENT_SORTABLE_FIELDS)[number];

export enum ClientRoleFilter {
  ALL = 'ALL',
  ADMIN = 'ADMIN',
  HR = 'HR',
  EMPLOYEE = 'EMPLOYEE',
}

export enum ClientStatusFilter {
  ALL = 'ALL',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export class GetPlatformClientsQueryDto {
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

  @ApiProperty({ required: false, description: 'Search by name, email or organization' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ enum: ClientRoleFilter, required: false, default: ClientRoleFilter.ALL })
  @IsOptional()
  @IsEnum(ClientRoleFilter)
  role?: ClientRoleFilter = ClientRoleFilter.ALL;

  @ApiProperty({ required: false, description: 'Filter by tenant/organization id' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiProperty({ enum: ClientStatusFilter, required: false, default: ClientStatusFilter.ALL })
  @IsOptional()
  @IsEnum(ClientStatusFilter)
  status?: ClientStatusFilter = ClientStatusFilter.ALL;

  @ApiProperty({ required: false, enum: CLIENT_SORTABLE_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(CLIENT_SORTABLE_FIELDS)
  sortBy?: ClientSortableField = 'createdAt';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class GetRecentPlatformClientsQueryDto {
  @ApiProperty({ required: false, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 5;
}

export class UpdatePlatformClientStatusDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  isActive: boolean;
}

// ==========================================
// Internal message-pattern payload DTOs (gateway -> user-service).
// Real classes so the microservice's global ValidationPipe actually
// re-validates them — a plain `{ tenantId, userId }` type literal has no
// runtime metadata and is silently skipped by class-validator.
// ==========================================

export class TenantUserIdDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  userId: string;
}

export class UpdatePlatformClientStatusMessageDto extends TenantUserIdDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  isActive: boolean;
}

export class TenantIdsDto {
  @ApiProperty({ type: [String] })
  @IsUUID(undefined, { each: true })
  tenantIds: string[];
}
