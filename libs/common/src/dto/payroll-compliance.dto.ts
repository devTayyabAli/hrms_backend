import {
  IsBoolean,
  IsDateString,
  IsDefined,
  ValidateNested,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeActorDto } from './employee-portal.dto';

/**
 * Payroll compliance (Pakistan). Rule figures live in `configuration` and
 * are validated by the compliance engine, not here: these DTOs check shape
 * and dates only, so a new kind of rule doesn't need a new DTO.
 */

export const COMPLIANCE_RULE_TYPES = [
  'INCOME_TAX',
  'EOBI',
  'PROVIDENT_FUND',
] as const;
export const COMPLIANCE_REPORT_TYPES = ['TAX', 'EOBI', 'PF'] as const;
export type ComplianceReportType = (typeof COMPLIANCE_REPORT_TYPES)[number];

const optionalBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateComplianceRuleDto {
  @ApiPropertyOptional({
    example: 'PK_INCOME_TAX_SALARY_TY2027',
    description:
      'Start from a sourced template; its figures are copied into the draft',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  templateKey?: string;

  @ApiPropertyOptional({
    enum: COMPLIANCE_RULE_TYPES,
    description: 'Required when not starting from a template',
  })
  @IsOptional()
  @IsIn(COMPLIANCE_RULE_TYPES)
  ruleType?: string;

  @ApiPropertyOptional({ example: 'Income tax on salary — TY2027' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({
    example: 2027,
    description:
      'Income tax rules: the tax year (July–June, named for the June it ends in)',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear?: number | null;

  @ApiPropertyOptional({
    example: '2026-07-01',
    description: 'Required unless the template gives one',
  })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({ example: '2027-06-30', nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  effectiveTo?: string | null;

  @ApiPropertyOptional({
    description:
      'Rule figures; see the template for the shape of each rule type',
  })
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;
}

export class UpdateComplianceRuleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  effectiveTo?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Where the figures come from (official source)',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  source?: string | null;
}

export class ActivateComplianceRuleDto {
  @ApiPropertyOptional({
    description:
      'Required for a rule marked as needing review: confirms the figures were checked against the current law',
  })
  @IsOptional()
  @IsBoolean()
  confirmReviewed?: boolean;
}

export class ComplianceRuleQueryDto {
  @ApiPropertyOptional({ enum: COMPLIANCE_RULE_TYPES })
  @IsOptional()
  @IsIn(COMPLIANCE_RULE_TYPES)
  ruleType?: string;
}

export class TaxYearQueryDto {
  @ApiProperty({ example: 2027 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear: number;
}

export class SaveTaxProfileDto {
  @ApiPropertyOptional({ example: '2026-07-01', nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  effectiveFrom?: string | null;

  @ApiPropertyOptional({ example: '1234567-8', nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @Matches(/^[0-9A-Za-z-]{5,32}$/, {
    message: 'NTN should be letters, digits and dashes only.',
  })
  ntn?: string | null;

  @ApiPropertyOptional({ enum: ['FILER', 'NON_FILER'], nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(['FILER', 'NON_FILER'])
  taxStatus?: 'FILER' | 'NON_FILER' | null;

  @ApiPropertyOptional({ enum: ['RESIDENT', 'NON_RESIDENT'] })
  @IsOptional()
  @IsIn(['RESIDENT', 'NON_RESIDENT'])
  residency?: 'RESIDENT' | 'NON_RESIDENT';

  @ApiPropertyOptional({
    description: 'Taxable salary from an earlier employer in this tax year',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  previousEmployerTaxableIncome?: number;

  @ApiPropertyOptional({
    description: 'Tax that employer already deducted this tax year',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  previousEmployerTaxDeducted?: number;

  @ApiPropertyOptional({
    description:
      'Deductible allowances for the year (e.g. Zakat, if documented)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  annualDeductibleAllowances?: number;

  @ApiPropertyOptional({
    description:
      'Tax credits for the year (e.g. donations, pension contributions, if documented)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  annualTaxCredits?: number;

  @ApiPropertyOptional({
    description:
      'An additional (or, negative, reduced) tax amount for the year; needs a reason',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-999_999_999)
  @Max(999_999_999)
  taxAdjustment?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  taxAdjustmentReason?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'A tax reduction the active rule allows (by its code)',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @MaxLength(40)
  reductionCode?: string | null;

  @ApiPropertyOptional({
    description: 'Part of monthly allowances that is medical allowance',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999)
  medicalAllowanceMonthly?: number;

  @ApiPropertyOptional({
    description:
      'Free medical treatment or reimbursement is provided — removes the medical allowance exemption',
  })
  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  freeMedicalProvided?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  eobiCovered?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @MaxLength(40)
  eobiRegistrationNumber?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Provident fund membership; null follows the rule',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  pfMember?: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  pfJoinDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class ComplianceReportQueryDto {
  @ApiPropertyOptional({
    example: '2026-09',
    description: 'One payroll month (YYYY-MM)',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM.' })
  month?: string;

  @ApiPropertyOptional({ example: 2027 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    enum: ['APPROVAL', 'PAYMENT', 'COMPLETED'],
    description: 'Run step; defaults to every locked run',
  })
  @IsOptional()
  @IsIn(['APPROVAL', 'PAYMENT', 'COMPLETED'])
  status?: string;
}

export class TaxCertificateQueryDto {
  @ApiPropertyOptional({ example: 2027 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

// ── Message payloads (gateway → tenant-service) ──────────────────────────

export class TenantComplianceDto {
  @IsUUID()
  tenantId: string;
}

export class ListComplianceRulesMessageDto extends TenantComplianceDto {
  @IsOptional()
  @IsIn(COMPLIANCE_RULE_TYPES)
  ruleType?: string;
}

export class CreateComplianceRuleMessageDto extends TenantComplianceDto {
  @ValidateNested()
  @Type(() => CreateComplianceRuleDto)
  @IsDefined()
  dto: CreateComplianceRuleDto;
}

export class ComplianceRuleIdMessageDto extends TenantComplianceDto {
  @IsUUID()
  ruleId: string;
}

export class UpdateComplianceRuleMessageDto extends ComplianceRuleIdMessageDto {
  @ValidateNested()
  @Type(() => UpdateComplianceRuleDto)
  @IsDefined()
  dto: UpdateComplianceRuleDto;
}

export class ActivateComplianceRuleMessageDto extends ComplianceRuleIdMessageDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ActivateComplianceRuleDto)
  dto?: ActivateComplianceRuleDto;
}

export class TaxYearMessageDto extends TenantComplianceDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear: number;
}

export class EmployeeTaxYearMessageDto extends TaxYearMessageDto {
  @IsUUID()
  employeeId: string;
}

export class SaveTaxProfileMessageDto extends EmployeeTaxYearMessageDto {
  @ValidateNested()
  @Type(() => SaveTaxProfileDto)
  @IsDefined()
  dto: SaveTaxProfileDto;
}

export class ComplianceReportMessageDto extends TenantComplianceDto {
  @IsIn(COMPLIANCE_REPORT_TYPES)
  type: ComplianceReportType;

  @IsOptional()
  @ValidateNested()
  @Type(() => ComplianceReportQueryDto)
  filters?: ComplianceReportQueryDto;
}

export class TaxCertificateListMessageDto extends TenantComplianceDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TaxCertificateQueryDto)
  filters?: TaxCertificateQueryDto;
}

export class TaxCertificateIdMessageDto extends TenantComplianceDto {
  @IsUUID()
  certificateId: string;
}

export class MyTaxSummaryMessageDto extends EmployeeActorDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear: number;
}

export class MyTaxCertificateMessageDto extends EmployeeActorDto {
  @IsUUID()
  certificateId: string;
}

export class IssueTaxCertificateDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: 2027 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear: number;
}
