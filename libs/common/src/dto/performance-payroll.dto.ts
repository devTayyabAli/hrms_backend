import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** What an earning adjustment is — the income tax rule classifies each one. */
export const PAYROLL_ADJUSTMENT_CATEGORIES = ['BONUS', 'ARREARS', 'COMMISSION', 'REIMBURSEMENT', 'OTHER'] as const;
export type PayrollAdjustmentCategory = (typeof PAYROLL_ADJUSTMENT_CATEGORIES)[number];

/** Review lifecycle shown on the Performance screen. */
export enum PerformanceReviewStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

/** Goal lifecycle. Progress is the bar; status is derived by the client or set explicitly. */
export enum PerformanceGoalStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

/**
 * Payroll Process stepper. A run is born in REVIEW and only moves forward:
 * Review → Approval → Payment → Completed.
 */
export enum PayrollProcessStep {
  REVIEW = 'REVIEW',
  APPROVAL = 'APPROVAL',
  PAYMENT = 'PAYMENT',
  COMPLETED = 'COMPLETED',
}

/** How often a payroll run repeats — the Cycle column on Recent Payroll Runs. */
export enum PayrollCycle {
  MONTHLY = 'MONTHLY',
  BI_WEEKLY = 'BI_WEEKLY',
  WEEKLY = 'WEEKLY',
}

export class DashboardLimitDto {
  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export class GetPerformanceTrendQueryDto {
  @ApiProperty({
    required: false,
    default: 6,
    minimum: 1,
    maximum: 24,
    description: 'How many calendar months the Performance Trend chart covers, ending this month.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number = 6;
}

export class PerformanceMetricScoresDto {
  @ApiProperty({ required: false, minimum: 0, maximum: 5, description: 'Professionalism, 0–5' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  professionalism?: number;

  @ApiProperty({ required: false, minimum: 0, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  communication?: number;

  @ApiProperty({ required: false, minimum: 0, maximum: 5, description: 'Quality of Work, 0–5' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  qualityOfWork?: number;

  @ApiProperty({ required: false, minimum: 0, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  teamwork?: number;

  @ApiProperty({ required: false, minimum: 0, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  leadership?: number;
}

export class CreatePerformanceReviewDto extends PerformanceMetricScoresDto {
  @ApiProperty({ description: 'Employee being reviewed' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: '2026 Q1', description: 'Review cycle label shown on the review' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  cycle: string;

  @ApiProperty({ enum: PerformanceReviewStatus, required: false, default: PerformanceReviewStatus.PENDING })
  @IsOptional()
  @IsEnum(PerformanceReviewStatus)
  status?: PerformanceReviewStatus = PerformanceReviewStatus.PENDING;

  @ApiProperty({
    required: false,
    minimum: 0,
    maximum: 5,
    description: 'Overall rating. When omitted, it is the average of the metric scores that were sent.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false, example: '2026-03-31', format: 'date' })
  @IsOptional()
  @IsDateString()
  reviewDate?: string;
}

export class UpdatePerformanceReviewDto extends PerformanceMetricScoresDto {
  @ApiProperty({ required: false, example: '2026 Q1' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  cycle?: string;

  @ApiProperty({ enum: PerformanceReviewStatus, required: false })
  @IsOptional()
  @IsEnum(PerformanceReviewStatus)
  status?: PerformanceReviewStatus;

  @ApiProperty({ required: false, minimum: 0, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  reviewDate?: string;
}

export class CreatePerformanceGoalDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: 'Close 12 enterprise deals' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @ApiProperty({ required: false, example: 'Sales' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiProperty({ required: false, minimum: 0, maximum: 100, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number = 0;

  @ApiProperty({ enum: PerformanceGoalStatus, required: false })
  @IsOptional()
  @IsEnum(PerformanceGoalStatus)
  status?: PerformanceGoalStatus = PerformanceGoalStatus.NOT_STARTED;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdatePerformanceGoalDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiProperty({ required: false, minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiProperty({ enum: PerformanceGoalStatus, required: false })
  @IsOptional()
  @IsEnum(PerformanceGoalStatus)
  status?: PerformanceGoalStatus;

  @ApiProperty({ required: false, format: 'date' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class CreatePayrollRunDto {
  @ApiProperty({
    example: '2026-09-01',
    format: 'date',
    description: 'First day of the pay period — the 1st of a month',
  })
  @IsDateString()
  periodStart: string;

  @ApiProperty({
    example: '2026-09-30',
    format: 'date',
    description: 'Last day of the pay period — the last day of the same month',
  })
  @IsDateString()
  periodEnd: string;

  @ApiProperty({ enum: PayrollCycle, required: false, default: PayrollCycle.MONTHLY })
  @IsOptional()
  @IsEnum(PayrollCycle)
  cycle?: PayrollCycle;

  @ApiProperty({
    required: false,
    format: 'date',
    example: '2026-10-20',
    description:
      'When people are actually paid. Defaults to 20 days after the period ends for a monthly cycle, 5 for shorter ones.',
  })
  @IsOptional()
  @IsDateString()
  payDate?: string;
}

/** A one-off change to a payroll line in Review. */
export enum PayrollAdjustmentType {
  EARNING = 'EARNING',
  DEDUCTION = 'DEDUCTION',
}

export class AddPayrollAdjustmentDto {
  @ApiProperty({ enum: PayrollAdjustmentType, description: 'EARNING adds to pay (bonus, arrears); DEDUCTION takes from it' })
  @IsEnum(PayrollAdjustmentType)
  type: PayrollAdjustmentType;

  @ApiPropertyOptional({
    enum: PAYROLL_ADJUSTMENT_CATEGORIES,
    description: 'Earnings only: what the earning is, which decides its tax treatment under the income tax rule. Defaults to OTHER.',
  })
  @IsOptional()
  @IsIn(PAYROLL_ADJUSTMENT_CATEGORIES as unknown as string[])
  category?: PayrollAdjustmentCategory;

  @ApiProperty({ example: 5000, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999)
  amount: number;

  @ApiProperty({ example: 'Performance bonus', description: 'Why — kept on the line and in the audit log' })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'The date it relates to (for the record; the payroll month decides when it is paid)' })
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}

export class ReturnPayrollRunDto {
  @ApiProperty({ example: 'Two attendance corrections are still pending', description: 'Shown to whoever prepares the run' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class PayPayrollRunDto {
  @ApiProperty({ example: '2026-10-01', format: 'date', description: 'When salaries were actually paid' })
  @IsDateString()
  paymentDate: string;

  @ApiProperty({ required: false, example: 'HBL batch 2026-10-01', description: 'Bank batch or transfer reference' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentReference?: string;
}

/** A salary and the day it takes effect. Saving never overwrites history. */
export class SetEmployeeSalaryDto {
  @ApiProperty({ example: 80000, minimum: 0, description: 'Monthly basic salary' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  basicSalary: number;

  @ApiProperty({ example: 20000, minimum: 0, description: 'Monthly allowances' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  allowances: number;

  @ApiProperty({ example: 0, minimum: 0, description: 'Deducted every month (e.g. a loan instalment)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  recurringDeductions: number;

  @ApiProperty({ example: '2026-09-01', format: 'date' })
  @IsDateString()
  effectiveFrom: string;

  @ApiProperty({ required: false, example: 'Annual increment' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class SetEmployeeBankDto {
  @ApiProperty({ required: false, nullable: true, example: 'Habib Bank Limited' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  bankName?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'Ayesha Khan' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  bankAccountTitle?: string | null;

  @ApiProperty({ required: false, nullable: true, example: '0123-4567890-01' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9 -]*$/, { message: 'Account number may only contain letters, digits, spaces and dashes.' })
  bankAccountNumber?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'PK36SCBL0000001123456702' })
  @IsOptional()
  @IsString()
  @MaxLength(34)
  @Matches(/^$|^[A-Za-z]{2}\d{2}[A-Za-z0-9 ]{10,30}$/, { message: 'IBAN must start with a country code and check digits, e.g. PK36SCBL0000001123456702.' })
  iban?: string | null;
}

export class GetPayrollHistoryQueryDto {
  @ApiProperty({ required: false, default: 6, minimum: 1, maximum: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number = 6;
}

export class GetPayrollRecordsQueryDto {
  @ApiProperty({ required: false, default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 100;

  @ApiProperty({
    required: false,
    description: 'Payroll run to list. Omit to use the latest run — the Employee Payroll table on the Payroll screen.',
  })
  @IsOptional()
  @IsUUID()
  payrollRunId?: string;
}

export class TenantPerformanceReviewIdDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  reviewId: string;
}

export class CreatePerformanceReviewMessageDto {
  @IsUUID()
  tenantId: string;

  @ValidateNested()
  @Type(() => CreatePerformanceReviewDto)
  @IsDefined()
  dto: CreatePerformanceReviewDto;
}

export class UpdatePerformanceReviewMessageDto extends TenantPerformanceReviewIdDto {
  @ValidateNested()
  @Type(() => UpdatePerformanceReviewDto)
  @IsDefined()
  dto: UpdatePerformanceReviewDto;
}

export class TenantPerformanceGoalIdDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  goalId: string;
}

export class CreatePerformanceGoalMessageDto {
  @IsUUID()
  tenantId: string;

  @ValidateNested()
  @Type(() => CreatePerformanceGoalDto)
  @IsDefined()
  dto: CreatePerformanceGoalDto;
}

export class UpdatePerformanceGoalMessageDto extends TenantPerformanceGoalIdDto {
  @ValidateNested()
  @Type(() => UpdatePerformanceGoalDto)
  @IsDefined()
  dto: UpdatePerformanceGoalDto;
}

export class GetPerformanceTrendMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GetPerformanceTrendQueryDto)
  query?: GetPerformanceTrendQueryDto;
}

export class GetPerformanceListMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DashboardLimitDto)
  query?: DashboardLimitDto;
}

export class CreatePayrollRunMessageDto {
  @IsUUID()
  tenantId: string;

  @ValidateNested()
  @Type(() => CreatePayrollRunDto)
  @IsDefined()
  dto: CreatePayrollRunDto;
}

export class TenantPayrollRunIdDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  payrollRunId: string;
}

export class ReturnPayrollRunMessageDto extends TenantPayrollRunIdDto {
  @ValidateNested()
  @Type(() => ReturnPayrollRunDto)
  @IsDefined()
  dto: ReturnPayrollRunDto;
}

export class PayPayrollRunMessageDto extends TenantPayrollRunIdDto {
  @ValidateNested()
  @Type(() => PayPayrollRunDto)
  @IsDefined()
  dto: PayPayrollRunDto;
}

export class GetPayrollHistoryMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GetPayrollHistoryQueryDto)
  query?: GetPayrollHistoryQueryDto;
}

export class GetPayrollRecordsMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GetPayrollRecordsQueryDto)
  query?: GetPayrollRecordsQueryDto;
}

export class TenantPayrollRecordIdDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  recordId: string;
}

export class AddPayrollAdjustmentMessageDto extends TenantPayrollRecordIdDto {
  @ValidateNested()
  @Type(() => AddPayrollAdjustmentDto)
  @IsDefined()
  dto: AddPayrollAdjustmentDto;
}

export class RemovePayrollAdjustmentMessageDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  adjustmentId: string;
}

export class ListPayslipsQueryDto {
  @ApiProperty({ required: false, description: 'Name, employee ID or payslip number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, example: '2026-09', description: 'Payroll month' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

  @ApiProperty({ required: false, default: 200, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ListPayslipsMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListPayslipsQueryDto)
  query?: ListPayslipsQueryDto;
}

export class EmailRunPayslipsDto {
  @ApiProperty({ required: false, default: false, description: 'Also re-send payslips already emailed' })
  @IsOptional()
  @IsBoolean()
  resend?: boolean;
}

export class EmailRunPayslipsMessageDto extends TenantPayrollRunIdDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => EmailRunPayslipsDto)
  dto?: EmailRunPayslipsDto;
}

export class TenantEmployeePayDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  employeeId: string;
}

export class SetEmployeeSalaryMessageDto extends TenantEmployeePayDto {
  @ValidateNested()
  @Type(() => SetEmployeeSalaryDto)
  @IsDefined()
  dto: SetEmployeeSalaryDto;
}

export class SetEmployeeBankMessageDto extends TenantEmployeePayDto {
  @ValidateNested()
  @Type(() => SetEmployeeBankDto)
  @IsDefined()
  dto: SetEmployeeBankDto;
}
