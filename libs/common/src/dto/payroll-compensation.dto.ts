import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeActorDto } from './employee-portal.dto';

/**
 * Payroll Phase 4 — compensation. These check shape; the compensation
 * service checks the rules (bases, references, dates, locked months).
 */

export const PAY_COMPONENT_TYPES = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION'] as const;
export const PAY_CALCULATION_METHODS = ['FIXED', 'PERCENTAGE', 'FORMULA'] as const;
export const PAY_PERCENTAGE_BASES = ['BASIC', 'SELECTED', 'GROSS', 'TAXABLE_EARNINGS'] as const;
export const PAY_TAX_TREATMENTS = ['TAXABLE', 'NON_TAXABLE', 'RULE_DEPENDENT'] as const;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const list = (values: readonly string[]) => values as unknown as string[];

class ComponentCalculationDto {
  @ApiPropertyOptional({ enum: PAY_CALCULATION_METHODS })
  @IsOptional()
  @IsIn(list(PAY_CALCULATION_METHODS))
  calculationMethod?: string;

  @ApiPropertyOptional({ description: 'FIXED: monthly amount · PERCENTAGE: the percent', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999_999_999)
  value?: number | null;

  @ApiPropertyOptional({ enum: PAY_PERCENTAGE_BASES, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(list(PAY_PERCENTAGE_BASES))
  percentageBase?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'PERCENTAGE of SELECTED: component codes' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  baseComponents?: string[];

  @ApiPropertyOptional({ example: 'BASIC * 10% + 500', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  formula?: string | null;
}

export class CreatePayrollComponentDto extends ComponentCalculationDto {
  @ApiProperty({ example: 'HOUSING' })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{1,31}$/)
  code: string;

  @ApiProperty({ example: 'Housing Allowance' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ enum: PAY_COMPONENT_TYPES })
  @IsIn(list(PAY_COMPONENT_TYPES))
  type: string;

  @ApiProperty({ example: 'ALLOWANCE' })
  @IsString()
  @MaxLength(32)
  category: string;

  @ApiProperty({ enum: PAY_CALCULATION_METHODS })
  @IsIn(list(PAY_CALCULATION_METHODS))
  calculationMethod: string;

  @ApiPropertyOptional({ enum: PAY_TAX_TREATMENTS })
  @IsOptional()
  @IsIn(list(PAY_TAX_TREATMENTS))
  taxTreatment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includedInGross?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includedInOvertimeBase?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includedInLeaveBase?: boolean;

  @ApiPropertyOptional({ example: '2026-07-01' })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  effectiveTo?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class UpdatePayrollComponentDto extends ComponentCalculationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: PAY_COMPONENT_TYPES })
  @IsOptional()
  @IsIn(list(PAY_COMPONENT_TYPES))
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  category?: string;

  @ApiPropertyOptional({ enum: PAY_TAX_TREATMENTS })
  @IsOptional()
  @IsIn(list(PAY_TAX_TREATMENTS))
  taxTreatment?: string;

  @IsOptional()
  @IsBoolean()
  includedInGross?: boolean;

  @IsOptional()
  @IsBoolean()
  includedInOvertimeBase?: boolean;

  @IsOptional()
  @IsBoolean()
  includedInLeaveBase?: boolean;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  effectiveTo?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class ComponentStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'INACTIVE'] })
  @IsIn(['ACTIVE', 'INACTIVE'])
  status: 'ACTIVE' | 'INACTIVE';
}

export class ComponentQueryDto {
  @IsOptional()
  @IsIn(list(PAY_COMPONENT_TYPES))
  type?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: string;
}

export class CompensationLineDto extends ComponentCalculationDto {
  @ApiProperty()
  @IsUUID()
  componentId: string;
}

export class SalaryStructureDto {
  @ApiPropertyOptional({ example: 'MGMT' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{1,31}$/)
  code?: string;

  @ApiPropertyOptional({ example: 'Management Package' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: string;

  @ApiPropertyOptional({ type: [CompensationLineDto], description: 'Its components; calculation fields override the component’s own' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CompensationLineDto)
  components?: CompensationLineDto[];
}

export class SaveCompensationDto {
  @ApiProperty({ example: '2026-10-01' })
  @IsDateString()
  effectiveFrom: string;

  @ApiPropertyOptional({ nullable: true, description: 'Start from this structure' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  structureId?: string | null;

  @ApiPropertyOptional({ type: [CompensationLineDto], description: 'Components and amounts — over the structure’s, or on their own' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CompensationLineDto)
  lines?: CompensationLineDto[];

  @ApiPropertyOptional({ example: 'Annual increment' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class RecurringItemDto {
  @ApiPropertyOptional({ enum: ['EARNING', 'DEDUCTION'] })
  @IsOptional()
  @IsIn(['EARNING', 'DEDUCTION'])
  kind?: 'EARNING' | 'DEDUCTION';

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  category?: string;

  @IsOptional()
  @IsIn(['FIXED', 'PERCENTAGE'])
  calculationMethod?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999_999_999)
  amount?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['BASIC', 'GROSS'])
  percentageBase?: string | null;

  @IsOptional()
  @IsIn(['MONTHLY', 'ONE_TIME'])
  frequency?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional({ description: 'Deductions: stop after this much in total', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalAmount?: number | null;

  @IsOptional()
  @IsIn(list(PAY_TAX_TREATMENTS))
  taxTreatment?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'STOPPED'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class LoanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: ['LOAN', 'ADVANCE'] })
  @IsOptional()
  @IsIn(['LOAN', 'ADVANCE'])
  kind?: 'LOAN' | 'ADVANCE';

  @ApiPropertyOptional({ example: 120000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999)
  principal?: number;

  @ApiPropertyOptional({ example: 20000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  installmentAmount?: number;

  @ApiPropertyOptional({ example: 6, description: 'Instead of the amount: split into this many' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  installments?: number;

  @IsOptional()
  @IsDateString()
  issuedOn?: string;

  @ApiPropertyOptional({ description: 'Any date in the first recovery month' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'ON_HOLD', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class LoanQueryDto {
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsIn(['LOAN', 'ADVANCE'])
  kind?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'])
  status?: string;
}

export class ReimbursementDto {
  @ApiPropertyOptional({ description: 'Staff only — an employee claims for themselves' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ example: 4500 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999)
  amount: number;

  @ApiProperty({ example: 'TRAVEL' })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  category: string;

  @ApiProperty({ example: '2026-09-12' })
  @IsDateString()
  expenseDate: string;

  @ApiProperty({ example: 'Client visit — Lahore to Islamabad' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional({ description: 'Supporting document: id from POST /files/upload' })
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(127)
  mimeType?: string;

  @ApiPropertyOptional({ example: '2026-10', description: 'Staff: the payroll to pay it in' })
  @IsOptional()
  @Matches(PERIOD)
  payrollPeriod?: string;
}

export class DecideReimbursementDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsIn(['APPROVE', 'REJECT'])
  decision: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(PERIOD)
  payrollPeriod?: string | null;
}

export class ReimbursementQueryDto {
  @IsOptional()
  @IsIn(['SUBMITTED', 'APPROVED', 'REJECTED', 'INCLUDED'])
  status?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class AdjustmentEntryDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: '2026-10' })
  @Matches(PERIOD)
  payrollPeriod: string;

  @ApiProperty({ enum: ['EARNING', 'DEDUCTION'] })
  @IsIn(['EARNING', 'DEDUCTION'])
  type: 'EARNING' | 'DEDUCTION';

  @ApiPropertyOptional({ enum: ['BONUS', 'ARREARS', 'COMMISSION', 'REIMBURSEMENT', 'OTHER'] })
  @IsOptional()
  @IsIn(['BONUS', 'ARREARS', 'COMMISSION', 'REIMBURSEMENT', 'OTHER'])
  category?: string;

  @ApiProperty({ example: 20000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999)
  amount: number;

  @ApiProperty({ example: 'Q3 performance bonus' })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}

export class AdjustmentEntryQueryDto {
  @IsOptional()
  @Matches(PERIOD)
  period?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class CompensationImportDto {
  @ApiProperty({ description: 'CSV: Employee ID, Component, Amount, Effective Date' })
  @IsString()
  @MinLength(10)
  @MaxLength(2_000_000)
  csv: string;

  @ApiPropertyOptional({ description: 'Save — only when every row is valid. Default: check only' })
  @IsOptional()
  @IsBoolean()
  apply?: boolean;
}

// ── Message payloads ─────────────────────────────────────────────────────

export class TenantCompensationDto {
  @IsUUID()
  tenantId: string;
}

class WithId extends TenantCompensationDto {
  @IsUUID()
  id: string;
}

class WithEmployee extends TenantCompensationDto {
  @IsUUID()
  employeeId: string;
}

export class ComponentQueryMessageDto extends TenantCompensationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ComponentQueryDto)
  query?: ComponentQueryDto;
}

export class CreateComponentMessageDto extends TenantCompensationDto {
  @ValidateNested()
  @Type(() => CreatePayrollComponentDto)
  @IsDefined()
  dto: CreatePayrollComponentDto;
}

export class UpdateComponentMessageDto extends WithId {
  @ValidateNested()
  @Type(() => UpdatePayrollComponentDto)
  @IsDefined()
  dto: UpdatePayrollComponentDto;
}

export class ComponentStatusMessageDto extends WithId {
  @ValidateNested()
  @Type(() => ComponentStatusDto)
  @IsDefined()
  dto: ComponentStatusDto;
}

export class StructureMessageDto extends TenantCompensationDto {
  @ValidateNested()
  @Type(() => SalaryStructureDto)
  @IsDefined()
  dto: SalaryStructureDto;
}

export class UpdateStructureMessageDto extends WithId {
  @ValidateNested()
  @Type(() => SalaryStructureDto)
  @IsDefined()
  dto: SalaryStructureDto;
}

export class EmployeeCompensationMessageDto extends WithEmployee {}

export class SaveCompensationMessageDto extends WithEmployee {
  @ValidateNested()
  @Type(() => SaveCompensationDto)
  @IsDefined()
  dto: SaveCompensationDto;
}

export class RecurringItemMessageDto extends WithEmployee {
  @ValidateNested()
  @Type(() => RecurringItemDto)
  @IsDefined()
  dto: RecurringItemDto;
}

export class UpdateRecurringItemMessageDto extends WithId {
  @ValidateNested()
  @Type(() => RecurringItemDto)
  @IsDefined()
  dto: RecurringItemDto;
}

export class LoanQueryMessageDto extends TenantCompensationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => LoanQueryDto)
  query?: LoanQueryDto;
}

export class LoanMessageDto extends TenantCompensationDto {
  @ValidateNested()
  @Type(() => LoanDto)
  @IsDefined()
  dto: LoanDto;
}

export class UpdateLoanMessageDto extends WithId {
  @ValidateNested()
  @Type(() => LoanDto)
  @IsDefined()
  dto: LoanDto;
}

export class ReimbursementQueryMessageDto extends TenantCompensationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ReimbursementQueryDto)
  query?: ReimbursementQueryDto;
}

export class ReimbursementMessageDto extends TenantCompensationDto {
  @ValidateNested()
  @Type(() => ReimbursementDto)
  @IsDefined()
  dto: ReimbursementDto;
}

export class DecideReimbursementMessageDto extends WithId {
  @ValidateNested()
  @Type(() => DecideReimbursementDto)
  @IsDefined()
  dto: DecideReimbursementDto;
}

export class AdjustmentEntryQueryMessageDto extends TenantCompensationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AdjustmentEntryQueryDto)
  query?: AdjustmentEntryQueryDto;
}

export class AdjustmentEntryMessageDto extends TenantCompensationDto {
  @ValidateNested()
  @Type(() => AdjustmentEntryDto)
  @IsDefined()
  dto: AdjustmentEntryDto;
}

export class CompensationIdMessageDto extends WithId {}

export class CompensationImportMessageDto extends TenantCompensationDto {
  @ValidateNested()
  @Type(() => CompensationImportDto)
  @IsDefined()
  dto: CompensationImportDto;
}

export class MyReimbursementMessageDto extends EmployeeActorDto {
  @ValidateNested()
  @Type(() => ReimbursementDto)
  @IsDefined()
  dto: ReimbursementDto;
}
