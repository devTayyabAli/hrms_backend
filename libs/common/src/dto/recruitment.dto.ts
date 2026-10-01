import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEmail,
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

// ==========================================
// Enums
// ==========================================

/**
 * Lifecycle of a job requisition.
 *
 * DRAFT is kept distinct from ACTIVE so the "Total Open Positions" KPI counts
 * only postings a candidate could actually apply to — a half-written
 * requisition is not an open position. ON_HOLD is not CLOSED for the same
 * reason in reverse: the seat is still budgeted and the pipeline intact, the
 * posting is just paused, so collapsing the two would lose that distinction.
 */
export enum JobOpeningStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  ON_HOLD = 'ON_HOLD',
  CLOSED = 'CLOSED',
}

/** Adds ALL so the Job Openings filter row can express "no status filter". */
export enum JobOpeningStatusFilter {
  ALL = 'ALL',
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  ON_HOLD = 'ON_HOLD',
  CLOSED = 'CLOSED',
}

export enum EmploymentType {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  CONTRACT = 'CONTRACT',
  INTERNSHIP = 'INTERNSHIP',
  TEMPORARY = 'TEMPORARY',
}

/**
 * Where a candidate came from — backs the Application Sources donut.
 *
 * Deliberately a closed enum rather than free text: the donut exists to
 * compare channel effectiveness, and "LinkedIn" / "linkedin" / "Linked In"
 * arriving as three separate slices would make it useless.
 */
export enum CandidateSource {
  LINKEDIN = 'LINKEDIN',
  COMPANY_WEBSITE = 'COMPANY_WEBSITE',
  JOB_PORTAL = 'JOB_PORTAL',
  REFERRAL = 'REFERRAL',
  OTHER = 'OTHER',
}

/**
 * Candidate's position in the hiring funnel — the Candidate Pipeline columns.
 *
 * REJECTED is a terminal side-exit rather than a funnel stage: someone
 * rejected at screening should leave the Screening column without being
 * counted as having reached Interview. `furthestStageRank` on the Candidate
 * model is what preserves how far they actually got, so the funnel chart
 * stays honest after a rejection.
 */
export enum CandidateStage {
  APPLIED = 'APPLIED',
  SCREENING = 'SCREENING',
  INTERVIEW = 'INTERVIEW',
  OFFER = 'OFFER',
  HIRED = 'HIRED',
  REJECTED = 'REJECTED',
}

/** Adds ALL so the candidate table can express "no stage filter". */
export enum CandidateStageFilter {
  ALL = 'ALL',
  APPLIED = 'APPLIED',
  SCREENING = 'SCREENING',
  INTERVIEW = 'INTERVIEW',
  OFFER = 'OFFER',
  HIRED = 'HIRED',
  REJECTED = 'REJECTED',
}

/**
 * The advancing stages, in funnel order. REJECTED is absent on purpose — it
 * is not a rung on this ladder, so it has no rank and never advances
 * `furthestStageRank`.
 */
export const CANDIDATE_FUNNEL_STAGES = [
  CandidateStage.APPLIED,
  CandidateStage.SCREENING,
  CandidateStage.INTERVIEW,
  CandidateStage.OFFER,
  CandidateStage.HIRED,
] as const;

/** Rank of a funnel stage, or -1 for REJECTED. */
export const candidateStageRank = (stage: CandidateStage): number =>
  (CANDIDATE_FUNNEL_STAGES as readonly CandidateStage[]).indexOf(stage);

/**
 * Stages counted by the "Shortlisted Candidates" KPI: past the initial
 * application and still live. HIRED is excluded because it has its own card
 * and double-counting would make the cards sum to more than the pipeline
 * holds; REJECTED because a shortlist of rejected people is not a shortlist.
 */
export const SHORTLISTED_STAGES = [
  CandidateStage.SCREENING,
  CandidateStage.INTERVIEW,
  CandidateStage.OFFER,
] as const;

export enum InterviewMode {
  ONLINE = 'ONLINE',
  IN_OFFICE = 'IN_OFFICE',
  PHONE = 'PHONE',
}

export enum InterviewStatus {
  SCHEDULED = 'SCHEDULED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  NO_SHOW = 'NO_SHOW',
}

/** The interviewer's recommendation, recorded alongside their feedback. */
export enum InterviewOutcome {
  PENDING = 'PENDING',
  ADVANCE = 'ADVANCE',
  REJECT = 'REJECT',
  HOLD = 'HOLD',
}

/** Entry types in the Recent Activities feed. */
export enum RecruitmentActivityType {
  APPLICATION_RECEIVED = 'APPLICATION_RECEIVED',
  STAGE_CHANGED = 'STAGE_CHANGED',
  INTERVIEW_SCHEDULED = 'INTERVIEW_SCHEDULED',
  INTERVIEW_RESCHEDULED = 'INTERVIEW_RESCHEDULED',
  INTERVIEW_COMPLETED = 'INTERVIEW_COMPLETED',
  INTERVIEW_CANCELLED = 'INTERVIEW_CANCELLED',
  OFFER_EXTENDED = 'OFFER_EXTENDED',
  OFFER_ACCEPTED = 'OFFER_ACCEPTED',
  CANDIDATE_REJECTED = 'CANDIDATE_REJECTED',
  JOB_OPENING_CREATED = 'JOB_OPENING_CREATED',
  JOB_OPENING_STATUS_CHANGED = 'JOB_OPENING_STATUS_CHANGED',
}

export const JOB_OPENING_SORTABLE_FIELDS = [
  'title',
  'status',
  'postedOn',
  'closingDate',
  'department',
  'createdAt',
] as const;
export type JobOpeningSortableField =
  (typeof JOB_OPENING_SORTABLE_FIELDS)[number];

export const CANDIDATE_SORTABLE_FIELDS = [
  'candidateName',
  'stage',
  'source',
  'appliedAt',
  'rating',
  'createdAt',
] as const;
export type CandidateSortableField = (typeof CANDIDATE_SORTABLE_FIELDS)[number];

// ==========================================
// Job Openings
// ==========================================

export class GetJobOpeningsQueryDto {
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
    description: 'Search by job title, location or requisition code',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: JobOpeningStatusFilter,
    required: false,
    default: JobOpeningStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(JobOpeningStatusFilter)
  status?: JobOpeningStatusFilter = JobOpeningStatusFilter.ALL;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ enum: EmploymentType, required: false })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @ApiProperty({
    enum: JOB_OPENING_SORTABLE_FIELDS,
    required: false,
    default: 'postedOn',
  })
  @IsOptional()
  @IsIn(JOB_OPENING_SORTABLE_FIELDS)
  sortBy?: JobOpeningSortableField = 'postedOn';

  @ApiProperty({ enum: ['ASC', 'DESC'], required: false, default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class CreateJobOpeningDto {
  @ApiProperty({ example: 'Frontend Developer' })
  @IsString()
  @MaxLength(150)
  title: string;

  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  departmentId: string;

  @ApiProperty({
    required: false,
    description: 'Optional designation this requisition hires into',
  })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({ enum: EmploymentType, default: EmploymentType.FULL_TIME })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType = EmploymentType.FULL_TIME;

  @ApiProperty({ required: false, example: 'Karachi, PK (Hybrid)' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string;

  @ApiProperty({
    required: false,
    default: 1,
    description: 'Number of seats this requisition is hiring for.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  openings?: number = 1;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiProperty({ required: false, isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @ApiProperty({ required: false, example: 120000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryMin?: number;

  @ApiProperty({ required: false, example: 180000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryMax?: number;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Defaults to today when omitted — the Posted On column.',
  })
  @IsOptional()
  @IsDateString()
  postedOn?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  closingDate?: string;

  @ApiProperty({
    enum: JobOpeningStatus,
    required: false,
    default: JobOpeningStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(JobOpeningStatus)
  status?: JobOpeningStatus = JobOpeningStatus.ACTIVE;

  @ApiProperty({
    required: false,
    description: 'Employee who owns this requisition',
  })
  @IsOptional()
  @IsUUID()
  hiringManagerEmployeeId?: string;
}

export class UpdateJobOpeningDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({ enum: EmploymentType, required: false })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  openings?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiProperty({ required: false, isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryMin?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryMax?: number;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  postedOn?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  closingDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  hiringManagerEmployeeId?: string;
}

export class UpdateJobOpeningStatusDto {
  @ApiProperty({ enum: JobOpeningStatus })
  @IsEnum(JobOpeningStatus)
  status: JobOpeningStatus;
}

export class ExportJobOpeningsQueryDto extends GetJobOpeningsQueryDto {}

// ==========================================
// Candidates
// ==========================================

export class GetCandidatesQueryDto {
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
    description: 'Search by candidate name or email',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    enum: CandidateStageFilter,
    required: false,
    default: CandidateStageFilter.ALL,
  })
  @IsOptional()
  @IsEnum(CandidateStageFilter)
  stage?: CandidateStageFilter = CandidateStageFilter.ALL;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  jobOpeningId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ enum: CandidateSource, required: false })
  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Applied on or after this date',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Applied on or before this date',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({
    enum: CANDIDATE_SORTABLE_FIELDS,
    required: false,
    default: 'appliedAt',
  })
  @IsOptional()
  @IsIn(CANDIDATE_SORTABLE_FIELDS)
  sortBy?: CandidateSortableField = 'appliedAt';

  @ApiProperty({ enum: ['ASC', 'DESC'], required: false, default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class CreateCandidateDto {
  @ApiProperty({ example: 'Sarah' })
  @IsString()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Khan' })
  @IsString()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ example: 'sarah.khan@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ required: false, example: '+92 300 1234567' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiProperty({ description: 'The requisition applied to' })
  @IsUUID()
  jobOpeningId: string;

  @ApiProperty({ enum: CandidateSource, default: CandidateSource.OTHER })
  @IsEnum(CandidateSource)
  source: CandidateSource;

  @ApiProperty({
    enum: CandidateStage,
    required: false,
    default: CandidateStage.APPLIED,
    description: 'Entry stage. Defaults to APPLIED for a fresh application.',
  })
  @IsOptional()
  @IsEnum(CandidateStage)
  stage?: CandidateStage = CandidateStage.APPLIED;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  resumeUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  linkedInUrl?: string;

  @ApiProperty({ required: false, example: 150000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  expectedSalary?: number;

  @ApiProperty({ required: false, example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(50)
  yearsOfExperience?: number;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Defaults to today when omitted.',
  })
  @IsOptional()
  @IsDateString()
  appliedAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @ApiProperty({
    required: false,
    description: 'Referring employee — expected when source is REFERRAL.',
  })
  @IsOptional()
  @IsUUID()
  referredByEmployeeId?: string;
}

export class UpdateCandidateDto {
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

  @ApiProperty({ enum: CandidateSource, required: false })
  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  resumeUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  linkedInUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  expectedSalary?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(50)
  yearsOfExperience?: number;

  @ApiProperty({
    required: false,
    example: 4.5,
    description: 'Evaluation score out of 5',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

export class MoveCandidateStageDto {
  @ApiProperty({
    enum: CandidateStage,
    description:
      'Target column in the Candidate Pipeline. Moving to HIRED is what creates the matching onboarding New Hire.',
  })
  @IsEnum(CandidateStage)
  stage: CandidateStage;

  @ApiProperty({
    required: false,
    description: 'Reason, recorded on the activity feed entry',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class GetCandidatePipelineQueryDto {
  @ApiProperty({
    required: false,
    default: 5,
    description:
      'Cards rendered per pipeline column. The column header count is always the full stage total, independent of this.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limitPerStage?: number = 5;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  jobOpeningId?: string;
}

export class ExportCandidatesQueryDto extends GetCandidatesQueryDto {}

// ==========================================
// Interviews
// ==========================================

export class GetInterviewsQueryDto {
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  candidateId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  jobOpeningId?: string;

  @ApiProperty({ enum: InterviewStatus, required: false })
  @IsOptional()
  @IsEnum(InterviewStatus)
  status?: InterviewStatus;

  @ApiProperty({ enum: InterviewMode, required: false })
  @IsOptional()
  @IsEnum(InterviewMode)
  mode?: InterviewMode;

  @ApiProperty({
    required: false,
    description: 'Scheduled at or after this instant',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    required: false,
    description: 'Scheduled at or before this instant',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ScheduleInterviewDto {
  @ApiProperty()
  @IsUUID()
  candidateId: string;

  @ApiProperty({
    example: '2026-09-12T10:00:00.000Z',
    description: 'Start instant, stored with timezone.',
  })
  @IsDateString()
  scheduledAt: string;

  @ApiProperty({
    default: 60,
    description: 'Length in minutes — drives the end time shown on the card.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(600)
  durationMinutes?: number = 60;

  @ApiProperty({ enum: InterviewMode, default: InterviewMode.ONLINE })
  @IsEnum(InterviewMode)
  mode: InterviewMode;

  @ApiProperty({ required: false, default: 1, description: 'Interview round' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  round?: number = 1;

  @ApiProperty({ required: false, description: 'Interviewing employee' })
  @IsOptional()
  @IsUUID()
  interviewerEmployeeId?: string;

  @ApiProperty({
    required: false,
    description: 'Meeting URL — expected when mode is ONLINE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  meetingLink?: string;

  @ApiProperty({
    required: false,
    description: 'Room or address — expected when mode is IN_OFFICE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class RescheduleInterviewDto {
  @ApiProperty({ example: '2026-09-13T14:00:00.000Z' })
  @IsDateString()
  scheduledAt: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(600)
  durationMinutes?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class UpdateInterviewDto {
  @ApiProperty({ enum: InterviewMode, required: false })
  @IsOptional()
  @IsEnum(InterviewMode)
  mode?: InterviewMode;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  interviewerEmployeeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  meetingLink?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class SubmitInterviewFeedbackDto {
  @ApiProperty({ enum: InterviewOutcome })
  @IsEnum(InterviewOutcome)
  outcome: InterviewOutcome;

  @ApiProperty({
    required: false,
    example: 4.5,
    description: 'Score out of 5',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  feedback?: string;
}

export class CancelInterviewDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class GetUpcomingInterviewsQueryDto {
  @ApiProperty({ required: false, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 5;

  @ApiProperty({
    required: false,
    default: 14,
    description: 'How many days ahead the Upcoming Interviews panel looks.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  withinDays?: number = 14;
}

// ==========================================
// Overview widgets
// ==========================================

export class GetRecruitmentActivityQueryDto {
  @ApiProperty({ required: false, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiProperty({ enum: RecruitmentActivityType, required: false })
  @IsOptional()
  @IsEnum(RecruitmentActivityType)
  type?: RecruitmentActivityType;
}

export class GetApplicationSourcesQueryDto {
  @ApiProperty({
    required: false,
    description: 'Restrict the donut to a single requisition.',
  })
  @IsOptional()
  @IsUUID()
  jobOpeningId?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class GetHiringGoalQueryDto {
  @ApiProperty({
    required: false,
    default: false,
    description:
      'When true the goal window is the current quarter instead of the current month.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  quarterly?: boolean = false;
}

// ==========================================
// Microservice message envelopes
// ==========================================

export class TenantJobOpeningIdDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  jobOpeningId: string;
}

export class TenantCandidateIdDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  candidateId: string;
}

export class TenantInterviewIdDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  interviewId: string;
}

export class GetJobOpeningsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetJobOpeningsQueryDto })
  @ValidateNested()
  @Type(() => GetJobOpeningsQueryDto)
  @IsDefined()
  query: GetJobOpeningsQueryDto;
}

export class CreateJobOpeningMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: CreateJobOpeningDto })
  @ValidateNested()
  @Type(() => CreateJobOpeningDto)
  @IsDefined()
  dto: CreateJobOpeningDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class UpdateJobOpeningMessageDto extends TenantJobOpeningIdDto {
  @ApiProperty({ type: UpdateJobOpeningDto })
  @ValidateNested()
  @Type(() => UpdateJobOpeningDto)
  @IsDefined()
  dto: UpdateJobOpeningDto;
}

export class UpdateJobOpeningStatusMessageDto extends TenantJobOpeningIdDto {
  @ApiProperty({ type: UpdateJobOpeningStatusDto })
  @ValidateNested()
  @Type(() => UpdateJobOpeningStatusDto)
  @IsDefined()
  dto: UpdateJobOpeningStatusDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class ExportJobOpeningsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportJobOpeningsQueryDto })
  @ValidateNested()
  @Type(() => ExportJobOpeningsQueryDto)
  @IsDefined()
  query: ExportJobOpeningsQueryDto;
}

export class GetCandidatesMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetCandidatesQueryDto })
  @ValidateNested()
  @Type(() => GetCandidatesQueryDto)
  @IsDefined()
  query: GetCandidatesQueryDto;
}

export class CreateCandidateMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: CreateCandidateDto })
  @ValidateNested()
  @Type(() => CreateCandidateDto)
  @IsDefined()
  dto: CreateCandidateDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class UpdateCandidateMessageDto extends TenantCandidateIdDto {
  @ApiProperty({ type: UpdateCandidateDto })
  @ValidateNested()
  @Type(() => UpdateCandidateDto)
  @IsDefined()
  dto: UpdateCandidateDto;
}

export class MoveCandidateStageMessageDto extends TenantCandidateIdDto {
  @ApiProperty({ type: MoveCandidateStageDto })
  @ValidateNested()
  @Type(() => MoveCandidateStageDto)
  @IsDefined()
  dto: MoveCandidateStageDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class GetCandidatePipelineMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetCandidatePipelineQueryDto })
  @ValidateNested()
  @Type(() => GetCandidatePipelineQueryDto)
  @IsDefined()
  query: GetCandidatePipelineQueryDto;
}

export class ExportCandidatesMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportCandidatesQueryDto })
  @ValidateNested()
  @Type(() => ExportCandidatesQueryDto)
  @IsDefined()
  query: ExportCandidatesQueryDto;
}

export class GetInterviewsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetInterviewsQueryDto })
  @ValidateNested()
  @Type(() => GetInterviewsQueryDto)
  @IsDefined()
  query: GetInterviewsQueryDto;
}

export class ScheduleInterviewMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ScheduleInterviewDto })
  @ValidateNested()
  @Type(() => ScheduleInterviewDto)
  @IsDefined()
  dto: ScheduleInterviewDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class UpdateInterviewMessageDto extends TenantInterviewIdDto {
  @ApiProperty({ type: UpdateInterviewDto })
  @ValidateNested()
  @Type(() => UpdateInterviewDto)
  @IsDefined()
  dto: UpdateInterviewDto;
}

export class RescheduleInterviewMessageDto extends TenantInterviewIdDto {
  @ApiProperty({ type: RescheduleInterviewDto })
  @ValidateNested()
  @Type(() => RescheduleInterviewDto)
  @IsDefined()
  dto: RescheduleInterviewDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class SubmitInterviewFeedbackMessageDto extends TenantInterviewIdDto {
  @ApiProperty({ type: SubmitInterviewFeedbackDto })
  @ValidateNested()
  @Type(() => SubmitInterviewFeedbackDto)
  @IsDefined()
  dto: SubmitInterviewFeedbackDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class CancelInterviewMessageDto extends TenantInterviewIdDto {
  @ApiProperty({ type: CancelInterviewDto })
  @ValidateNested()
  @Type(() => CancelInterviewDto)
  @IsDefined()
  dto: CancelInterviewDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class GetUpcomingInterviewsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetUpcomingInterviewsQueryDto })
  @ValidateNested()
  @Type(() => GetUpcomingInterviewsQueryDto)
  @IsDefined()
  query: GetUpcomingInterviewsQueryDto;
}

export class GetRecruitmentActivityMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetRecruitmentActivityQueryDto })
  @ValidateNested()
  @Type(() => GetRecruitmentActivityQueryDto)
  @IsDefined()
  query: GetRecruitmentActivityQueryDto;
}

export class GetApplicationSourcesMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetApplicationSourcesQueryDto })
  @ValidateNested()
  @Type(() => GetApplicationSourcesQueryDto)
  @IsDefined()
  query: GetApplicationSourcesQueryDto;
}

export class GetHiringGoalMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetHiringGoalQueryDto })
  @ValidateNested()
  @Type(() => GetHiringGoalQueryDto)
  @IsDefined()
  query: GetHiringGoalQueryDto;
}
