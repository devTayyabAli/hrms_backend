import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  Max,
  IsArray,
  IsISO8601,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The platform reports the Super Admin can run. */
export const REPORT_TYPES = [
  'organization-summary',
  'user-activity',
  'subscription-reports',
  'employee-growth',
  'system-usage',
  'security-audit',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Time windows a report can cover; `custom` uses `from`/`to`. */
export const REPORT_PERIODS = [
  'last-7-days',
  'last-30-days',
  'last-90-days',
  'this-month',
  'last-month',
  'last-12-months',
  'this-year',
  'all-time',
  'custom',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** What a report is filtered by. Every field is optional; each report uses the ones it supports. */
export class ReportFiltersDto {
  @ApiPropertyOptional({ enum: REPORT_PERIODS, example: 'last-30-days' })
  @IsOptional()
  @IsIn(REPORT_PERIODS as unknown as string[])
  period?: ReportPeriod;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'Start of a custom period (ISO date)',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description: 'End of a custom period (ISO date, inclusive)',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    example: 'ACTIVE',
    description: 'Organization or subscription status, depending on the report',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;
}

export class GenerateReportDto {
  @ApiProperty({ enum: REPORT_TYPES, example: 'organization-summary' })
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType: ReportType;

  @ApiPropertyOptional({ type: ReportFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportFiltersDto)
  filters?: ReportFiltersDto;

  @ApiPropertyOptional({
    type: [String],
    description: 'Column keys to include; all when omitted',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  columns?: string[];
}

export class PlatformGrowthQueryDto {
  @ApiPropertyOptional({ example: '6months', enum: ['6months', '12months'] })
  @IsOptional()
  @IsIn(['6months', '12months'])
  period?: '6months' | '12months' = '6months';
}

export class TopOrganizationsQueryDto {
  @ApiPropertyOptional({ example: 5, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 5;
}

export class CustomReportQueryDto {
  @ApiPropertyOptional({
    example: 'Organizations',
    description: 'Filter by category',
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    example: 'monthly',
    description: 'Search name or description',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 10, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export class CreateCustomReportDto {
  @ApiProperty({ example: 'Monthly organization review' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({
    example:
      'Every organization with its plan and headcount, for the monthly review.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    enum: REPORT_TYPES,
    example: 'organization-summary',
    description: 'Which report this is built on',
  })
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType: ReportType;

  @ApiPropertyOptional({ type: ReportFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportFiltersDto)
  filters?: ReportFiltersDto;

  @ApiPropertyOptional({
    type: [String],
    description: 'Column keys to include; all when omitted',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  columns?: string[];
}

export class UpdateCustomReportDto {
  @ApiPropertyOptional({ example: 'Monthly organization review' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: REPORT_TYPES })
  @IsOptional()
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType?: ReportType;

  @ApiPropertyOptional({ type: ReportFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportFiltersDto)
  filters?: ReportFiltersDto;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  columns?: string[];
}
