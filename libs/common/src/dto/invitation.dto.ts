import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  IsDefined,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsStrongPassword } from '../validators/strong-password.validator';

export class CreateAdminInvitationDto {
  @ApiProperty({ example: 'admin@acme-enterprises.com' })
  @IsEmail()
  @IsNotEmpty()
  adminEmail: string;

  @ApiProperty({ example: 'Alice Smith', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  adminName?: string;

  @ApiProperty({
    example: 'Welcome aboard — your workspace is ready.',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  customMessage?: string;
}

export class ActivateAdminDto {
  @ApiProperty({ example: 'a1b2c3d4e5f6...' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsStrongPassword()
  password: string;

  @ApiProperty({ example: 'C0rrectHorse!Battery' })
  @IsString()
  @IsNotEmpty()
  confirmPassword: string;

  @ApiProperty({ example: 'Alice', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ example: 'Smith', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;
}

/**
 * Payload for MESSAGE_PATTERNS.INVITATION.CREATE.
 */
export class CreateAdminInvitationMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: CreateAdminInvitationDto })
  @ValidateNested()
  @Type(() => CreateAdminInvitationDto)
  @IsDefined()
  dto: CreateAdminInvitationDto;

  @ApiProperty({
    example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183',
    required: false,
  })
  @IsString()
  @IsOptional()
  createdBy?: string;
}

/**
 * Payload for MESSAGE_PATTERNS.INVITATION.VALIDATE.
 */
export class ValidateInvitationTokenDto {
  @ApiProperty({ example: 'a1b2c3d4e5f6...' })
  @IsString()
  @IsNotEmpty()
  token: string;
}
