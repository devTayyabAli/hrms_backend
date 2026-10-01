import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
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
  DashboardLimitDto,
  GetPerformanceTrendQueryDto,
  UpdatePerformanceGoalDto,
  UpdatePerformanceReviewDto,
} from '@app/common';
import {
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
