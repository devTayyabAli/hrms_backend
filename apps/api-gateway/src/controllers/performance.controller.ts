import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  CreatePerformanceGoalDto,
  CreatePerformanceReviewDto,
  ReviewChangeDecisionDto,
  SavePerformancePlanDto,
  SetReviewEvaluatorsDto,
  SetReviewAccessDto,
  DashboardLimitDto,
  GetPerformanceTrendQueryDto,
  GetReviewEvidenceQueryDto,
  UpdatePerformanceGoalDto,
  UpdatePerformanceReviewDto,
} from '@app/common';
import {
  CurrentUser,
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * Admin Performance screen.
 *
 * KPI cards, the monthly trend, the five metric bars and the Top Performers
 * table are reads. Reviews and goals are the writes that feed those widgets —
 * a completed review's rating and metric scores are what the charts average.
 */
@Controller('organization/performance')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PERFORMANCE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PERFORMANCE)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class PerformanceController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('overview')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({
    summary: 'KPI cards — Total Employees, Avg Rating, Completed Reviews, Pending Reviews',
  })
  getOverview(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_OVERVIEW, { tenantId });
  }

  @Get('trend')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({
    summary: 'Performance Trend line — average completed rating per month, including empty months',
  })
  getTrend(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetPerformanceTrendQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_TREND, { tenantId, query });
  }

  @Get('metrics')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({
    summary:
      'Performance Metrics bars — Professionalism, Communication, Quality of Work, Teamwork, Leadership',
  })
  getMetrics(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_METRICS, { tenantId });
  }

  @Get('by-department')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({
    summary:
      'Performance by Department bars — average completed-review rating per department, as a percentage of the 5-point scale',
  })
  getByDepartment(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_BY_DEPARTMENT, { tenantId });
  }

  @Get('top-performers')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Top Performers table, ranked by average completed rating' })
  getTopPerformers(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: DashboardLimitDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_TOP_PERFORMERS, {
      tenantId,
      query,
    });
  }

  @Get('reviews')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Performance reviews, newest first' })
  getReviews(@Headers('x-tenant-id') tenantId: string, @Query() query: DashboardLimitDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_REVIEWS, { tenantId, query });
  }

  @Post('reviews')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.CREATE)
  @RequirePermissions('performance.create', 'performance.manage')
  @ApiOperation({
    summary:
      'Create a review. Overall rating defaults to the average of the metric scores when omitted',
  })
  createReview(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreatePerformanceReviewDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.CREATE_REVIEW, { tenantId, dto });
  }

  @Get('reviews/:reviewId/evidence')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({
    summary:
      'Read-only work evidence for the person on this review: assigned projects, completed tasks, overdue tasks and manager feedback. Does not read or write the rating.',
  })
  getReviewEvidence(
    @Headers('x-tenant-id') tenantId: string,
    @Param('reviewId') reviewId: string,
    @Query() query: GetReviewEvidenceQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_REVIEW_EVIDENCE, { tenantId, reviewId, query });
  }

  @Get('reviews/:reviewId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'One performance review' })
  getReview(@Headers('x-tenant-id') tenantId: string, @Param('reviewId') reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_REVIEW, { tenantId, reviewId });
  }

  @Patch('reviews/:reviewId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Update a review cycle, status, rating or metric scores' })
  updateReview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: UpdatePerformanceReviewDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.UPDATE_REVIEW, {
      tenantId,
      reviewId,
      dto,
    });
  }

  @Post('reviews/:reviewId/publish')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Show a completed review to the employee (rating, scores, feedback) and tell them. Only a completed review' })
  publishReview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @CurrentUser('email') email: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.PUBLISH_REVIEW, { tenantId, reviewId, email });
  }

  @Get('reviews/:reviewId/reviewers')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'The evaluators of a review with more than one: who, as what, their share, and what each has submitted' })
  getReviewers(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_EVALUATOR.LIST, { tenantId, reviewId });
  }

  @Put('reviews/:reviewId/reviewers')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Set the evaluators of a review: two to eight, one the lead, shares adding up to 100. An empty list goes back to one reviewer' })
  setReviewers(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string, @Body() dto: SetReviewEvaluatorsDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_EVALUATOR.SET, { tenantId, reviewId, dto });
  }

  @Post('reviews/:reviewId/consolidate')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Complete a review with several evaluators now, from the evaluations that are in. It completes by itself when the last one submits' })
  consolidate(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_EVALUATOR.CONSOLIDATE, { tenantId, reviewId });
  }

  @Get('changes')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Open reviews whose person changed (a transfer, or the cycle no longer includes them) and are waiting for HR to decide, oldest first' })
  getPendingChanges(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SYNC.PENDING, { tenantId });
  }

  @Post('reviews/:reviewId/change-decision')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Decide what happens to a review whose person changed: KEEP it, REASSIGN it to the new manager, RESTART it on the new department\'s KPIs, or REMOVE the person from the cycle' })
  decideChange(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string, @Body() dto: ReviewChangeDecisionDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SYNC.DECIDE, { tenantId, reviewId, dto });
  }

  @Post('reviews/:reviewId/reopen')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Reopen a closed review, if the person works here again' })
  reopen(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_SYNC.REOPEN, { tenantId, reviewId });
  }

  @Get('reviews/:reviewId/plan')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'The KPIs and goals of a review, with whether they are still a draft' })
  getPlan(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.ADMIN_GET, { tenantId, reviewId });
  }

  @Put('reviews/:reviewId/plan')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Set a review\'s KPIs and goals. Each list sent replaces the one before; leave a list out to keep it. Locked once the review is completed' })
  savePlan(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string, @Body() dto: SavePerformancePlanDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.ADMIN_SAVE, { tenantId, reviewId, dto });
  }

  @Post('reviews/:reviewId/plan/publish')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Show the plan to the employee. KPI weights must add up to 100' })
  publishPlan(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.ADMIN_PUBLISH, { tenantId, reviewId, email });
  }

  @Post('reviews/:reviewId/plan/unpublish')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Take the plan back to a draft. The employee stops seeing it' })
  unpublishPlan(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.ADMIN_UNPUBLISH, { tenantId, reviewId });
  }

  @Get('reviews/:reviewId/history')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'What changed in a review\'s KPIs, goals and evaluation, newest first' })
  getHistory(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.HISTORY, { tenantId, reviewId });
  }

  @Put('reviews/:reviewId/access')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Let particular employees read a review they would not otherwise see (a newly assigned manager does not see earlier confidential reviews on their own). An empty list takes it away' })
  setReviewAccess(
    @Headers('x-tenant-id') tenantId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @CurrentUser('email') email: string,
    @Body() dto: SetReviewAccessDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.SET_REVIEW_ACCESS, { tenantId, reviewId, email, dto });
  }

  @Post('reviews/:reviewId/unpublish')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Take a published review back so it can be corrected. The employee no longer sees the result' })
  unpublishReview(@Headers('x-tenant-id') tenantId: string, @Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.UNPUBLISH_REVIEW, { tenantId, reviewId });
  }

  @Delete('reviews/:reviewId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'reviewId', description: 'Performance Review ID' })
  @ApiOperation({ summary: 'Delete a performance review' })
  deleteReview(@Headers('x-tenant-id') tenantId: string, @Param('reviewId') reviewId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.DELETE_REVIEW, {
      tenantId,
      reviewId,
    });
  }

  @Get('goals')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Performance goals and their progress' })
  getGoals(@Headers('x-tenant-id') tenantId: string, @Query() query: DashboardLimitDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_GOALS, { tenantId, query });
  }

  @Post('goals')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.CREATE)
  @RequirePermissions('performance.create', 'performance.manage')
  @ApiOperation({ summary: 'Create a performance goal' })
  createGoal(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreatePerformanceGoalDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.CREATE_GOAL, { tenantId, dto });
  }

  @Get('goals/:goalId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'goalId', description: 'Performance Goal ID' })
  @ApiOperation({ summary: 'One performance goal' })
  getGoal(@Headers('x-tenant-id') tenantId: string, @Param('goalId') goalId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.GET_GOAL, { tenantId, goalId });
  }

  @Patch('goals/:goalId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'goalId', description: 'Performance Goal ID' })
  @ApiOperation({ summary: 'Update a goal. Changing progress also moves its status' })
  updateGoal(
    @Headers('x-tenant-id') tenantId: string,
    @Param('goalId') goalId: string,
    @Body() dto: UpdatePerformanceGoalDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.UPDATE_GOAL, {
      tenantId,
      goalId,
      dto,
    });
  }

  @Delete('goals/:goalId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'goalId', description: 'Performance Goal ID' })
  @ApiOperation({ summary: 'Delete a performance goal' })
  deleteGoal(@Headers('x-tenant-id') tenantId: string, @Param('goalId') goalId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE.DELETE_GOAL, { tenantId, goalId });
  }
}
