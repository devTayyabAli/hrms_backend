import {
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
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

export enum WorkspaceTaskPriority {
  URGENT = 'URGENT',
  HIGH = 'HIGH',
  NORMAL = 'NORMAL',
  LOW = 'LOW',
}

export enum WorkspaceProjectStatus {
  ACTIVE = 'ACTIVE',
  ON_HOLD = 'ON_HOLD',
  AT_RISK = 'AT_RISK',
  COMPLETED = 'COMPLETED',
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
}

export class UpdateTaskStatusDto {
  @ApiProperty({ enum: WorkspaceTaskStatus })
  @IsEnum(WorkspaceTaskStatus)
  status: WorkspaceTaskStatus;
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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  leadEmployeeId?: string | null;

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

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE_ONLY, { message: `dueDate ${DATE_MESSAGE}` })
  dueDate?: string | null;

  @ApiPropertyOptional({ description: 'Next milestone, e.g. "UAT sign-off"' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  milestone?: string | null;
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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  leadEmployeeId?: string | null;

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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE_ONLY, { message: `dueDate ${DATE_MESSAGE}` })
  dueDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  milestone?: string | null;
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
