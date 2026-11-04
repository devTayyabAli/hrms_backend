import { IsDateString, IsDefined, IsEnum, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Learning, reported: the dashboard numbers, per-course and per-department
 * results, and the CSV of assignments. Everything follows the caller's data
 * scope, so a Team Lead's report is their team and HR's is everyone.
 */

export enum LearningReportGroup {
  COURSE = 'COURSE',
  DEPARTMENT = 'DEPARTMENT',
}

export class GetLearningReportQueryDto {
  @ApiProperty({ required: false, example: '2026-01-01', description: 'Courses assigned on or after this day (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  from?: string;

  @ApiProperty({ required: false, example: '2026-12-31', description: 'Courses assigned on or before this day (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  to?: string;

  @ApiProperty({ required: false, description: 'Only this department (as it was when assigned). Course report only' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class GetLearningReportMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ enum: LearningReportGroup })
  @IsEnum(LearningReportGroup)
  group: LearningReportGroup;

  @ApiProperty({ type: GetLearningReportQueryDto })
  @ValidateNested()
  @Type(() => GetLearningReportQueryDto)
  @IsDefined()
  query: GetLearningReportQueryDto;
}
