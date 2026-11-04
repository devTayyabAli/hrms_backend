import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { LearningActorDto, TRAINING_MAX_DUE_DAYS } from './learning.dto';

/**
 * Learning, assigned: giving courses to people, and what each person does with
 * them. The stored status is NOT_STARTED, IN_PROGRESS, COMPLETED or CANCELLED;
 * "overdue" is not stored — an open assignment is overdue when its due date has
 * passed — so it can never be wrong.
 */

export const TRAINING_ASSIGN_MAX_EMPLOYEES = 1000;
export const TRAINING_ASSIGN_MAX_GROUPS = 50;
/** More people than this from one assignment is a mistake to narrow down, not a job to run. */
export const TRAINING_ASSIGN_MAX_PEOPLE = 2000;

export enum TrainingAssignmentStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/** What a person or a manager sees: the stored status, except an open assignment past its due date reads OVERDUE. */
export enum TrainingAssignmentViewStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  OVERDUE = 'OVERDUE',
  CANCELLED = 'CANCELLED',
}

export enum TrainingAssignmentStatusFilter {
  ALL = 'ALL',
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  OVERDUE = 'OVERDUE',
  CANCELLED = 'CANCELLED',
}

/** The employee's own list has no cancelled filter: a cancelled assignment is not theirs to see. */
export enum MyLearningStatusFilter {
  ALL = 'ALL',
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  OVERDUE = 'OVERDUE',
}

/** Why a person has the course. Direct beats department beats designation when more than one applies. */
export enum TrainingAssignmentSource {
  DIRECT = 'DIRECT',
  DEPARTMENT = 'DEPARTMENT',
  DESIGNATION = 'DESIGNATION',
  ONBOARDING = 'ONBOARDING',
}

export const TRAINING_ASSIGNMENT_SORTABLE_FIELDS = ['assignedAt', 'dueDate', 'employeeName', 'courseTitle', 'status'] as const;
export type TrainingAssignmentSortField = (typeof TRAINING_ASSIGNMENT_SORTABLE_FIELDS)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

// ==========================================
// Requests: assigning (HR / managers)
// ==========================================

export class AssignTrainingDto {
  @ApiProperty({ description: 'A published course' })
  @IsUUID()
  courseId: string;

  @ApiProperty({ required: false, type: [String], description: 'Employees to assign to' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TRAINING_ASSIGN_MAX_EMPLOYEES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  employeeIds?: string[];

  @ApiProperty({ required: false, type: [String], description: 'Everyone currently in these departments' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TRAINING_ASSIGN_MAX_GROUPS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  departmentIds?: string[];

  @ApiProperty({ required: false, type: [String], description: 'Everyone currently holding these designations' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TRAINING_ASSIGN_MAX_GROUPS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  designationIds?: string[];

  @ApiProperty({ required: false, example: '2026-12-15', description: 'YYYY-MM-DD, today or later. Not together with dueInDays' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  dueDate?: string | null;

  @ApiProperty({ required: false, example: 14, minimum: 1, maximum: TRAINING_MAX_DUE_DAYS, description: 'Due this many days from today. Not together with dueDate' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRAINING_MAX_DUE_DAYS)
  dueInDays?: number;

  @ApiProperty({ required: false, description: 'Defaults to the course\'s "mandatory by default". A mandatory assignment needs a due date' })
  @IsOptional()
  @IsBoolean()
  mandatory?: boolean;
}

export class GetTrainingAssignmentsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ required: false, description: 'The department the employee was in when it was assigned' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ enum: TrainingAssignmentStatusFilter, required: false, default: TrainingAssignmentStatusFilter.ALL })
  @IsOptional()
  @IsEnum(TrainingAssignmentStatusFilter)
  status?: TrainingAssignmentStatusFilter = TrainingAssignmentStatusFilter.ALL;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  mandatory?: boolean;

  @ApiProperty({ required: false, description: 'Matches the employee\'s name or code, or the course title' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, enum: TRAINING_ASSIGNMENT_SORTABLE_FIELDS, default: 'assignedAt' })
  @IsOptional()
  @IsIn(TRAINING_ASSIGNMENT_SORTABLE_FIELDS)
  sortBy?: TrainingAssignmentSortField = 'assignedAt';

  @ApiProperty({ required: false, enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';

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

export class UpdateTrainingAssignmentDto {
  @ApiProperty({ required: false, example: '2026-12-31', description: 'YYYY-MM-DD, today or later. null removes it (not for a mandatory assignment)' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  dueDate?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  mandatory?: boolean;
}

export class CancelTrainingAssignmentDto {
  @ApiProperty({ required: false, example: 'Role changed, no longer needed' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

// ==========================================
// Requests: the employee's own learning
// ==========================================

export class GetMyLearningQueryDto {
  @ApiProperty({ enum: MyLearningStatusFilter, required: false, default: MyLearningStatusFilter.ALL })
  @IsOptional()
  @IsEnum(MyLearningStatusFilter)
  status?: MyLearningStatusFilter = MyLearningStatusFilter.ALL;

  @ApiProperty({ required: false, description: 'Matches the course title or category' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class GetMyLearningHistoryQueryDto {
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

export class CompleteMyLearningDto {
  @ApiProperty({ required: false, example: 'Finished all the modules' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

// ==========================================
// Requests: notification settings
// ==========================================

export const LEARNING_REMINDER_DAYS_DEFAULT = [3, 1];
export const LEARNING_REMINDER_DAYS_MAX = 30;

export class UpdateLearningSettingsDto {
  @ApiProperty({ required: false, description: 'Tell people about a new course, a changed due date, or one withdrawn. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  assignmentNotificationsEnabled?: boolean;

  @ApiProperty({ required: false, description: 'Tell people a due date is coming up. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  deadlineRemindersEnabled?: boolean;

  @ApiProperty({ required: false, description: 'Tell people, and for a mandatory course their manager, that a course is overdue. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdueRemindersEnabled?: boolean;

  @ApiProperty({ required: false, description: 'Tell a manager when someone finishes a mandatory course. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  completionNotificationsEnabled?: boolean;

  @ApiProperty({ required: false, type: [Number], example: [3, 1], description: 'How many days before the due date a reminder goes out. 1 to 30 days, at most 5, no repeats.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(LEARNING_REMINDER_DAYS_MAX, { each: true })
  reminderDays?: number[];
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class UpdateLearningSettingsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: UpdateLearningSettingsDto })
  @ValidateNested()
  @Type(() => UpdateLearningSettingsDto)
  @IsDefined()
  dto: UpdateLearningSettingsDto;
}

export class AssignTrainingMessageDto extends LearningActorDto {
  @ApiProperty({ type: AssignTrainingDto })
  @ValidateNested()
  @Type(() => AssignTrainingDto)
  @IsDefined()
  dto: AssignTrainingDto;
}

export class GetTrainingAssignmentsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetTrainingAssignmentsQueryDto })
  @ValidateNested()
  @Type(() => GetTrainingAssignmentsQueryDto)
  @IsDefined()
  query: GetTrainingAssignmentsQueryDto;
}

export class TrainingAssignmentIdMessageDto extends LearningActorDto {
  @ApiProperty()
  @IsUUID()
  assignmentId: string;
}

export class UpdateTrainingAssignmentMessageDto extends TrainingAssignmentIdMessageDto {
  @ApiProperty({ type: UpdateTrainingAssignmentDto })
  @ValidateNested()
  @Type(() => UpdateTrainingAssignmentDto)
  @IsDefined()
  dto: UpdateTrainingAssignmentDto;
}

export class CancelTrainingAssignmentMessageDto extends TrainingAssignmentIdMessageDto {
  @ApiProperty({ type: CancelTrainingAssignmentDto })
  @ValidateNested()
  @Type(() => CancelTrainingAssignmentDto)
  @IsDefined()
  dto: CancelTrainingAssignmentDto;
}

export class GetEmployeeLearningMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ type: GetMyLearningHistoryQueryDto })
  @ValidateNested()
  @Type(() => GetMyLearningHistoryQueryDto)
  @IsDefined()
  query: GetMyLearningHistoryQueryDto;
}

export class GetMyLearningMessageDto extends LearningActorDto {
  @ApiProperty({ type: GetMyLearningQueryDto })
  @ValidateNested()
  @Type(() => GetMyLearningQueryDto)
  @IsDefined()
  query: GetMyLearningQueryDto;
}

export class GetMyLearningHistoryMessageDto extends LearningActorDto {
  @ApiProperty({ type: GetMyLearningHistoryQueryDto })
  @ValidateNested()
  @Type(() => GetMyLearningHistoryQueryDto)
  @IsDefined()
  query: GetMyLearningHistoryQueryDto;
}

export class MyTrainingMaterialMessageDto extends TrainingAssignmentIdMessageDto {
  @ApiProperty()
  @IsUUID()
  materialId: string;
}

export class CompleteMyLearningMessageDto extends TrainingAssignmentIdMessageDto {
  @ApiProperty({ type: CompleteMyLearningDto })
  @ValidateNested()
  @Type(() => CompleteMyLearningDto)
  @IsDefined()
  dto: CompleteMyLearningDto;
}
