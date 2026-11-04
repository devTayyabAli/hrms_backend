import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Learning: the courses an organization offers and the materials in them.
 * (Assigning courses to people comes next.)
 */

export const TRAINING_MAX_MATERIALS = 30;
export const TRAINING_MAX_TAGS = 20;
export const TRAINING_TAG_MAX = 40;
export const TRAINING_MAX_MINUTES = 10080;
export const TRAINING_MAX_DUE_DAYS = 365;
/** Files for training are uploaded to the file store under this category. */
export const TRAINING_FILE_CATEGORY = 'training';

export enum TrainingCourseStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

/** Adds ALL so the status tabs can express "no filter". */
export enum TrainingCourseStatusFilter {
  ALL = 'ALL',
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

export enum TrainingMaterialKind {
  /** A PDF, document or other file uploaded to the file store. */
  FILE = 'FILE',
  VIDEO_LINK = 'VIDEO_LINK',
  /** Any other external resource. */
  LINK = 'LINK',
}

export const TRAINING_COURSE_SORTABLE_FIELDS = ['title', 'createdAt', 'status'] as const;
export type TrainingCourseSortField = (typeof TRAINING_COURSE_SORTABLE_FIELDS)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** An empty string from a cleared form field means "nothing". */
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

// ==========================================
// Requests: courses
// ==========================================

export class GetTrainingCoursesQueryDto {
  @ApiProperty({ required: false, description: 'Matches the title, description or category' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ enum: TrainingCourseStatusFilter, required: false, default: TrainingCourseStatusFilter.ALL })
  @IsOptional()
  @IsEnum(TrainingCourseStatusFilter)
  status?: TrainingCourseStatusFilter = TrainingCourseStatusFilter.ALL;

  @ApiProperty({ required: false, description: 'Exact category (not case-sensitive)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiProperty({ required: false, description: 'true: only courses that are mandatory by default. false: only the optional ones' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  mandatory?: boolean;

  @ApiProperty({ required: false, enum: TRAINING_COURSE_SORTABLE_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(TRAINING_COURSE_SORTABLE_FIELDS)
  sortBy?: TrainingCourseSortField = 'createdAt';

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

export class CreateTrainingCourseDto {
  @ApiProperty({ example: 'Workplace Safety Orientation', description: 'Unique across the organization (not case-sensitive)' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Course title is required.' })
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiProperty({ required: false, example: 'Compliance' })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @ApiProperty({ required: false, type: [String], description: `At most ${TRAINING_MAX_TAGS} tags of ${TRAINING_TAG_MAX} characters` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TRAINING_MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(TRAINING_TAG_MAX, { each: true })
  tags?: string[] | null;

  @ApiProperty({ required: false, default: false, description: 'New assignments of this course start as mandatory' })
  @IsOptional()
  @IsBoolean()
  mandatoryByDefault?: boolean;

  @ApiProperty({ required: false, example: 45, minimum: 1, maximum: TRAINING_MAX_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRAINING_MAX_MINUTES)
  estimatedMinutes?: number | null;

  @ApiProperty({ required: false, default: false, description: 'Completing needs every required material to be opened' })
  @IsOptional()
  @IsBoolean()
  requireAllMaterials?: boolean;

  @ApiProperty({ required: false, example: 14, minimum: 1, maximum: TRAINING_MAX_DUE_DAYS, description: 'Assignments without a due date are due this many days after they are assigned' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRAINING_MAX_DUE_DAYS)
  defaultDueDays?: number | null;

  @ApiProperty({ required: false, default: false, description: 'Assign to every new joiner' })
  @IsOptional()
  @IsBoolean()
  autoAssignOnJoin?: boolean;
}

/** Everything optional; null (or an empty string) clears the optional ones. */
export class UpdateTrainingCourseDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Course title is required.' })
  @MaxLength(200)
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @ApiProperty({ required: false, type: [String], description: 'Replaces the whole list' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TRAINING_MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(TRAINING_TAG_MAX, { each: true })
  tags?: string[] | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  mandatoryByDefault?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRAINING_MAX_MINUTES)
  estimatedMinutes?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  requireAllMaterials?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRAINING_MAX_DUE_DAYS)
  defaultDueDays?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  autoAssignOnJoin?: boolean;
}

// ==========================================
// Requests: materials
// ==========================================

export class AddTrainingMaterialDto {
  @ApiProperty({ enum: TrainingMaterialKind })
  @IsEnum(TrainingMaterialKind)
  kind: TrainingMaterialKind;

  @ApiProperty({ example: 'Safety handbook (PDF)' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Material title is required.' })
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false, example: 'https://www.youtube.com/watch?v=abc', description: 'For VIDEO_LINK and LINK: an http or https address' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  url?: string;

  @ApiProperty({ required: false, description: 'For FILE: the id from POST /files/upload (category "training"), uploaded by you' })
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @ApiProperty({ required: false, default: true, description: 'Counts towards "requires all materials"' })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

/** The kind and the file cannot change: remove the material and add another. */
export class UpdateTrainingMaterialDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Material title is required.' })
  @MaxLength(200)
  title?: string;

  @ApiProperty({ required: false, description: 'Only for VIDEO_LINK and LINK' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

export class SetTrainingMaterialOrderDto {
  @ApiProperty({ type: [String], description: 'Every material of the course, in the order they should show' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TRAINING_MAX_MATERIALS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  materialIds: string[];
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

/** Who is acting — recorded in the audit log. */
export class LearningActorDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;
}

export class GetTrainingCoursesMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetTrainingCoursesQueryDto })
  @ValidateNested()
  @Type(() => GetTrainingCoursesQueryDto)
  @IsDefined()
  query: GetTrainingCoursesQueryDto;
}

export class TrainingTenantMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;
}

export class TrainingCourseIdMessageDto extends LearningActorDto {
  @ApiProperty()
  @IsUUID()
  courseId: string;
}

export class CreateTrainingCourseMessageDto extends LearningActorDto {
  @ApiProperty({ type: CreateTrainingCourseDto })
  @ValidateNested()
  @Type(() => CreateTrainingCourseDto)
  @IsDefined()
  dto: CreateTrainingCourseDto;
}

export class UpdateTrainingCourseMessageDto extends TrainingCourseIdMessageDto {
  @ApiProperty({ type: UpdateTrainingCourseDto })
  @ValidateNested()
  @Type(() => UpdateTrainingCourseDto)
  @IsDefined()
  dto: UpdateTrainingCourseDto;
}

/** The file's own facts, as the gateway read them from the file store. */
export class TrainingFileDto {
  @ApiProperty()
  @IsUUID()
  fileId: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  fileName: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sizeBytes: number;
}

export class AddTrainingMaterialMessageDto extends TrainingCourseIdMessageDto {
  @ApiProperty({ type: AddTrainingMaterialDto })
  @ValidateNested()
  @Type(() => AddTrainingMaterialDto)
  @IsDefined()
  dto: AddTrainingMaterialDto;

  @ApiProperty({ required: false, type: TrainingFileDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TrainingFileDto)
  file?: TrainingFileDto;
}

export class TrainingMaterialIdMessageDto extends TrainingCourseIdMessageDto {
  @ApiProperty()
  @IsUUID()
  materialId: string;
}

export class UpdateTrainingMaterialMessageDto extends TrainingMaterialIdMessageDto {
  @ApiProperty({ type: UpdateTrainingMaterialDto })
  @ValidateNested()
  @Type(() => UpdateTrainingMaterialDto)
  @IsDefined()
  dto: UpdateTrainingMaterialDto;
}

export class SetTrainingMaterialOrderMessageDto extends TrainingCourseIdMessageDto {
  @ApiProperty({ type: SetTrainingMaterialOrderDto })
  @ValidateNested()
  @Type(() => SetTrainingMaterialOrderDto)
  @IsDefined()
  dto: SetTrainingMaterialOrderDto;
}
