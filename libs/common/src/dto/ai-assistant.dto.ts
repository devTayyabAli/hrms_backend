import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Longest question the assistant accepts in one message. */
export const AI_MAX_QUESTION_LENGTH = 4000;

export const AI_OWNER_TYPES = ['superadmin', 'tenant'] as const;
export type AiOwnerType = (typeof AI_OWNER_TYPES)[number];

// ==========================================
// HTTP (api-gateway)
// ==========================================

export class AiChatDto {
  @ApiProperty({ description: 'The question, in any language' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_MAX_QUESTION_LENGTH)
  message: string;

  @ApiPropertyOptional({ description: 'Continue an existing conversation; omit to start a new one' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

// ==========================================
// TCP (api-gateway -> auth-service)
// ==========================================

export class AiConversationOwnerDto {
  @IsString()
  @IsNotEmpty()
  ownerId: string;

  @IsIn(AI_OWNER_TYPES)
  ownerType: AiOwnerType;
}

export class AiConversationRefDto extends AiConversationOwnerDto {
  @IsUUID()
  conversationId: string;
}

export class AiUsageDto {
  @IsInt()
  @Min(0)
  inputTokens: number;

  @IsInt()
  @Min(0)
  outputTokens: number;
}

export class AiAuditDto {
  @IsString()
  question: string;

  @IsArray()
  @IsString({ each: true })
  tools: string[];

  @IsIn(['Success', 'Failed'])
  status: 'Success' | 'Failed';

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;

  @IsOptional()
  @IsString()
  model?: string;
}

/** Audit-only record of a question that failed before its answer could be saved. */
export class LogAiFailureDto extends AiConversationOwnerDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => AiUsageDto)
  usage: AiUsageDto;

  @IsObject()
  @ValidateNested()
  @Type(() => AiAuditDto)
  audit: AiAuditDto;
}

export class SaveAiConversationDto extends AiConversationOwnerDto {
  /** Omitted for a new conversation. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  /**
   * The full Messages API history, exactly as the model returned it (thinking
   * and tool blocks included). Only ever appended to — see AiAssistantService.
   */
  @IsArray()
  apiMessages: unknown[];

  /** What the chat panel renders: one entry per question and per answer. */
  @IsArray()
  transcript: unknown[];

  @IsObject()
  @ValidateNested()
  @Type(() => AiUsageDto)
  usage: AiUsageDto;

  @IsObject()
  @ValidateNested()
  @Type(() => AiAuditDto)
  audit: AiAuditDto;
}
