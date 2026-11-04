import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * The helpdesk: an employee raises a ticket with IT, IT works it from a queue.
 * Not to be confused with Help & Support, where an organization writes to the
 * platform team.
 */
export enum HelpdeskCategory {
  HARDWARE = 'HARDWARE',
  SOFTWARE = 'SOFTWARE',
  ACCESS = 'ACCESS',
  NETWORK = 'NETWORK',
  OTHER = 'OTHER',
}

export enum HelpdeskPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum HelpdeskStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  WAITING_ON_REQUESTER = 'WAITING_ON_REQUESTER',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateMyTicketDto {
  @ApiProperty({ example: 'VPN does not connect', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @ApiProperty({ example: 'Since this morning the VPN client says authentication failed.', maxLength: 4000 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  description: string;

  @ApiProperty({ enum: HelpdeskCategory, required: false, default: HelpdeskCategory.OTHER })
  @IsOptional()
  @IsEnum(HelpdeskCategory)
  category?: HelpdeskCategory;

  @ApiProperty({ enum: HelpdeskPriority, required: false, default: HelpdeskPriority.MEDIUM })
  @IsOptional()
  @IsEnum(HelpdeskPriority)
  priority?: HelpdeskPriority;
}

export class AddTicketCommentDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;

  @ApiProperty({ required: false, default: false, description: 'IT only: a note the requester does not see' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  internal?: boolean;
}

export class UpdateTicketDto {
  @ApiProperty({ enum: HelpdeskStatus, required: false, description: 'RESOLVED needs a resolution note' })
  @IsOptional()
  @IsEnum(HelpdeskStatus)
  status?: HelpdeskStatus;

  @ApiProperty({ enum: HelpdeskPriority, required: false })
  @IsOptional()
  @IsEnum(HelpdeskPriority)
  priority?: HelpdeskPriority;

  @ApiProperty({ required: false, nullable: true, description: 'The employee who works the ticket. null takes it back to the queue' })
  @IsOptional()
  @IsUUID()
  assignedToEmployeeId?: string | null;

  @ApiProperty({ required: false, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  resolutionNote?: string;
}

export class GetTicketsQueryDto {
  @ApiProperty({ enum: HelpdeskStatus, required: false })
  @IsOptional()
  @IsEnum(HelpdeskStatus)
  status?: HelpdeskStatus;

  @ApiProperty({ enum: HelpdeskPriority, required: false })
  @IsOptional()
  @IsEnum(HelpdeskPriority)
  priority?: HelpdeskPriority;

  @ApiProperty({ enum: HelpdeskCategory, required: false })
  @IsOptional()
  @IsEnum(HelpdeskCategory)
  category?: HelpdeskCategory;

  @ApiProperty({ required: false, enum: ['ME', 'UNASSIGNED'], description: 'ME: assigned to me. UNASSIGNED: nobody yet' })
  @IsOptional()
  @IsEnum(['ME', 'UNASSIGNED'])
  assigned?: 'ME' | 'UNASSIGNED';

  @ApiProperty({ required: false, description: 'Ticket number or subject, max 100' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
