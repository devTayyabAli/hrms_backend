import { ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { PerformanceMetricScoresDto } from './performance-payroll.dto';
import { KpiScoreDto } from './performance-plan.dto';

/**
 * Performance, from the employee's side: their own goals, the self-assessment
 * they write for an open review, and the evaluations HR has published to them.
 */

export const PERFORMANCE_COMMENTS_MAX = 2000;

/** Who is asking: the signed-in login, which the service maps to an employee. */
export class PerformanceActorDto {
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

/** The same five 0 to 5 scores a reviewer gives, as the employee sees themselves, plus a note. */
export class SubmitSelfAssessmentDto extends PerformanceMetricScoresDto {
  @ApiProperty({ required: false, example: 'Led the migration and mentored two juniors.', maxLength: PERFORMANCE_COMMENTS_MAX })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(PERFORMANCE_COMMENTS_MAX)
  comments?: string;
}

/** The reviewer's evaluation of someone they review: the five scores, feedback, and whether it is finished. */
export class SubmitReviewEvaluationDto extends PerformanceMetricScoresDto {
  @ApiProperty({ required: false, maxLength: PERFORMANCE_COMMENTS_MAX })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(PERFORMANCE_COMMENTS_MAX)
  reviewerComments?: string;

  @ApiProperty({ type: [KpiScoreDto], required: false, description: 'What was achieved on, and the score (0 to 5) for, each KPI of the review' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => KpiScoreDto)
  kpiScores?: KpiScoreDto[];

  @ApiProperty({ required: false, default: false, description: 'true completes the review (needs at least one score, on a KPI or a competency). false saves it as in progress' })
  @IsOptional()
  @IsBoolean()
  complete?: boolean;
}

export class UpdateMyGoalProgressDto {
  @ApiProperty({ minimum: 0, maximum: 100, example: 60 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  progress: number;
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class PerformanceReviewIdMessageDto extends PerformanceActorDto {
  @ApiProperty()
  @IsUUID()
  reviewId: string;
}

export class SubmitSelfAssessmentMessageDto extends PerformanceReviewIdMessageDto {
  @ApiProperty({ type: SubmitSelfAssessmentDto })
  @ValidateNested()
  @Type(() => SubmitSelfAssessmentDto)
  @IsDefined()
  dto: SubmitSelfAssessmentDto;
}

export class UpdateMyGoalProgressMessageDto extends PerformanceActorDto {
  @ApiProperty()
  @IsUUID()
  goalId: string;

  @ApiProperty({ type: UpdateMyGoalProgressDto })
  @ValidateNested()
  @Type(() => UpdateMyGoalProgressDto)
  @IsDefined()
  dto: UpdateMyGoalProgressDto;
}
