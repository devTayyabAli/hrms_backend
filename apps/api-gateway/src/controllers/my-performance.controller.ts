import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  SavePerformancePlanDto,
  SubmitReviewEvaluationDto,
  SubmitSelfAssessmentDto,
  UpdateMyGoalProgressDto,
} from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, RequireModule, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * My Performance (employee portal): the reviews open for my own assessment,
 * the results HR has published to me, and my goals.
 *
 * Like the rest of `organization/me`, everything is the caller's own: the
 * employee linked to the login. There is no permission to check and no
 * employee id to name; a review or goal that is someone else's is simply not
 * found. The Performance module still has to be enabled for the organization.
 */
@Controller('organization/me/performance')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyPerformanceController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  private actor(tenantId: string, userId: string, email: string) {
    return { tenantId, userId, email };
  }

  @Get('reviews')
  @ApiOperation({ summary: 'My reviews: those waiting for my self-assessment and the results published to me' })
  getReviews(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.GET_REVIEWS, this.actor(tenantId, userId, email));
  }

  @Get('reviews/:reviewId')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'One of my reviews. The result shows only once it is published' })
  getReview(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.GET_REVIEW, { ...this.actor(tenantId, userId, email), reviewId });
  }

  @Put('reviews/:reviewId/self-assessment')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'Write or change my self-assessment for a review that is not completed yet' })
  submitSelfAssessment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: SubmitSelfAssessmentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.SUBMIT_SELF_ASSESSMENT, { ...this.actor(tenantId, userId, email), reviewId, dto });
  }

  @Get('reviewing')
  @ApiOperation({ summary: 'The reviews I complete for others (by default, my direct reports), those still to complete first' })
  getReviewing(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.GET_REVIEWING, this.actor(tenantId, userId, email));
  }

  @Get('reviewing/:reviewId')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'One review I complete, with the employee\'s self-assessment' })
  getReviewingOne(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.GET_REVIEWING_ONE, { ...this.actor(tenantId, userId, email), reviewId });
  }

  @Put('reviewing/:reviewId/evaluation')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'Score and give feedback on a review I complete. complete: true finishes it (at least one score needed). HR decides when the employee sees it' })
  submitEvaluation(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: SubmitReviewEvaluationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.SUBMIT_EVALUATION, { ...this.actor(tenantId, userId, email), reviewId, dto });
  }

  @Get('reviewing/:reviewId/plan')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'The KPIs and goals of a review I complete: what to set, adjust and publish for the employee' })
  getReviewingPlan(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.REVIEWER_GET, { ...this.actor(tenantId, userId, email), reviewId });
  }

  @Put('reviewing/:reviewId/plan')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'Set the KPIs and goals of a review I complete. Each list sent replaces the one before; leave a list out to keep it' })
  saveReviewingPlan(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: SavePerformancePlanDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.REVIEWER_SAVE, { ...this.actor(tenantId, userId, email), reviewId, dto });
  }

  @Post('reviewing/:reviewId/plan/publish')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'Show the plan to the employee. KPI weights must add up to 100' })
  publishReviewingPlan(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.REVIEWER_PUBLISH, { ...this.actor(tenantId, userId, email), reviewId });
  }

  @Get('plan')
  @ApiOperation({ summary: 'My KPIs and goals for each review whose plan has been published. Results show once the review is published to me' })
  getMyPlans(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.MINE, this.actor(tenantId, userId, email));
  }

  @Get('goals')
  @ApiOperation({ summary: 'My goals, open ones first, with a count per status' })
  getGoals(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.GET_GOALS, this.actor(tenantId, userId, email));
  }

  @Patch('goals/:goalId/progress')
  @ApiParam({ name: 'goalId' })
  @ApiOperation({ summary: 'Move the progress of one of my goals. Its status follows' })
  updateGoalProgress(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
    @Body() dto: UpdateMyGoalProgressDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SELF.UPDATE_GOAL_PROGRESS, { ...this.actor(tenantId, userId, email), goalId, dto });
  }
}
