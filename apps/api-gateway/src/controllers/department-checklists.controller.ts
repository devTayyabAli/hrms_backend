import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  CreateDepartmentChecklistItemDto,
  GetDepartmentChecklistQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdateDepartmentChecklistItemDto,
} from '@app/common';
import { JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

const VIEW = ['departments.view', 'departments.manage', 'onboarding.manage', 'offboarding.view', 'offboarding.manage'];
const MANAGE = ['departments.manage', 'onboarding.manage', 'offboarding.manage'];

/**
 * What a department adds to onboarding (tasks on the checklist of people who
 * join it) and to offboarding (clearance steps when people leave it), and who
 * owns each. It applies to the department and the ones under it. People who
 * have already joined or started leaving keep the checklist they were given.
 */
@Controller('organization/department-checklists')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_DEPARTMENTS)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.DEPARTMENTS)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class DepartmentChecklistsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions(...VIEW)
  @ApiOperation({ summary: 'The onboarding tasks and offboarding clearance steps departments add. Filter by kind or department' })
  list(@Headers('x-tenant-id') tenantId: string, @Query() query: GetDepartmentChecklistQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.DEPARTMENT_CHECKLIST.LIST, { tenantId, query });
  }

  @Post()
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.CREATE)
  @RequirePermissions(...MANAGE)
  @ApiOperation({ summary: 'Add an onboarding task or an offboarding clearance step to a department (or to every department)' })
  create(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateDepartmentChecklistItemDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.DEPARTMENT_CHECKLIST.CREATE, { tenantId, dto });
  }

  @Patch(':id')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EDIT)
  @RequirePermissions(...MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Change an item, or switch it off (isActive: false). People already onboarding or leaving keep theirs' })
  update(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDepartmentChecklistItemDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.DEPARTMENT_CHECKLIST.UPDATE, { tenantId, id, dto });
  }

  @Delete(':id')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.DELETE)
  @RequirePermissions(...MANAGE)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Remove an item' })
  remove(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.DEPARTMENT_CHECKLIST.DELETE, { tenantId, id });
  }
}
