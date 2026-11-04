import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  Inject,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  GetReportingTreeQueryDto,
  ReassignReportsDto,
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

/**
 * Department Hierarchy (organization portal): the Organization Hierarchy
 * View and the structure-wide actions.
 *
 * Department create / edit / delete stay on `/organization/departments`
 * (Setup Wizard), the head assignment on
 * `/organization/departments/:id/manager`, and one employee's reporting
 * assignment on `/organization/employees/:id/reporting` — this controller
 * adds the tree views and the bulk reassignment that span the structure.
 *
 * Everything is narrowed to the caller's data scope in the tenant service:
 * a department head sees their department's part of the trees, a team lead
 * their reporting line, an organization-wide role all of it.
 */
@ApiTags(TAGS.ORG_DEPARTMENTS)
@Controller('organization/hierarchy')
@ApiBearerAuth()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@RequireModule(HRMSModuleKey.DEPARTMENTS)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class OrganizationHierarchyController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  @Get('departments')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions(
    'departments.view',
    'departments.manage',
    'employee.view',
    'employee.manage',
  )
  @ApiOperation({
    summary:
      'Department tree — departments nested under their parents, each with head, branch/location, own headcount and total headcount including sub-departments',
  })
  getDepartmentTree(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_HIERARCHY.GET_DEPARTMENT_TREE,
      { tenantId },
    );
  }

  @Get('departments/:departmentId/history')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiOperation({
    summary:
      'History of head and parent changes for one department, newest first',
  })
  @ApiParam({ name: 'departmentId', format: 'uuid' })
  getDepartmentHistory(
    @Headers('x-tenant-id') tenantId: string,
    @Param('departmentId') departmentId: string,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_HIERARCHY.GET_DEPARTMENT_HISTORY,
      { tenantId, departmentId },
    );
  }

  @Get('reporting')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'Reporting tree — who reports to whom, nested from the top (or from `rootEmployeeId`), with designation, department, departments headed and team size',
  })
  getReportingTree(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetReportingTreeQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_HIERARCHY.GET_REPORTING_TREE,
      { tenantId, query },
    );
  }

  @Post('reassign-reports')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiOperation({
    summary:
      'Hand every direct report of one manager to another (or to nobody) when a manager leaves or changes role. Refuses a circular line; one history row per employee',
  })
  reassignReports(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: ReassignReportsDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_HIERARCHY.REASSIGN_REPORTS,
      { tenantId, dto },
    );
  }
}
