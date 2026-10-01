import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Put,
  Body,
  Param,
  Query,
  Inject,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiHeader, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  CreateOrgRoleDto,
  UpdateOrgRoleDto,
  AssignRolePermissionsDto,
  AssignUserRolesDto,
  QueryEntityAuditLogsDto,
  GetAllRolesDto,
  GetAllUsersDto,
  UpdateUserDto,
} from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
  MicroserviceSigningService,
} from '@app/tenant-context';

@Controller('organization')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard, RolesGuard, PermissionsGuard)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class OrganizationRolesController {
  constructor(
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    private readonly signingService: MicroserviceSigningService,
  ) {}

  @ApiTags(TAGS.ORG_ROLES)
  @Get('permissions')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'Get available permissions grouped by module, filtered by organization module access' })
  async getAvailablePermissions() {
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.PERMISSION.GET_AVAILABLE, this.signingService.sign({})),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Get('roles')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'Get all roles defined for current organization' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1-based page number (default 1).' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Rows per page; clamped to the service maximum.' })
  async getAllRoles(@Query() query: GetAllRolesDto) {
    // Paging is forwarded rather than dropped: the handler behind this route
    // is bounded now, so a caller that wants more than the first page has to
    // be able to ask for it.
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.ROLE.GET_ALL, this.signingService.sign(query ?? {})),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Get('roles/:id')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'Get specific role by ID with permissions' })
  async getRoleById(@Param('id') id: string) {
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.ROLE.GET_BY_ID, this.signingService.sign({ id })),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Post('roles')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.CREATE)
  @RequirePermissions('user_management.manage')
  @ApiOperation({ summary: 'Create custom role for organization' })
  async createRole(@Body() dto: CreateOrgRoleDto) {
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.ROLE.CREATE, this.signingService.sign(dto)),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Patch('roles/:id')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.EDIT)
  @RequirePermissions('user_management.manage')
  @ApiOperation({ summary: 'Update custom role name and description' })
  async updateRole(@Param('id') id: string, @Body() dto: UpdateOrgRoleDto) {
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.ROLE.UPDATE, this.signingService.sign({ id, data: dto })),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Delete('roles/:id')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.DELETE)
  @RequirePermissions('user_management.manage')
  @ApiOperation({ summary: 'Delete custom role (if no users assigned)' })
  async deleteRole(@Param('id') id: string) {
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.ROLE.DELETE, this.signingService.sign({ id })),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Get('roles/:roleId/permissions')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'Get permissions assigned to a role' })
  async getRolePermissions(@Param('roleId') roleId: string) {
    const role = await firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.ROLE.GET_BY_ID, this.signingService.sign({ id: roleId })),
    );
    return role?.permissions || [];
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Put('roles/:roleId/permissions')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.MANAGE)
  @RequirePermissions('user_management.manage')
  @ApiOperation({ summary: 'Assign / replace permissions for a role' })
  async setRolePermissions(
    @Param('roleId') roleId: string,
    @Body() dto: AssignRolePermissionsDto,
  ) {
    return firstValueFrom(
      this.userClient.send(
        MESSAGE_PATTERNS.ROLE.SET_PERMISSIONS,
        this.signingService.sign({
          roleId,
          permissionIds: dto.permissionIds,
        }),
      ),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Get('users/:userId/roles')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'Get roles assigned to a user' })
  async getUserRoles(@Param('userId') userId: string) {
    const user = await firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.USER.GET_USER, this.signingService.sign({ id: userId })),
    );
    return user?.roles || [];
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Put('users/:userId/roles')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.MANAGE)
  @RequirePermissions('user_management.manage')
  @ApiOperation({ summary: 'Assign / replace roles for a user' })
  async setUserRoles(
    @Param('userId') userId: string,
    @Body() dto: AssignUserRolesDto,
  ) {
    return firstValueFrom(
      this.userClient.send(
        MESSAGE_PATTERNS.USER.SET_ROLES,
        this.signingService.sign({
          userId,
          roleIds: dto.roleIds,
        }),
      ),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Get('users')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'Get all users in the organization with their assigned roles' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getAllUsers(@Query() query: GetAllUsersDto) {
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.USER.GET_ALL, this.signingService.sign(query ?? {})),
    );
  }

  @ApiTags(TAGS.ORG_ROLES)
  @Patch('users/:userId')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.EDIT)
  @RequirePermissions('user_management.manage')
  @ApiOperation({ summary: 'Update organization user account status and details' })
  async updateUser(
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    return firstValueFrom(
      this.userClient.send(
        MESSAGE_PATTERNS.USER.UPDATE_USER,
        this.signingService.sign({ id: userId, data: dto }),
      ),
    );
  }

  // ==========================================
  // ENTITY AUDIT TRAIL
  // ==========================================

  @ApiTags(TAGS.ORG_AUDIT_LOGS)
  @Get('audit-logs')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT, ModuleAction.VIEW)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'Get change-history audit trail for this organization (roles, permissions, users)' })
  @ApiQuery({ name: 'tableName', required: false, description: 'e.g. Role, Permission, User' })
  @ApiQuery({ name: 'recordId', required: false })
  @ApiQuery({ name: 'action', required: false, enum: ['CREATE', 'UPDATE', 'DELETE'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getEntityAuditLogs(@Query() query: QueryEntityAuditLogsDto) {
    return firstValueFrom(
      this.userClient.send(MESSAGE_PATTERNS.AUDIT.QUERY_ENTITY_LOGS, this.signingService.sign(query)),
    );
  }
}
