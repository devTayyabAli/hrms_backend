import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  AssignBranchEmployeesDto,
  BranchesFromLocationsDto,
  CreateBranchDto,
  GetBranchesQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdateBranchDto,
} from '@app/common';
import { JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * Branches: the offices or locations an organization works from, who heads
 * each, and who works from it. Part of the organization structure, so the
 * Departments permissions apply.
 */
@Controller('organization/branches')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_DEPARTMENTS)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.DEPARTMENTS)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class BranchesController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  // Static routes are declared before the `:branchId` ones so they are never read as an id.

  @Post('from-locations')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.CREATE)
  @RequirePermissions('departments.create', 'departments.manage')
  @ApiOperation({ summary: 'Turn the free-text location on departments into branches and put their people in them. Shows what it would do until apply is true' })
  fromLocations(@Headers('x-tenant-id') tenantId: string, @Body() dto: BranchesFromLocationsDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.FROM_LOCATIONS, { tenantId, dto });
  }

  @Get()
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiOperation({ summary: 'Branches with their heads and headcount, and how many people have no branch' })
  getBranches(@Headers('x-tenant-id') tenantId: string, @Query() query: GetBranchesQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.GET_ALL, { tenantId, query });
  }

  @Post()
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.CREATE)
  @RequirePermissions('departments.create', 'departments.manage')
  @ApiOperation({ summary: 'Add a branch' })
  createBranch(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateBranchDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.CREATE, { tenantId, dto });
  }

  @Get(':branchId')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.VIEW)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiParam({ name: 'branchId' })
  @ApiOperation({ summary: 'One branch, with how its people are spread across departments' })
  getBranch(@Headers('x-tenant-id') tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.GET_ONE, { tenantId, branchId });
  }

  @Patch(':branchId')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EDIT)
  @RequirePermissions('departments.edit', 'departments.manage')
  @ApiParam({ name: 'branchId' })
  @ApiOperation({ summary: 'Edit a branch: name, address, head, or make it inactive' })
  updateBranch(@Headers('x-tenant-id') tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: UpdateBranchDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.UPDATE, { tenantId, branchId, dto });
  }

  @Delete(':branchId')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.DELETE)
  @RequirePermissions('departments.delete', 'departments.manage')
  @ApiParam({ name: 'branchId' })
  @ApiOperation({ summary: 'Delete a branch nobody is assigned to' })
  deleteBranch(@Headers('x-tenant-id') tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.DELETE, { tenantId, branchId });
  }

  @Post(':branchId/employees')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EDIT)
  @RequirePermissions('departments.edit', 'departments.manage')
  @ApiParam({ name: 'branchId' })
  @ApiOperation({ summary: 'Put employees in the branch (up to 500)' })
  assignEmployees(@Headers('x-tenant-id') tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: AssignBranchEmployeesDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.ASSIGN_EMPLOYEES, { tenantId, branchId, dto });
  }

  @Post(':branchId/employees/remove')
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EDIT)
  @RequirePermissions('departments.edit', 'departments.manage')
  @ApiParam({ name: 'branchId' })
  @ApiOperation({ summary: 'Take employees out of the branch (they are left with no branch)' })
  removeEmployees(@Headers('x-tenant-id') tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: AssignBranchEmployeesDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.BRANCH.REMOVE_EMPLOYEES, { tenantId, branchId, dto });
  }
}
