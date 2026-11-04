import {
  IsDefined,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Department Hierarchy module: the department tree, the reporting tree,
 * reporting assignments and their history.
 *
 * Department create / update / delete stay on the Setup Wizard endpoints
 * (CreateDepartmentDto / UpdateDepartmentDto); the department head stays on
 * AssignDepartmentManagerDto. These DTOs only add what the hierarchy screens
 * need on top.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Move an employee in the structure: a new reporting manager, department
 * and/or designation. Fields left out are not touched; `null` clears one.
 * Recorded in the reporting history with the date and note.
 */
export class UpdateEmployeeReportingDto {
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Employee id of the new primary reporting manager, or null for none.',
  })
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Department to transfer the employee to, or null.',
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  designationId?: string | null;

  @ApiProperty({
    required: false,
    example: '2026-11-01',
    description: 'The day the change applies from. Defaults to today.',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom?: string;

  @ApiProperty({
    required: false,
    example: 'Moved to the platform team after the reorg.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * When a manager leaves or changes role: hand everyone who reports to them
 * to someone else in one step. One history row is written per employee.
 */
export class ReassignReportsDto {
  @ApiProperty({
    description: 'The manager whose direct reports are being moved.',
  })
  @IsUUID()
  fromManagerId: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Their new reporting manager, or null to leave them without one.',
  })
  @IsOptional()
  @IsUUID()
  toManagerId?: string | null;

  @ApiProperty({ required: false, example: '2026-11-01' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class GetReportingTreeQueryDto {
  @ApiProperty({
    required: false,
    description:
      'Start the tree at this employee instead of the top of the organization.',
  })
  @IsOptional()
  @IsUUID()
  rootEmployeeId?: string;
}

// ==========================================
// Internal message-pattern payload DTOs (gateway -> tenant-service).
// ==========================================

export class GetReportingTreeMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetReportingTreeQueryDto })
  @ValidateNested()
  @Type(() => GetReportingTreeQueryDto)
  @IsDefined()
  query: GetReportingTreeQueryDto;
}

export class UpdateEmployeeReportingMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ type: UpdateEmployeeReportingDto })
  @ValidateNested()
  @Type(() => UpdateEmployeeReportingDto)
  @IsDefined()
  dto: UpdateEmployeeReportingDto;
}

export class ReassignReportsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ReassignReportsDto })
  @ValidateNested()
  @Type(() => ReassignReportsDto)
  @IsDefined()
  dto: ReassignReportsDto;
}
