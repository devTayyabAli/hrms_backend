import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
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

export const SHIFT_WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type ShiftWeekday = (typeof SHIFT_WEEKDAYS)[number];

/** 24-hour "HH:mm". An end earlier than the start means the shift runs past midnight. */
export const SHIFT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHIFT_TIME_MESSAGE = 'Use 24-hour HH:mm, for example 09:00.';

/** Longest unpaid break a shift can carry. */
export const SHIFT_MAX_BREAK_MINUTES = 480;

/** Adds ALL so the status tabs can express "no filter". */
export enum ShiftStatusFilter {
  ALL = 'ALL',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class GetShiftsQueryDto {
  @ApiProperty({ enum: ShiftStatusFilter, required: false, default: ShiftStatusFilter.ALL })
  @IsOptional()
  @IsEnum(ShiftStatusFilter)
  status?: ShiftStatusFilter = ShiftStatusFilter.ALL;

  @ApiProperty({ required: false, description: 'Search by shift name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class CreateShiftDto {
  @ApiProperty({ example: 'Morning Shift', description: 'Unique within the organization (not case-sensitive)' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Shift name is required.' })
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @Matches(SHIFT_TIME_PATTERN, { message: SHIFT_TIME_MESSAGE })
  startTime: string;

  @ApiProperty({ example: '18:00', description: 'Earlier than startTime for a night shift that ends the next day' })
  @IsString()
  @Matches(SHIFT_TIME_PATTERN, { message: SHIFT_TIME_MESSAGE })
  endTime: string;

  @ApiProperty({ required: false, default: 60, minimum: 0, maximum: SHIFT_MAX_BREAK_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(SHIFT_MAX_BREAK_MINUTES)
  breakMinutes?: number = 60;

  @ApiProperty({ enum: SHIFT_WEEKDAYS, isArray: true, example: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] })
  @IsIn(SHIFT_WEEKDAYS, { each: true, message: 'Each working day must be MONDAY to SUNDAY.' })
  @ArrayMinSize(1, { message: 'Pick at least one working day.' })
  @ArrayUnique()
  workingDays: ShiftWeekday[];

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean = true;
}

export class UpdateShiftDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Shift name is required.' })
  @MaxLength(100)
  name?: string;

  @ApiProperty({ required: false, example: '09:00' })
  @IsOptional()
  @IsString()
  @Matches(SHIFT_TIME_PATTERN, { message: SHIFT_TIME_MESSAGE })
  startTime?: string;

  @ApiProperty({ required: false, example: '18:00' })
  @IsOptional()
  @IsString()
  @Matches(SHIFT_TIME_PATTERN, { message: SHIFT_TIME_MESSAGE })
  endTime?: string;

  @ApiProperty({ required: false, minimum: 0, maximum: SHIFT_MAX_BREAK_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(SHIFT_MAX_BREAK_MINUTES)
  breakMinutes?: number;

  @ApiProperty({ required: false, enum: SHIFT_WEEKDAYS, isArray: true })
  @IsOptional()
  @IsIn(SHIFT_WEEKDAYS, { each: true, message: 'Each working day must be MONDAY to SUNDAY.' })
  @ArrayMinSize(1, { message: 'Pick at least one working day.' })
  @ArrayUnique()
  workingDays?: ShiftWeekday[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AssignShiftEmployeesDto {
  @ApiProperty({
    type: [String],
    description: 'The complete set of employees on this shift. Anyone listed is moved here from another shift; anyone not listed is taken off it.',
  })
  @IsUUID('all', { each: true })
  @ArrayUnique()
  @ArrayMaxSize(1000)
  employeeIds: string[];
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class ShiftTenantDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;
}

export class GetShiftsMessageDto extends ShiftTenantDto {
  @ApiProperty({ type: GetShiftsQueryDto })
  @ValidateNested()
  @Type(() => GetShiftsQueryDto)
  @IsDefined()
  query: GetShiftsQueryDto;
}

export class ShiftIdMessageDto extends ShiftTenantDto {
  @ApiProperty()
  @IsUUID()
  shiftId: string;
}

export class CreateShiftMessageDto extends ShiftTenantDto {
  @ApiProperty({ type: CreateShiftDto })
  @ValidateNested()
  @Type(() => CreateShiftDto)
  @IsDefined()
  dto: CreateShiftDto;
}

export class UpdateShiftMessageDto extends ShiftIdMessageDto {
  @ApiProperty({ type: UpdateShiftDto })
  @ValidateNested()
  @Type(() => UpdateShiftDto)
  @IsDefined()
  dto: UpdateShiftDto;
}

export class AssignShiftEmployeesMessageDto extends ShiftIdMessageDto {
  @ApiProperty({ type: AssignShiftEmployeesDto })
  @ValidateNested()
  @Type(() => AssignShiftEmployeesDto)
  @IsDefined()
  dto: AssignShiftEmployeesDto;
}
