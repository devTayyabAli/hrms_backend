import {
  IsArray,
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Employment lifecycle state. Drives the Employees screen KPI cards
 * (Total / Active / On Leave / Resigned) and the Status column chip, and is
 * what attendance generation skips over — a RESIGNED employee is never
 * counted as absent.
 */
export enum EmployeeStatus {
  ACTIVE = 'ACTIVE',
  ON_LEAVE = 'ON_LEAVE',
  RESIGNED = 'RESIGNED',
  /** Retained but not currently employed (suspended, sabbatical, contract gap). */
  INACTIVE = 'INACTIVE',
}

/** Adds ALL so the table filter can express "no status filter". */
export enum EmployeeStatusFilter {
  ALL = 'ALL',
  ACTIVE = 'ACTIVE',
  ON_LEAVE = 'ON_LEAVE',
  RESIGNED = 'RESIGNED',
  INACTIVE = 'INACTIVE',
}

/** Real EmployeeRow field names — keeps `sortBy` a closed set. */
export const EMPLOYEE_SORTABLE_FIELDS = [
  'createdAt',
  'employeeCode',
  'name',
  'email',
  'department',
  'designation',
  'status',
  'joiningDate',
] as const;
export type EmployeeSortableField = (typeof EMPLOYEE_SORTABLE_FIELDS)[number];

// ==========================================
// Employees table / KPI queries
// ==========================================

export class GetEmployeesQueryDto {
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
    description: 'Search by name, email or employee ID',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, description: 'Filter by department id' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false, description: 'Filter by designation id' })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({
    enum: EmployeeStatusFilter,
    required: false,
    default: EmployeeStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(EmployeeStatusFilter)
  status?: EmployeeStatusFilter = EmployeeStatusFilter.ALL;

  @ApiProperty({
    required: false,
    enum: EMPLOYEE_SORTABLE_FIELDS,
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(EMPLOYEE_SORTABLE_FIELDS)
  sortBy?: EmployeeSortableField = 'createdAt';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

/**
 * Export reuses the table's filters so the CSV matches what the admin is
 * looking at, minus pagination — an export is always the full filtered set.
 */
export class ExportEmployeesQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({
    enum: EmployeeStatusFilter,
    required: false,
    default: EmployeeStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(EmployeeStatusFilter)
  status?: EmployeeStatusFilter = EmployeeStatusFilter.ALL;

  @ApiProperty({
    required: false,
    enum: EMPLOYEE_SORTABLE_FIELDS,
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(EMPLOYEE_SORTABLE_FIELDS)
  sortBy?: EmployeeSortableField = 'createdAt';

  @ApiProperty({ required: false, enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

// ==========================================
// Employee create / update
// ==========================================

/** How someone is employed — drives probation/contract dates on the record. */
export enum EmployeeEmploymentType {
  PERMANENT = 'PERMANENT',
  PROBATION = 'PROBATION',
  CONTRACT = 'CONTRACT',
  INTERNSHIP = 'INTERNSHIP',
  PART_TIME = 'PART_TIME',
  CONSULTANT = 'CONSULTANT',
  TEMPORARY = 'TEMPORARY',
}

export enum EmployeeGender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
}

export enum MaritalStatus {
  SINGLE = 'SINGLE',
  MARRIED = 'MARRIED',
  DIVORCED = 'DIVORCED',
  WIDOWED = 'WIDOWED',
}

export enum WorkMode {
  ONSITE = 'ONSITE',
  REMOTE = 'REMOTE',
  HYBRID = 'HYBRID',
}

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const SALUTATIONS = ['Mr', 'Ms', 'Mrs', 'Miss', 'Dr'] as const;

/**
 * The personal, contact and employment details kept on an employee record —
 * all optional, so an HR team can fill them in over time. Shared by create
 * and update so both validate them the same way.
 */
export class EmployeeProfileFieldsDto {
  @ApiProperty({ required: false, enum: SALUTATIONS })
  @IsOptional()
  @IsIn(SALUTATIONS as unknown as string[])
  salutation?: string;

  @ApiProperty({ required: false, example: 'Muhammad Khan', description: "Father's or husband's name" })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  fatherName?: string;

  @ApiProperty({ required: false, enum: EmployeeGender })
  @IsOptional()
  @IsEnum(EmployeeGender)
  gender?: EmployeeGender;

  @ApiProperty({ required: false, example: '1994-05-21', format: 'date' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiProperty({ required: false, enum: MaritalStatus })
  @IsOptional()
  @IsEnum(MaritalStatus)
  maritalStatus?: MaritalStatus;

  @ApiProperty({ required: false, example: 'Pakistani' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  nationality?: string;

  @ApiProperty({ required: false, example: 'Islam' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  religion?: string;

  @ApiProperty({ required: false, enum: BLOOD_GROUPS })
  @IsOptional()
  @IsIn(BLOOD_GROUPS as unknown as string[])
  bloodGroup?: string;

  @ApiProperty({ required: false, example: '35202-1234567-1', description: 'National ID / CNIC number' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  nationalId?: string;

  @ApiProperty({ required: false, example: 'House 12, Street 4, DHA Phase 5' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  currentAddress?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  permanentAddress?: string;

  @ApiProperty({ required: false, example: 'Lahore' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiProperty({ required: false, example: 'Sara Khan' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  emergencyContactName?: string;

  @ApiProperty({ required: false, example: 'Spouse' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  emergencyContactRelation?: string;

  @ApiProperty({ required: false, example: '+92 300 7654321' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  emergencyContactPhone?: string;

  @ApiProperty({ required: false, enum: EmployeeEmploymentType })
  @IsOptional()
  @IsEnum(EmployeeEmploymentType)
  employmentType?: EmployeeEmploymentType;

  @ApiProperty({ required: false, format: 'date', description: 'When probation ends (Probation employees)' })
  @IsOptional()
  @IsDateString()
  probationEndDate?: string;

  @ApiProperty({ required: false, format: 'date', description: 'When the contract or internship ends' })
  @IsOptional()
  @IsDateString()
  contractEndDate?: string;

  @ApiProperty({ required: false, enum: WorkMode })
  @IsOptional()
  @IsEnum(WorkMode)
  workMode?: WorkMode;
}

/** The profile fields, for services that copy them between DTO and model. */
export const EMPLOYEE_PROFILE_FIELDS = [
  'salutation',
  'fatherName',
  'gender',
  'dateOfBirth',
  'maritalStatus',
  'nationality',
  'religion',
  'bloodGroup',
  'nationalId',
  'currentAddress',
  'permanentAddress',
  'city',
  'emergencyContactName',
  'emergencyContactRelation',
  'emergencyContactPhone',
  'employmentType',
  'probationEndDate',
  'contractEndDate',
  'workMode',
] as const;
export type EmployeeProfileField = (typeof EMPLOYEE_PROFILE_FIELDS)[number];

export class CreateEmployeeDto extends EmployeeProfileFieldsDto {
  @ApiProperty({
    required: false,
    example: 'EMP001',
    description:
      'Human-readable employee ID shown in the table. Auto-generated from the highest existing code when omitted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  employeeCode?: string;

  @ApiProperty({ example: 'Ayesha' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Khan' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ example: 'ayesha.khan@company.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ required: false, example: '+92 300 1234567' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiProperty({ required: false, description: 'Department to place them in' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({
    required: false,
    description: 'Designation — the Role column on the Employees screen',
  })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({
    required: false,
    description: 'Another employee they report to',
  })
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string;

  @ApiProperty({ required: false, example: '2024-06-11', format: 'date' })
  @IsOptional()
  @IsDateString()
  joiningDate?: string;

  @ApiProperty({
    enum: EmployeeStatus,
    required: false,
    default: EmployeeStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus = EmployeeStatus.ACTIVE;

  @ApiProperty({ required: false, description: 'Profile photo URL or file id' })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiProperty({
    required: false,
    description:
      'Existing login account (user-service User id) to link this employee record to.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  // Salary is not set here: it needs payroll permissions, not employee ones.
  // See PUT organization/payroll/employees/:employeeId/salary.
}

export class UpdateEmployeeDto extends EmployeeProfileFieldsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  employeeCode?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  designationId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  reportingManagerId?: string;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  joiningDate?: string;

  @ApiProperty({ enum: EmployeeStatus, required: false })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiProperty({
    required: false,
    format: 'date',
    description:
      'Last working day. Required by the API when status is RESIGNED.',
  })
  @IsOptional()
  @IsDateString()
  exitDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  userId?: string;

  // Salary is changed through the payroll salary endpoint, which keeps its
  // history and requires payroll permissions.
}

export class UpdateEmployeeStatusDto {
  @ApiProperty({ enum: EmployeeStatus, example: EmployeeStatus.ON_LEAVE })
  @IsEnum(EmployeeStatus)
  status: EmployeeStatus;

  @ApiProperty({
    required: false,
    format: 'date',
    description: 'Last working day. Required when status is RESIGNED.',
  })
  @IsOptional()
  @IsDateString()
  exitDate?: string;
}

export class BulkDeleteEmployeesDto {
  @ApiProperty({ type: [String], description: 'Employee ids to remove' })
  @IsArray()
  @IsUUID(undefined, { each: true })
  employeeIds: string[];
}

// ==========================================
// Internal message-pattern payload DTOs (gateway -> tenant-service).
// Real classes so the microservice's own ValidationPipe re-validates them;
// a plain type literal carries no runtime metadata and is silently skipped.
// ==========================================

export class TenantEmployeeIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  employeeId: string;
}

export class GetEmployeesMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: GetEmployeesQueryDto })
  @ValidateNested()
  @Type(() => GetEmployeesQueryDto)
  @IsDefined()
  query: GetEmployeesQueryDto;
}

export class ExportEmployeesMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: ExportEmployeesQueryDto })
  @ValidateNested()
  @Type(() => ExportEmployeesQueryDto)
  @IsDefined()
  query: ExportEmployeesQueryDto;
}

export class CreateEmployeeMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: CreateEmployeeDto })
  @ValidateNested()
  @Type(() => CreateEmployeeDto)
  @IsDefined()
  dto: CreateEmployeeDto;
}

export class UpdateEmployeeMessageDto extends TenantEmployeeIdDto {
  @ApiProperty({ type: UpdateEmployeeDto })
  @ValidateNested()
  @Type(() => UpdateEmployeeDto)
  @IsDefined()
  dto: UpdateEmployeeDto;
}

export class UpdateEmployeeStatusMessageDto extends TenantEmployeeIdDto {
  @ApiProperty({ type: UpdateEmployeeStatusDto })
  @ValidateNested()
  @Type(() => UpdateEmployeeStatusDto)
  @IsDefined()
  dto: UpdateEmployeeStatusDto;
}

export class BulkDeleteEmployeesMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ type: BulkDeleteEmployeesDto })
  @ValidateNested()
  @Type(() => BulkDeleteEmployeesDto)
  @IsDefined()
  dto: BulkDeleteEmployeesDto;
}

/**
 * Self-service avatar lookup/update for the signed-in HR/Employee account —
 * scoped by email rather than employeeId since the caller (My Profile) only
 * knows its own JWT claims, not its Employee row's id.
 */
export class TenantEmployeeEmailDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  tenantId: string;

  @ApiProperty({ example: 'jane.doe@acme.com' })
  @IsEmail()
  email: string;
}

export class UpdateEmployeeAvatarByEmailDto extends TenantEmployeeEmailDto {
  @ApiProperty({ example: 'https://cdn.example.com/files/abc123.png' })
  @IsString()
  avatarUrl: string;
}
