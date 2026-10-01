import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
  Inject,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiBearerAuth } from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  UpdateOrganizationProfileDto,
  CreateDepartmentDto,
  UpdateDepartmentDto,
  CreateDesignationDto,
  UpdateDesignationDto,
  UpdateWorkingHoursDto,
  CreateLeavePolicyDto,
  UpdateLeavePolicyDto,
  UpdateAttendancePolicyDto,
  HRMSModuleKey,
  ModuleAction,
} from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
  CurrentUser,
} from '@app/tenant-context';

@Controller('organization')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class OrganizationSetupController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  @ApiTags(TAGS.ORG_SETUP)
  @Get('setup/progress')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.VIEW)
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({ summary: 'Get Organization Setup Wizard progress & module completion checklist' })
  getSetupProgress(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_PROGRESS, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Get('setup/profile')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.VIEW)
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({
    summary:
      'Get Organization Profile — the details already on file, so the setup wizard opens pre-filled',
  })
  getOrganizationProfile(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_PROFILE, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Get('branding')
  @ApiOperation({
    summary:
      "Get the organization's name and logo only — every signed-in member of the tenant needs this to render their own portal's shell, so unlike the rest of this controller it carries no @RequirePermissions/@RequireModule gate",
  })
  getOrganizationBranding(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_BRANDING, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Get('modules')
  @ApiOperation({
    summary:
      "Get the organization's enabled module entitlements — every signed-in member of the tenant needs this to filter their navigation menu to active modules only",
  })
  getMyOrganizationModules(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.GET_MODULE_ACCESS, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Put('setup/profile')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.EDIT)
  @RequirePermissions('settings.edit', 'settings.manage')
  @ApiOperation({ summary: 'Configure Organization Profile & General Settings' })
  updateOrganizationProfile(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: UpdateOrganizationProfileDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_PROFILE, { tenantId, dto });
  }

  // ==========================================
  // DEPARTMENTS (Supports both /departments & /setup/departments)
  // ==========================================

  @ApiTags(TAGS.ORG_SETUP)
  @Get(['departments', 'setup/departments'])
  @RequireModule(HRMSModuleKey.DEPARTMENTS)
  @RequirePermissions('departments.view', 'departments.manage')
  @ApiOperation({ summary: 'List all departments for organization' })
  getDepartments(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_DEPARTMENTS, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Post(['departments', 'setup/departments'])
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.CREATE)
  @RequirePermissions('departments.create', 'departments.manage')
  @ApiOperation({ summary: 'Create new department' })
  createDepartment(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateDepartmentDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.CREATE_DEPARTMENT, { tenantId, dto });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Patch(['departments/:id', 'setup/departments/:id'])
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.EDIT)
  @RequirePermissions('departments.edit', 'departments.manage')
  @ApiOperation({ summary: 'Update department' })
  updateDepartment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') departmentId: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_DEPARTMENT, {
      tenantId,
      departmentId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Delete(['departments/:id', 'setup/departments/:id'])
  @RequireModule(HRMSModuleKey.DEPARTMENTS, ModuleAction.DELETE)
  @RequirePermissions('departments.delete', 'departments.manage')
  @ApiOperation({ summary: 'Delete department' })
  deleteDepartment(@Headers('x-tenant-id') tenantId: string, @Param('id') departmentId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.DELETE_DEPARTMENT, {
      tenantId,
      departmentId,
    });
  }

  // ==========================================
  // DESIGNATIONS (Supports both /designations & /setup/designations)
  // ==========================================

  @ApiTags(TAGS.ORG_SETUP)
  @Get(['designations', 'setup/designations'])
  @RequireModule(HRMSModuleKey.EMPLOYEE)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({ summary: 'List all designations for organization' })
  getDesignations(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_DESIGNATIONS, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Post(['designations', 'setup/designations'])
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.CREATE)
  @RequirePermissions('employee.create', 'employee.manage')
  @ApiOperation({ summary: 'Create new designation' })
  createDesignation(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateDesignationDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.CREATE_DESIGNATION, { tenantId, dto });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Patch(['designations/:id', 'setup/designations/:id'])
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiOperation({ summary: 'Update designation' })
  updateDesignation(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') designationId: string,
    @Body() dto: UpdateDesignationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_DESIGNATION, {
      tenantId,
      designationId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Delete(['designations/:id', 'setup/designations/:id'])
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.DELETE)
  @RequirePermissions('employee.delete', 'employee.manage')
  @ApiOperation({ summary: 'Delete designation' })
  deleteDesignation(@Headers('x-tenant-id') tenantId: string, @Param('id') designationId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.DELETE_DESIGNATION, {
      tenantId,
      designationId,
    });
  }

  // ==========================================
  // WORKING HOURS / SHIFTS (Supports both /working-hours & /setup/working-hours)
  // ==========================================

  @ApiTags(TAGS.ORG_SETUP)
  @Get(['working-hours', 'setup/working-hours'])
  @RequireModule(HRMSModuleKey.ATTENDANCE)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({ summary: 'Get organization working hours & shift configuration' })
  getWorkingHours(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_WORKING_HOURS, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Put(['working-hours', 'setup/working-hours'])
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.EDIT)
  @RequirePermissions('attendance.edit', 'attendance.manage')
  @ApiOperation({ summary: 'Configure organization working hours & shift configuration' })
  updateWorkingHours(@Headers('x-tenant-id') tenantId: string, @Body() dto: UpdateWorkingHoursDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_WORKING_HOURS, {
      tenantId,
      dto,
    });
  }

  // ==========================================
  // LEAVE POLICIES (Supports both /leave-policy & /setup/leave-policies)
  // ==========================================

  @ApiTags(TAGS.ORG_SETUP)
  @Get(['leave-policy', 'setup/leave-policies'])
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT)
  @RequirePermissions('leave_management.view', 'leave_management.manage')
  @ApiOperation({ summary: 'List organization leave policies' })
  getLeavePolicies(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_LEAVE_POLICIES, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Post(['leave-policy', 'setup/leave-policies'])
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.CREATE)
  @RequirePermissions('leave_management.create', 'leave_management.manage')
  @ApiOperation({ summary: 'Create leave policy' })
  createLeavePolicy(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateLeavePolicyDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.CREATE_LEAVE_POLICY, { tenantId, dto });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Patch(['leave-policy/:id', 'setup/leave-policies/:id'])
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.EDIT)
  @RequirePermissions('leave_management.edit', 'leave_management.manage')
  @ApiOperation({ summary: 'Update leave policy' })
  updateLeavePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
    @Body() dto: UpdateLeavePolicyDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_LEAVE_POLICY, {
      tenantId,
      policyId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Delete(['leave-policy/:id', 'setup/leave-policies/:id'])
  @RequireModule(HRMSModuleKey.LEAVE_MANAGEMENT, ModuleAction.DELETE)
  @RequirePermissions('leave_management.delete', 'leave_management.manage')
  @ApiOperation({ summary: 'Delete leave policy' })
  deleteLeavePolicy(@Headers('x-tenant-id') tenantId: string, @Param('id') policyId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.DELETE_LEAVE_POLICY, {
      tenantId,
      policyId,
    });
  }

  // ==========================================
  // ATTENDANCE POLICY (Supports both /attendance-policy & /setup/attendance-policy)
  // ==========================================

  @ApiTags(TAGS.ORG_SETUP)
  @Get(['attendance-policy', 'setup/attendance-policy'])
  @RequireModule(HRMSModuleKey.ATTENDANCE)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({ summary: 'Get organization attendance policy' })
  getAttendancePolicy(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_ATTENDANCE_POLICY, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Put(['attendance-policy', 'setup/attendance-policy'])
  @RequireModule(HRMSModuleKey.ATTENDANCE, ModuleAction.EDIT)
  @RequirePermissions('attendance.edit', 'attendance.manage')
  @ApiOperation({ summary: 'Configure organization attendance policy' })
  updateAttendancePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: UpdateAttendancePolicyDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.UPDATE_ATTENDANCE_POLICY, {
      tenantId,
      dto,
    });
  }

  // ==========================================
  // SETUP COMPLETION (LIFECYCLE TRANSITION)
  // ==========================================

  @ApiTags(TAGS.ORG_SETUP)
  @Post('setup/complete')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.MANAGE)
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Finalize Setup Wizard & Activate Organization Tenant (status -> ACTIVE)' })
  completeSetup(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.COMPLETE_SETUP, { tenantId });
  }

  // ==========================================
  // INDUSTRY-STANDARD RECOMMENDED SETUP (opt-in)
  // ==========================================

  @ApiTags(TAGS.ORG_SETUP)
  @Get('setup/industry-template')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.VIEW)
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({
    summary:
      "Preview the recommended Departments/Designations/Leave Policies/HR Policies for the organization's industry, if one exists",
  })
  getIndustryTemplate(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.GET_INDUSTRY_TEMPLATE, { tenantId });
  }

  @ApiTags(TAGS.ORG_SETUP)
  @Post('setup/industry-template/apply')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.MANAGE)
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary:
      'Apply the recommended setup for the industry — creates whatever is missing, skips anything that already exists by name. Safe to call more than once',
  })
  applyIndustryTemplate(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_SETUP.APPLY_INDUSTRY_TEMPLATE, {
      tenantId,
      actorUserId,
    });
  }
}
