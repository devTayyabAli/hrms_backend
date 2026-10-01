import {
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Read-side DTOs for the admin Departments screen.
 *
 * Create / update / delete are deliberately NOT redefined here — the Setup
 * Wizard already owns them (CreateDepartmentDto / UpdateDepartmentDto in
 * setup.dto.ts, exposed at POST|PATCH|DELETE /organization/departments), and
 * the admin screen's Add Department and row actions reuse those endpoints
 * rather than introducing a second, divergent write path.
 */

/** Real DepartmentRow field names — keeps `sortBy` a closed set. */
export const DEPARTMENT_SORTABLE_FIELDS = [
  'name',
  'code',
  'employeeCount',
  'createdAt',
] as const;
export type DepartmentSortableField =
  (typeof DEPARTMENT_SORTABLE_FIELDS)[number];

export enum DepartmentStatusFilter {
  ALL = 'ALL',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export class GetDepartmentsOverviewQueryDto {
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

  @ApiProperty({
    required: false,
    description: 'Search by department name, code or description',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: DepartmentStatusFilter,
    required: false,
    default: DepartmentStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(DepartmentStatusFilter)
  status?: DepartmentStatusFilter = DepartmentStatusFilter.ALL;

  @ApiProperty({
    required: false,
    enum: DEPARTMENT_SORTABLE_FIELDS,
    default: 'name',
  })
  @IsOptional()
  @IsIn(DEPARTMENT_SORTABLE_FIELDS)
  sortBy?: DepartmentSortableField = 'name';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'ASC';
}

export class ExportDepartmentsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: DepartmentStatusFilter,
    required: false,
    default: DepartmentStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(DepartmentStatusFilter)
  status?: DepartmentStatusFilter = DepartmentStatusFilter.ALL;

  @ApiProperty({
    required: false,
    enum: DEPARTMENT_SORTABLE_FIELDS,
    default: 'name',
  })
  @IsOptional()
  @IsIn(DEPARTMENT_SORTABLE_FIELDS)
  sortBy?: DepartmentSortableField = 'name';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'ASC';
}

/**
 * Assign (or clear) the department head shown in the Manager column.
 * `managerId` must be an employee in this same tenant.
 */
export class AssignDepartmentManagerDto {
  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Employee id to set as manager, or null to clear it.',
  })
  @IsOptional()
  @IsUUID()
  managerId?: string | null;
}

// ==========================================
// Internal message-pattern payload DTOs (gateway -> tenant-service).
// Real classes so the microservice's own ValidationPipe re-validates them;
// a plain type literal carries no runtime metadata and is silently skipped.
// ==========================================

export class GetDepartmentsOverviewMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetDepartmentsOverviewQueryDto })
  @ValidateNested()
  @Type(() => GetDepartmentsOverviewQueryDto)
  @IsDefined()
  query: GetDepartmentsOverviewQueryDto;
}

export class ExportDepartmentsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportDepartmentsQueryDto })
  @ValidateNested()
  @Type(() => ExportDepartmentsQueryDto)
  @IsDefined()
  query: ExportDepartmentsQueryDto;
}

export class AssignDepartmentManagerMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  departmentId: string;

  @ApiProperty({ type: AssignDepartmentManagerDto })
  @ValidateNested()
  @Type(() => AssignDepartmentManagerDto)
  @IsDefined()
  dto: AssignDepartmentManagerDto;
}
