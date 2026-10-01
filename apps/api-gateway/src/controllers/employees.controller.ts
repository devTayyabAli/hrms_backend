import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
  GetEmployeesQueryDto,
  ExportEmployeesQueryDto,
  CreateEmployeeDto,
  UpdateEmployeeDto,
  UpdateEmployeeStatusDto,
  BulkDeleteEmployeesDto,
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
 * Admin-side Employees screen (organization portal).
 *
 * Tenant-scoped: every route needs a bearer token plus `x-tenant-id`, and is
 * gated by the organization's `employee` module entitlement on top of the
 * caller's own role permissions. This is deliberately NOT the SuperAdmin's
 * cross-tenant Clients directory (`/superadmin/clients`) — these operate
 * strictly inside one organization's own database.
 */
@Controller('organization/employees')
@ApiBearerAuth()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@RequireModule(HRMSModuleKey.EMPLOYEE)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class EmployeesController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // ==========================================
  // KPI cards + pickers
  // NOTE: declared before ':employeeId' so Express doesn't treat "stats"
  // or "directory" as an employee id.
  // ==========================================

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Get('stats')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'Employees KPI cards (Total / Active / On Leave / Resigned) with month-over-month growth',
  })
  getStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.GET_STATS, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Get('directory')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'Lightweight id/code/name list for pickers (reporting manager, department manager, attendance entry)',
  })
  getDirectory(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.GET_DIRECTORY, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Get('next-code')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.CREATE)
  @RequirePermissions('employee.create', 'employee.manage')
  @ApiOperation({
    summary:
      'The Employee ID a new hire would be given (EMP001, EMP002, …) — the same code Create assigns when none is supplied',
  })
  getNextCode(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.GET_NEXT_CODE, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Get('export')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EXPORT)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary: 'Export the filtered employee list as CSV (Export button)',
  })
  async exportEmployees(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportEmployeesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.EMPLOYEE.EXPORT,
      { tenantId, query },
      'employees',
      [
        { header: 'Employee ID', value: (row) => row.employeeCode },
        { header: 'Name', value: (row) => row.name },
        { header: 'Email', value: (row) => row.email },
        { header: 'Phone', value: (row) => row.phone },
        { header: 'Department', value: (row) => row.department?.name },
        { header: 'Role', value: (row) => row.designation?.title },
        {
          header: 'Reporting Manager',
          value: (row) => row.reportingManager?.name,
        },
        { header: 'Status', value: (row) => row.status },
        { header: 'Joining Date', value: (row) => row.joiningDate },
        { header: 'Exit Date', value: (row) => row.exitDate },
      ],
    );
  }

  // ==========================================
  // Employees table + CRUD
  // ==========================================

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Get()
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'All Employees table — paginated, searchable, filterable by department, designation and status',
  })
  getEmployees(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetEmployeesQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Post()
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.CREATE)
  @RequirePermissions('employee.manage')
  @ApiOperation({
    summary:
      'Add Employee. Employee ID is auto-generated when omitted; rejected if the plan seat limit is reached',
  })
  createEmployee(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateEmployeeDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.CREATE, {
      tenantId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Delete()
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.DELETE)
  @RequirePermissions('employee.manage')
  @ApiOperation({
    summary:
      'Bulk remove employees (row multi-select). Also deletes their attendance history',
  })
  bulkDeleteEmployees(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: BulkDeleteEmployeesDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.BULK_DELETE, {
      tenantId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Get(':employeeId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({ summary: 'Get a single employee with department and role' })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  getEmployee(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.GET_ONE, {
      tenantId,
      employeeId,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Patch(':employeeId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.manage')
  @ApiOperation({ summary: 'Edit an employee (row Edit action)' })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  updateEmployee(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId') employeeId: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.UPDATE, {
      tenantId,
      employeeId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Patch(':employeeId/status')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.manage')
  @ApiOperation({
    summary:
      'Change employment status (Active / On Leave / Resigned / Inactive). RESIGNED records an exit date',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  updateEmployeeStatus(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId') employeeId: string,
    @Body() dto: UpdateEmployeeStatusDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.UPDATE_STATUS, {
      tenantId,
      employeeId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_EMPLOYEES)
  @Delete(':employeeId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.DELETE)
  @RequirePermissions('employee.manage')
  @ApiOperation({
    summary:
      'Remove an employee (row Delete action). Also deletes their attendance history',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  deleteEmployee(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE.DELETE, {
      tenantId,
      employeeId,
    });
  }
}
