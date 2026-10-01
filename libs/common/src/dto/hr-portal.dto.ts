import {
  IsDateString,
  IsDefined,
  IsEmail,
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
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

// ==========================================
// HR Dashboard
// ==========================================

/**
 * Why a pending leave request is flagged on the HR Dashboard. Derived at read
 * time from the dates already on the request — nothing is stored, so the badge
 * cannot go stale while a request sits in the queue.
 */
export enum LeaveApprovalUrgency {
  /** Starts within URGENT_WITHIN_DAYS — staffing is about to be affected. */
  URGENT = 'URGENT',
  /** Already started or finished while still pending. */
  OVERDUE = 'OVERDUE',
  NORMAL = 'NORMAL',
}

/** A leave starting this many days out or sooner is Urgent. */
export const LEAVE_URGENT_WITHIN_DAYS = 3;

export class HrDashboardQueryDto {
  @ApiProperty({
    required: false,
    default: 5,
    minimum: 1,
    maximum: 50,
    description: 'How many pending leave approvals to return with the dashboard.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  approvalsLimit?: number = 5;
}

/** The range pickers on the organization admin dashboard's cards. */
export enum AdminDashboardRange {
  TODAY = 'TODAY',
  THIS_WEEK = 'THIS_WEEK',
  THIS_MONTH = 'THIS_MONTH',
  LAST_MONTH = 'LAST_MONTH',
  THIS_QUARTER = 'THIS_QUARTER',
  THIS_YEAR = 'THIS_YEAR',
  ALL_TIME = 'ALL_TIME',
}

/** One range per card, so changing one card's filter leaves the others alone. */
export class AdminDashboardQueryDto {
  @ApiProperty({ required: false, enum: AdminDashboardRange, description: 'Employee Statistics chart' })
  @IsOptional()
  @IsEnum(AdminDashboardRange)
  statsRange?: AdminDashboardRange;

  @ApiProperty({ required: false, enum: AdminDashboardRange, description: 'Performance Overview' })
  @IsOptional()
  @IsEnum(AdminDashboardRange)
  performanceRange?: AdminDashboardRange;

  @ApiProperty({ required: false, enum: AdminDashboardRange, description: 'Attendance Overview' })
  @IsOptional()
  @IsEnum(AdminDashboardRange)
  attendanceRange?: AdminDashboardRange;

  @ApiProperty({ required: false, enum: AdminDashboardRange, description: 'Task Overview' })
  @IsOptional()
  @IsEnum(AdminDashboardRange)
  taskRange?: AdminDashboardRange;

  @ApiProperty({ required: false, enum: AdminDashboardRange, description: 'Payroll Summary' })
  @IsOptional()
  @IsEnum(AdminDashboardRange)
  payrollRange?: AdminDashboardRange;
}

export class AdminDashboardMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AdminDashboardQueryDto)
  query?: AdminDashboardQueryDto;
}

export class LeaveApprovalsQueryDto {
  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiProperty({ required: false, description: 'Restrict to one department' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({
    required: false,
    enum: LeaveApprovalUrgency,
    description: 'Show only the requests at this urgency.',
  })
  @IsOptional()
  @IsEnum(LeaveApprovalUrgency)
  urgency?: LeaveApprovalUrgency;
}

// ==========================================
// Onboarding checklist matrix
// ==========================================

export class OnboardingMatrixQueryDto {
  @ApiProperty({ required: false, description: 'Restrict to one department' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({
    required: false,
    default: 10,
    minimum: 1,
    maximum: 25,
    description: 'How many new hires become columns in the matrix.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number = 10;
}

// ==========================================
// HR Reports
// ==========================================

/** The report cards on the Reports screen. */
export enum HrReportType {
  EMPLOYEE = 'EMPLOYEE',
  ATTENDANCE = 'ATTENDANCE',
  LEAVE = 'LEAVE',
  ONBOARDING = 'ONBOARDING',
  DEPARTMENT_SUMMARY = 'DEPARTMENT_SUMMARY',
  CUSTOM = 'CUSTOM',
}

/** The Date Range select in the Generate dialog. */
export enum HrReportRange {
  THIS_MONTH = 'THIS_MONTH',
  LAST_MONTH = 'LAST_MONTH',
  LAST_7_DAYS = 'LAST_7_DAYS',
  LAST_30_DAYS = 'LAST_30_DAYS',
  THIS_QUARTER = 'THIS_QUARTER',
  THIS_YEAR = 'THIS_YEAR',
  /** Uses `from` and `to`, which become required. */
  CUSTOM = 'CUSTOM',
}

/**
 * The Format select. CSV downloads as a file; JSON returns the same rows as
 * the response body for a client that renders the report itself.
 */
export enum HrReportFormat {
  CSV = 'CSV',
  JSON = 'JSON',
}

export class GenerateHrReportDto {
  @ApiProperty({ enum: HrReportType })
  @IsEnum(HrReportType)
  type: HrReportType;

  @ApiProperty({ enum: HrReportRange, default: HrReportRange.THIS_MONTH })
  @IsOptional()
  @IsEnum(HrReportRange)
  range?: HrReportRange = HrReportRange.THIS_MONTH;

  @ApiProperty({ required: false, format: 'date', description: 'Required when range is CUSTOM' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, format: 'date', description: 'Required when range is CUSTOM' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false, description: 'Restrict to one department' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ enum: HrReportFormat, default: HrReportFormat.JSON })
  @IsOptional()
  @IsEnum(HrReportFormat)
  format?: HrReportFormat = HrReportFormat.JSON;
}

export class HrReportQueryDto extends GenerateHrReportDto {}

// ==========================================
// Employee invitations — portal access for an employee
// ==========================================

export enum EmployeeInvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

export class InviteEmployeeDto {
  @ApiProperty({ description: 'The employee who should get portal access' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    required: false,
    description: 'Where to send the invitation. Defaults to the address on the employee record.',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, description: 'Added to the invitation email' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  @ApiProperty({ required: false, description: 'Role ID to assign to the invited user' })
  @IsOptional()
  @IsUUID()
  roleId?: string;
}

export class GetEmployeeInvitationsQueryDto {
  @ApiProperty({ required: false, enum: EmployeeInvitationStatus })
  @IsOptional()
  @IsEnum(EmployeeInvitationStatus)
  status?: EmployeeInvitationStatus;

  @ApiProperty({ required: false, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;
}

export class ValidateEmployeeInvitationDto {
  @ApiProperty({ description: 'The raw token from the invitation link' })
  @IsString()
  @MinLength(16)
  token: string;
}

export class AcceptEmployeeInvitationDto {
  @ApiProperty({ description: 'The raw token from the invitation link' })
  @IsString()
  @MinLength(16)
  token: string;

  @ApiProperty({ example: 'S0me-Strong-Pass' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  confirmPassword?: string;
}

// ==========================================
// RPC payloads
// ==========================================

export class HrDashboardMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HrDashboardQueryDto)
  query?: HrDashboardQueryDto;
}

export class LeaveApprovalsMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveApprovalsQueryDto)
  query?: LeaveApprovalsQueryDto;
}

export class OnboardingMatrixMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardingMatrixQueryDto)
  query?: OnboardingMatrixQueryDto;
}

export class GenerateHrReportMessageDto {
  @IsUUID()
  tenantId: string;

  @ValidateNested()
  @Type(() => GenerateHrReportDto)
  @IsDefined()
  dto: GenerateHrReportDto;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class InviteEmployeeMessageDto {
  @IsUUID()
  tenantId: string;

  @ValidateNested()
  @Type(() => InviteEmployeeDto)
  @IsDefined()
  dto: InviteEmployeeDto;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class EmployeeInvitationIdMessageDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  invitationId: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class GetEmployeeInvitationsMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GetEmployeeInvitationsQueryDto)
  query?: GetEmployeeInvitationsQueryDto;
}
