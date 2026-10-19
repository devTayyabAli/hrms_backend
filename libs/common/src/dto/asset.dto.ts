import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  /** Broken and not yet being fixed. The holder, if any, stays on record. */
  DAMAGED = 'DAMAGED',
  /** Cannot be found. The holder, if any, stays on record. */
  LOST = 'LOST',
  DISPOSED = 'DISPOSED',
}

/** The state an asset is in when it is handed back. */
export enum AssetCondition {
  GOOD = 'GOOD',
  FAIR = 'FAIR',
  DAMAGED = 'DAMAGED',
}

/** Routine service, or fixing something that broke. */
export enum AssetMaintenanceType {
  MAINTENANCE = 'MAINTENANCE',
  REPAIR = 'REPAIR',
}

/** The checklist the assign form starts from. The person handing the asset over has to tick every item. */
export const DEFAULT_HANDOVER_CHECKLIST = [
  'Asset is in working condition',
  'Charger, cables and accessories handed over',
  'Asset tag is attached and legible',
  'Employee has been briefed on the usage policy',
] as const;

export const ASSET_SPECIFICATIONS_MAX = 20;

/** Adds ALL so the status filter can express "no filter". */
export enum AssetStatusFilter {
  ALL = 'ALL',
  AVAILABLE = 'AVAILABLE',
  IN_USE = 'IN_USE',
  MAINTENANCE = 'MAINTENANCE',
  DAMAGED = 'DAMAGED',
  LOST = 'LOST',
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

  @ApiProperty({ required: false, description: 'Only the assets held by people in this department' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

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

export class AssetSpecificationDto {
  @ApiProperty({ example: 'RAM' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Each specification needs a name.' })
  @MaxLength(50)
  key: string;

  @ApiProperty({ example: '16 GB' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Each specification needs a value.' })
  @MaxLength(200)
  value: string;
}

export class HandoverChecklistItemDto {
  @ApiProperty({ example: 'Charger, cables and accessories handed over' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  item: string;

  @ApiProperty({ description: 'Every item has to be ticked before an asset can be handed over' })
  @IsBoolean()
  checked: boolean;
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


  @ApiProperty({
    required: false,
    type: () => [AssetSpecificationDto],
    description: 'Specifications as name / value pairs, e.g. [{ "key": "RAM", "value": "16 GB" }]. Sending the list replaces the whole list.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ASSET_SPECIFICATIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => AssetSpecificationDto)
  specifications?: AssetSpecificationDto[];

  @ApiProperty({ required: false, description: 'Give it to this employee straight away; the asset is then In Use. Needs the handover checklist.' })
  @IsOptional()
  @IsUUID()
  assignedEmployeeId?: string;

  @ApiProperty({ required: false, example: '2026-10-19', description: 'With assignedEmployeeId: the day it was handed over (not in the future). Defaults to today.' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  assignedOn?: string | null;

  @ApiProperty({ required: false, type: () => [HandoverChecklistItemDto], description: 'With assignedEmployeeId: the handover checklist, every item ticked.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HandoverChecklistItemDto)
  checklist?: HandoverChecklistItemDto[];
}

/** Everything except where it is and who has it — those change through the assign, return, maintenance, damage, loss and dispose actions. */
export class UpdateAssetDto {
  @ApiProperty({
    required: false,
    type: () => [AssetSpecificationDto],
    description: 'Specifications as name / value pairs, e.g. [{ "key": "RAM", "value": "16 GB" }]. Sending the list replaces the whole list.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ASSET_SPECIFICATIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => AssetSpecificationDto)
  specifications?: AssetSpecificationDto[];


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

  @ApiProperty({ required: false, example: '2026-10-19', description: 'The day it was handed over (YYYY-MM-DD, not in the future). Defaults to today.' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  assignedOn?: string | null;

  @ApiProperty({
    type: () => [HandoverChecklistItemDto],
    description: 'The handover checklist. Required, and every item has to be ticked (GET organization/assets/handover-checklist has the standard items).',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Complete the handover checklist before handing the asset over.' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HandoverChecklistItemDto)
  checklist: HandoverChecklistItemDto[];

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

export class ReturnAssetDto {
  @ApiProperty({ enum: AssetCondition, description: 'The state it came back in. Damaged puts the asset in Damaged instead of back in stock.' })
  @IsEnum(AssetCondition)
  condition: AssetCondition;

  @ApiProperty({ required: false, example: 'Left the company' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class StartMaintenanceDto {
  @ApiProperty({ enum: AssetMaintenanceType, required: false, default: AssetMaintenanceType.REPAIR })
  @IsOptional()
  @IsEnum(AssetMaintenanceType)
  type?: AssetMaintenanceType;

  @ApiProperty({ required: false, example: 'Screen flickering' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  issue?: string | null;

  @ApiProperty({ required: false, example: 'Apple Authorized Service' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(150)
  vendor?: string | null;

  @ApiProperty({ required: false, example: '2026-10-19', description: 'YYYY-MM-DD, not in the future. Defaults to today.' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  startedOn?: string | null;

  @ApiProperty({ required: false, example: '2026-10-26', description: 'When it is expected back; not before startedOn.' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  expectedOn?: string | null;

  @ApiProperty({ required: false, example: 120, minimum: 0 })
  @IsOptional()
  @Transform(toCost)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999)
  estimatedCost?: number | null;
}

export class CompleteMaintenanceDto {
  @ApiProperty({ required: false, example: 'Screen replaced' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  resolution?: string | null;

  @ApiProperty({ required: false, example: 135.5, minimum: 0, description: 'What it actually cost' })
  @IsOptional()
  @Transform(toCost)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999)
  cost?: number | null;

  @ApiProperty({ required: false, example: '2026-10-24', description: 'YYYY-MM-DD, not before it started and not in the future. Defaults to today.' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  completedOn?: string | null;
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

export class ReturnAssetMessageDto extends AssetIdMessageDto {
  @ApiProperty({ type: ReturnAssetDto })
  @ValidateNested()
  @Type(() => ReturnAssetDto)
  @IsDefined()
  dto: ReturnAssetDto;
}

export class StartMaintenanceMessageDto extends AssetIdMessageDto {
  @ApiProperty({ type: StartMaintenanceDto })
  @ValidateNested()
  @Type(() => StartMaintenanceDto)
  @IsDefined()
  dto: StartMaintenanceDto;
}

export class CompleteMaintenanceMessageDto extends AssetIdMessageDto {
  @ApiProperty({ type: CompleteMaintenanceDto })
  @ValidateNested()
  @Type(() => CompleteMaintenanceDto)
  @IsDefined()
  dto: CompleteMaintenanceDto;
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
