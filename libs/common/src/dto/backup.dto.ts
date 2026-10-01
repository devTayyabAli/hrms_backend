import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum BackupFrequency {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

export enum BackupLocation {
  CLOUD = 'CLOUD',
  LOCAL = 'LOCAL',
}

export enum BackupStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export class UpdateBackupSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  automaticBackupEnabled?: boolean;

  @ApiPropertyOptional({ enum: BackupFrequency })
  @IsOptional()
  @IsEnum(BackupFrequency)
  frequency?: BackupFrequency;

  @ApiPropertyOptional({ example: '03:00', description: 'HH:MM, 24-hour clock' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'time must be in HH:MM 24-hour format' })
  time?: string;

  @ApiPropertyOptional({ example: 30, minimum: 1, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  retentionDays?: number;

  @ApiPropertyOptional({
    enum: BackupLocation,
    description: 'Preference only — actual storage backend always follows the app-wide STORAGE_PROVIDER config.',
  })
  @IsOptional()
  @IsEnum(BackupLocation)
  location?: BackupLocation;
}

export class GetBackupsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}
