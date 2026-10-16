import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** Longest single message. */
export const CHAT_BODY_MAX = 4000;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Query strings arrive as text: "true" / "false". */
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

// ==========================================
// Requests
// ==========================================

export class GetConversationsQueryDto {
  @ApiProperty({ required: false, description: 'Search the person\'s name, or any text in the conversation' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, description: 'Only conversations with messages you have not read' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unread?: boolean;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 30;
}

export class StartConversationDto {
  @ApiProperty({ description: 'The employee to talk to' })
  @IsUUID()
  employeeId: string;
}

export class GetChatMessagesQueryDto {
  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'Older messages: the sentAt of the oldest message you already have. Cannot be combined with `after`.',
  })
  @IsOptional()
  @IsDateString()
  before?: string;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'New messages since this moment — the sentAt of the newest message you have. For polling.',
  })
  @IsOptional()
  @IsDateString()
  after?: string;

  @ApiProperty({ required: false, default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 30;
}

export class SendChatMessageDto {
  @ApiProperty({ required: false, description: 'The text. Optional when a file is attached.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_BODY_MAX)
  body?: string;

  @ApiProperty({ required: false, description: 'A file you uploaded with POST /files/upload (category "chat")' })
  @IsOptional()
  @IsUUID()
  fileId?: string;
}

export class GetChatContactsQueryDto {
  @ApiProperty({ required: false, description: 'Filter by name, employee code or email' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

// ==========================================
// Message payloads (gateway -> tenant-service)
// ==========================================

/** Who is acting: the signed-in login. A conversation is theirs, so every call carries it. */
export class ChatCallerDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;

  @ApiProperty({ description: 'The caller\'s login id (from the token)' })
  @IsString()
  @MinLength(1)
  userId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;
}

/**
 * A file's facts as the file store holds them. Set by the gateway after it
 * has checked the caller uploaded the file — never taken from the request.
 */
export class ChatAttachmentDto {
  @ApiProperty()
  @IsUUID()
  fileId: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  fileName: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sizeBytes: number;
}

export class GetConversationsMessageDto extends ChatCallerDto {
  @ApiProperty({ type: GetConversationsQueryDto })
  @ValidateNested()
  @Type(() => GetConversationsQueryDto)
  @IsDefined()
  query: GetConversationsQueryDto;
}

export class StartConversationMessageDto extends ChatCallerDto {
  @ApiProperty({ type: StartConversationDto })
  @ValidateNested()
  @Type(() => StartConversationDto)
  @IsDefined()
  dto: StartConversationDto;
}

export class ConversationIdMessageDto extends ChatCallerDto {
  @ApiProperty()
  @IsUUID()
  conversationId: string;
}

export class GetChatMessagesMessageDto extends ConversationIdMessageDto {
  @ApiProperty({ type: GetChatMessagesQueryDto })
  @ValidateNested()
  @Type(() => GetChatMessagesQueryDto)
  @IsDefined()
  query: GetChatMessagesQueryDto;
}

export class SendChatMessageMessageDto extends ConversationIdMessageDto {
  @ApiProperty({ type: SendChatMessageDto })
  @ValidateNested()
  @Type(() => SendChatMessageDto)
  @IsDefined()
  dto: SendChatMessageDto;

  @ApiProperty({ type: ChatAttachmentDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChatAttachmentDto)
  attachment?: ChatAttachmentDto;
}

export class ChatMessageIdMessageDto extends ChatCallerDto {
  @ApiProperty()
  @IsUUID()
  messageId: string;
}

export class GetChatContactsMessageDto extends ChatCallerDto {
  @ApiProperty({ type: GetChatContactsQueryDto })
  @ValidateNested()
  @Type(() => GetChatContactsQueryDto)
  @IsDefined()
  query: GetChatContactsQueryDto;
}
