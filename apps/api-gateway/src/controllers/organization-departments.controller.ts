import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Headers,
  Inject,
  UseGuards,
  Res,
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
import type { Response } from 'express';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  GetDepartmentsOverviewQueryDto,
  ExportDepartmentsQueryDto,
  AssignDepartmentManagerDto,
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
import { sendCsvExport } from '../utils/csv-export.helper';

/**
 * Admin-side Departments screen (organization portal) — read side plus
 * manager assignment.
 *
 * Create, update and delete are intentionally absent: the Setup Wizard
 * already owns them at POST|PATCH|DELETE /organization/departments, and the
 * Add Department button and row Edit/Delete actions on this screen reuse
 * those endpoints. Adding a second write path here would mean two places
 * validating department names and parent cycles, free to drift apart.
 *
 * Route note: this controller's own paths are all deeper than
 * `/organization/departments` itself, so nothing here shadows the wizard's
 * list/create route on that exact path.
 */
@Controller('organization/departments')
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
export class OrganizationDepartmentsController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // NOTE: the static sub-routes below are declared before ':departmentId'
  // so Express doesn't match "stats" or "overview" as a department id.

  @ApiTags(TAGS.ORG_DEPARTMENTS)
  @Get('stats')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiOperation({
    summary:
      'Departments KPI cards (Total Departments, Total Employees, Avg Department Size, Top Department) with month-over-month growth',
  })
  getStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.GET_STATS,
      { tenantId },
    );
  }

  @ApiTags(TAGS.ORG_DEPARTMENTS)
  @Get('overview')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiOperation({
    summary:
      'Departments table enriched with headcount and manager per row — paginated, searchable, sortable',
  })
  getOverview(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetDepartmentsOverviewQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.GET_OVERVIEW,
      { tenantId, query },
    );
  }

  @ApiTags(TAGS.ORG_DEPARTMENTS)
  @Get('export')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EXPORT)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiOperation({
    summary: 'Export the Departments table as CSV (Export button)',
  })
  async exportDepartments(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportDepartmentsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.EXPORT,
      { tenantId, query },
      'departments',
      [
        { header: 'Department Name', value: (row) => row.name },
        { header: 'Code', value: (row) => row.code },
        { header: 'Description', value: (row) => row.description },
        { header: 'Employees', value: (row) => row.employeeCount },
        { header: 'Manager', value: (row) => row.manager?.name },
        {
          header: 'Status',
          value: (row) => (row.isActive ? 'Active' : 'Inactive'),
        },
      ],
    );
  }

  @ApiTags(TAGS.ORG_DEPARTMENTS)
  @Get(':departmentId/detail')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiOperation({
    summary: 'Get one department with its headcount and manager resolved',
  })
  @ApiParam({ name: 'departmentId', format: 'uuid' })
  getDepartment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('departmentId') departmentId: string,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.GET_ONE,
      { tenantId, departmentId },
    );
  }

  @ApiTags(TAGS.ORG_DEPARTMENTS)
  @Patch(':departmentId/manager')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EDIT)
  @RequirePermissions('departments.manage')
  @ApiOperation({
    summary:
      'Assign or clear the department manager (Manager column). Send managerId: null to clear',
  })
  @ApiParam({ name: 'departmentId', format: 'uuid' })
  assignManager(
    @Headers('x-tenant-id') tenantId: string,
    @Param('departmentId') departmentId: string,
    @Body() dto: AssignDepartmentManagerDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ORGANIZATION_DEPARTMENT.ASSIGN_MANAGER,
      { tenantId, departmentId, dto },
    );
  }
}
