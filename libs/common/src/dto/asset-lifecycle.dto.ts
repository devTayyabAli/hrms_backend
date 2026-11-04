import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { AssetActorDto } from './asset.dto';

/**
 * Everything around an asset that is not the register itself: the employee's
 * own view and acknowledgement, repair requests, salary deductions for lost or
 * damaged assets, and the asset clearance a leaving employee needs.
 */

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export const PAYROLL_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// ==========================================
// Enums
// ==========================================

export enum AssetRequestType {
  REPAIR = 'REPAIR',
  REPLACEMENT = 'REPLACEMENT',
  DAMAGE_REPORT = 'DAMAGE_REPORT',
}

export enum AssetRequestStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
}

export enum AssetRequestStatusFilter {
  ALL = 'ALL',
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
}

/** What IT / Admin can move a request to. */
export enum AssetRequestDecision {
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
}

export enum AssetDeductionReason {
  LOST = 'LOST',
  DAMAGED = 'DAMAGED',
}

export enum AssetDeductionStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  WAIVED = 'WAIVED',
}

export enum AssetDeductionStatusFilter {
  ALL = 'ALL',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  WAIVED = 'WAIVED',
}

// ==========================================
// Requests: employee self-service
// ==========================================

export class AcceptAssetHandoverDto {
  @ApiProperty({ description: 'Must be true: "I received this asset and it works". If it does not, report it with a repair request instead.' })
  @IsBoolean()
  confirmed: boolean;

  @ApiProperty({ example: 'Ayesha Khan', description: 'The e-signature: the employee\'s full name, typed exactly as it is on their profile (case does not matter)' })
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Type your full name to sign.' })
  @MaxLength(150)
  signature: string;
}

export class CreateAssetRequestDto {
  @ApiProperty({ description: 'One of your own assets' })
  @IsUUID()
  assetId: string;

  @ApiProperty({ enum: AssetRequestType })
  @IsEnum(AssetRequestType)
  type: AssetRequestType;

  @ApiProperty({ example: 'The screen flickers when I plug in the charger.' })
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Describe the problem in a few words.' })
  @MaxLength(1000)
  description: string;
}

// ==========================================
// Requests: IT / Admin
// ==========================================

export class GetAssetRequestsQueryDto {
  @ApiProperty({ enum: AssetRequestStatusFilter, required: false, default: AssetRequestStatusFilter.ALL })
  @IsOptional()
  @IsEnum(AssetRequestStatusFilter)
  status?: AssetRequestStatusFilter = AssetRequestStatusFilter.ALL;

  @ApiProperty({ enum: AssetRequestType, required: false })
  @IsOptional()
  @IsEnum(AssetRequestType)
  type?: AssetRequestType;

  @ApiProperty({ required: false, description: 'Matches the employee\'s name, the asset\'s name, code or serial number, or the description' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

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

export class UpdateAssetRequestDto {
  @ApiProperty({ enum: AssetRequestDecision })
  @IsEnum(AssetRequestDecision)
  status: AssetRequestDecision;

  @ApiProperty({ required: false, example: 'Screen replaced under warranty', description: 'Required when rejecting' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  resolutionNote?: string | null;
}

// ==========================================
// Requests: deductions and clearance
// ==========================================

export class GetAssetDeductionsQueryDto {
  @ApiProperty({ enum: AssetDeductionStatusFilter, required: false, default: AssetDeductionStatusFilter.ALL })
  @IsOptional()
  @IsEnum(AssetDeductionStatusFilter)
  status?: AssetDeductionStatusFilter = AssetDeductionStatusFilter.ALL;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

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

export class ApproveAssetDeductionDto {
  @ApiProperty({ example: 1899.5, description: 'What is taken from the salary. May differ from the suggested amount (the asset\'s cost)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'The deduction has to be more than zero. To take nothing, waive it.' })
  @Max(9999999999)
  amount: number;

  @ApiProperty({ required: false, example: '2026-11', description: 'The payroll month it is taken in (YYYY-MM). Defaults to the current month; payroll for a month that already has a run does not pick it up.' })
  @IsOptional()
  @Matches(PAYROLL_PERIOD_PATTERN, { message: 'Use a month as YYYY-MM.' })
  payrollPeriod?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class WaiveAssetDeductionDto {
  @ApiProperty({ required: false, example: 'Normal wear, not the employee\'s fault' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class ConfirmAssetClearanceDto {
  @ApiProperty({ required: false, example: 'Laptop and ID card received, both fine' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class AssetAcceptMessageDto extends AssetActorDto {
  @ApiProperty()
  @IsUUID()
  assetId: string;

  @ApiProperty({ type: AcceptAssetHandoverDto })
  @ValidateNested()
  @Type(() => AcceptAssetHandoverDto)
  @IsDefined()
  dto: AcceptAssetHandoverDto;
}

export class CreateAssetRequestMessageDto extends AssetActorDto {
  @ApiProperty({ type: CreateAssetRequestDto })
  @ValidateNested()
  @Type(() => CreateAssetRequestDto)
  @IsDefined()
  dto: CreateAssetRequestDto;
}

export class GetAssetRequestsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetAssetRequestsQueryDto })
  @ValidateNested()
  @Type(() => GetAssetRequestsQueryDto)
  @IsDefined()
  query: GetAssetRequestsQueryDto;
}

export class UpdateAssetRequestMessageDto extends AssetActorDto {
  @ApiProperty()
  @IsUUID()
  requestId: string;

  @ApiProperty({ type: UpdateAssetRequestDto })
  @ValidateNested()
  @Type(() => UpdateAssetRequestDto)
  @IsDefined()
  dto: UpdateAssetRequestDto;
}

export class GetAssetDeductionsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetAssetDeductionsQueryDto })
  @ValidateNested()
  @Type(() => GetAssetDeductionsQueryDto)
  @IsDefined()
  query: GetAssetDeductionsQueryDto;
}

export class ApproveAssetDeductionMessageDto extends AssetActorDto {
  @ApiProperty()
  @IsUUID()
  deductionId: string;

  @ApiProperty({ type: ApproveAssetDeductionDto })
  @ValidateNested()
  @Type(() => ApproveAssetDeductionDto)
  @IsDefined()
  dto: ApproveAssetDeductionDto;
}

export class WaiveAssetDeductionMessageDto extends AssetActorDto {
  @ApiProperty()
  @IsUUID()
  deductionId: string;

  @ApiProperty({ type: WaiveAssetDeductionDto })
  @ValidateNested()
  @Type(() => WaiveAssetDeductionDto)
  @IsDefined()
  dto: WaiveAssetDeductionDto;
}

export class AssetClearanceMessageDto extends AssetActorDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;
}

export class ConfirmAssetClearanceMessageDto extends AssetClearanceMessageDto {
  @ApiProperty({ type: ConfirmAssetClearanceDto })
  @ValidateNested()
  @Type(() => ConfirmAssetClearanceDto)
  @IsDefined()
  dto: ConfirmAssetClearanceDto;
}
