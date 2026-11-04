import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The role dashboards: what is waiting for a Finance person, for IT, and for
 * a manager, each with a few headline numbers. They count what other screens
 * list, so a number here always opens onto the list it counts.
 */
export class RoleDashboardActorDto {
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
