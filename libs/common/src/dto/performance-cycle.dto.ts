import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
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
 * A performance review cycle and who it is for. HR sets the rules; Employee
 * Management stays the source of who each person is.
 */
export enum PerformanceCycleStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
}

export enum CycleEnrolmentMode {
  /** Eligible people get their review when the cycle launches, and as they become eligible. */
  AUTO_ENROL = 'AUTO_ENROL',
  /** Eligible people wait in a queue for HR to enrol them. */
  HR_QUEUE = 'HR_QUEUE',
}

export enum ProbationRuleDto {
  INCLUDE = 'INCLUDE',
  EXCLUDE = 'EXCLUDE',
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class EligibilityRulesDto {
  @ApiProperty({ required: false, default: 90, minimum: 0, maximum: 3650, description: 'Whole days employed, on the day of the check and no later than the last day of the cycle' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  minTenureDays?: number;

  @ApiProperty({ enum: ProbationRuleDto, required: false, default: ProbationRuleDto.EXCLUDE, description: 'EXCLUDE leaves out people still in probation' })
  @IsOptional()
  @IsEnum(ProbationRuleDto)
  probation?: ProbationRuleDto;

  @ApiProperty({ type: [String], required: false, description: 'PERMANENT, PROBATION, CONTRACT, INTERNSHIP, PART_TIME, CONSULTANT, TEMPORARY. Empty means all' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  employmentTypes?: string[];

  @ApiProperty({ type: [String], required: false, description: 'A department includes the ones under it. Empty means all' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  departmentIds?: string[];

  @ApiProperty({ type: [String], required: false, description: 'Empty means all' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  designationIds?: string[];

  @ApiProperty({ type: [String], required: false, description: 'Always in, whatever the other rules say (but never someone who has left)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  includeEmployeeIds?: string[];

  @ApiProperty({ type: [String], required: false, description: 'Always out, whatever the other rules say' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  excludeEmployeeIds?: string[];
}

export class CreatePerformanceCycleDto {
  @ApiProperty({ example: 'H2 2026', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '2026-07-01', description: 'The first day of the period being reviewed' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2026-12-31', description: 'The last day of the period being reviewed' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ required: false, example: '2027-01-31', description: 'When reviews should be done' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiProperty({ enum: CycleEnrolmentMode, required: false, default: CycleEnrolmentMode.AUTO_ENROL })
  @IsOptional()
  @IsEnum(CycleEnrolmentMode)
  enrolmentMode?: CycleEnrolmentMode;

  @ApiProperty({ type: EligibilityRulesDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => EligibilityRulesDto)
  eligibility?: EligibilityRulesDto;

  @ApiProperty({ required: false, description: 'Who completes the review of someone with no reporting manager. Leave out for HR to do it' })
  @IsOptional()
  @IsUUID()
  fallbackReviewerId?: string;
}

export class UpdatePerformanceCycleDto {
  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  @ApiProperty({ enum: CycleEnrolmentMode, required: false })
  @IsOptional()
  @IsEnum(CycleEnrolmentMode)
  enrolmentMode?: CycleEnrolmentMode;

  @ApiProperty({ type: EligibilityRulesDto, required: false, description: 'Replaces the rules. People already enrolled keep their reviews' })
  @IsOptional()
  @ValidateNested()
  @Type(() => EligibilityRulesDto)
  eligibility?: EligibilityRulesDto;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  fallbackReviewerId?: string | null;
}

export class EnrolInCycleDto {
  @ApiProperty({ type: [String], description: '1 to 200 employees' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  employeeIds: string[];

  @ApiProperty({ required: false, default: false, description: 'Enrol someone the rules leave out. Needs performance.manage, and is recorded' })
  @IsOptional()
  @IsBoolean()
  override?: boolean;
}

/** What HR decides about an open review whose person changed. */
export enum ReviewChangeDecision {
  /** Leave it as it is: same reviewer, same KPIs and criteria. */
  KEEP = 'KEEP',
  /** Give it to a new reviewer (the person's new manager unless one is named). Same KPIs. */
  REASSIGN = 'REASSIGN',
  /** Start the plan again on the person's new department and designation. Not once KPIs are scored. */
  RESTART = 'RESTART',
  /** Take the person out of the cycle. The review is closed, not deleted. */
  REMOVE = 'REMOVE',
}

export class ReviewChangeDecisionDto {
  @ApiProperty({ enum: ReviewChangeDecision })
  @IsEnum(ReviewChangeDecision)
  decision: ReviewChangeDecision;

  @ApiProperty({ required: false, description: 'REASSIGN only: the new reviewer. Leave out for the person\'s reporting manager' })
  @IsOptional()
  @IsUUID()
  reviewerId?: string;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class GetPerformanceCyclesQueryDto {
  @ApiProperty({ enum: PerformanceCycleStatus, required: false })
  @IsOptional()
  @IsEnum(PerformanceCycleStatus)
  status?: PerformanceCycleStatus;
}
