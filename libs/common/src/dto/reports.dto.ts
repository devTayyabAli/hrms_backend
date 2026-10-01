import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsArray,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateReportDto {
  @ApiProperty({
    example: 'organization-summary',
    description:
      'Report template ID: organization-summary, user-activity, subscription-reports, employee-growth, system-usage, security-audit, or custom report ID',
  })
  @IsString()
  @IsNotEmpty()
  reportType: string;

  @ApiPropertyOptional({ example: 'json', enum: ['json', 'csv'] })
  @IsOptional()
  @IsEnum(['json', 'csv'])
  format?: 'json' | 'csv' = 'json';

  @ApiPropertyOptional({ example: 'last-6-months', description: 'last-30-days, last-3-months, last-6-months, last-year, custom' })
  @IsOptional()
  @IsString()
  period?: string;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.999Z' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ description: 'Filter report by specific organization/tenant ID' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}

export class PlatformGrowthQueryDto {
  @ApiPropertyOptional({ example: '6months', enum: ['6months', '12months'] })
  @IsOptional()
  @IsString()
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
  @ApiPropertyOptional({ example: 'Security', description: 'Filter by category: Security, Organizations, Reports, Subscription' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: 'Employee', description: 'Search report name or description' })
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
  @ApiProperty({ example: 'Employee Activity Report' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Security', description: 'Security, Organizations, Reports, Subscription' })
  @IsString()
  @IsNotEmpty()
  category: string;

  @ApiPropertyOptional({ example: 'User logins and engagement metrics across all tenants' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: ['logins', 'failed_attempts', 'active_sessions'], type: [String] })
  @IsOptional()
  @IsArray()
  metrics?: string[];

  @ApiPropertyOptional({ example: { dateRange: 'last-30-days' } })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;
}

export class UpdateCustomReportDto {
  @ApiPropertyOptional({ example: 'Employee Activity Report (Updated)' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Security' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: 'Updated description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: ['logins', 'active_sessions'], type: [String] })
  @IsOptional()
  @IsArray()
  metrics?: string[];

  @ApiPropertyOptional({ example: { dateRange: 'last-6-months' } })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;

  @ApiPropertyOptional({ example: 'Active', enum: ['Active', 'Archived'] })
  @IsOptional()
  @IsString()
  status?: string;
}
