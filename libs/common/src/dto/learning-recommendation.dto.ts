import { IsDateString, IsDefined, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { LearningActorDto, TRAINING_MAX_DUE_DAYS } from './learning.dto';

/**
 * Learning, recommended: a reviewer suggests a course for someone, usually
 * after a performance review. It is only a suggestion. HR or whoever assigns
 * courses decides: assign it (it becomes an ordinary assignment) or dismiss it.
 */

export enum TrainingRecommendationStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  DISMISSED = 'DISMISSED',
}

export enum TrainingRecommendationStatusFilter {
  ALL = 'ALL',
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  DISMISSED = 'DISMISSED',
}

const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class CreateTrainingRecommendationDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ description: 'A published course' })
  @IsUUID()
  courseId: string;

  @ApiProperty({ required: false, description: 'The performance review this comes from. Must be this employee\'s' })
  @IsOptional()
  @IsUUID()
  reviewId?: string;

  @ApiProperty({ example: 'Communication scored 2.5 this cycle', description: 'Why, in a sentence' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  reason: string;
}

export class GetTrainingRecommendationsQueryDto {
  @ApiProperty({ required: false, enum: TrainingRecommendationStatusFilter, default: 'PENDING' })
  @IsOptional()
  @IsEnum(TrainingRecommendationStatusFilter)
  status?: TrainingRecommendationStatusFilter;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  courseId?: string;

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

export class ApproveTrainingRecommendationDto {
  @ApiProperty({ required: false, example: '2026-12-15', description: 'YYYY-MM-DD, today or later. Not together with dueInDays' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  dueDate?: string | null;

  @ApiProperty({ required: false, example: 14, minimum: 1, maximum: TRAINING_MAX_DUE_DAYS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRAINING_MAX_DUE_DAYS)
  dueInDays?: number;

  @ApiProperty({ required: false, description: 'Defaults to the course\'s "mandatory by default"' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  mandatory?: boolean;
}

export class DismissTrainingRecommendationDto {
  @ApiProperty({ required: false, example: 'Already covered in onboarding' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class CreateTrainingRecommendationMessageDto extends LearningActorDto {
  @ApiProperty({ type: CreateTrainingRecommendationDto })
  @ValidateNested()
  @Type(() => CreateTrainingRecommendationDto)
  @IsDefined()
  dto: CreateTrainingRecommendationDto;
}

export class GetTrainingRecommendationsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetTrainingRecommendationsQueryDto })
  @ValidateNested()
  @Type(() => GetTrainingRecommendationsQueryDto)
  @IsDefined()
  query: GetTrainingRecommendationsQueryDto;
}

export class TrainingRecommendationIdMessageDto extends LearningActorDto {
  @ApiProperty()
  @IsUUID()
  recommendationId: string;
}

export class ApproveTrainingRecommendationMessageDto extends TrainingRecommendationIdMessageDto {
  @ApiProperty({ type: ApproveTrainingRecommendationDto })
  @ValidateNested()
  @Type(() => ApproveTrainingRecommendationDto)
  @IsDefined()
  dto: ApproveTrainingRecommendationDto;
}

export class DismissTrainingRecommendationMessageDto extends TrainingRecommendationIdMessageDto {
  @ApiProperty({ type: DismissTrainingRecommendationDto })
  @ValidateNested()
  @Type(() => DismissTrainingRecommendationDto)
  @IsDefined()
  dto: DismissTrainingRecommendationDto;
}
