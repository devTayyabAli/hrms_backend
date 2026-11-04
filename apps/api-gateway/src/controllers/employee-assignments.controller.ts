import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  CreateEmployeeAssignmentDto,
  EndEmployeeAssignmentDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdateEmployeeAssignmentDto,
} from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * Additional roles beside a person's primary position (a second department, a
 * dotted-line manager, a named responsibility). HR sets them with the same
 * permissions as changing an employee. The primary department, designation and
 * reporting manager stay on the employee, and approvals follow them.
 */
@Controller('organization/employees/:employeeId/assignments')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_DEPARTMENTS)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.EMPLOYEE)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class EmployeeAssignmentsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'A person\'s primary position and their additional assignments, active ones first' })
  list(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_ASSIGNMENT.LIST, { tenantId, employeeId });
  }

  @Post()
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: 'Give someone an additional assignment: another department, a dotted-line manager, or a named role' })
  add(@Headers('x-tenant-id') tenantId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Body() dto: CreateEmployeeAssignmentDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_ASSIGNMENT.ADD, { tenantId, employeeId, dto });
  }

  @Patch(':assignmentId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'Change an assignment that is still running' })
  update(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: UpdateEmployeeAssignmentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_ASSIGNMENT.UPDATE, { tenantId, employeeId, assignmentId, dto });
  }

  @Post(':assignmentId/end')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'End an assignment from a date (today by default). It stays on record' })
  end(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: EndEmployeeAssignmentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_ASSIGNMENT.END, { tenantId, employeeId, assignmentId, dto });
  }
}

/** The employee's own: the extra roles they hold, and who else works for them or their department. */
@Controller('organization/me/assignments')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_DEPARTMENTS)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.EMPLOYEE)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyAssignmentsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'My additional roles, and the people who also work for me or my department' })
  mine(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_ASSIGNMENT.MINE, { tenantId, userId, email });
  }
}
