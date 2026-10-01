import {
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Shared taxonomy across articles, videos and tickets — matches the Help centre's category tiles. */
export enum HelpCategory {
  GETTING_STARTED = 'GETTING_STARTED',
  ORGANIZATIONS = 'ORGANIZATIONS',
  USERS_ROLES = 'USERS_ROLES',
  SUBSCRIPTIONS_BILLING = 'SUBSCRIPTIONS_BILLING',
  SYSTEM_MANAGEMENT = 'SYSTEM_MANAGEMENT',
}

export enum SupportTicketStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export enum SupportTicketPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

/** Which slice of the article list the "All Topics / Trending / New Articles" tabs ask for. */
export enum ArticleFilter {
  ALL = 'ALL',
  TRENDING = 'TRENDING',
  NEW = 'NEW',
}

// ==========================================
// SUPPORT TICKETS
// ==========================================

export class CreateSupportTicketDto {
  @ApiProperty({ example: 'Unable to export reports' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject: string;

  @ApiProperty({ example: 'Exporting the organizations report returns an empty file.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ enum: HelpCategory })
  @IsOptional()
  @IsEnum(HelpCategory)
  category?: HelpCategory;

  @ApiPropertyOptional({ enum: SupportTicketPriority, default: SupportTicketPriority.MEDIUM })
  @IsOptional()
  @IsEnum(SupportTicketPriority)
  priority?: SupportTicketPriority;
}

export class UpdateSupportTicketDto {
  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ enum: SupportTicketPriority })
  @IsOptional()
  @IsEnum(SupportTicketPriority)
  priority?: SupportTicketPriority;

  @ApiPropertyOptional({ example: 'Fixed in release 2.5.1.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolutionNote?: string;
}

export class GetSupportTicketsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ description: 'Search ticket number or subject' })
  @IsOptional()
  @IsString()
  search?: string;
}

// ==========================================
// KNOWLEDGE BASE ARTICLES
// ==========================================

export class CreateArticleDto {
  @ApiProperty({ example: 'Getting Started with Fuutura HRMS' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({ enum: HelpCategory })
  @IsEnum(HelpCategory)
  category: HelpCategory;

  @ApiPropertyOptional({ example: 'A quick overview of the platform' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class UpdateArticleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ enum: HelpCategory })
  @IsOptional()
  @IsEnum(HelpCategory)
  category?: HelpCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  content?: string;
}

export class GetArticlesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ enum: HelpCategory })
  @IsOptional()
  @IsEnum(HelpCategory)
  category?: HelpCategory;

  @ApiPropertyOptional({ enum: ArticleFilter, default: ArticleFilter.ALL, description: 'Maps to the All Topics / Trending / New Articles tabs.' })
  @IsOptional()
  @IsEnum(ArticleFilter)
  filter?: ArticleFilter = ArticleFilter.ALL;

  @ApiPropertyOptional({ description: 'Search title or excerpt' })
  @IsOptional()
  @IsString()
  search?: string;
}

// ==========================================
// VIDEO TUTORIALS
// ==========================================

export class CreateVideoTutorialDto {
  @ApiProperty({ example: 'How to Add a New Organization' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({ enum: HelpCategory })
  @IsEnum(HelpCategory)
  category: HelpCategory;

  @ApiPropertyOptional({ example: 'Learn how to add and manage organizations' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 'https://videos.fuutura.com/add-organization.mp4' })
  @IsUrl()
  videoUrl: string;

  @ApiPropertyOptional({ example: 'https://videos.fuutura.com/thumbs/add-organization.jpg' })
  @IsOptional()
  @IsUrl()
  thumbnailUrl?: string;

  @ApiProperty({ example: 275, description: 'Duration in seconds (rendered as mm:ss).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationSeconds: number;
}

export class UpdateVideoTutorialDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ enum: HelpCategory })
  @IsOptional()
  @IsEnum(HelpCategory)
  category?: HelpCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  videoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  thumbnailUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationSeconds?: number;
}

export class GetVideosQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ enum: HelpCategory })
  @IsOptional()
  @IsEnum(HelpCategory)
  category?: HelpCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}

// ==========================================
// Internal RPC-only payload DTOs (gateway -> auth-service)
// ==========================================

export class HelpIdDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;
}

// Every nested `dto` below needs real validation metadata: the microservice's
// global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so an
// undecorated property is stripped and then rejected as "should not exist".

export class CreateSupportTicketMessageDto {
  @ApiProperty({ type: () => CreateSupportTicketDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateSupportTicketDto)
  dto: CreateSupportTicketDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  createdBy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  createdByName?: string;
}

export class UpdateSupportTicketMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ type: () => UpdateSupportTicketDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateSupportTicketDto)
  dto: UpdateSupportTicketDto;
}

export class UpdateArticleMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ type: () => UpdateArticleDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateArticleDto)
  dto: UpdateArticleDto;
}

export class UpdateVideoMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ type: () => UpdateVideoTutorialDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateVideoTutorialDto)
  dto: UpdateVideoTutorialDto;
}
