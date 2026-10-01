import { BadRequestException, Controller, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MESSAGE_PATTERNS, Public, SignedMicroservicePayload } from '@app/common';
import {
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  SignedPayloadGuard,
  ServiceRolesGuard,
  RequireServiceRoles,
  TenantContextService,
  AllowUnsignedRpc,
} from '@app/tenant-context';
import { UserService } from './services/user.service';
import { RoleService } from './services/role.service';
import { PermissionRegistryService } from './services/permission-registry.service';
import { PlatformClientsService } from './services/platform-clients.service';
import { TenantModelProviderService } from './services/tenant-model-provider.service';
import {
  CreateOrganizationAdminDto,
  CreateEmployeeUserDto,
  CreateRoleDto,
  UpdateRoleDto,
  UpdateRoleEnvelopeDataDto,
  IdParamDto,
  SetRolePermissionsDto,
  RolePermissionActionDto,
  GetAvailablePermissionsDto,
  EmptyDataDto,
  GetAllUsersDto,
  GetAllRolesDto,
  GetPlatformClientsQueryDto,
  GetRecentPlatformClientsQueryDto,
  TenantUserIdDto,
  UpdatePlatformClientStatusMessageDto,
  TenantIdsDto,
  CreateUserPayloadDto,
  UpdateUserPayloadDto,
  DeleteUserDto,
  UserRoleActionDto,
  SetUserRolesDto,
  QueryEntityAuditLogsDto,
  ResolveCredentialPermissionsDto,
  ResolveEffectiveAuthorizationDto,
} from '@app/common';

function requireTenantId(tenantId: string | undefined): string {
  if (!tenantId) {
    throw new BadRequestException('Tenant context (tenantId) is required for this operation.');
  }
  return tenantId;
}

/**
 * Validates a plain object against a class-validator DTO class and throws an
 * RpcException (the TCP-transport-friendly equivalent of BadRequestException)
 * if it doesn't conform.
 *
 * Needed for handlers whose @Payload() is a SignedMicroservicePayload<T>: that
 * envelope is a plain TS interface, so the global microservice ValidationPipe
 * never inspects it (or its nested `.data`) — this performs the same
 * whitelist/forbidNonWhitelisted validation manually against the extracted data.
 */
async function validateOrThrow<T extends object>(cls: new () => T, plain: unknown): Promise<T> {
  const dto = plainToInstance(cls, plain ?? {});
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    throw new RpcException({
      statusCode: 400,
      message: errors.flatMap((e) => Object.values(e.constraints || {})),
      error: 'Bad Request',
    });
  }
  return dto;
}

@Controller()
@UseGuards(TenantGuard, RolesGuard, PermissionsGuard)
export class UserServiceController {
  constructor(
    private readonly userService: UserService,
    private readonly roleService: RoleService,
    private readonly permissionRegistryService: PermissionRegistryService,
    private readonly platformClientsService: PlatformClientsService,
    private readonly tenantModelProvider: TenantModelProviderService,
    private readonly tenantContextService: TenantContextService,
  ) {}

  /**
   * Runs a mutating service call with the signed envelope's actor identity
   * available via AsyncLocalStorage — TenantModelProviderService's audit
   * hooks (see registerAuditHooks) read it back via
   * tenantContextService.getContext().userId to attribute the resulting
   * entity_audit_logs row to the real caller, not just "someone".
   */
  private withAuditContext<T>(
    envelope: SignedMicroservicePayload<unknown> | undefined,
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tenantContextService.run(
      {
        tenantId,
        userId: envelope?.context?.userId,
        roles: envelope?.context?.roles,
      },
      fn,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.HEALTH.CHECK)
  // Liveness probes are run by orchestration, which has no reason to
  // hold MICROSERVICE_SIGNING_SECRET. Safe to exempt: it takes no
  // parameters, reads no tenant data and changes nothing.
  @AllowUnsignedRpc()
  @Public()
  healthCheck() {
    return {
      service: 'user-service',
      status: 'up',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    };
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.CREATE_ORGANIZATION_ADMIN)
  @Public()
  async createOrganizationAdminMessage(@Payload() data: CreateOrganizationAdminDto) {
    return this.userService.createOrganizationAdminUser(data);
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.CREATE_EMPLOYEE_USER)
  @Public()
  async createEmployeeUserMessage(@Payload() data: CreateEmployeeUserDto) {
    return this.userService.createEmployeeUser(data);
  }

  // ==========================================
  // MICROSERVICE MESSAGE PATTERN HANDLERS
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.ROLE.GET_ALL)
  @UseGuards(SignedPayloadGuard)
  async handleGetAllRoles(@Payload() envelope: SignedMicroservicePayload<GetAllRolesDto>) {
    const dto = await validateOrThrow(GetAllRolesDto, envelope?.data ?? {});
    return this.roleService.getAllRoles(
      requireTenantId(envelope?.context?.tenantId),
      dto,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ROLE.GET_BY_ID)
  @UseGuards(SignedPayloadGuard)
  async handleGetRoleById(@Payload() envelope: SignedMicroservicePayload<{ id: string }>) {
    const dto = await validateOrThrow(IdParamDto, envelope?.data);
    return this.roleService.getRoleById(requireTenantId(envelope?.context?.tenantId), dto.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.ROLE.CREATE)
  @UseGuards(SignedPayloadGuard, ServiceRolesGuard)
  @RequireServiceRoles('admin', 'ORGANIZATION_ADMIN')
  async handleCreateRole(@Payload() envelope: SignedMicroservicePayload<CreateRoleDto>) {
    const dto = await validateOrThrow(CreateRoleDto, envelope?.data);
    const tenantId = requireTenantId(envelope?.context?.tenantId);
    return this.withAuditContext(envelope, tenantId, () => this.roleService.createRole(tenantId, dto));
  }

  @MessagePattern(MESSAGE_PATTERNS.ROLE.UPDATE)
  @UseGuards(SignedPayloadGuard, ServiceRolesGuard)
  @RequireServiceRoles('admin', 'ORGANIZATION_ADMIN')
  async handleUpdateRole(
    @Payload() envelope: SignedMicroservicePayload<{ id: string; data: UpdateRoleDto }>,
  ) {
    const dto = await validateOrThrow(UpdateRoleEnvelopeDataDto, envelope?.data);
    const tenantId = requireTenantId(envelope?.context?.tenantId);
    return this.withAuditContext(envelope, tenantId, () =>
      this.roleService.updateRole(tenantId, dto.id, dto.data),
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.ROLE.DELETE)
  @UseGuards(SignedPayloadGuard, ServiceRolesGuard)
  @RequireServiceRoles('admin', 'ORGANIZATION_ADMIN')
  async handleDeleteRole(@Payload() envelope: SignedMicroservicePayload<{ id: string }>) {
    const tenantId = requireTenantId(envelope?.context?.tenantId);
    const dto = await validateOrThrow(IdParamDto, envelope?.data);
    await this.withAuditContext(envelope, tenantId, () => this.roleService.deleteRole(tenantId, dto.id));
    return { message: `Role ${dto.id} deleted successfully` };
  }

  @MessagePattern(MESSAGE_PATTERNS.ROLE.ASSIGN_PERMISSION)
  async handleAssignPermission(@Payload() payload: RolePermissionActionDto) {
    const tenantId = requireTenantId(payload.tenantId);
    await this.roleService.assignPermission(tenantId, payload.roleId, payload.permissionId);
    return { message: `Permission assigned to role successfully` };
  }

  @MessagePattern(MESSAGE_PATTERNS.ROLE.REVOKE_PERMISSION)
  async handleRevokePermission(@Payload() payload: RolePermissionActionDto) {
    const tenantId = requireTenantId(payload.tenantId);
    await this.roleService.revokePermission(tenantId, payload.roleId, payload.permissionId);
    return { message: `Permission revoked from role successfully` };
  }

  @MessagePattern(MESSAGE_PATTERNS.ROLE.SET_PERMISSIONS)
  @UseGuards(SignedPayloadGuard, ServiceRolesGuard)
  @RequireServiceRoles('admin', 'ORGANIZATION_ADMIN')
  async handleSetRolePermissions(
    @Payload() envelope: SignedMicroservicePayload<{ roleId: string; permissionIds: string[] }>,
  ) {
    const dto = await validateOrThrow(SetRolePermissionsDto, envelope?.data);
    const tenantId = requireTenantId(envelope?.context?.tenantId);
    return this.withAuditContext(envelope, tenantId, () =>
      this.roleService.setRolePermissions(tenantId, dto.roleId, dto.permissionIds),
    );
  }

  /** Called by auth-service at login and refresh to fill the JWT's `permissions` claim (legacy). */
  @MessagePattern(MESSAGE_PATTERNS.ROLE.RESOLVE_CREDENTIAL_PERMISSIONS)
  @Public()
  async handleResolveCredentialPermissions(@Payload() payload: ResolveCredentialPermissionsDto) {
    const dto = await validateOrThrow(ResolveCredentialPermissionsDto, payload);
    return this.roleService.resolveCredentialPermissions(dto.tenantId, dto.credentialRole);
  }

  /** Called by auth-service at login and refresh to resolve user_roles -> roles -> permissions. */
  @MessagePattern(MESSAGE_PATTERNS.ROLE.RESOLVE_EFFECTIVE_AUTHORIZATION)
  @Public()
  async handleResolveEffectiveAuthorization(@Payload() payload: ResolveEffectiveAuthorizationDto) {
    const dto = await validateOrThrow(ResolveEffectiveAuthorizationDto, payload);
    return this.roleService.resolveEffectiveAuthorization(dto.tenantId, dto.email, dto.credentialRole);
  }

  @MessagePattern(MESSAGE_PATTERNS.PERMISSION.GET_AVAILABLE)
  @UseGuards(SignedPayloadGuard)
  async handleGetAvailablePermissions(
    @Payload() envelope: SignedMicroservicePayload<{ enabledModules?: string[] }>,
  ) {
    const dto = await validateOrThrow(GetAvailablePermissionsDto, envelope?.data);
    return this.permissionRegistryService.getAvailablePermissions(
      requireTenantId(envelope?.context?.tenantId),
      dto.enabledModules,
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.GET_ALL)
  async handleGetAllUsers(@Payload() payload?: any) {
    const isEnvelope = payload && 'data' in payload && 'context' in payload;
    const tenantId = isEnvelope ? payload.context?.tenantId : payload?.tenantId;
    const data = isEnvelope ? payload.data : payload;
    return this.userService.getAllUsersPage(requireTenantId(tenantId), data);
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.GET_USER)
  @UseGuards(SignedPayloadGuard)
  async handleGetUserById(@Payload() envelope: SignedMicroservicePayload<{ id: string }>) {
    const dto = await validateOrThrow(IdParamDto, envelope?.data);
    return this.userService.getUserById(requireTenantId(envelope?.context?.tenantId), dto.id);
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.CREATE_USER)
  async handleCreateUser(@Payload() payload: CreateUserPayloadDto) {
    const { tenantId, ...data } = payload;
    return this.userService.createUser(requireTenantId(tenantId), data);
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.UPDATE_USER)
  async handleUpdateUser(@Payload() payload: UpdateUserPayloadDto) {
    return this.userService.updateUser(requireTenantId(payload.tenantId), payload.id, payload.data);
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.DELETE_USER)
  async handleDeleteUser(@Payload() payload: DeleteUserDto) {
    const tenantId = requireTenantId(payload.tenantId);
    await this.userService.deleteUser(tenantId, payload.id);
    return { message: `User ${payload.id} deleted successfully` };
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.ASSIGN_ROLE)
  async handleAssignUserRole(@Payload() payload: UserRoleActionDto) {
    const tenantId = requireTenantId(payload.tenantId);
    await this.userService.assignRole(tenantId, payload.userId, payload.roleId);
    return { message: `Role assigned to user successfully` };
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.REVOKE_ROLE)
  async handleRevokeUserRole(@Payload() payload: UserRoleActionDto) {
    const tenantId = requireTenantId(payload.tenantId);
    await this.userService.revokeRole(tenantId, payload.userId, payload.roleId);
    return { message: `Role revoked from user successfully` };
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.GET_TENANT_USER_COUNTS)
  async handleGetTenantUserCounts(@Payload() payload: TenantIdsDto) {
    return this.platformClientsService.getUserCountsByTenant(payload.tenantIds || []);
  }

  // ==========================================
  // SUPERADMIN PLATFORM CLIENTS (cross-tenant)
  // ==========================================

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ALL)
  async handleGetAllPlatformClients(@Payload() query: GetPlatformClientsQueryDto) {
    return this.platformClientsService.getClients(query || {});
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_STATS)
  async handleGetPlatformClientsStats() {
    return this.platformClientsService.getStats();
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_BY_ROLE)
  async handleGetPlatformClientsByRole() {
    return this.platformClientsService.getByRole();
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_RECENT)
  async handleGetRecentPlatformClients(@Payload() payload: GetRecentPlatformClientsQueryDto) {
    return this.platformClientsService.getRecent(payload?.limit);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_ONE)
  async handleGetOnePlatformClient(@Payload() payload: TenantUserIdDto) {
    return this.platformClientsService.getOne(payload.tenantId, payload.userId);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_CLIENTS.UPDATE_STATUS)
  async handleUpdatePlatformClientStatus(@Payload() payload: UpdatePlatformClientStatusMessageDto) {
    return this.platformClientsService.updateStatus(payload.tenantId, payload.userId, payload.isActive);
  }

  @MessagePattern(MESSAGE_PATTERNS.PLATFORM_CLIENTS.DELETE)
  async handleDeletePlatformClient(@Payload() payload: TenantUserIdDto) {
    await this.platformClientsService.remove(payload.tenantId, payload.userId);
    return { message: `Client ${payload.userId} removed successfully` };
  }

  @MessagePattern(MESSAGE_PATTERNS.USER.SET_ROLES)
  @UseGuards(SignedPayloadGuard, ServiceRolesGuard)
  @RequireServiceRoles('admin', 'ORGANIZATION_ADMIN')
  async handleSetUserRoles(
    @Payload() envelope: SignedMicroservicePayload<{ userId: string; roleIds: string[] }>,
  ) {
    const dto = await validateOrThrow(SetUserRolesDto, envelope?.data);
    const tenantId = requireTenantId(envelope?.context?.tenantId);
    return this.withAuditContext(envelope, tenantId, () =>
      this.userService.setUserRoles(tenantId, dto.userId, dto.roleIds),
    );
  }

  @MessagePattern(MESSAGE_PATTERNS.AUDIT.QUERY_ENTITY_LOGS)
  @UseGuards(SignedPayloadGuard)
  async handleQueryEntityAuditLogs(
    @Payload()
    envelope: SignedMicroservicePayload<{
      tableName?: string;
      recordId?: string;
      action?: string;
      page?: number;
      limit?: number;
    }>,
  ) {
    const dto = await validateOrThrow(QueryEntityAuditLogsDto, envelope?.data);
    const tenantId = requireTenantId(envelope?.context?.tenantId);
    return this.tenantModelProvider.queryEntityAuditLogs(tenantId, dto);
  }
}
