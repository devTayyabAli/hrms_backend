import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsDateString, IsDefined, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Policy distribution: a company document (usually a policy) can be sent to
 * part of the organization and can ask each person to acknowledge it. It is a
 * property of the document, not a second kind of record.
 */

export const POLICY_AUDIENCE_MAX_GROUPS = 100;
export const POLICY_AUDIENCE_MAX_PEOPLE = 1000;

export enum PolicyAcknowledgementStatus {
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  PENDING = 'PENDING',
  OVERDUE = 'OVERDUE',
}

export enum PolicyAcknowledgementFilter {
  ALL = 'ALL',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  PENDING = 'PENDING',
  OVERDUE = 'OVERDUE',
}

export enum MyPolicyFilter {
  ALL = 'ALL',
  PENDING = 'PENDING',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
}

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;
const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class PolicyAudienceDto {
  @ApiProperty({ required: false, type: [String], description: 'Everyone currently in these departments' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POLICY_AUDIENCE_MAX_GROUPS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  departmentIds?: string[];

  @ApiProperty({ required: false, type: [String], description: 'These people by name' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POLICY_AUDIENCE_MAX_PEOPLE)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  employeeIds?: string[];
}

export class SetPolicyDistributionDto {
  @ApiProperty({ required: false, description: 'Ask each person in the audience to acknowledge the document' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  requiresAcknowledgement?: boolean;

  @ApiProperty({
    required: false,
    nullable: true,
    type: PolicyAudienceDto,
    description: 'Who it is for. null, or no departments and no people, means everyone',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PolicyAudienceDto)
  audience?: PolicyAudienceDto | null;

  @ApiProperty({ required: false, nullable: true, example: '2026-12-15', description: 'YYYY-MM-DD, today or later. null removes it' })
  @IsOptional()
  @Transform(blankToNull)
  @IsDateString({ strict: true }, { message: 'Use a date as YYYY-MM-DD.' })
  acknowledgeBy?: string | null;
}

export class GetPolicyAcknowledgementsQueryDto {
  @ApiProperty({ required: false, enum: PolicyAcknowledgementFilter, default: 'ALL' })
  @IsOptional()
  @IsEnum(PolicyAcknowledgementFilter)
  status?: PolicyAcknowledgementFilter;

  @ApiProperty({ required: false, description: 'Employee name or code, max 100' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;
}

export class GetMyPoliciesQueryDto {
  @ApiProperty({ required: false, enum: MyPolicyFilter, default: 'ALL' })
  @IsOptional()
  @IsEnum(MyPolicyFilter)
  status?: MyPolicyFilter;

  @ApiProperty({ required: false, description: 'Document name, max 100' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

export class PolicyActorDto {
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

export class PolicyDocumentIdMessageDto extends PolicyActorDto {
  @ApiProperty()
  @IsUUID()
  documentId: string;
}

export class SetPolicyDistributionMessageDto extends PolicyDocumentIdMessageDto {
  @ApiProperty({ type: SetPolicyDistributionDto })
  @ValidateNested()
  @Type(() => SetPolicyDistributionDto)
  @IsDefined()
  dto: SetPolicyDistributionDto;
}

export class GetPolicyAcknowledgementsMessageDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty()
  @IsUUID()
  documentId: string;

  @ApiProperty({ type: GetPolicyAcknowledgementsQueryDto })
  @ValidateNested()
  @Type(() => GetPolicyAcknowledgementsQueryDto)
  @IsDefined()
  query: GetPolicyAcknowledgementsQueryDto;
}

export class GetMyPoliciesMessageDto extends PolicyActorDto {
  @ApiProperty({ type: GetMyPoliciesQueryDto })
  @ValidateNested()
  @Type(() => GetMyPoliciesQueryDto)
  @IsDefined()
  query: GetMyPoliciesQueryDto;
}
