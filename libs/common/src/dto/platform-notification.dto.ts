import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The four Profile › Notifications categories a Super Admin notification belongs to. */
export enum PlatformNotificationCategory {
  SECURITY = 'security',
  ACCOUNT = 'account',
  SYSTEM = 'system',
  REPORTS = 'reports',
}

// ==========================================
// HTTP bodies / queries
// ==========================================

export class PlatformNotificationListQueryDto {
  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class PushSubscriptionKeysDto {
  @ApiProperty({ description: "Browser's P-256 public key, base64url" })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{80,100}$/, { message: 'keys.p256dh must be a base64url P-256 public key.' })
  p256dh: string;

  @ApiProperty({ description: 'Auth secret, base64url' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,30}$/, { message: 'keys.auth must be a base64url auth secret.' })
  auth: string;
}

/** `PushSubscription.toJSON()` from the browser. */
export class PushSubscriptionDto {
  @ApiProperty({ example: 'https://fcm.googleapis.com/fcm/send/…' })
  @IsString()
  @MaxLength(1000)
  @Matches(/^https:\/\//, { message: 'endpoint must be an https URL.' })
  endpoint: string;

  @ApiProperty({ type: PushSubscriptionKeysDto })
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys: PushSubscriptionKeysDto;

  /** Part of the browser's toJSON(); almost always null. Accepted, not stored. */
  @ApiPropertyOptional({ nullable: true, example: null })
  @IsOptional()
  @IsNumber()
  expirationTime?: number | null;
}

export class PushUnsubscribeDto {
  @ApiProperty({ example: 'https://fcm.googleapis.com/fcm/send/…' })
  @IsString()
  @MaxLength(1000)
  endpoint: string;
}

// ==========================================
// TCP payloads
// ==========================================

export class PlatformNotificationListPayloadDto {
  @IsUUID()
  superAdminId: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class PlatformNotificationReadPayloadDto {
  @IsUUID()
  superAdminId: string;

  @IsUUID()
  id: string;
}

export class PushSubscribePayloadDto {
  @IsUUID()
  superAdminId: string;

  @ValidateNested()
  @Type(() => PushSubscriptionDto)
  subscription: PushSubscriptionDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;
}

export class PushUnsubscribePayloadDto {
  @IsUUID()
  superAdminId: string;

  @IsString()
  @MaxLength(1000)
  endpoint: string;
}

/** Another service reporting something Super Admins should hear about. */
export class PlatformNotifyPayloadDto {
  @IsEnum(PlatformNotificationCategory)
  category: PlatformNotificationCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  body: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^\//, { message: 'url must be an app path starting with /.' })
  url?: string;

  @IsOptional()
  @IsUUID()
  superAdminId?: string;
}
