import {
  IsArray,
  IsDateString,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Daily attendance outcome for one employee.
 *
 * PRESENT / LATE are derived from the tenant's own AttendancePolicy
 * (gracePeriodMinutes, lateThresholdMinutes) measured against the configured
 * WorkingHours start time — see AttendanceService.deriveStatus. An admin can
 * always override the derived value when correcting a record.
 */
export enum AttendanceStatus {
  PRESENT = 'PRESENT',
  LATE = 'LATE',
  ABSENT = 'ABSENT',
  ON_LEAVE = 'ON_LEAVE',
  HALF_DAY = 'HALF_DAY',
  HOLIDAY = 'HOLIDAY',
}

/** Adds ALL so the table filter can express "no status filter". */
export enum AttendanceStatusFilter {
  ALL = 'ALL',
  PRESENT = 'PRESENT',
  LATE = 'LATE',
  ABSENT = 'ABSENT',
  ON_LEAVE = 'ON_LEAVE',
  HALF_DAY = 'HALF_DAY',
  HOLIDAY = 'HOLIDAY',
}

/** How a record got into the table — manual admin entry today. */
export enum AttendanceSource {
  MANUAL = 'MANUAL',
  IMPORT = 'IMPORT',
  DEVICE = 'DEVICE',
  /** The employee punched in from their own portal, not HR on their behalf. */
  SELF_SERVICE = 'SELF_SERVICE',
}

export const ATTENDANCE_SORTABLE_FIELDS = [
  'date',
  'employeeName',
  'department',
  'checkInAt',
  'checkOutAt',
  'workedMinutes',
  'status',
] as const;
export type AttendanceSortableField =
  (typeof ATTENDANCE_SORTABLE_FIELDS)[number];

/** Granularity of the Attendance Overview chart. */
export enum AttendanceTrendInterval {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

// ==========================================
// Attendance table / KPI / chart queries
// ==========================================

export class GetAttendanceQueryDto {
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
    description: 'Search by employee name or employee ID',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description:
      'Single day to show. Defaults to today when no range is given.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({ required: false, format: 'date', description: 'Range start' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, format: 'date', description: 'Range end' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({
    enum: AttendanceStatusFilter,
    required: false,
    default: AttendanceStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(AttendanceStatusFilter)
  status?: AttendanceStatusFilter = AttendanceStatusFilter.ALL;

  @ApiProperty({
    required: false,
    enum: ATTENDANCE_SORTABLE_FIELDS,
    default: 'date',
  })
  @IsOptional()
  @IsIn(ATTENDANCE_SORTABLE_FIELDS)
  sortBy?: AttendanceSortableField = 'date';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class ExportAttendanceQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({
    enum: AttendanceStatusFilter,
    required: false,
    default: AttendanceStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(AttendanceStatusFilter)
  status?: AttendanceStatusFilter = AttendanceStatusFilter.ALL;

  @ApiProperty({
    required: false,
    enum: ATTENDANCE_SORTABLE_FIELDS,
    default: 'date',
  })
  @IsOptional()
  @IsIn(ATTENDANCE_SORTABLE_FIELDS)
  sortBy?: AttendanceSortableField = 'date';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

/** KPI cards are always "as of" one day — today unless asked otherwise. */
export class AttendanceStatsQueryDto {
  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Day to report on. Defaults to today.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class AttendanceOverviewQueryDto {
  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({
    enum: AttendanceTrendInterval,
    required: false,
    default: AttendanceTrendInterval.DAY,
  })
  @IsOptional()
  @IsEnum(AttendanceTrendInterval)
  interval?: AttendanceTrendInterval = AttendanceTrendInterval.DAY;

  @ApiProperty({
    required: false,
    default: 30,
    description: 'Number of intervals back from `to` when `from` is omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(365)
  points?: number = 30;
}

export class AttendanceByDepartmentQueryDto {
  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Single day to break down. Defaults to today.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

// ==========================================
// Attendance writes (admin manual entry / correction)
// ==========================================

export class CreateAttendanceRecordDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: '2026-09-11', format: 'date' })
  @IsDateString()
  date: string;

  @ApiProperty({
    required: false,
    example: '2026-09-11T09:10:00.000Z',
    description: 'Full timestamp. Status is derived from this when omitted.',
  })
  @IsOptional()
  @IsISO8601()
  checkInAt?: string;

  @ApiProperty({ required: false, example: '2026-09-11T18:05:00.000Z' })
  @IsOptional()
  @IsISO8601()
  checkOutAt?: string;

  @ApiProperty({
    enum: AttendanceStatus,
    required: false,
    description:
      'Overrides the status derived from check-in against the attendance policy.',
  })
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateAttendanceRecordDto {
  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  checkInAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  checkOutAt?: string;

  @ApiProperty({ enum: AttendanceStatus, required: false })
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class BulkAttendanceEntryDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ enum: AttendanceStatus })
  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  checkInAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  checkOutAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Mark a whole day in one request — the "mark attendance" action on the
 * Attendance screen. Existing records for that employee/date are updated
 * rather than duplicated, so re-marking a day is safe.
 */
export class BulkMarkAttendanceDto {
  @ApiProperty({ example: '2026-09-11', format: 'date' })
  @IsDateString()
  date: string;

  @ApiProperty({ type: [BulkAttendanceEntryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkAttendanceEntryDto)
  entries: BulkAttendanceEntryDto[];

  @ApiProperty({
    required: false,
    description:
      'Also record every ACTIVE employee missing from `entries` with this status.',
    enum: AttendanceStatus,
  })
  @IsOptional()
  @IsEnum(AttendanceStatus)
  fillRemainingWith?: AttendanceStatus;
}

// ==========================================
// Internal message-pattern payload DTOs (gateway -> tenant-service).
// Real classes so the microservice's own ValidationPipe re-validates them;
// a plain type literal carries no runtime metadata and is silently skipped.
// ==========================================

export class TenantAttendanceIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  recordId: string;
}

export class GetAttendanceMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetAttendanceQueryDto })
  @ValidateNested()
  @Type(() => GetAttendanceQueryDto)
  @IsDefined()
  query: GetAttendanceQueryDto;
}

export class ExportAttendanceMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportAttendanceQueryDto })
  @ValidateNested()
  @Type(() => ExportAttendanceQueryDto)
  @IsDefined()
  query: ExportAttendanceQueryDto;
}

export class AttendanceStatsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: AttendanceStatsQueryDto })
  @ValidateNested()
  @Type(() => AttendanceStatsQueryDto)
  @IsDefined()
  query: AttendanceStatsQueryDto;
}

export class AttendanceOverviewMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: AttendanceOverviewQueryDto })
  @ValidateNested()
  @Type(() => AttendanceOverviewQueryDto)
  @IsDefined()
  query: AttendanceOverviewQueryDto;
}

export class AttendanceByDepartmentMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: AttendanceByDepartmentQueryDto })
  @ValidateNested()
  @Type(() => AttendanceByDepartmentQueryDto)
  @IsDefined()
  query: AttendanceByDepartmentQueryDto;
}

export class CreateAttendanceMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: CreateAttendanceRecordDto })
  @ValidateNested()
  @Type(() => CreateAttendanceRecordDto)
  @IsDefined()
  dto: CreateAttendanceRecordDto;

  @ApiProperty({ required: false, description: 'Admin performing the entry' })
  @IsOptional()
  @IsUUID()
  markedByUserId?: string;
}

export class UpdateAttendanceMessageDto extends TenantAttendanceIdDto {
  @ApiProperty({ type: UpdateAttendanceRecordDto })
  @ValidateNested()
  @Type(() => UpdateAttendanceRecordDto)
  @IsDefined()
  dto: UpdateAttendanceRecordDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  markedByUserId?: string;
}

export class BulkMarkAttendanceMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: BulkMarkAttendanceDto })
  @ValidateNested()
  @Type(() => BulkMarkAttendanceDto)
  @IsDefined()
  dto: BulkMarkAttendanceDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  markedByUserId?: string;
}

// ==========================================
// HR: all-employee attendance register, per-employee detail, unmarked list
// and the one-call screen aggregate.
// ==========================================

/**
 * Register columns that sort in SQL. Aggregate columns (present, late,
 * attendance rate) are deliberately absent: the register paginates
 * employees first and aggregates the page, so sorting by an aggregate would
 * only order the current page and read as a global ranking it isn't.
 */
export const ATTENDANCE_REGISTER_SORTABLE_FIELDS = [
  'employeeName',
  'employeeCode',
  'department',
  'joiningDate',
] as const;
export type AttendanceRegisterSortableField =
  (typeof ATTENDANCE_REGISTER_SORTABLE_FIELDS)[number];

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The period every HR attendance view reports on: a calendar `month`, or an
 * explicit `from`/`to` range (which wins). Defaults to the current month.
 */
export class AttendancePeriodQueryDto {
  @ApiProperty({
    required: false,
    example: '2026-09',
    description: 'Calendar month. Defaults to the current month.',
  })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'month must be in YYYY-MM format' })
  month?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Range start. Overrides `month` when given.',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Range end. Overrides `month` when given.',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ExportAttendanceRegisterQueryDto extends AttendancePeriodQueryDto {
  @ApiProperty({
    required: false,
    description: 'Search by employee name or employee ID',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({
    required: false,
    enum: ATTENDANCE_REGISTER_SORTABLE_FIELDS,
    default: 'employeeName',
  })
  @IsOptional()
  @IsIn(ATTENDANCE_REGISTER_SORTABLE_FIELDS)
  sortBy?: AttendanceRegisterSortableField = 'employeeName';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'ASC';
}

export class AttendanceRegisterQueryDto extends ExportAttendanceRegisterQueryDto {
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
}

/** Who has no attendance record yet on one day — the follow-up list. */
export class UnmarkedAttendanceQueryDto {
  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Day to check. Defaults to today.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({
    required: false,
    description: 'Search by employee name or employee ID',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/** The whole Attendance screen in one call, "as of" one day. */
export class AttendanceDashboardQueryDto {
  @ApiProperty({
    required: false,
    format: 'date',
    description:
      'Day the KPI cards, breakdown and table report on. Defaults to today.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({
    enum: AttendanceTrendInterval,
    required: false,
    default: AttendanceTrendInterval.DAY,
  })
  @IsOptional()
  @IsEnum(AttendanceTrendInterval)
  interval?: AttendanceTrendInterval = AttendanceTrendInterval.DAY;

  @ApiProperty({
    required: false,
    default: 30,
    description: 'Number of chart intervals ending at `date`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(365)
  points?: number = 30;
}

export class AttendanceRegisterMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: AttendanceRegisterQueryDto })
  @ValidateNested()
  @Type(() => AttendanceRegisterQueryDto)
  @IsDefined()
  query: AttendanceRegisterQueryDto;
}

export class ExportAttendanceRegisterMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportAttendanceRegisterQueryDto })
  @ValidateNested()
  @Type(() => ExportAttendanceRegisterQueryDto)
  @IsDefined()
  query: ExportAttendanceRegisterQueryDto;
}

export class EmployeeAttendanceMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ type: AttendancePeriodQueryDto })
  @ValidateNested()
  @Type(() => AttendancePeriodQueryDto)
  @IsDefined()
  query: AttendancePeriodQueryDto;
}

export class UnmarkedAttendanceMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: UnmarkedAttendanceQueryDto })
  @ValidateNested()
  @Type(() => UnmarkedAttendanceQueryDto)
  @IsDefined()
  query: UnmarkedAttendanceQueryDto;
}

export class AttendanceDashboardMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: AttendanceDashboardQueryDto })
  @ValidateNested()
  @Type(() => AttendanceDashboardQueryDto)
  @IsDefined()
  query: AttendanceDashboardQueryDto;
}
