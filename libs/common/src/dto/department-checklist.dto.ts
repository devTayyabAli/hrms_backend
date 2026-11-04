import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { OnboardingTaskCategory } from './onboarding.dto';

/**
 * Responsibilities a department adds to the standard onboarding checklist and
 * to the offboarding clearance. Nothing here is specific to an industry: each
 * organization says, per department, what has to happen and who owns it.
 */
export enum ChecklistKind {
  ONBOARDING = 'ONBOARDING',
  OFFBOARDING = 'OFFBOARDING',
}

export enum ChecklistOwnerKind {
  /** The head of the person's department. */
  DEPARTMENT_HEAD = 'DEPARTMENT_HEAD',
  /** The person's reporting manager. */
  REPORTING_MANAGER = 'REPORTING_MANAGER',
  /** One named person. */
  EMPLOYEE = 'EMPLOYEE',
  /** Anyone holding a permission (offboarding clearance only). */
  PERMISSION = 'PERMISSION',
  /** Nobody in particular: an onboarding task anyone in HR can pick up. */
  NONE = 'NONE',
}

/** Most items one department can add of each kind. */
export const MAX_DEPARTMENT_CHECKLIST_ITEMS = 20;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class CreateDepartmentChecklistItemDto {
  @ApiProperty({ enum: ChecklistKind })
  @IsEnum(ChecklistKind)
  kind: ChecklistKind;

  @ApiProperty({ required: false, description: 'The department it applies to, and its sub-departments. Leave out for every department' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ example: 'Revoke repository access', maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: ChecklistOwnerKind, description: 'Who owns it. Onboarding: not PERMISSION. Offboarding: not NONE' })
  @IsEnum(ChecklistOwnerKind)
  ownerKind: ChecklistOwnerKind;

  @ApiProperty({ required: false, description: 'EMPLOYEE only' })
  @IsOptional()
  @IsUUID()
  ownerEmployeeId?: string;

  @ApiProperty({ required: false, example: 'assets.manage', description: 'PERMISSION only: anyone holding it can clear this' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$/, { message: 'Use a permission such as assets.manage.' })
  ownerPermission?: string;

  @ApiProperty({ enum: OnboardingTaskCategory, required: false, default: OnboardingTaskCategory.OTHER, description: 'Onboarding only' })
  @IsOptional()
  @IsEnum(OnboardingTaskCategory)
  category?: OnboardingTaskCategory;

  @ApiProperty({ required: false, default: 0, minimum: -30, maximum: 365, description: 'Onboarding only: days from the joining date it is due. Negative is before' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-30)
  @Max(365)
  dueInDays?: number;
}

export class UpdateDepartmentChecklistItemDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  @ApiProperty({ required: false, maxLength: 160 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({ enum: ChecklistOwnerKind, required: false })
  @IsOptional()
  @IsEnum(ChecklistOwnerKind)
  ownerKind?: ChecklistOwnerKind;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  ownerEmployeeId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$/, { message: 'Use a permission such as assets.manage.' })
  ownerPermission?: string | null;

  @ApiProperty({ enum: OnboardingTaskCategory, required: false })
  @IsOptional()
  @IsEnum(OnboardingTaskCategory)
  category?: OnboardingTaskCategory;

  @ApiProperty({ required: false, minimum: -30, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-30)
  @Max(365)
  dueInDays?: number;

  @ApiProperty({ required: false, description: 'false stops it being added to new hires and new offboardings. Ones already made are unchanged' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class GetDepartmentChecklistQueryDto {
  @ApiProperty({ enum: ChecklistKind, required: false })
  @IsOptional()
  @IsEnum(ChecklistKind)
  kind?: ChecklistKind;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}
