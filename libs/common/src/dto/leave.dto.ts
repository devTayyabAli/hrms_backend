import {
  IsDateString,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Lifecycle of a leave request.
 *
 * CANCELLED is deliberately distinct from REJECTED: rejected is a decision
 * the approver made, cancelled is the request being withdrawn. Collapsing
 * the two would make the Rejected KPI card overstate how often the
 * organization actually turns leave down.
 */
export enum LeaveRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

/** Adds ALL so the table tab row can express "no status filter". */
export enum LeaveRequestStatusFilter {
  ALL = 'ALL',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export const LEAVE_REQUEST_SORTABLE_FIELDS = [
  'fromDate',
  'toDate',
  'totalDays',
  'status',
  'employeeName',
  'leaveType',
  'createdAt',
] as const;
export type LeaveRequestSortableField =
  (typeof LEAVE_REQUEST_SORTABLE_FIELDS)[number];

// ==========================================
// Leave Requests table / KPI queries
// ==========================================

export class GetLeaveRequestsQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiProperty({
    required: false,
    description: 'Search by employee name, employee ID or leave reason',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: LeaveRequestStatusFilter,
    required: false,
    default: LeaveRequestStatusFilter.ALL,
    description:
      'Backs the All Requests / Pending / Approved / Rejected tab row.',
  })
  @IsOptional()
  @IsEnum(LeaveRequestStatusFilter)
  status?: LeaveRequestStatusFilter = LeaveRequestStatusFilter.ALL;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({
    required: false,
    description: 'Filter by leave type (a configured leave policy).',
  })
  @IsOptional()
  @IsUUID()
  leavePolicyId?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Only requests whose leave period ends on or after this date',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description:
      'Only requests whose leave period starts on or before this date',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({
    required: false,
    enum: LEAVE_REQUEST_SORTABLE_FIELDS,
    default: 'fromDate',
  })
  @IsOptional()
  @IsIn(LEAVE_REQUEST_SORTABLE_FIELDS)
  sortBy?: LeaveRequestSortableField = 'fromDate';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class ExportLeaveRequestsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: LeaveRequestStatusFilter,
    required: false,
    default: LeaveRequestStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(LeaveRequestStatusFilter)
  status?: LeaveRequestStatusFilter = LeaveRequestStatusFilter.ALL;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  leavePolicyId?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({
    required: false,
    enum: LEAVE_REQUEST_SORTABLE_FIELDS,
    default: 'fromDate',
  })
  @IsOptional()
  @IsIn(LEAVE_REQUEST_SORTABLE_FIELDS)
  sortBy?: LeaveRequestSortableField = 'fromDate';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

// ==========================================
// Leave request writes
// ==========================================

export class CreateLeaveRequestDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    description: 'Leave type — one of the tenant configured leave policies',
  })
  @IsUUID()
  leavePolicyId: string;

  @ApiProperty({ example: '2026-09-18', format: 'date' })
  @IsDateString()
  fromDate: string;

  @ApiProperty({ example: '2026-09-21', format: 'date' })
  @IsDateString()
  toDate: string;

  @ApiProperty({
    required: false,
    example: 0.5,
    description:
      'Days to deduct. Defaults to the inclusive calendar span; send it only for a partial day, or to exclude non-working days.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.5)
  totalDays?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiProperty({
    enum: LeaveRequestStatus,
    required: false,
    description:
      'Defaults to PENDING. An admin filing leave that was already agreed to can send APPROVED.',
  })
  @IsOptional()
  @IsEnum(LeaveRequestStatus)
  status?: LeaveRequestStatus;
}

export class UpdateLeaveRequestDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  leavePolicyId?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.5)
  totalDays?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/**
 * Approve or reject — the row Approve / Reject actions. One endpoint taking
 * the target status, so both decisions share the same already-decided and
 * overlap checks rather than drifting apart across two handlers.
 */
export class DecideLeaveRequestDto {
  @ApiProperty({
    enum: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.REJECTED],
  })
  @IsIn([LeaveRequestStatus.APPROVED, LeaveRequestStatus.REJECTED])
  status: LeaveRequestStatus.APPROVED | LeaveRequestStatus.REJECTED;

  @ApiProperty({
    required: false,
    description: 'Shown against the request — the reason for a rejection.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  decisionNote?: string;
}

// ==========================================
// Internal message-pattern payload DTOs (gateway -> tenant-service).
// Real classes so the microservice ValidationPipe re-validates them; a plain
// type literal carries no runtime metadata and is silently skipped.
// ==========================================

export class TenantLeaveRequestIdDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  leaveRequestId: string;
}

export class GetLeaveRequestsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetLeaveRequestsQueryDto })
  @ValidateNested()
  @Type(() => GetLeaveRequestsQueryDto)
  @IsDefined()
  query: GetLeaveRequestsQueryDto;
}

export class ExportLeaveRequestsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportLeaveRequestsQueryDto })
  @ValidateNested()
  @Type(() => ExportLeaveRequestsQueryDto)
  @IsDefined()
  query: ExportLeaveRequestsQueryDto;
}

export class CreateLeaveRequestMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: CreateLeaveRequestDto })
  @ValidateNested()
  @Type(() => CreateLeaveRequestDto)
  @IsDefined()
  dto: CreateLeaveRequestDto;

  @ApiProperty({ required: false, description: 'Admin filing the request' })
  @IsOptional()
  @IsUUID()
  appliedByUserId?: string;
}

export class UpdateLeaveRequestMessageDto extends TenantLeaveRequestIdDto {
  @ApiProperty({ type: UpdateLeaveRequestDto })
  @ValidateNested()
  @Type(() => UpdateLeaveRequestDto)
  @IsDefined()
  dto: UpdateLeaveRequestDto;
}

export class DecideLeaveRequestMessageDto extends TenantLeaveRequestIdDto {
  @ApiProperty({ type: DecideLeaveRequestDto })
  @ValidateNested()
  @Type(() => DecideLeaveRequestDto)
  @IsDefined()
  dto: DecideLeaveRequestDto;

  @ApiProperty({ required: false, description: 'Admin making the decision' })
  @IsOptional()
  @IsUUID()
  decidedByUserId?: string;
}
