import { ApiProperty, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
 * Performance Improvement Plans, development goals and recommendations, and the
 * employee's acknowledgements.
 */
export enum PipStatus {
  PROPOSED = 'PROPOSED',
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  REJECTED = 'REJECTED',
}

export enum PipOutcome {
  SUCCESSFUL = 'SUCCESSFUL',
  UNSUCCESSFUL = 'UNSUCCESSFUL',
  CANCELLED = 'CANCELLED',
}

export enum PipTargetStatus {
  OPEN = 'OPEN',
  MET = 'MET',
  NOT_MET = 'NOT_MET',
}

export enum PipProgress {
  ON_TRACK = 'ON_TRACK',
  AT_RISK = 'AT_RISK',
  OFF_TRACK = 'OFF_TRACK',
}

export enum DevelopmentType {
  GOAL = 'GOAL',
  RECOMMENDATION = 'RECOMMENDATION',
}

export enum DevelopmentStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  DROPPED = 'DROPPED',
  DISMISSED = 'DISMISSED',
}

export enum AcknowledgementAgreement {
  AGREE = 'AGREE',
  DISAGREE = 'DISAGREE',
  NOTED = 'NOTED',
}

/** Longest a PIP can run, in days. */
export const MAX_PIP_DAYS = 180;
export const MAX_PIP_TARGETS = 10;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class PipTargetDto {
  @ApiProperty({ required: false, description: 'Present when changing a target that already exists' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Close at least 90% of assigned tickets within SLA', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({ required: false, maxLength: 500, description: 'How it will be judged met' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  successCriteria?: string | null;

  @ApiProperty({ required: false, format: 'date', nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  @ApiProperty({ enum: PipTargetStatus, required: false, default: PipTargetStatus.OPEN })
  @IsOptional()
  @IsEnum(PipTargetStatus)
  status?: PipTargetStatus;
}

export class CreatePipDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ required: false, description: 'The review it follows from' })
  @IsOptional()
  @IsUUID()
  reviewId?: string;

  @ApiProperty({ minLength: 10, maxLength: 3000, description: 'Why the plan is needed' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  reason: string;

  @ApiProperty({ example: '2026-11-15' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2027-02-15', description: `No more than ${MAX_PIP_DAYS} days after the start` })
  @IsDateString()
  endDate: string;

  @ApiProperty({ type: [PipTargetDto], description: `1 to ${MAX_PIP_TARGETS} targets` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PIP_TARGETS)
  @ValidateNested({ each: true })
  @Type(() => PipTargetDto)
  targets: PipTargetDto[];
}

export class UpdatePipDto {
  @ApiProperty({ required: false, maxLength: 3000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  reason?: string;

  @ApiProperty({ required: false, description: 'Only while it is a proposal' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, description: 'Once it is active, moving it later needs extensionReason' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false, maxLength: 500, description: 'Why the end date moved' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  extensionReason?: string;

  @ApiProperty({ type: [PipTargetDto], required: false, description: 'Replaces the targets. HR marks them MET or NOT_MET as the plan goes' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PIP_TARGETS)
  @ValidateNested({ each: true })
  @Type(() => PipTargetDto)
  targets?: PipTargetDto[];
}

export class RejectPipDto {
  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class PipCheckInDto {
  @ApiProperty({ minLength: 3, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  note: string;

  @ApiProperty({ enum: PipProgress })
  @IsEnum(PipProgress)
  progress: PipProgress;

  @ApiProperty({ required: false, format: 'date', description: 'Defaults to today' })
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class ClosePipDto {
  @ApiProperty({ enum: PipOutcome })
  @IsEnum(PipOutcome)
  outcome: PipOutcome;

  @ApiProperty({ required: false, maxLength: 3000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(3000)
  note?: string;
}

export class GetPipsQueryDto {
  @ApiProperty({ enum: PipStatus, required: false })
  @IsOptional()
  @IsEnum(PipStatus)
  status?: PipStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class CreateDevelopmentItemDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ enum: DevelopmentType, required: false, default: DevelopmentType.GOAL, description: 'A RECOMMENDATION waits for the employee to accept or dismiss it' })
  @IsOptional()
  @IsEnum(DevelopmentType)
  type?: DevelopmentType;

  @ApiProperty({ example: 'Learn system design', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false, maxLength: 2000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  skill?: string | null;

  @ApiProperty({ required: false, description: 'A course in Learning that would help' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @ApiProperty({ required: false, description: 'The review it comes from' })
  @IsOptional()
  @IsUUID()
  reviewId?: string;
}

export class CreateTeamDevelopmentItemDto extends OmitType(CreateDevelopmentItemDto, ['employeeId'] as const) {}

export class CreateMyDevelopmentItemDto {
  @ApiProperty({ maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false, maxLength: 2000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  skill?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  targetDate?: string;
}

export class UpdateDevelopmentItemDto {
  @ApiProperty({ required: false, maxLength: 200, description: 'Only on one you created' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ required: false, format: 'date', nullable: true })
  @IsOptional()
  @IsDateString()
  targetDate?: string | null;

  @ApiProperty({ required: false, minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiProperty({ enum: DevelopmentStatus, required: false })
  @IsOptional()
  @IsEnum(DevelopmentStatus)
  status?: DevelopmentStatus;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class GetDevelopmentQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ enum: DevelopmentStatus, required: false })
  @IsOptional()
  @IsEnum(DevelopmentStatus)
  status?: DevelopmentStatus;
}

export class AcknowledgeDto {
  @ApiProperty({ enum: AcknowledgementAgreement, required: false, default: AcknowledgementAgreement.NOTED })
  @IsOptional()
  @IsEnum(AcknowledgementAgreement)
  agreement?: AcknowledgementAgreement;

  @ApiProperty({ required: false, maxLength: 2000, description: 'Recorded beside the review or plan. It never changes the rating or the plan' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}

/**
 * The window a work summary covers. Send a review (its cycle's dates are used)
 * or a `from` and `to`; send nothing for everything on record.
 */
export class GetWorkSummaryQueryDto {
  @ApiProperty({ required: false, description: 'A review of this employee. The period is its cycle’s start and end.' })
  @IsOptional()
  @IsUUID()
  reviewId?: string;

  @ApiProperty({ required: false, example: '2026-07-01', description: 'First day, YYYY-MM-DD. Needs `to`.' })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiProperty({ required: false, example: '2026-12-31', description: 'Last day, YYYY-MM-DD. Needs `from`.' })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}

export class GetAcknowledgementsQueryDto {
  @ApiProperty({ enum: ['REVIEW', 'PIP'], required: false })
  @IsOptional()
  @IsEnum(['REVIEW', 'PIP'])
  kind?: 'REVIEW' | 'PIP';

  @ApiProperty({ enum: ['PENDING', 'ACKNOWLEDGED', 'DISAGREED'], required: false, default: 'PENDING' })
  @IsOptional()
  @IsEnum(['PENDING', 'ACKNOWLEDGED', 'DISAGREED'])
  status?: 'PENDING' | 'ACKNOWLEDGED' | 'DISAGREED';
}
