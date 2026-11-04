import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDateString, IsDefined, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Offboarding: one case for each person leaving, with a clearance from each
 * department that must say they have nothing outstanding. Whether an
 * employee can be marked Resigned only once every clearance is in is the
 * organization's choice (off until it turns it on).
 */

export enum OffboardingType {
  RESIGNATION = 'RESIGNATION',
  TERMINATION = 'TERMINATION',
  END_OF_CONTRACT = 'END_OF_CONTRACT',
  RETIREMENT = 'RETIREMENT',
  OTHER = 'OTHER',
}

export enum OffboardingStage {
  MANAGER = 'MANAGER',
  HR = 'HR',
  IT = 'IT',
  FINANCE = 'FINANCE',
}

/** The state a case is shown in. OPEN cases are INITIATED, IN_CLEARANCE or CLEARED depending on their clearances. */
export enum OffboardingCaseStatus {
  INITIATED = 'INITIATED',
  IN_CLEARANCE = 'IN_CLEARANCE',
  CLEARED = 'CLEARED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum OffboardingCaseFilter {
  ALL = 'ALL',
  OPEN = 'OPEN',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

export class InitiateOffboardingDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ enum: OffboardingType })
  @IsEnum(OffboardingType)
  type: OffboardingType;

  @ApiProperty({ required: false, nullable: true, example: '2026-11-01', description: 'The day notice was given. Not after the last working day' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  noticeDate?: string | null;

  @ApiProperty({ example: '2026-12-01', description: 'The last day they work' })
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  lastWorkingDay: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class UpdateOffboardingDto {
  @ApiProperty({ required: false, enum: OffboardingType })
  @IsOptional()
  @IsEnum(OffboardingType)
  type?: OffboardingType;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  noticeDate?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  lastWorkingDay?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class OffboardingNoteDto {
  @ApiProperty({ required: false, nullable: true, maxLength: 500, example: 'Laptop and ID card returned' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** My clearance on someone's offboarding: the reporting manager's by default, or a step their department added that is mine. */
export class ClearMyOffboardingDto extends OffboardingNoteDto {
  @ApiProperty({ required: false, default: 'MANAGER', example: 'DEPT-1', description: 'MANAGER, or the key of a department step (DEPT-1, DEPT-2 ...)' })
  @IsOptional()
  @Matches(/^(MANAGER|DEPT-\d{1,3})$/, { message: 'Use MANAGER, or a department step such as DEPT-1.' })
  stage?: string;
}

export class CancelOffboardingDto {
  @ApiProperty({ required: false, nullable: true, maxLength: 500, example: 'Resignation withdrawn' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class GetOffboardingCasesQueryDto {
  @ApiProperty({ required: false, enum: OffboardingCaseFilter, default: 'OPEN' })
  @IsOptional()
  @IsEnum(OffboardingCaseFilter)
  status?: OffboardingCaseFilter;

  @ApiProperty({ required: false, description: 'Employee name or code, max 100' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

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

export class UpdateOffboardingSettingsDto {
  @ApiProperty({ required: false, description: 'When on, an employee cannot be marked Resigned until their offboarding is cleared' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  gateEnabled?: boolean;

  @ApiProperty({ required: false, enum: OffboardingStage, isArray: true, description: 'Which clearances a case needs' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsEnum(OffboardingStage, { each: true })
  stages?: OffboardingStage[];
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class OffboardingActorDto {
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

export class OffboardingCaseIdMessageDto extends OffboardingActorDto {
  @ApiProperty()
  @IsUUID()
  caseId: string;
}

export class GetOffboardingCasesMessageDto extends OffboardingActorDto {
  @ApiProperty({ type: GetOffboardingCasesQueryDto })
  @ValidateNested()
  @Type(() => GetOffboardingCasesQueryDto)
  @IsDefined()
  query: GetOffboardingCasesQueryDto;
}

export class InitiateOffboardingMessageDto extends OffboardingActorDto {
  @ApiProperty({ type: InitiateOffboardingDto })
  @ValidateNested()
  @Type(() => InitiateOffboardingDto)
  @IsDefined()
  dto: InitiateOffboardingDto;
}

export class UpdateOffboardingMessageDto extends OffboardingCaseIdMessageDto {
  @ApiProperty({ type: UpdateOffboardingDto })
  @ValidateNested()
  @Type(() => UpdateOffboardingDto)
  @IsDefined()
  dto: UpdateOffboardingDto;
}

export class OffboardingStageMessageDto extends OffboardingCaseIdMessageDto {
  @ApiProperty({ enum: OffboardingStage })
  @IsEnum(OffboardingStage)
  stage: OffboardingStage;

  @ApiProperty({ type: OffboardingNoteDto })
  @ValidateNested()
  @Type(() => OffboardingNoteDto)
  @IsDefined()
  dto: OffboardingNoteDto;
}

export class CancelOffboardingMessageDto extends OffboardingCaseIdMessageDto {
  @ApiProperty({ type: CancelOffboardingDto })
  @ValidateNested()
  @Type(() => CancelOffboardingDto)
  @IsDefined()
  dto: CancelOffboardingDto;
}

export class UpdateOffboardingSettingsMessageDto extends OffboardingActorDto {
  @ApiProperty({ type: UpdateOffboardingSettingsDto })
  @ValidateNested()
  @Type(() => UpdateOffboardingSettingsDto)
  @IsDefined()
  dto: UpdateOffboardingSettingsDto;
}

export class ClearMyOffboardingMessageDto extends OffboardingCaseIdMessageDto {
  @ApiProperty({ type: ClearMyOffboardingDto })
  @ValidateNested()
  @Type(() => ClearMyOffboardingDto)
  @IsDefined()
  dto: ClearMyOffboardingDto;
}
