import { ArrayMaxSize, ArrayMinSize, IsArray, IsDefined, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * How a kind of request is approved: an ordered list of stages, each naming
 * who decides. An organization that never saves one keeps the built-in route.
 */

export const MAX_APPROVAL_STAGES = 3;
export const MAX_MANAGER_LEVEL = 3;

export enum ApprovalStageKind {
  REPORTING_MANAGER = 'REPORTING_MANAGER',
  DEPARTMENT_HEAD = 'DEPARTMENT_HEAD',
  /** The requester's additional (dotted-line) manager, when they have one. Skipped when they do not. */
  ADDITIONAL_MANAGER = 'ADDITIONAL_MANAGER',
  EMPLOYEE = 'EMPLOYEE',
  PERMISSION = 'PERMISSION',
  HR = 'HR',
}

/**
 * What can be given a route. Employee requests keep their own two-step
 * setting for now. Leave always has a route (built in until one is saved);
 * reimbursements and salary changes have none until the organization saves one.
 */
export enum ApprovalRequestType {
  LEAVE = 'LEAVE',
  REIMBURSEMENT = 'REIMBURSEMENT',
  SALARY_REVISION = 'SALARY_REVISION',
  FINAL_SETTLEMENT = 'FINAL_SETTLEMENT',
  EMPLOYEE_REQUEST = 'EMPLOYEE_REQUEST',
}

export class ApprovalPolicyStageDto {
  @ApiProperty({ enum: ApprovalStageKind })
  @IsEnum(ApprovalStageKind)
  kind: ApprovalStageKind;

  @ApiProperty({ required: false, minimum: 1, maximum: MAX_MANAGER_LEVEL, description: 'REPORTING_MANAGER only: 1 is the direct manager, 2 their manager' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MANAGER_LEVEL)
  level?: number;

  @ApiProperty({ required: false, description: 'EMPLOYEE only: the named approver' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ required: false, example: 'payroll.approve', description: 'PERMISSION only: anyone holding it decides' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$/, { message: 'Use a permission such as payroll.approve.' })
  permission?: string;
}

export class UpdateApprovalPolicyDto {
  @ApiProperty({ type: [ApprovalPolicyStageDto], description: `1 to ${MAX_APPROVAL_STAGES} stages, in the order they decide` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_APPROVAL_STAGES)
  @ValidateNested({ each: true })
  @Type(() => ApprovalPolicyStageDto)
  stages: ApprovalPolicyStageDto[];
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class ApprovalPolicyTenantMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;
}

export class ApprovalPolicyTypeMessageDto extends ApprovalPolicyTenantMessageDto {
  @ApiProperty({ enum: ApprovalRequestType })
  @IsEnum(ApprovalRequestType)
  requestType: ApprovalRequestType;
}

export class UpdateApprovalPolicyMessageDto extends ApprovalPolicyTypeMessageDto {
  @ApiProperty({ type: UpdateApprovalPolicyDto })
  @ValidateNested()
  @Type(() => UpdateApprovalPolicyDto)
  @IsDefined()
  dto: UpdateApprovalPolicyDto;
}
