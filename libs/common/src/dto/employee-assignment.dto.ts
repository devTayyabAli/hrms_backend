import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Most additional assignments one person can hold at a time. */
export const MAX_ACTIVE_ASSIGNMENTS = 5;

const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

/**
 * An additional role beside someone's primary position. Give at least a
 * department, a manager or a title. Approvals keep following the primary
 * reporting manager: this adds who else the person works for.
 */
export class CreateEmployeeAssignmentDto {
  @ApiProperty({ required: false, description: 'The other department they work for' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({ required: false, maxLength: 120, example: 'Payroll liaison' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiProperty({ required: false, description: 'The additional (dotted-line) manager' })
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string;

  @ApiProperty({ required: false, maxLength: 2000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  responsibilities?: string;

  @ApiProperty({ required: false, example: '2026-11-01', description: 'Defaults to today' })
  @IsOptional()
  @IsDateString()
  startDate?: string;
}

export class UpdateEmployeeAssignmentDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  designationId?: string | null;

  @ApiProperty({ required: false, nullable: true, maxLength: 120 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string | null;

  @ApiProperty({ required: false, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  responsibilities?: string | null;
}

export class EndEmployeeAssignmentDto {
  @ApiProperty({ required: false, example: '2026-12-31', description: 'Defaults to today' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
