import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEmail,
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
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

// ==========================================
// Enums
// ==========================================

/**
 * A new hire's onboarding progress — the Status column on the New Hires table
 * and the three slices of the Onboarding Progress donut.
 *
 * This is *derived* from the hire's checklist, never stored: no tasks done is
 * PENDING, all tasks done is COMPLETED, anything between is IN_PROGRESS. See
 * `deriveOnboardingStatus` below for why.
 */
export enum NewHireOnboardingStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

/** Adds ALL so the New Hires filter row can express "no status filter". */
export enum NewHireOnboardingStatusFilter {
  ALL = 'ALL',
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

export enum OnboardingTaskStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
}

/** Adds ALL so the task list can express "no status filter". */
export enum OnboardingTaskStatusFilter {
  ALL = 'ALL',
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
}

/**
 * Grouping for the checklist. Categories exist so a template can be seeded
 * and reported on per area ("IT setup is always the bottleneck") rather than
 * only as a flat list of task titles.
 */
export enum OnboardingTaskCategory {
  DOCUMENTATION = 'DOCUMENTATION',
  IT_SETUP = 'IT_SETUP',
  ORIENTATION = 'ORIENTATION',
  COMPLIANCE = 'COMPLIANCE',
  TRAINING = 'TRAINING',
  OTHER = 'OTHER',
}

/**
 * Derive a hire's onboarding status from their checklist tallies.
 *
 * Status is computed rather than stored so the Status column, the "Completed
 * Onboarding" KPI and the progress donut can never disagree with the
 * checklist they are all summarising. A stored column would need updating on
 * every task toggle, task add and task delete, and the first missed write
 * would leave a hire showing COMPLETED with three open tasks.
 *
 * A hire with no tasks at all is PENDING, not COMPLETED — vacuously "all
 * tasks done" would otherwise report someone whose onboarding has not been
 * planned yet as finished.
 */
export const deriveOnboardingStatus = (
  totalTasks: number,
  completedTasks: number,
): NewHireOnboardingStatus => {
  if (totalTasks === 0 || completedTasks === 0) {
    return NewHireOnboardingStatus.PENDING;
  }
  return completedTasks >= totalTasks
    ? NewHireOnboardingStatus.COMPLETED
    : NewHireOnboardingStatus.IN_PROGRESS;
};

export const NEW_HIRE_SORTABLE_FIELDS = [
  'employeeName',
  'position',
  'department',
  'joiningDate',
  'createdAt',
] as const;
export type NewHireSortableField = (typeof NEW_HIRE_SORTABLE_FIELDS)[number];

export const ONBOARDING_TASK_SORTABLE_FIELDS = [
  'title',
  'dueDate',
  'status',
  'category',
  'sortOrder',
  'createdAt',
] as const;
export type OnboardingTaskSortableField =
  (typeof ONBOARDING_TASK_SORTABLE_FIELDS)[number];

// ==========================================
// New Hires
// ==========================================

export class GetNewHiresQueryDto {
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
    description: 'Search by new hire name, email or position',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: NewHireOnboardingStatusFilter,
    required: false,
    default: NewHireOnboardingStatusFilter.ALL,
    description:
      'Filters on the derived status, so it is applied after the checklist tallies are joined.',
  })
  @IsOptional()
  @IsEnum(NewHireOnboardingStatusFilter)
  status?: NewHireOnboardingStatusFilter = NewHireOnboardingStatusFilter.ALL;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Joining on or after this date',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Joining on or before this date',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({
    enum: NEW_HIRE_SORTABLE_FIELDS,
    required: false,
    default: 'joiningDate',
  })
  @IsOptional()
  @IsIn(NEW_HIRE_SORTABLE_FIELDS)
  sortBy?: NewHireSortableField = 'joiningDate';

  @ApiProperty({ enum: ['ASC', 'DESC'], required: false, default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class CreateNewHireDto {
  @ApiProperty({ example: 'Ayesha' })
  @IsString()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Khan' })
  @IsString()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ example: 'ayesha.khan@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiProperty({
    example: 'Frontend Developer',
    description: 'The Position column',
  })
  @IsString()
  @MaxLength(150)
  position: string;

  @ApiProperty()
  @IsUUID()
  departmentId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({ format: 'date', example: '2026-09-12' })
  @IsDateString()
  joiningDate: string;

  @ApiProperty({
    required: false,
    description: 'Assigned buddy or onboarding owner',
  })
  @IsOptional()
  @IsUUID()
  reportingManagerEmployeeId?: string;

  @ApiProperty({
    required: false,
    description:
      'Existing employee record this onboarding belongs to. Set automatically when the hire is converted to an employee.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({
    required: false,
    description:
      'Candidate this hire came from. Set automatically when a candidate is moved to HIRED.',
  })
  @IsOptional()
  @IsUUID()
  candidateId?: string;

  @ApiProperty({
    required: false,
    default: true,
    description:
      'Seed the default onboarding checklist for this hire. Turn off to attach a custom list yourself.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  seedDefaultTasks?: boolean = true;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

export class UpdateNewHireDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  position?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  joiningDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  reportingManagerEmployeeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

export class GetOnboardingProgressQueryDto {
  @ApiProperty({
    required: false,
    description: 'Restrict the donut to one department.',
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class ExportNewHiresQueryDto extends GetNewHiresQueryDto {}

// ==========================================
// Onboarding tasks (the checklist)
// ==========================================

export class GetOnboardingTasksQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 25;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: OnboardingTaskStatusFilter,
    required: false,
    default: OnboardingTaskStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(OnboardingTaskStatusFilter)
  status?: OnboardingTaskStatusFilter = OnboardingTaskStatusFilter.ALL;

  @ApiProperty({ enum: OnboardingTaskCategory, required: false })
  @IsOptional()
  @IsEnum(OnboardingTaskCategory)
  category?: OnboardingTaskCategory;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  newHireId?: string;

  @ApiProperty({
    enum: ONBOARDING_TASK_SORTABLE_FIELDS,
    required: false,
    default: 'dueDate',
  })
  @IsOptional()
  @IsIn(ONBOARDING_TASK_SORTABLE_FIELDS)
  sortBy?: OnboardingTaskSortableField = 'dueDate';

  @ApiProperty({ enum: ['ASC', 'DESC'], required: false, default: 'ASC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'ASC';
}

export class CreateOnboardingTaskDto {
  @ApiProperty({ example: 'Setup laptop & software' })
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty({ description: 'The new hire this task belongs to' })
  @IsUUID()
  newHireId: string;

  @ApiProperty({
    enum: OnboardingTaskCategory,
    required: false,
    default: OnboardingTaskCategory.OTHER,
  })
  @IsOptional()
  @IsEnum(OnboardingTaskCategory)
  category?: OnboardingTaskCategory = OnboardingTaskCategory.OTHER;

  @ApiProperty({ required: false, format: 'date', example: '2026-09-12' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiProperty({
    required: false,
    description: 'Employee responsible for the task',
  })
  @IsOptional()
  @IsUUID()
  assignedToEmployeeId?: string;

  @ApiProperty({
    required: false,
    default: 0,
    description:
      'Explicit checklist position; ties break on dueDate then title.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number = 0;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateOnboardingTaskDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiProperty({ enum: OnboardingTaskCategory, required: false })
  @IsOptional()
  @IsEnum(OnboardingTaskCategory)
  category?: OnboardingTaskCategory;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  assignedToEmployeeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class SetOnboardingTaskStatusDto {
  @ApiProperty({
    description:
      'Checklist checkbox. true completes the task (stamping completedAt), false reopens it and clears the stamp.',
  })
  @Type(() => Boolean)
  @IsBoolean()
  completed: boolean;
}

export class GetUpcomingOnboardingTasksQueryDto {
  @ApiProperty({ required: false, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 5;

  @ApiProperty({
    required: false,
    default: 30,
    description:
      'How many days ahead the Upcoming Tasks panel looks. Overdue tasks are always included regardless of this window.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  withinDays?: number = 30;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  newHireId?: string;
}

// ==========================================
// Microservice message envelopes
// ==========================================

export class TenantNewHireIdDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  newHireId: string;
}

export class TenantOnboardingTaskIdDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  taskId: string;
}

export class GetNewHiresMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetNewHiresQueryDto })
  @ValidateNested()
  @Type(() => GetNewHiresQueryDto)
  @IsDefined()
  query: GetNewHiresQueryDto;
}

export class CreateNewHireMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: CreateNewHireDto })
  @ValidateNested()
  @Type(() => CreateNewHireDto)
  @IsDefined()
  dto: CreateNewHireDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class UpdateNewHireMessageDto extends TenantNewHireIdDto {
  @ApiProperty({ type: UpdateNewHireDto })
  @ValidateNested()
  @Type(() => UpdateNewHireDto)
  @IsDefined()
  dto: UpdateNewHireDto;
}

export class ExportNewHiresMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportNewHiresQueryDto })
  @ValidateNested()
  @Type(() => ExportNewHiresQueryDto)
  @IsDefined()
  query: ExportNewHiresQueryDto;
}

export class GetOnboardingProgressMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetOnboardingProgressQueryDto })
  @ValidateNested()
  @Type(() => GetOnboardingProgressQueryDto)
  @IsDefined()
  query: GetOnboardingProgressQueryDto;
}

export class GetOnboardingTasksMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetOnboardingTasksQueryDto })
  @ValidateNested()
  @Type(() => GetOnboardingTasksQueryDto)
  @IsDefined()
  query: GetOnboardingTasksQueryDto;
}

export class CreateOnboardingTaskMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: CreateOnboardingTaskDto })
  @ValidateNested()
  @Type(() => CreateOnboardingTaskDto)
  @IsDefined()
  dto: CreateOnboardingTaskDto;
}

export class UpdateOnboardingTaskMessageDto extends TenantOnboardingTaskIdDto {
  @ApiProperty({ type: UpdateOnboardingTaskDto })
  @ValidateNested()
  @Type(() => UpdateOnboardingTaskDto)
  @IsDefined()
  dto: UpdateOnboardingTaskDto;
}

export class SetOnboardingTaskStatusMessageDto extends TenantOnboardingTaskIdDto {
  @ApiProperty({ type: SetOnboardingTaskStatusDto })
  @ValidateNested()
  @Type(() => SetOnboardingTaskStatusDto)
  @IsDefined()
  dto: SetOnboardingTaskStatusDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class GetUpcomingOnboardingTasksMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetUpcomingOnboardingTasksQueryDto })
  @ValidateNested()
  @Type(() => GetUpcomingOnboardingTasksQueryDto)
  @IsDefined()
  query: GetUpcomingOnboardingTasksQueryDto;
}
