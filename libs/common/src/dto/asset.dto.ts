import {
  IsDateString,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export enum AssetStatus {
  /** In stock, nobody has it. */
  AVAILABLE = 'AVAILABLE',
  /** Assigned to an employee. */
  IN_USE = 'IN_USE',
  MAINTENANCE = 'MAINTENANCE',
  DISPOSED = 'DISPOSED',
}

/** Adds ALL so the status filter can express "no filter". */
export enum AssetStatusFilter {
  ALL = 'ALL',
  AVAILABLE = 'AVAILABLE',
  IN_USE = 'IN_USE',
  MAINTENANCE = 'MAINTENANCE',
  DISPOSED = 'DISPOSED',
}

export const ASSET_SORTABLE_FIELDS = ['name', 'assetCode', 'category', 'serialNumber', 'status', 'assignedTo', 'purchaseDate', 'createdAt'] as const;
export type AssetSortField = (typeof ASSET_SORTABLE_FIELDS)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** An empty string from a cleared form field means "nothing". */
/** A cost typed as text becomes a number; an empty or null one stays "nothing" instead of becoming 0. */
const toCost = ({ value }: { value: unknown }) => (value === null || value === '' ? null : typeof value === 'string' ? Number(value) : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

// ==========================================
// Requests: assets
// ==========================================

export class ExportAssetsQueryDto {
  @ApiProperty({ required: false, description: 'Matches name, asset code, serial number, brand or the assignee\'s name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ enum: AssetStatusFilter, required: false, default: AssetStatusFilter.ALL })
  @IsOptional()
  @IsEnum(AssetStatusFilter)
  status?: AssetStatusFilter = AssetStatusFilter.ALL;

  @ApiProperty({ required: false, description: 'Only the assets this employee has' })
  @IsOptional()
  @IsUUID()
  assignedEmployeeId?: string;

  @ApiProperty({ required: false, enum: ASSET_SORTABLE_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(ASSET_SORTABLE_FIELDS)
  sortBy?: AssetSortField = 'createdAt';

  @ApiProperty({ required: false, enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class GetAssetsQueryDto extends ExportAssetsQueryDto {
  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export class CreateAssetDto {
  @ApiProperty({ example: 'MacBook Pro 14"' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Asset name is required.' })
  @MaxLength(150)
  name: string;

  @ApiProperty({ description: 'An asset category of this organization (GET organization/assets/categories)' })
  @IsUUID()
  categoryId: string;

  @ApiProperty({ required: false, example: 'SN12345789', description: 'Unique across the organization\'s assets when given' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  serialNumber?: string | null;

  @ApiProperty({ required: false, example: 'Apple' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  brand?: string | null;

  @ApiProperty({ required: false, example: '2026-03-15', description: 'YYYY-MM-DD' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  purchaseDate?: string | null;

  @ApiProperty({ required: false, example: 1899.0, minimum: 0 })
  @IsOptional()
  @Transform(toCost)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999)
  purchaseCost?: number | null;

  @ApiProperty({ required: false, example: '2029-03-15', description: 'YYYY-MM-DD' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  warrantyExpiry?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(150)
  vendor?: string | null;

  @ApiProperty({ required: false, example: 'Head Office, 2nd floor' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(150)
  location?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiProperty({ required: false, description: 'Give it to this employee straight away; the asset is then In Use.' })
  @IsOptional()
  @IsUUID()
  assignedEmployeeId?: string;
}

/** Everything except where it is and who has it — those change through the assign, return, maintenance and dispose actions. */
export class UpdateAssetDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Asset name is required.' })
  @MaxLength(150)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ required: false, description: 'null or empty clears it' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  serialNumber?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  brand?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  purchaseDate?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(toCost)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999)
  purchaseCost?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  warrantyExpiry?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(150)
  vendor?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(150)
  location?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class AssignAssetDto {
  @ApiProperty({ description: 'The employee who gets the asset (must still work here)' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ required: false, example: 'Handed over at onboarding' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** Return, start maintenance and finish maintenance all take just an optional remark for the history. */
export class AssetNoteDto {
  @ApiProperty({ required: false, example: 'Screen flickering' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class DisposeAssetDto {
  @ApiProperty({ required: false, example: 'Beyond repair' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

// ==========================================
// Requests: categories
// ==========================================

export class CreateAssetCategoryDto {
  @ApiProperty({ example: 'Laptop', description: 'Unique within the organization (not case-sensitive)' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Category name is required.' })
  @MaxLength(100)
  name: string;

  @ApiProperty({ required: false, example: 'laptop', description: 'An icon key for the screen; any short text' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(40)
  icon?: string | null;
}

export class UpdateAssetCategoryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Category name is required.' })
  @MaxLength(100)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(40)
  icon?: string | null;
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

/** Who is acting — recorded in the asset's history. */
export class AssetActorDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;
}

export class GetAssetsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetAssetsQueryDto })
  @ValidateNested()
  @Type(() => GetAssetsQueryDto)
  @IsDefined()
  query: GetAssetsQueryDto;
}

export class ExportAssetsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportAssetsQueryDto })
  @ValidateNested()
  @Type(() => ExportAssetsQueryDto)
  @IsDefined()
  query: ExportAssetsQueryDto;
}

export class AssetTenantMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;
}

export class AssetIdMessageDto extends AssetActorDto {
  @ApiProperty()
  @IsUUID()
  assetId: string;
}

export class CreateAssetMessageDto extends AssetActorDto {
  @ApiProperty({ type: CreateAssetDto })
  @ValidateNested()
  @Type(() => CreateAssetDto)
  @IsDefined()
  dto: CreateAssetDto;
}

export class UpdateAssetMessageDto extends AssetIdMessageDto {
  @ApiProperty({ type: UpdateAssetDto })
  @ValidateNested()
  @Type(() => UpdateAssetDto)
  @IsDefined()
  dto: UpdateAssetDto;
}

export class AssignAssetMessageDto extends AssetIdMessageDto {
  @ApiProperty({ type: AssignAssetDto })
  @ValidateNested()
  @Type(() => AssignAssetDto)
  @IsDefined()
  dto: AssignAssetDto;
}

export class AssetNoteMessageDto extends AssetIdMessageDto {
  @ApiProperty({ type: AssetNoteDto })
  @ValidateNested()
  @Type(() => AssetNoteDto)
  @IsDefined()
  dto: AssetNoteDto;
}

export class DisposeAssetMessageDto extends AssetIdMessageDto {
  @ApiProperty({ type: DisposeAssetDto })
  @ValidateNested()
  @Type(() => DisposeAssetDto)
  @IsDefined()
  dto: DisposeAssetDto;
}

export class CreateAssetCategoryMessageDto extends AssetActorDto {
  @ApiProperty({ type: CreateAssetCategoryDto })
  @ValidateNested()
  @Type(() => CreateAssetCategoryDto)
  @IsDefined()
  dto: CreateAssetCategoryDto;
}

export class AssetCategoryIdMessageDto extends AssetActorDto {
  @ApiProperty()
  @IsUUID()
  categoryId: string;
}

export class UpdateAssetCategoryMessageDto extends AssetCategoryIdMessageDto {
  @ApiProperty({ type: UpdateAssetCategoryDto })
  @ValidateNested()
  @Type(() => UpdateAssetCategoryDto)
  @IsDefined()
  dto: UpdateAssetCategoryDto;
}
