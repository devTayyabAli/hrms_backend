import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Branches: the offices or locations an organization works from. An employee
 * belongs to at most one. A role can be limited to the branch it heads, or to
 * the branch the person works in (data scope BRANCH).
 */

export const BRANCH_ASSIGN_MAX_EMPLOYEES = 500;

export enum BranchStatusFilter {
  ALL = 'ALL',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

export class CreateBranchDto {
  @ApiProperty({ example: 'Lahore HQ', maxLength: 120, description: 'Unique in the organization, ignoring case' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ required: false, example: 'LHE', maxLength: 20, description: 'Short code, unique when given' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() || null : value))
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @ApiProperty({ required: false, maxLength: 255 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @ApiProperty({ required: false, maxLength: 32 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiProperty({ required: false, nullable: true, description: 'The employee who heads the branch. A role limited to its branch sees the branches its person heads' })
  @IsOptional()
  @IsUUID()
  headEmployeeId?: string | null;
}

export class UpdateBranchDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() || null : value))
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  headEmployeeId?: string | null;

  @ApiProperty({ required: false, description: 'An inactive branch keeps its people but cannot be given new ones' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class GetBranchesQueryDto {
  @ApiProperty({ required: false, description: 'Name, code or city, max 100' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, enum: BranchStatusFilter, default: 'ALL' })
  @IsOptional()
  @IsEnum(BranchStatusFilter)
  status?: BranchStatusFilter;
}

export class AssignBranchEmployeesDto {
  @ApiProperty({ type: [String], description: `1 to ${BRANCH_ASSIGN_MAX_EMPLOYEES} employees` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BRANCH_ASSIGN_MAX_EMPLOYEES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  employeeIds: string[];
}

export class BranchesFromLocationsDto {
  @ApiProperty({ required: false, default: false, description: 'false shows what would be created and moved; true does it' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  apply?: boolean;
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class BranchTenantMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;
}

export class GetBranchesMessageDto extends BranchTenantMessageDto {
  @ApiProperty({ type: GetBranchesQueryDto })
  @ValidateNested()
  @Type(() => GetBranchesQueryDto)
  @IsDefined()
  query: GetBranchesQueryDto;
}

export class BranchIdMessageDto extends BranchTenantMessageDto {
  @ApiProperty()
  @IsUUID()
  branchId: string;
}

export class CreateBranchMessageDto extends BranchTenantMessageDto {
  @ApiProperty({ type: CreateBranchDto })
  @ValidateNested()
  @Type(() => CreateBranchDto)
  @IsDefined()
  dto: CreateBranchDto;
}

export class UpdateBranchMessageDto extends BranchIdMessageDto {
  @ApiProperty({ type: UpdateBranchDto })
  @ValidateNested()
  @Type(() => UpdateBranchDto)
  @IsDefined()
  dto: UpdateBranchDto;
}

export class AssignBranchEmployeesMessageDto extends BranchIdMessageDto {
  @ApiProperty({ type: AssignBranchEmployeesDto })
  @ValidateNested()
  @Type(() => AssignBranchEmployeesDto)
  @IsDefined()
  dto: AssignBranchEmployeesDto;
}

export class BranchesFromLocationsMessageDto extends BranchTenantMessageDto {
  @ApiProperty({ type: BranchesFromLocationsDto })
  @ValidateNested()
  @Type(() => BranchesFromLocationsDto)
  @IsDefined()
  dto: BranchesFromLocationsDto;
}
