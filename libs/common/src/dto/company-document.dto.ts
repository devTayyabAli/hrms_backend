import {
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
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
 * Company library (Workspace › Documents): handbook, policies, compliance
 * forms and contract templates shared with the whole organization. Bytes
 * live in the shared file store (`files/upload`); a document row points at
 * them. Employees see Published documents only.
 */

export enum CompanyDocumentCategory {
  HANDBOOK = 'HANDBOOK',
  POLICY = 'POLICY',
  COMPLIANCE = 'COMPLIANCE',
  CONTRACT = 'CONTRACT',
  OTHER = 'OTHER',
}

export enum CompanyDocumentStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

/** Same ceiling as the gateway's upload limit. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);

export class GetCompanyDocumentsQueryDto {
  @ApiPropertyOptional({ description: 'Matches name, file name or owner' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: CompanyDocumentCategory })
  @IsOptional()
  @IsEnum(CompanyDocumentCategory)
  category?: CompanyDocumentCategory;

  @ApiPropertyOptional({ enum: CompanyDocumentStatus })
  @IsOptional()
  @IsEnum(CompanyDocumentStatus)
  status?: CompanyDocumentStatus;
}

/** The stored file a document points at — from `files/upload`. */
class StoredFileFields {
  @ApiProperty({ description: 'id returned by files/upload' })
  @IsUUID()
  fileId: string;

  @ApiProperty({ example: 'employee-handbook-2026.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  @ApiProperty({ example: 245760 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_FILE_BYTES)
  sizeBytes: number;
}

export class CreateCompanyDocumentDto extends StoredFileFields {
  @ApiProperty({ example: 'Employee Handbook 2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({ enum: CompanyDocumentCategory })
  @IsEnum(CompanyDocumentCategory)
  category: CompanyDocumentCategory;

  @ApiPropertyOptional({ enum: CompanyDocumentStatus, default: CompanyDocumentStatus.DRAFT })
  @IsOptional()
  @IsEnum(CompanyDocumentStatus)
  status?: CompanyDocumentStatus;

  @ApiPropertyOptional({ description: 'Employee responsible for keeping it current' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  ownerEmployeeId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class UpdateCompanyDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ enum: CompanyDocumentCategory })
  @IsOptional()
  @IsEnum(CompanyDocumentCategory)
  category?: CompanyDocumentCategory;

  @ApiPropertyOptional({ enum: CompanyDocumentStatus })
  @IsOptional()
  @IsEnum(CompanyDocumentStatus)
  status?: CompanyDocumentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  ownerEmployeeId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  // A replacement file: all four together, or none.
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.fileId !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.fileId !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_FILE_BYTES)
  sizeBytes?: number;
}

// ==========================================
// TCP messages (api-gateway -> tenant-service)
// ==========================================

class TenantDocumentMessageDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class GetCompanyDocumentsMessageDto extends TenantDocumentMessageDto {
  @ValidateNested()
  @Type(() => GetCompanyDocumentsQueryDto)
  @IsDefined()
  query: GetCompanyDocumentsQueryDto;
}

export class CompanyDocumentIdMessageDto extends TenantDocumentMessageDto {
  @IsUUID()
  documentId: string;
}

export class CreateCompanyDocumentMessageDto extends TenantDocumentMessageDto {
  @ValidateNested()
  @Type(() => CreateCompanyDocumentDto)
  @IsDefined()
  dto: CreateCompanyDocumentDto;
}

export class UpdateCompanyDocumentMessageDto extends CompanyDocumentIdMessageDto {
  @ValidateNested()
  @Type(() => UpdateCompanyDocumentDto)
  @IsDefined()
  dto: UpdateCompanyDocumentDto;
}

export class GetPublishedDocumentsMessageDto extends EmployeeActorDto {
  @ValidateNested()
  @Type(() => GetCompanyDocumentsQueryDto)
  @IsDefined()
  query: GetCompanyDocumentsQueryDto;
}
