import { IsDefined, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The final settlement of someone leaving: what the organization owes them
 * (leave they may cash in, anything else) and what they owe it (the balance of
 * a loan or advance), added up. It is prepared, checked by someone other than
 * the person who prepared it, and when approved becomes ordinary earnings and
 * deductions in the payroll of their last month. Tax is not worked out here:
 * it is entered as a line.
 */

export enum SettlementStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export enum SettlementStatusFilter {
  ALL = 'ALL',
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export enum SettlementLineType {
  EARNING = 'EARNING',
  DEDUCTION = 'DEDUCTION',
}

/** What an earning is, which decides how the tax rule treats it in payroll. */
export const SETTLEMENT_EARNING_CATEGORIES = ['BONUS', 'ARREARS', 'COMMISSION', 'REIMBURSEMENT', 'OTHER'] as const;

export const SETTLEMENT_MAX_LINES = 30;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class SettlementLineDto {
  @ApiProperty({ enum: SettlementLineType })
  @IsEnum(SettlementLineType)
  type: SettlementLineType;

  @ApiProperty({ example: 'Notice period shortfall', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label: string;

  @ApiProperty({ example: 25000, minimum: 0.01, description: 'Always positive: the type says whether it is added or taken' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000000)
  amount: number;

  @ApiProperty({ required: false, enum: SETTLEMENT_EARNING_CATEGORIES, description: 'Earnings only: what it is, for the tax rule. Defaults to OTHER' })
  @IsOptional()
  @IsIn(SETTLEMENT_EARNING_CATEGORIES as unknown as string[])
  category?: (typeof SETTLEMENT_EARNING_CATEGORIES)[number];
}

export class UpdateSettlementLineDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;

  @ApiProperty({ required: false, minimum: 0.01 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000000)
  amount?: number;

  @ApiProperty({ required: false, enum: SETTLEMENT_EARNING_CATEGORIES })
  @IsOptional()
  @IsIn(SETTLEMENT_EARNING_CATEGORIES as unknown as string[])
  category?: (typeof SETTLEMENT_EARNING_CATEGORIES)[number];
}

export class UpdateSettlementDto {
  @ApiProperty({ required: false, example: '2026-12', description: 'The payroll month it is paid in. Defaults to the month of the last working day' })
  @IsOptional()
  @Matches(PERIOD, { message: 'The payroll month is YYYY-MM.' })
  payrollPeriod?: string;
}

export class DecideSettlementDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsIn(['APPROVE', 'REJECT'])
  decision: 'APPROVE' | 'REJECT';

  @ApiProperty({ required: false, maxLength: 500, description: 'Required when rejecting' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @ApiProperty({ required: false, example: '2026-12', description: 'Approving the last stage: the payroll month to pay it in, if not the one it was prepared for' })
  @IsOptional()
  @Matches(PERIOD, { message: 'The payroll month is YYYY-MM.' })
  payrollPeriod?: string;
}

export class GetSettlementsQueryDto {
  @ApiProperty({ required: false, enum: SettlementStatusFilter, default: 'ALL' })
  @IsOptional()
  @IsEnum(SettlementStatusFilter)
  status?: SettlementStatusFilter;

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

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class SettlementActorDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;
}

export class SettlementCaseMessageDto extends SettlementActorDto {
  @ApiProperty()
  @IsUUID()
  caseId: string;
}

export class SettlementIdMessageDto extends SettlementActorDto {
  @ApiProperty()
  @IsUUID()
  settlementId: string;
}

export class GetSettlementsMessageDto extends SettlementActorDto {
  @ApiProperty({ type: GetSettlementsQueryDto })
  @ValidateNested()
  @Type(() => GetSettlementsQueryDto)
  @IsDefined()
  query: GetSettlementsQueryDto;
}

export class UpdateSettlementMessageDto extends SettlementIdMessageDto {
  @ApiProperty({ type: UpdateSettlementDto })
  @ValidateNested()
  @Type(() => UpdateSettlementDto)
  @IsDefined()
  dto: UpdateSettlementDto;
}

export class AddSettlementLineMessageDto extends SettlementIdMessageDto {
  @ApiProperty({ type: SettlementLineDto })
  @ValidateNested()
  @Type(() => SettlementLineDto)
  @IsDefined()
  dto: SettlementLineDto;
}

export class SettlementLineIdMessageDto extends SettlementIdMessageDto {
  @ApiProperty()
  @IsUUID()
  lineId: string;
}

export class UpdateSettlementLineMessageDto extends SettlementLineIdMessageDto {
  @ApiProperty({ type: UpdateSettlementLineDto })
  @ValidateNested()
  @Type(() => UpdateSettlementLineDto)
  @IsDefined()
  dto: UpdateSettlementLineDto;
}

export class DecideSettlementMessageDto extends SettlementIdMessageDto {
  @ApiProperty({ type: DecideSettlementDto })
  @ValidateNested()
  @Type(() => DecideSettlementDto)
  @IsDefined()
  dto: DecideSettlementDto;
}
