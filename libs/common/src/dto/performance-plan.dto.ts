import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
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

/**
 * KPIs and goals. HR keeps KPI templates by department and designation; when
 * someone is enrolled in a cycle they get the template that fits them, their
 * manager adjusts it and sets their goals, and the employee sees the plan once
 * it is published.
 */
export enum KpiMeasurement {
  NUMBER = 'NUMBER',
  PERCENT = 'PERCENT',
  YES_NO = 'YES_NO',
  RATING = 'RATING',
}

/** Most KPIs, and most goals, in one plan or template. */
export const MAX_PLAN_ITEMS = 15;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class KpiItemDto {
  @ApiProperty({ required: false, description: 'Present when changing a KPI that already exists' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Tickets resolved within SLA', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({ minimum: 1, maximum: 100, example: 25, description: 'Its share of the KPI score. A plan\'s weights add up to 100' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  weight: number;

  @ApiProperty({ required: false, example: '95%', maxLength: 100 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  target?: string | null;

  @ApiProperty({ required: false, example: 'tickets', maxLength: 30 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(30)
  unit?: string | null;

  @ApiProperty({ enum: KpiMeasurement, required: false, default: KpiMeasurement.NUMBER })
  @IsOptional()
  @IsEnum(KpiMeasurement)
  measurement?: KpiMeasurement;

  @ApiProperty({ required: false, maxLength: 60 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(60)
  category?: string | null;
}

export class CreateKpiTemplateDto {
  @ApiProperty({ example: 'Support engineer', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({ type: [String], required: false, description: 'Departments it fits, and the ones under them. Empty: any department' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  departmentIds?: string[];

  @ApiProperty({ type: [String], required: false, description: 'Designations it fits. Empty: any designation' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  designationIds?: string[];

  @ApiProperty({ type: [KpiItemDto], description: `1 to ${MAX_PLAN_ITEMS} KPIs; the weights add up to 100` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PLAN_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => KpiItemDto)
  items: KpiItemDto[];
}

export class UpdateKpiTemplateDto {
  @ApiProperty({ required: false, maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  departmentIds?: string[];

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  designationIds?: string[];

  @ApiProperty({ type: [KpiItemDto], required: false, description: 'Replaces the KPIs. Plans already made keep theirs' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PLAN_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => KpiItemDto)
  items?: KpiItemDto[];

  @ApiProperty({ required: false, description: 'false stops it being given to people enrolled from now on' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PlanGoalDto {
  @ApiProperty({ required: false, description: 'Present when changing a goal that already exists' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Move the billing service to the new gateway', maxLength: 255 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title: string;

  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @ApiProperty({ required: false, format: 'date', nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

/** The KPIs and goals of one review. Each list given replaces the one before; leave a list out to keep it. */
export class SavePerformancePlanDto {
  @ApiProperty({ type: [KpiItemDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PLAN_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => KpiItemDto)
  kpis?: KpiItemDto[];

  @ApiProperty({ type: [PlanGoalDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PLAN_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => PlanGoalDto)
  goals?: PlanGoalDto[];
}

export class KpiScoreDto {
  @ApiProperty()
  @IsUUID()
  kpiId: string;

  @ApiProperty({ required: false, example: '97%', maxLength: 100, description: 'What was achieved' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  actual?: string | null;

  @ApiProperty({ required: false, minimum: 0, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  score?: number;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  comment?: string | null;
}

export class GetMatchingTemplateQueryDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;
}
