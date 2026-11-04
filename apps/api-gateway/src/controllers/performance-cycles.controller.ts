import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  CreatePerformanceCycleDto,
  EnrolInCycleDto,
  GetPerformanceCyclesQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdatePerformanceCycleDto,
} from '@app/common';
import { JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * Review cycles and who is in them. HR names a period, sets who it is for
 * (eligibility rules), and chooses whether eligible people are enrolled
 * automatically or wait in an HR queue. The rules read Employee Management; they
 * never copy it.
 */
@Controller('organization/performance/cycles')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PERFORMANCE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PERFORMANCE)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class PerformanceCyclesController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Review cycles, newest first, with how many are enrolled and a count per status' })
  list(@Headers('x-tenant-id') tenantId: string, @Query() query: GetPerformanceCyclesQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.LIST, { tenantId, query });
  }

  @Post()
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.CREATE)
  @RequirePermissions('performance.create', 'performance.manage')
  @ApiOperation({ summary: 'Create a cycle (as a draft): its period, enrolment mode, fallback reviewer and eligibility rules' })
  create(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreatePerformanceCycleDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.CREATE, { tenantId, dto });
  }

  @Get(':id')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'One cycle with its rules and how many people are eligible, left out, and waiting to be enrolled' })
  get(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.GET, { tenantId, id });
  }

  @Patch(':id')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Change a cycle. After it launches the name and period are fixed; the rules, due date, mode and fallback reviewer can still change (people already enrolled keep their reviews)' })
  update(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePerformanceCycleDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.UPDATE, { tenantId, id, dto });
  }

  @Delete(':id')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Delete a cycle that has not launched' })
  remove(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.DELETE, { tenantId, id });
  }

  @Get(':id/preview')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Who the rules include and who they leave out, with the reason for each. People who have left are counted, not listed' })
  preview(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.PREVIEW, { tenantId, id });
  }

  @Post(':id/launch')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Start the cycle. AUTO_ENROL gives every eligible person their review now; HR_QUEUE lists them for HR to enrol' })
  launch(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.LAUNCH, { tenantId, id });
  }

  @Post(':id/close')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Close a running cycle. Its reviews stay; nobody new is enrolled' })
  close(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.CLOSE, { tenantId, id });
  }

  @Get(':id/queue')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'The eligible people who have no review in this cycle yet' })
  queue(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.QUEUE, { tenantId, id });
  }

  @Post(':id/enrol')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Enrol people in a running cycle. The rules decide; override: true (needs performance.manage) enrols someone they leave out, and is recorded' })
  enrol(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EnrolInCycleDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_CYCLE.ENROL, { tenantId, id, dto });
  }
}
