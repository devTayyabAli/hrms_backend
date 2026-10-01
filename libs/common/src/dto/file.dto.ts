import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsBoolean,
  IsDefined,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FileUploadDto {
  @ApiPropertyOptional({ example: 'profile' })
  @IsOptional()
  @IsString()
  category?: string; // 'profile' | 'avatar' | 'documents' | 'employees' | 'payroll'

  @ApiPropertyOptional({ example: 'SuperAdmin' })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4' })
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  // Sent as multipart/form-data, so every field arrives as a string — without
  // this, an explicit `isPublic=true` fails `@IsBoolean()` and 400s.
  @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
  @IsBoolean()
  isPublic?: boolean;
}

export class FileQueryDto {
  @ApiPropertyOptional({ example: 'platform' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ example: 'profile' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: 'SuperAdmin' })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4' })
  @IsOptional()
  @IsString()
  entityId?: string;
}

// ==========================================
// TCP payload DTOs used by the auth-service FILE.* message-pattern handlers.
// ==========================================

export class FileDataDto {
  // The raw file buffer travels over TCP either as a Buffer instance
  // (in-process) or as a serialized `{ type: 'Buffer', data: number[] }`
  // object — the controller handles both shapes, so this is only checked
  // for presence, not for a specific type.
  @ApiProperty({ description: 'Raw file buffer (Buffer or serialized Buffer object)' })
  @IsDefined()
  buffer: Buffer;

  @ApiProperty({ example: 'resume.pdf' })
  @IsString()
  @IsNotEmpty()
  originalname: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  mimetype: string;

  @ApiPropertyOptional({ example: 102400 })
  @IsOptional()
  size?: number;
}

export class UploadFilePayloadDto {
  @ApiProperty({ type: () => FileDataDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => FileDataDto)
  file: FileDataDto;

  @ApiPropertyOptional({ example: 'platform' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsString()
  @IsNotEmpty()
  uploadedBy: string;

  @ApiPropertyOptional({ example: 'avatar' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: 'SuperAdmin' })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4' })
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class FileIdPayloadDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsString()
  @IsNotEmpty()
  fileId: string;

  @ApiPropertyOptional({ example: 'platform' })
  @IsOptional()
  @IsString()
  userTenantId?: string;
}
