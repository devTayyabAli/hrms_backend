import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, PickType } from '@nestjs/swagger';
import { EmployeeProfileFieldsDto } from './employee.dto';
import { LeaveRequestStatusFilter } from './leave.dto';

/** Tabs on My Documents. */
/** Longest day-end status accepted at check-out (a pasted daily report fits easily). */
export const DAY_END_STATUS_MAX = 5000;

export enum EmployeeDocumentCategory {
  EMPLOYMENT = 'EMPLOYMENT',
  IDENTITY = 'IDENTITY',
  PAYROLL = 'PAYROLL',
  QUALIFICATION = 'QUALIFICATION',
}

export enum EmployeeDocumentCategoryFilter {
  ALL = 'ALL',
  EMPLOYMENT = 'EMPLOYMENT',
  IDENTITY = 'IDENTITY',
  PAYROLL = 'PAYROLL',
  QUALIFICATION = 'QUALIFICATION',
}

/** Verification badge on the documents table. Employees cannot set this themselves. */
export enum EmployeeDocumentStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

/** The four cards on My Requests. */
export enum EmployeeRequestType {
  ATTENDANCE_CORRECTION = 'ATTENDANCE_CORRECTION',
  WORK_FROM_HOME = 'WORK_FROM_HOME',
  OVERTIME = 'OVERTIME',
  GENERAL = 'GENERAL',
}

export enum EmployeeRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

/** Drives the icon on a Notifications row. */
export enum EmployeeNotificationKind {
  LEAVE = 'LEAVE',
  ATTENDANCE = 'ATTENDANCE',
  POLICY = 'POLICY',
  HOLIDAY = 'HOLIDAY',
  LEAVE_BALANCE = 'LEAVE_BALANCE',
  REQUEST = 'REQUEST',
  DOCUMENT = 'DOCUMENT',
  GENERAL = 'GENERAL',
}

/**
 * What an employee may change on their own record: personal and contact
 * details. Employment (department, type, dates) and the national ID stay with
 * HR — they are verified facts, not self-declared ones.
 */
export const SELF_EDITABLE_PROFILE_FIELDS = [
  'fatherName',
  'gender',
  'dateOfBirth',
  'maritalStatus',
  'nationality',
  'religion',
  'bloodGroup',
  'currentAddress',
  'permanentAddress',
  'city',
  'emergencyContactName',
  'emergencyContactRelation',
  'emergencyContactPhone',
] as const;

export class UpdateMyProfileDto extends PickType(EmployeeProfileFieldsDto, SELF_EDITABLE_PROFILE_FIELDS) {
  @ApiProperty({ required: false, example: 'Ayesha' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiProperty({ required: false, example: 'Khan' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiProperty({ required: false, example: '+92 300 1234567' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiProperty({ required: false, description: 'Profile photo URL or file id' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string;
}

export class GetMyAttendanceQueryDto {
  @ApiProperty({
    required: false,
    example: '2026-09',
    description: 'Calendar month. Defaults to the current month.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

export class ApplyMyLeaveDto {
  @ApiProperty({ description: 'Leave type — one of the organization leave policies' })
  @IsUUID()
  leavePolicyId: string;

  @ApiProperty({ example: '2026-08-21', format: 'date' })
  @IsDateString()
  fromDate: string;

  @ApiProperty({ example: '2026-08-22', format: 'date' })
  @IsDateString()
  toDate: string;

  @ApiProperty({
    required: false,
    default: false,
    description: 'Half a day off. Only valid when fromDate equals toDate.',
  })
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** Edit a leave request that is still pending. Omitted fields keep their value. */
export class UpdateMyLeaveDto {
  @ApiProperty({ required: false, description: 'Leave type — one of the organization leave policies' })
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

  @ApiProperty({ required: false, description: 'Only valid for a single-day request.' })
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class GetMyLeaveSummaryQueryDto {
  @ApiProperty({
    required: false,
    example: 2026,
    description: 'Fiscal year by its starting year (FY 2026-27 is 2026). Defaults to the current one.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  fiscalYear?: number;
}

export class GetMyLeaveHistoryQueryDto extends GetMyLeaveSummaryQueryDto {
  @ApiProperty({
    enum: LeaveRequestStatusFilter,
    required: false,
    default: LeaveRequestStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(LeaveRequestStatusFilter)
  status?: LeaveRequestStatusFilter = LeaveRequestStatusFilter.ALL;

  @ApiProperty({ required: false, description: 'Only this leave type' })
  @IsOptional()
  @IsUUID()
  leavePolicyId?: string;

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

export class GetMyDocumentsQueryDto {
  @ApiProperty({ enum: EmployeeDocumentCategoryFilter, required: false, default: 'ALL' })
  @IsOptional()
  @IsEnum(EmployeeDocumentCategoryFilter)
  category?: EmployeeDocumentCategoryFilter = EmployeeDocumentCategoryFilter.ALL;

  @ApiProperty({ enum: EmployeeDocumentStatus, required: false, description: 'Only this verification status' })
  @IsOptional()
  @IsEnum(EmployeeDocumentStatus)
  status?: EmployeeDocumentStatus;

  @ApiProperty({ required: false, description: 'Search by title or file name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

/** The form fields of the one-step multipart upload; the file itself is the `file` part. */
export class UploadMyDocumentFormDto {
  @ApiProperty({ example: 'Offer Letter' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @ApiProperty({ enum: EmployeeDocumentCategory })
  @IsEnum(EmployeeDocumentCategory)
  category: EmployeeDocumentCategory;

  @ApiProperty({ required: false, format: 'date', description: 'When the document stops being valid' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}

export class UploadMyDocumentDto extends UploadMyDocumentFormDto {
  @ApiProperty({ description: 'File id returned by POST /files/upload. Must be a file you uploaded yourself' })
  @IsUUID()
  fileId: string;

  /**
   * File name, size and type are read from the file store by the gateway,
   * so these are optional and whatever the client sends is overwritten —
   * a document row cannot claim to be a different file than it points at.
   */
  @ApiProperty({ required: false, example: 'offer-letter.pdf', description: 'Ignored; taken from the file store' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName?: string;

  @ApiProperty({ required: false, example: 250880, description: 'Ignored; taken from the file store' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @ApiProperty({ required: false, example: 'application/pdf', description: 'Ignored; taken from the file store' })
  @IsOptional()
  @IsString()
  @MaxLength(127)
  mimeType?: string;
}

/**
 * Edit a document that HR has not verified. Any change sends it back to
 * Pending for another review. `fileId` replaces the file itself.
 */
export class UpdateMyDocumentDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;

  @ApiProperty({ enum: EmployeeDocumentCategory, required: false })
  @IsOptional()
  @IsEnum(EmployeeDocumentCategory)
  category?: EmployeeDocumentCategory;

  @ApiProperty({ required: false, format: 'date', nullable: true, description: 'null clears it' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string | null;

  @ApiProperty({ required: false, description: 'Replacement file id from POST /files/upload' })
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(127)
  mimeType?: string;
}

export class ReviewEmployeeDocumentDto {
  @ApiProperty({ enum: [EmployeeDocumentStatus.VERIFIED, EmployeeDocumentStatus.REJECTED] })
  @IsIn([EmployeeDocumentStatus.VERIFIED, EmployeeDocumentStatus.REJECTED])
  status: EmployeeDocumentStatus;

  /** Shown to the employee. Required when rejecting, so they know what to fix. */
  @ApiProperty({ required: false, example: 'The scan is blurry — please upload a clearer copy.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** HR's Employee Documents screen — every employee's uploads, and the verification queue. */
export class GetEmployeeDocumentsQueryDto {
  @ApiProperty({ required: false, enum: EmployeeDocumentStatus, description: 'PENDING for the review queue' })
  @IsOptional()
  @IsEnum(EmployeeDocumentStatus)
  status?: EmployeeDocumentStatus;

  /** A category, or ALL (the same as leaving it out). */
  @ApiProperty({ required: false, enum: EmployeeDocumentCategoryFilter })
  @IsOptional()
  @IsEnum(EmployeeDocumentCategoryFilter)
  category?: EmployeeDocumentCategoryFilter;

  @ApiProperty({ required: false, description: 'Employee name or code, document title or file name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

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
    description: 'Only documents that expire within this many days (already expired included)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  expiringWithinDays?: number;

  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export class CreateMyRequestDto {
  @ApiProperty({ enum: EmployeeRequestType })
  @IsEnum(EmployeeRequestType)
  type: EmployeeRequestType;

  @ApiProperty({
    example: 'Aug 20 — missed check-in',
    description: 'Text shown in the Request History description column',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description: string;

  @ApiProperty({
    required: false,
    example: '2026-08-21',
    format: 'date',
    description: 'Date shown in the history table. Defaults to today.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiProperty({ required: false, format: 'date', description: 'Work-from-home or overtime range start' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiProperty({ required: false, description: 'Overtime hours', minimum: 0.5, maximum: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(24)
  hours?: number;

  @ApiProperty({
    required: false,
    example: '09:30',
    description: 'Attendance correction: actual check-in. Overtime: start time. "HH:mm", the employee’s local time.',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'timeFrom must be a time like 09:30' })
  timeFrom?: string;

  @ApiProperty({
    required: false,
    example: '18:00',
    description: 'Attendance correction: actual check-out. Overtime: end time.',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'timeTo must be a time like 18:00' })
  timeTo?: string;
}

/**
 * Approve or reject. On approval, the optional fields are what HR actually
 * approves when it differs from what was asked — they're applied to the
 * employee's attendance.
 */
export class DecideEmployeeRequestDto {
  @ApiProperty({ enum: [EmployeeRequestStatus.APPROVED, EmployeeRequestStatus.REJECTED] })
  @IsIn([EmployeeRequestStatus.APPROVED, EmployeeRequestStatus.REJECTED])
  status: EmployeeRequestStatus.APPROVED | EmployeeRequestStatus.REJECTED;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiProperty({
    required: false,
    example: '2026-09-28T04:30:00.000Z',
    description: 'Attendance correction: the corrected check-in, as a full timestamp.',
  })
  @IsOptional()
  @IsISO8601()
  checkInAt?: string;

  @ApiProperty({ required: false, description: 'Attendance correction: the corrected check-out.' })
  @IsOptional()
  @IsISO8601()
  checkOutAt?: string;

  @ApiProperty({ required: false, description: 'Overtime: the hours approved.', minimum: 0.5, maximum: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(24)
  hours?: number;

  @ApiProperty({ required: false, format: 'date', description: 'Work from home: first approved day.' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiProperty({ required: false, format: 'date', description: 'Work from home: last approved day.' })
  @IsOptional()
  @IsDateString()
  toDate?: string;
}

export class GetMyNotificationsQueryDto {
  @ApiProperty({ required: false, default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 30;
}

export class EmployeeActorDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  userId: string;

  /**
   * Login email. The access token id is the auth credential, while
   * Employee.userId points at the user-service account, so email is the
   * link that already exists on both rows.
   */
  @IsOptional()
  @IsEmail()
  email?: string;
}

/** One of the caller's own payslips — the employee comes from the login, never the request. */
export class MyPayslipMessageDto extends EmployeeActorDto {
  @IsUUID()
  payslipId: string;
}

/**
 * The hierarchy request. `canViewAll` is decided by the gateway from the
 * caller's own token — organization-wide employee access (HR, admin) sees the
 * whole chart; anyone else only their own branch.
 */
export class HierarchyActorDto extends EmployeeActorDto {
  @IsOptional()
  @IsBoolean()
  canViewAll?: boolean;
}

/** Check-in / check-out: the actor plus the address the punch came from. */
export class EmployeePunchDto extends EmployeeActorDto {
  /** Checked against the organization's IP restriction, when it has one. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientIp?: string;

  /** Check-out only: the day-end status the employee reported. */
  @IsOptional()
  @IsString()
  @MaxLength(DAY_END_STATUS_MAX)
  dayEndStatus?: string;
}

/** `POST organization/me/attendance/check-out` body. */
export class CheckOutDto {
  @ApiProperty({
    required: false,
    maxLength: DAY_END_STATUS_MAX,
    example: '- Finished the payroll export\n- Reviewed 3 leave requests\n- Tomorrow: tax report',
    description: 'What was done today — typed or pasted when checking out. Shown to HR with the day’s attendance.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(DAY_END_STATUS_MAX)
  dayEndStatus?: string;
}

export class UpdateMyProfileMessageDto extends EmployeeActorDto {
  @ValidateNested()
  @Type(() => UpdateMyProfileDto)
  @IsDefined()
  dto: UpdateMyProfileDto;
}

export class GetMyAttendanceMessageDto extends EmployeeActorDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GetMyAttendanceQueryDto)
  query?: GetMyAttendanceQueryDto;
}

export class ApplyMyLeaveMessageDto extends EmployeeActorDto {
  @ValidateNested()
  @Type(() => ApplyMyLeaveDto)
  @IsDefined()
  dto: ApplyMyLeaveDto;
}

export class MyLeaveRequestMessageDto extends EmployeeActorDto {
  @IsUUID()
  leaveRequestId: string;
}

export class UpdateMyLeaveMessageDto extends MyLeaveRequestMessageDto {
  @ValidateNested()
  @Type(() => UpdateMyLeaveDto)
  @IsDefined()
  dto: UpdateMyLeaveDto;
}

export class GetMyLeaveSummaryMessageDto extends EmployeeActorDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GetMyLeaveSummaryQueryDto)
  query?: GetMyLeaveSummaryQueryDto;
}

export class GetMyLeaveHistoryMessageDto extends EmployeeActorDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GetMyLeaveHistoryQueryDto)
  query?: GetMyLeaveHistoryQueryDto;
}

export class GetMyDocumentsMessageDto extends EmployeeActorDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GetMyDocumentsQueryDto)
  query?: GetMyDocumentsQueryDto;
}

export class UploadMyDocumentMessageDto extends EmployeeActorDto {
  @ValidateNested()
  @Type(() => UploadMyDocumentDto)
  @IsDefined()
  dto: UploadMyDocumentDto;
}

export class MyDocumentMessageDto extends EmployeeActorDto {
  @IsUUID()
  documentId: string;
}

export class UpdateMyDocumentMessageDto extends MyDocumentMessageDto {
  @ValidateNested()
  @Type(() => UpdateMyDocumentDto)
  @IsDefined()
  dto: UpdateMyDocumentDto;
}

export class TenantEmployeeDocumentIdDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  documentId: string;
}

export class ReviewEmployeeDocumentMessageDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  documentId: string;

  /** Who reviews — recorded, and used to stop anyone reviewing their own upload. */
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsEmail()
  actorEmail?: string;

  @ValidateNested()
  @Type(() => ReviewEmployeeDocumentDto)
  @IsDefined()
  dto: ReviewEmployeeDocumentDto;
}

export class GetEmployeeDocumentsMessageDto {
  @IsUUID()
  tenantId: string;

  /** Who is looking — their own uploads are flagged, since they can't review them. */
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsEmail()
  actorEmail?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GetEmployeeDocumentsQueryDto)
  query?: GetEmployeeDocumentsQueryDto;
}

export class CreateMyRequestMessageDto extends EmployeeActorDto {
  @ValidateNested()
  @Type(() => CreateMyRequestDto)
  @IsDefined()
  dto: CreateMyRequestDto;
}

export class MyRequestMessageDto extends EmployeeActorDto {
  @IsUUID()
  requestId: string;
}

export class DecideEmployeeRequestMessageDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  requestId: string;

  @IsUUID()
  actorUserId: string;

  /** Used to recognise the decider's own request, which they may not decide. */
  @IsOptional()
  @IsEmail()
  actorEmail?: string;

  @ValidateNested()
  @Type(() => DecideEmployeeRequestDto)
  @IsDefined()
  dto: DecideEmployeeRequestDto;
}

/** HR's Employee Requests screen — every employee's requests. */
export class GetEmployeeRequestsQueryDto {
  @ApiProperty({ required: false, enum: EmployeeRequestStatus })
  @IsOptional()
  @IsEnum(EmployeeRequestStatus)
  status?: EmployeeRequestStatus;

  @ApiProperty({ required: false, enum: EmployeeRequestType })
  @IsOptional()
  @IsEnum(EmployeeRequestType)
  type?: EmployeeRequestType;

  @ApiProperty({ required: false, description: 'Employee name, code, or text in the description' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export class GetEmployeeRequestsMessageDto {
  @IsUUID()
  tenantId: string;

  /** Who is looking — their own requests are flagged, since they can't decide them. */
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsEmail()
  actorEmail?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GetEmployeeRequestsQueryDto)
  query?: GetEmployeeRequestsQueryDto;
}

export class GetMyNotificationsMessageDto extends EmployeeActorDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GetMyNotificationsQueryDto)
  query?: GetMyNotificationsQueryDto;
}

export class MyNotificationMessageDto extends EmployeeActorDto {
  @IsUUID()
  notificationId: string;
}
