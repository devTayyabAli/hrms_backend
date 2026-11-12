import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeActorDto } from './employee-portal.dto';

/**
 * Workspace: Tasks, Projects and the Company Calendar.
 *
 * Tasks and Projects ride on the `projects` module ("Projects & Tasks" in the
 * catalog); the calendar on `calendar`. Every date here is a calendar day
 * (YYYY-MM-DD), never a timestamp, so "due today" means the same thing in
 * every timezone.
 */

export enum WorkspaceTaskStatus {
  /** Shown as "To Do". The stored value stays PENDING so existing tasks are unchanged. */
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  BLOCKED = 'BLOCKED',
  COMPLETED = 'COMPLETED',
}

export enum WorkspaceTaskPriority {
  URGENT = 'URGENT',
  HIGH = 'HIGH',
  NORMAL = 'NORMAL',
  LOW = 'LOW',
}

export enum WorkspaceProjectStatus {
  PLANNED = 'PLANNED',
  ACTIVE = 'ACTIVE',
  ON_HOLD = 'ON_HOLD',
  AT_RISK = 'AT_RISK',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/** How urgent the project is. Separate from a task's priority. */
export enum WorkspaceProjectPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/** Kinds an admin can create. Birthdays and work anniversaries come from employee records. */
export enum CalendarEventKind {
  EVENT = 'EVENT',
  HOLIDAY = 'HOLIDAY',
}

/** What kind of day off a holiday is. */
export enum HolidayType {
  NATIONAL = 'NATIONAL',
  FESTIVAL = 'FESTIVAL',
  COMPANY = 'COMPANY',
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_MESSAGE = 'must be a date in YYYY-MM-DD format';
const TIME_MESSAGE = 'must be a time in HH:mm (24-hour) format';

const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

/** `''` from a cleared form field means "remove it", the same as null. */
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);

// ==========================================
// Tasks — HTTP
// ==========================================

export const WORKSPACE_TASK_SORT_FIELDS = ['dueDate', 'createdAt', 'priority', 'title', 'status'] as const;
export type WorkspaceTaskSortField = (typeof WORKSPACE_TASK_SORT_FIELDS)[number];

/** Filters shared by the list, its stats and the export. */
export class WorkspaceTaskFiltersDto {
  @ApiPropertyOptional({ description: 'Matches task title or assignee name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: WorkspaceTaskPriority })
  @IsOptional()
  @IsEnum(WorkspaceTaskPriority)
  priority?: WorkspaceTaskPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigneeEmployeeId?: string;

  @ApiPropertyOptional({ description: 'Only tasks past their due date and not completed' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdue?: boolean;
}

export class GetWorkspaceTasksQueryDto extends WorkspaceTaskFiltersDto {
  @ApiPropertyOptional({ enum: WorkspaceTaskStatus })
  @IsOptional()
  @IsEnum(WorkspaceTaskStatus)
  status?: WorkspaceTaskStatus;

  @ApiPropertyOptional({ enum: WORKSPACE_TASK_SORT_FIELDS })
  @IsOptional()
  @IsIn(WORKSPACE_TASK_SORT_FIELDS)
  sortBy?: WorkspaceTaskSortField;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'] })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 10, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ExportWorkspaceTasksQueryDto extends WorkspaceTaskFiltersDto {
  @ApiPropertyOptional({ enum: WorkspaceTaskStatus })
  @IsOptional()
  @IsEnum(WorkspaceTaskStatus)
  status?: WorkspaceTaskStatus;
}

export class CreateWorkspaceTaskDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({ description: 'Leave out for a task that belongs to no project' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiProperty()
  @IsUUID()
  assigneeEmployeeId: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Everyone responsible. The first id is the primary assignee. Omit to assign only assigneeEmployeeId.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  assigneeEmployeeIds?: string[];

  @ApiPropertyOptional({
    description: 'When task review is on for the organization, completing this task waits for a reviewer. Ignored while review is off.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  requiresReview?: boolean;

  @ApiProperty({ example: '2026-10-20' })
  @Matches(DATE_ONLY, { message: `dueDate ${DATE_MESSAGE}` })
  dueDate: string;

  @ApiPropertyOptional({ enum: WorkspaceTaskPriority, default: WorkspaceTaskPriority.NORMAL })
  @IsOptional()
  @IsEnum(WorkspaceTaskPriority)
  priority?: WorkspaceTaskPriority;

  @ApiPropertyOptional({ enum: WorkspaceTaskStatus, default: WorkspaceTaskStatus.PENDING })
  @IsOptional()
  @IsEnum(WorkspaceTaskStatus)
  status?: WorkspaceTaskStatus;

  @ApiPropertyOptional({
    description: 'Keep a due date that falls outside the project start and expected end. Ignored when there is no project or the date is inside the range.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  dueDateException?: boolean;
}

export class UpdateWorkspaceTaskDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({ description: 'null removes the task from its project' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigneeEmployeeId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces everyone responsible when sent. The first id becomes the primary assignee.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  assigneeEmployeeIds?: string[];

  @ApiPropertyOptional({ description: 'Whether this task waits for review before it can be completed. Ignored while review is off.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  requiresReview?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_ONLY, { message: `dueDate ${DATE_MESSAGE}` })
  dueDate?: string;

  @ApiPropertyOptional({ enum: WorkspaceTaskPriority })
  @IsOptional()
  @IsEnum(WorkspaceTaskPriority)
  priority?: WorkspaceTaskPriority;

  @ApiPropertyOptional({ enum: WorkspaceTaskStatus })
  @IsOptional()
  @IsEnum(WorkspaceTaskStatus)
  status?: WorkspaceTaskStatus;

  @ApiPropertyOptional({
    description: 'Keep a due date that falls outside the project start and expected end.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  dueDateException?: boolean;
}

export class UpdateWorkspaceSettingsDto {
  @ApiPropertyOptional({ description: 'Off completes tasks directly. On sends tasks marked for review to a reviewer first.' })
  @IsOptional()
  @IsBoolean()
  taskReviewEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Tell assignees the day before a task is due. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  deadlineRemindersEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Tell assignees and the project owner once a task is overdue. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdueRemindersEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Remind the project owner the next day if a task is still waiting for review. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  reviewRemindersEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Tell the owner and members when a project status changes. On when omitted. Closing still notifies even when this is off.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  projectStatusNotificationsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Tell people when they are added to a project or given a task, and when a task\'s due date or priority changes. On when omitted.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  assignmentNotificationsEnabled?: boolean;
}

export class DecideWorkspaceTaskReviewDto {
  @ApiProperty({ enum: ['APPROVE', 'RETURN'] })
  @IsIn(['APPROVE', 'RETURN'])
  decision: 'APPROVE' | 'RETURN';

  @ApiPropertyOptional({ description: 'Feedback on the work. Required when returning a task; optional when approving.', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  feedback?: string;
}

export class UpdateTaskStatusDto {
  @ApiProperty({ enum: WorkspaceTaskStatus })
  @IsEnum(WorkspaceTaskStatus)
  status: WorkspaceTaskStatus;
}

export class CreateWorkspaceTaskCommentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}

export class CreateWorkspaceChecklistItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;
}

export class UpdateWorkspaceChecklistItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  done?: boolean;
}

export class CreateWorkspaceTaskAttachmentDto {
  @ApiProperty({ description: 'File id from POST /files/upload with category "task"' })
  @IsUUID()
  fileId: string;
}

export class GetMyTasksQueryDto {
  @ApiPropertyOptional({ enum: WorkspaceTaskStatus })
  @IsOptional()
  @IsEnum(WorkspaceTaskStatus)
  status?: WorkspaceTaskStatus;
}

// ==========================================
// Projects — HTTP
// ==========================================

export class GetWorkspaceProjectsQueryDto {
  @ApiPropertyOptional({ description: 'Matches project name, client or lead' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: WorkspaceProjectStatus })
  @IsOptional()
  @IsEnum(WorkspaceProjectStatus)
  status?: WorkspaceProjectStatus;

  @ApiPropertyOptional({ description: 'Only projects tied to this branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class CreateWorkspaceProjectDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({ description: 'Client or internal sponsor' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  client?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiProperty({ description: 'The responsible owner. Required, and not changed on the employee record.' })
  @IsUUID()
  leadEmployeeId: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Team members besides the owner. The owner is not stored again in this list.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  memberEmployeeIds?: string[];

  @ApiPropertyOptional({ description: "Defaults to the lead's department" })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  departmentId?: string | null;

  @ApiPropertyOptional({ enum: WorkspaceProjectStatus, default: WorkspaceProjectStatus.ACTIVE })
  @IsOptional()
  @IsEnum(WorkspaceProjectStatus)
  status?: WorkspaceProjectStatus;

  @ApiPropertyOptional({ enum: WorkspaceProjectPriority, default: WorkspaceProjectPriority.MEDIUM })
  @IsOptional()
  @IsEnum(WorkspaceProjectPriority)
  priority?: WorkspaceProjectPriority;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Optional. Must be on or before the expected end.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE_ONLY, { message: `startDate ${DATE_MESSAGE}` })
  startDate?: string | null;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'Expected end. Task due dates should fall on or before this day.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE_ONLY, { message: `dueDate ${DATE_MESSAGE}` })
  dueDate?: string | null;

  @ApiPropertyOptional({ description: 'The branch the project runs from. It must be an active branch of this organization.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional({ description: 'Free-text place, for when no branch fits.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(150)
  location?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Up to 20 short labels. Duplicates are dropped.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Next milestone, e.g. "UAT sign-off"' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  milestone?: string | null;

  @ApiPropertyOptional({ description: 'Hidden from people who are not on the project, unless they can view confidential projects.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  confidential?: boolean;
}

export class UpdateWorkspaceProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  client?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({ description: 'A new owner. Omit to keep the current one. Null is refused.' })
  @IsOptional()
  @IsUUID()
  leadEmployeeId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces the team when sent. Omit to leave the team unchanged. The owner is dropped from this list.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  memberEmployeeIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  departmentId?: string | null;

  @ApiPropertyOptional({ enum: WorkspaceProjectStatus })
  @IsOptional()
  @IsEnum(WorkspaceProjectStatus)
  status?: WorkspaceProjectStatus;

  @ApiPropertyOptional({ enum: WorkspaceProjectPriority })
  @IsOptional()
  @IsEnum(WorkspaceProjectPriority)
  priority?: WorkspaceProjectPriority;

  @ApiPropertyOptional({ description: 'Null clears the start date.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE_ONLY, { message: `startDate ${DATE_MESSAGE}` })
  startDate?: string | null;

  @ApiPropertyOptional({ description: 'Expected end. Null clears it.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE_ONLY, { message: `dueDate ${DATE_MESSAGE}` })
  dueDate?: string | null;

  @ApiPropertyOptional({ description: 'Moves the project to another branch. Null clears it. The branch must be active.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional({ description: 'Free-text place. Null clears it.' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(150)
  location?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Replaces the tags when sent. Omit to leave them unchanged.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  milestone?: string | null;

  @ApiPropertyOptional({ description: 'Hidden from people who are not on the project, unless they can view confidential projects. Changing this needs that permission.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  confidential?: boolean;

  @ApiPropertyOptional({
    description: 'Required to close a project that still has incomplete or blocked tasks. Those tasks stay open.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  acknowledgeOpenTasks?: boolean;
}

// ==========================================
// Calendar — HTTP
// ==========================================

export class GetCalendarQueryDto {
  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiProperty({ example: 10, description: '1–12' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;
}

export class CreateCalendarEventDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @ApiProperty({ example: '2026-10-20' })
  @Matches(DATE_ONLY, { message: `date ${DATE_MESSAGE}` })
  date: string;

  @ApiPropertyOptional({ enum: CalendarEventKind, default: CalendarEventKind.EVENT })
  @IsOptional()
  @IsEnum(CalendarEventKind)
  kind?: CalendarEventKind;

  @ApiPropertyOptional({ example: '10:00' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(TIME_OF_DAY, { message: `startTime ${TIME_MESSAGE}` })
  startTime?: string | null;

  @ApiPropertyOptional({ example: '11:30' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(TIME_OF_DAY, { message: `endTime ${TIME_MESSAGE}` })
  endTime?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: HolidayType, description: 'Holidays only' })
  @IsOptional()
  @IsEnum(HolidayType)
  holidayType?: HolidayType;

  @ApiPropertyOptional({ description: 'Holidays only: staff may take it; the office stays open' })
  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;
}

export class UpdateCalendarEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_ONLY, { message: `date ${DATE_MESSAGE}` })
  date?: string;

  @ApiPropertyOptional({ enum: CalendarEventKind })
  @IsOptional()
  @IsEnum(CalendarEventKind)
  kind?: CalendarEventKind;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(TIME_OF_DAY, { message: `startTime ${TIME_MESSAGE}` })
  startTime?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(TIME_OF_DAY, { message: `endTime ${TIME_MESSAGE}` })
  endTime?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: HolidayType, description: 'Holidays only' })
  @IsOptional()
  @IsEnum(HolidayType)
  holidayType?: HolidayType;

  @ApiPropertyOptional({ description: 'Holidays only: staff may take it; the office stays open' })
  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;
}

// ==========================================
// TCP messages (api-gateway -> tenant-service)
// ==========================================

class TenantMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class GetWorkspaceTasksMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => GetWorkspaceTasksQueryDto)
  @IsDefined()
  query: GetWorkspaceTasksQueryDto;
}

export class WorkspaceTaskStatsMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => WorkspaceTaskFiltersDto)
  @IsDefined()
  query: WorkspaceTaskFiltersDto;
}

export class ExportWorkspaceTasksMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => ExportWorkspaceTasksQueryDto)
  @IsDefined()
  query: ExportWorkspaceTasksQueryDto;
}

export class WorkspaceTaskIdMessageDto extends TenantMessageDto {
  @IsUUID()
  taskId: string;
}

export class CreateWorkspaceTaskMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => CreateWorkspaceTaskDto)
  @IsDefined()
  dto: CreateWorkspaceTaskDto;
}

export class UpdateWorkspaceTaskMessageDto extends WorkspaceTaskIdMessageDto {
  @ValidateNested()
  @Type(() => UpdateWorkspaceTaskDto)
  @IsDefined()
  dto: UpdateWorkspaceTaskDto;
}

export class GetMyTasksMessageDto extends EmployeeActorDto {
  @ValidateNested()
  @Type(() => GetMyTasksQueryDto)
  @IsDefined()
  query: GetMyTasksQueryDto;
}

export class UpdateMyTaskStatusMessageDto extends EmployeeActorDto {
  @IsUUID()
  taskId: string;

  @IsEnum(WorkspaceTaskStatus)
  status: WorkspaceTaskStatus;
}

export class UpdateWorkspaceSettingsMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => UpdateWorkspaceSettingsDto)
  @IsDefined()
  dto: UpdateWorkspaceSettingsDto;
}

export class DecideWorkspaceTaskReviewMessageDto extends WorkspaceTaskIdMessageDto {
  @IsIn(['APPROVE', 'RETURN'])
  decision: 'APPROVE' | 'RETURN';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  feedback?: string;

  /** True for organization-wide task or project managers. They still cannot review a task assigned to themselves. */
  @IsBoolean()
  canManage: boolean;
}

export class AddTaskCommentMessageDto extends WorkspaceTaskIdMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;

  @IsUUID()
  userId: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsIn(['mine', 'manage'])
  scope: 'mine' | 'manage';
}

export class DeleteTaskCommentMessageDto extends WorkspaceTaskIdMessageDto {
  @IsUUID()
  commentId: string;

  @IsUUID()
  userId: string;

  @IsBoolean()
  canModerate: boolean;

  @IsIn(['mine', 'manage'])
  scope: 'mine' | 'manage';
}

export class AddChecklistItemMessageDto extends WorkspaceTaskIdMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;
}

export class UpdateChecklistItemMessageDto extends WorkspaceTaskIdMessageDto {
  @IsUUID()
  itemId: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsBoolean()
  done?: boolean;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsIn(['mine', 'manage'])
  scope: 'mine' | 'manage';
}

export class DeleteChecklistItemMessageDto extends WorkspaceTaskIdMessageDto {
  @IsUUID()
  itemId: string;
}

export class AddTaskAttachmentMessageDto extends WorkspaceTaskIdMessageDto {
  @IsUUID()
  fileId: string;

  @IsString()
  @MaxLength(255)
  fileName: string;

  @IsOptional()
  @IsString()
  @MaxLength(127)
  mimeType?: string;

  @IsOptional()
  @IsInt()
  sizeBytes?: number;

  @IsUUID()
  userId: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsIn(['mine', 'manage'])
  scope: 'mine' | 'manage';
}

export class DeleteTaskAttachmentMessageDto extends WorkspaceTaskIdMessageDto {
  @IsUUID()
  attachmentId: string;

  @IsUUID()
  userId: string;

  @IsBoolean()
  canModerate: boolean;

  @IsIn(['mine', 'manage'])
  scope: 'mine' | 'manage';
}

export class GetTaskAttachmentMessageDto extends WorkspaceTaskIdMessageDto {
  @IsUUID()
  attachmentId: string;

  @IsUUID()
  userId: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsIn(['mine', 'manage'])
  scope: 'mine' | 'manage';
}

export class GetWorkspaceProjectsMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => GetWorkspaceProjectsQueryDto)
  @IsDefined()
  query: GetWorkspaceProjectsQueryDto;
}

export class WorkspaceProjectIdMessageDto extends TenantMessageDto {
  @IsUUID()
  projectId: string;
}

export class CreateWorkspaceProjectMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => CreateWorkspaceProjectDto)
  @IsDefined()
  dto: CreateWorkspaceProjectDto;
}

export class UpdateWorkspaceProjectMessageDto extends WorkspaceProjectIdMessageDto {
  @ValidateNested()
  @Type(() => UpdateWorkspaceProjectDto)
  @IsDefined()
  dto: UpdateWorkspaceProjectDto;

  /** True when the caller has projects.reopen, projects.manage, or full access. */
  @IsOptional()
  @IsBoolean()
  canReopen?: boolean;
}

export class GetCalendarMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => GetCalendarQueryDto)
  @IsDefined()
  query: GetCalendarQueryDto;

  /** Whether the caller may edit events; decides each entry's `editable` flag. */
  @IsOptional()
  @IsBoolean()
  canEdit?: boolean;
}

export class CalendarEventIdMessageDto extends TenantMessageDto {
  @IsUUID()
  eventId: string;
}

export class CreateCalendarEventMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => CreateCalendarEventDto)
  @IsDefined()
  dto: CreateCalendarEventDto;
}

export class UpdateCalendarEventMessageDto extends CalendarEventIdMessageDto {
  @ValidateNested()
  @Type(() => UpdateCalendarEventDto)
  @IsDefined()
  dto: UpdateCalendarEventDto;
}

// ==========================================
// Holidays (Attendance › Holidays) — stored as calendar_events of kind HOLIDAY
// ==========================================


export class GetHolidaysQueryDto {
  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

export class CreateHolidayDto {
  @ApiProperty({ example: 'Independence Day' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({ example: '2026-08-14' })
  @Matches(DATE_ONLY, { message: `date ${DATE_MESSAGE}` })
  date: string;

  @ApiPropertyOptional({ enum: HolidayType, default: HolidayType.NATIONAL })
  @IsOptional()
  @IsEnum(HolidayType)
  holidayType?: HolidayType;

  @ApiPropertyOptional({ description: 'Staff may choose to take it; the office stays open', default: false })
  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class UpdateHolidayDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_ONLY, { message: `date ${DATE_MESSAGE}` })
  date?: string;

  @ApiPropertyOptional({ enum: HolidayType })
  @IsOptional()
  @IsEnum(HolidayType)
  holidayType?: HolidayType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class GetHolidaysMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => GetHolidaysQueryDto)
  @IsDefined()
  query: GetHolidaysQueryDto;
}

export class CreateHolidayMessageDto extends TenantMessageDto {
  @ValidateNested()
  @Type(() => CreateHolidayDto)
  @IsDefined()
  dto: CreateHolidayDto;
}

export class UpdateHolidayMessageDto extends CalendarEventIdMessageDto {
  @ValidateNested()
  @Type(() => UpdateHolidayDto)
  @IsDefined()
  dto: UpdateHolidayDto;
}
