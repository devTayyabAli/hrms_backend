import { Controller, Get, Headers, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { HRMSModuleKey, MESSAGE_PATTERNS, ModuleAction, SERVICES } from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

const FINANCE = [
  'payroll.view',
  'payroll.approve',
  'payroll.adjustments.view',
  'payroll.adjustments.manage',
  'payroll.compensation.view',
  'payroll.compensation.approve',
  'payroll.loans.view',
  'payroll.manage',
];
const IT = ['assets.view', 'assets.edit', 'assets.manage', 'tickets.view', 'tickets.manage'];

/**
 * Dashboards for the people who act on things: what is waiting for Finance
 * and for IT, each counted from the lists those teams already work from. A
 * count is of what the caller's own grants let them act on.
 */
@Controller('organization/dashboards')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_HR_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class RoleDashboardsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('finance')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.VIEW)
  @RequirePermissions(...FINANCE)
  @ApiOperation({ summary: 'Finance: the current payroll, and what is waiting for you (payroll to approve, salary changes, settlements, claims, clearances)' })
  getFinance(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ROLE_DASHBOARD.FINANCE, { tenantId });
  }

  @Get('it')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.VIEW)
  @RequirePermissions(...IT)
  @ApiOperation({ summary: 'IT: the asset register at a glance, and what is waiting for you (requests, deductions, setup items, people leaving with assets)' })
  getIt(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ROLE_DASHBOARD.IT, { tenantId });
  }
}

/** The manager's own dashboard: it is the caller's, so there is no permission to check. */
@Controller('organization/me/dashboard')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyManagerDashboardController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('manager')
  @ApiOperation({ summary: 'My team at a glance, what is waiting for me to approve, and what needs attention on my team. isManager is false when nobody works under me' })
  getManager(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ROLE_DASHBOARD.MANAGER, { tenantId, userId, email });
  }
}
