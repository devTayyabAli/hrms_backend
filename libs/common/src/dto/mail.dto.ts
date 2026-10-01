import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  IsObject,
  MaxLength,
  Matches,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A file sent with an email — base64, since it travels over RPC as JSON. */
export class EmailAttachmentDto {
  @ApiProperty({ example: 'Payslip-PS-2026-09-000001.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  filename: string;

  @ApiProperty({ description: 'File contents, base64-encoded (at most ~5 MB)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(7_000_000)
  content: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString()
  @Matches(/^[\w.+-]+\/[\w.+-]+$/)
  contentType?: string;
}

export class SendEmailDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  to: string;

  @ApiProperty({ example: 'HRMS Notification' })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiPropertyOptional({ example: '<p>Hello User</p>' })
  @IsOptional()
  @IsString()
  html?: string;

  @ApiPropertyOptional({ example: 'Hello User' })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ example: ['admin@example.com'] })
  @IsOptional()
  @IsArray()
  cc?: string[];

  @ApiPropertyOptional({ example: ['audit@example.com'] })
  @IsOptional()
  @IsArray()
  bcc?: string[];

  @ApiPropertyOptional({ type: [EmailAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => EmailAttachmentDto)
  attachments?: EmailAttachmentDto[];
}

export class SendTemplateEmailDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  to: string;

  @ApiProperty({ example: 'HRMS Notification' })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiProperty({ example: 'otp_email' })
  @IsString()
  @IsNotEmpty()
  templateName: string;

  @ApiProperty({ example: { firstName: 'Asma', otp: '123456' } })
  @IsObject()
  @IsNotEmpty()
  variables: Record<string, any>;

  @ApiPropertyOptional({ example: ['admin@example.com'] })
  @IsOptional()
  @IsArray()
  cc?: string[];

  @ApiPropertyOptional({ example: ['audit@example.com'] })
  @IsOptional()
  @IsArray()
  bcc?: string[];

  @ApiPropertyOptional({ type: [EmailAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => EmailAttachmentDto)
  attachments?: EmailAttachmentDto[];
}
