import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  AcknowledgeDto,
  ClosePipDto,
  CreateDevelopmentItemDto,
  CreateMyDevelopmentItemDto,
  CreateTeamDevelopmentItemDto,
  CreatePipDto,
  GetAcknowledgementsQueryDto,
  GetDevelopmentQueryDto,
  GetPipsQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  PipCheckInDto,
  RejectPipDto,
  SERVICES,
  UpdateDevelopmentItemDto,
  UpdatePipDto,
} from '@app/common';
import {
  CurrentUser,
  JwtAuthGuard,
  OrganizationModuleGuard,
  PermissionsGuard,
  RequireModule,
  RequirePermissions,
  RolesGuard,
  TenantGuard,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * Improvement plans, development goals and acknowledgements: the admin side.
 * Someone who may not manage performance but can edit it (a manager) can
 * propose a plan; HR approves it.
 */
@Controller('organization/performance')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PERFORMANCE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PERFORMANCE)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class PerformanceImprovementController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  // ── Improvement plans ──

  @Get('pips')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Improvement plans. HR sees all; anyone narrower sees only those they proposed' })
  list(@Headers('x-tenant-id') tenantId: string, @Query() query: GetPipsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.LIST, { tenantId, query });
  }

  @Post('pips')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiOperation({ summary: 'Start a plan (active at once for HR) or propose one (waits for HR to approve)' })
  create(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreatePipDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.CREATE, { tenantId, dto });
  }

  @Get('pips/:pipId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'One plan with its targets, check-ins, extensions and history' })
  get(@Headers('x-tenant-id') tenantId: string, @Param('pipId', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.GET, { tenantId, id });
  }

  @Patch('pips/:pipId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'Change a plan. While proposed: anything. Once running: its targets, and its end date later with a reason (HR)' })
  update(@Headers('x-tenant-id') tenantId: string, @Param('pipId', ParseUUIDPipe) id: string, @Body() dto: UpdatePipDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.UPDATE, { tenantId, id, dto });
  }

  @Post('pips/:pipId/approve')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.manage')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'Approve a proposed plan: it starts and the employee is told. Not by the person who proposed it' })
  approve(@Headers('x-tenant-id') tenantId: string, @Param('pipId', ParseUUIDPipe) id: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.APPROVE, { tenantId, id, email });
  }

  @Post('pips/:pipId/reject')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.manage')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'Reject a proposed plan with a reason. The employee never sees it' })
  reject(@Headers('x-tenant-id') tenantId: string, @Param('pipId', ParseUUIDPipe) id: string, @Body() dto: RejectPipDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.REJECT, { tenantId, id, dto });
  }

  @Post('pips/:pipId/check-ins')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'Add a check-in to a running plan' })
  checkIn(@Headers('x-tenant-id') tenantId: string, @Param('pipId', ParseUUIDPipe) id: string, @Body() dto: PipCheckInDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.CHECK_IN, { tenantId, id, dto });
  }

  @Post('pips/:pipId/close')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.manage')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'End a running plan with its outcome: SUCCESSFUL, UNSUCCESSFUL or CANCELLED' })
  close(@Headers('x-tenant-id') tenantId: string, @Param('pipId', ParseUUIDPipe) id: string, @Body() dto: ClosePipDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.CLOSE, { tenantId, id, dto });
  }

  // ── Development ──

  @Get('development')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'One person\'s development goals and recommendations (employeeId is required)' })
  listDevelopment(@Headers('x-tenant-id') tenantId: string, @Query() query: GetDevelopmentQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.LIST, { tenantId, query });
  }

  @Post('development')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiOperation({ summary: 'Add a goal or a recommendation (optionally a Learning course) for someone you may see' })
  createDevelopment(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateDevelopmentItemDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.CREATE, { tenantId, dto });
  }

  @Patch('development/:itemId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Change a development item' })
  updateDevelopment(@Headers('x-tenant-id') tenantId: string, @Param('itemId', ParseUUIDPipe) id: string, @Body() dto: UpdateDevelopmentItemDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.UPDATE, { tenantId, id, dto });
  }

  @Delete('development/:itemId')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Drop a development item you set (it stays on record as DROPPED)' })
  removeDevelopment(@Headers('x-tenant-id') tenantId: string, @Param('itemId', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.REMOVE, { tenantId, id });
  }

  // ── Acknowledgements ──

  @Get('acknowledgements')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Published reviews and approved plans by whether the employee has acknowledged them (PENDING, ACKNOWLEDGED, DISAGREED)' })
  acknowledgements(@Headers('x-tenant-id') tenantId: string, @Query() query: GetAcknowledgementsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_ACK.LIST, { tenantId, query });
  }
}

/**
 * My Performance, improvement side: the plan I was given, my development goals,
 * and acknowledging a review or a plan. Also what a manager does for their team:
 * propose, update and check in on a plan, and set development items.
 * Everything here is the caller's own or their team's; the tenant service checks.
 */
@Controller('organization/me/performance')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyPerformanceImprovementController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  private actor(tenantId: string, userId: string, email: string) {
    return { tenantId, userId, email };
  }

  @Get('pips')
  @ApiOperation({ summary: 'My improvement plans, once approved' })
  myPlans(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.MY_PLANS, this.actor(tenantId, userId, email));
  }

  @Post('pips/:pipId/acknowledge')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'Acknowledge my plan: AGREE, DISAGREE (with a comment) or NOTED. Once; never changes the plan' })
  acknowledgePip(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('pipId', ParseUUIDPipe) planId: string,
    @Body() dto: AcknowledgeDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_ACK.ACKNOWLEDGE_PIP, { ...this.actor(tenantId, userId, email), planId, dto });
  }

  @Post('reviews/:reviewId/acknowledge')
  @ApiParam({ name: 'reviewId' })
  @ApiOperation({ summary: 'Acknowledge my published review: AGREE, DISAGREE (with a comment) or NOTED. Once; never changes the rating' })
  acknowledgeReview(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: AcknowledgeDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_ACK.ACKNOWLEDGE_REVIEW, { ...this.actor(tenantId, userId, email), reviewId, dto });
  }

  @Get('development')
  @ApiOperation({ summary: 'My development goals and the recommendations made to me' })
  myDevelopment(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Query() query: GetDevelopmentQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.MY_LIST, { ...this.actor(tenantId, userId, email), query });
  }

  @Post('development')
  @ApiOperation({ summary: 'Add a development goal of my own' })
  addMyDevelopment(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Body() dto: CreateMyDevelopmentItemDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.MY_CREATE, { ...this.actor(tenantId, userId, email), dto });
  }

  @Patch('development/:itemId')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Move my progress or status along (title and dates only on goals I added)' })
  updateMyDevelopment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('itemId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDevelopmentItemDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.MY_UPDATE, { ...this.actor(tenantId, userId, email), id, dto });
  }

  @Post('development/:itemId/accept')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Accept a recommendation: it becomes one of my goals' })
  acceptDevelopment(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('itemId', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.MY_ACCEPT, { ...this.actor(tenantId, userId, email), id });
  }

  @Post('development/:itemId/dismiss')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Dismiss a recommendation' })
  dismissDevelopment(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('itemId', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.MY_DISMISS, { ...this.actor(tenantId, userId, email), id });
  }

  // ── A manager's view of their team ──

  @Get('team/pips')
  @ApiOperation({ summary: 'The improvement plans I proposed' })
  proposedByMe(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.MINE, this.actor(tenantId, userId, email));
  }

  @Post('team/pips')
  @ApiOperation({ summary: 'Propose an improvement plan for someone who reports to me or whose review I complete. HR approves it' })
  propose(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Body() dto: CreatePipDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.PROPOSE, { ...this.actor(tenantId, userId, email), dto });
  }

  @Get('team/pips/:pipId')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'A plan I proposed, with its history' })
  getProposed(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('pipId', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.GET_OWN, { ...this.actor(tenantId, userId, email), id });
  }

  @Patch('team/pips/:pipId')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'Change a plan I proposed while it waits for HR' })
  updateProposed(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('pipId', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePipDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.UPDATE_OWN, { ...this.actor(tenantId, userId, email), id, dto });
  }

  @Post('team/pips/:pipId/check-ins')
  @ApiParam({ name: 'pipId' })
  @ApiOperation({ summary: 'Add a check-in to a plan I proposed that is running' })
  checkInProposed(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('pipId', ParseUUIDPipe) id: string,
    @Body() dto: PipCheckInDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PIP.CHECK_IN_OWN, { ...this.actor(tenantId, userId, email), id, dto });
  }

  @Get('team/:employeeId/development')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'The development items of someone in my team' })
  teamDevelopment(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.FOR_TEAM_MEMBER, { ...this.actor(tenantId, userId, email), employeeId });
  }

  @Post('team/:employeeId/development')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'Set a goal or make a recommendation for someone in my team' })
  addTeamDevelopment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateTeamDevelopmentItemDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_DEVELOPMENT.CREATE_FOR_TEAM_MEMBER, { ...this.actor(tenantId, userId, email), employeeId, dto });
  }
}
