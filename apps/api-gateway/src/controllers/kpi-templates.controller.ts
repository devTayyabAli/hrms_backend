import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  CreateKpiTemplateDto,
  GetMatchingTemplateQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdateKpiTemplateDto,
} from '@app/common';
import { JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * KPI templates HR keeps by department and designation. Someone enrolled in a
 * review cycle gets the template that fits them as their own copy for their
 * manager to adjust; editing a template never rewrites a plan already made.
 */
@Controller('organization/performance/kpi-templates')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_PERFORMANCE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.PERFORMANCE)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class KpiTemplatesController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'KPI templates with their KPIs and who they fit' })
  list(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.TEMPLATE_LIST, { tenantId });
  }

  // Declared before `:id` so it is never read as an id.
  @Get('match')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'The template an employee would get today, from their department and designation' })
  match(@Headers('x-tenant-id') tenantId: string, @Query() query: GetMatchingTemplateQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.TEMPLATE_MATCH, { tenantId, employeeId: query.employeeId });
  }

  @Post()
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.CREATE)
  @RequirePermissions('performance.create', 'performance.manage')
  @ApiOperation({ summary: 'Create a KPI template. Its weights add up to 100' })
  create(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateKpiTemplateDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.TEMPLATE_CREATE, { tenantId, dto });
  }

  @Get(':id')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.VIEW)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'One KPI template' })
  get(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.TEMPLATE_GET, { tenantId, id });
  }

  @Patch(':id')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Change a template, or switch it off (isActive: false). Plans already made keep their KPIs' })
  update(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKpiTemplateDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.TEMPLATE_UPDATE, { tenantId, id, dto });
  }

  @Delete(':id')
  @RequireModule(HRMSModuleKey.PERFORMANCE, ModuleAction.EDIT)
  @RequirePermissions('performance.edit', 'performance.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Delete a template' })
  remove(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.PERFORMANCE_PLAN.TEMPLATE_DELETE, { tenantId, id });
  }
}
