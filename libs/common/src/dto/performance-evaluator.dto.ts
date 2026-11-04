import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/**
 * A review with more than one evaluator: who they are, what each evaluates the
 * person as, and each one's share of the final rating.
 */
export class ReviewerEntryDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ required: false, example: 'Project Manager', maxLength: 120, description: 'What they evaluate the person as' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(120)
  roleLabel?: string;

  @ApiProperty({ minimum: 1, maximum: 100, example: 60, description: 'Their share of the final rating, in percent. All shares add up to 100' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  weight: number;

  @ApiProperty({ required: false, default: false, description: 'The main reviewer: sets the plan, writes the overall comment. Exactly one in the list' })
  @IsOptional()
  @IsBoolean()
  isLead?: boolean;
}

export class SetReviewEvaluatorsDto {
  @ApiProperty({ type: [ReviewerEntryDto], description: 'Two to eight reviewers, one of them the lead, with shares adding up to 100. An empty list goes back to a single reviewer' })
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ReviewerEntryDto)
  reviewers: ReviewerEntryDto[];
}
