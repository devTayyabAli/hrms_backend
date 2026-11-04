import { Body, Controller, Delete, Get, Headers, Inject, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { HRMSModuleKey, MESSAGE_PATTERNS, ModuleAction, SERVICES, UpdateApprovalPolicyDto } from '@app/common';
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
 * Who approves what. Each kind of request has an ordered list of stages: the
 * reporting manager some levels up, the head of the department, a named
 * person, anyone holding a permission, or HR. Until an organization saves a
 * route, a request keeps the built-in one.
 */
@Controller('organization/approval-policies')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_SETUP)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.SETTINGS)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class ApprovalPoliciesController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.VIEW)
  @RequirePermissions('workflows.view', 'workflows.manage', 'settings.view', 'settings.manage')
  @ApiOperation({ summary: 'How each kind of request is approved: its stages, and whether it is still the built-in route' })
  list(@Headers('x-tenant-id') tenantId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.APPROVAL_POLICY.GET_ALL, { tenantId, email });
  }

  @Put(':requestType')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.EDIT)
  @RequirePermissions('workflows.manage', 'settings.manage')
  @ApiParam({ name: 'requestType', description: 'LEAVE' })
  @ApiOperation({ summary: 'Set the stages a kind of request goes through. Requests already on their way keep their route' })
  update(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('email') email: string,
    @Param('requestType') requestType: string,
    @Body() dto: UpdateApprovalPolicyDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.APPROVAL_POLICY.UPDATE, { tenantId, email, requestType, dto });
  }

  @Delete(':requestType')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.EDIT)
  @RequirePermissions('workflows.manage', 'settings.manage')
  @ApiParam({ name: 'requestType', description: 'LEAVE' })
  @ApiOperation({ summary: 'Go back to the built-in route' })
  reset(@Headers('x-tenant-id') tenantId: string, @CurrentUser('email') email: string, @Param('requestType') requestType: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.APPROVAL_POLICY.RESET, { tenantId, email, requestType });
  }
}
