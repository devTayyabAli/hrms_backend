import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { literal } from 'sequelize';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { PermissionRegistryService } from './permission-registry.service';
import {
  buildPaginatedResult,
  DataScope,
  EffectiveAuthorization,
  FULL_ACCESS_PERMISSION,
  isAdminTierCredentialRole,
  isReservedRoleName,
  ListBoundsInput,
  ORG_ADMIN_ROLE_NAME,
  PaginatedResult,
  resolveListBounds,
  roleNameForCredentialRole,
  SYSTEM_TENANT_ROLES,
  effectiveRoleScope,
  widestDataScope,
} from '@app/common';
import { Role } from '../models';

export interface CreateRoleData {
  name: string;
  description?: string;
  isSystemRole?: boolean;
  permissionIds?: string[];
  dataScope?: DataScope;
}

export interface UpdateRoleData {
  name?: string;
  description?: string;
  dataScope?: DataScope;
}

const PROTECTED_SYSTEM_ROLES = [
  'ORGANIZATION_ADMIN',
  'ADMIN',
  'HR MANAGER',
  'MANAGER',
  'EMPLOYEE',
];

@Injectable()
export class RoleService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly permissionRegistryService: PermissionRegistryService,
  ) {}

  /**
   * Create a role in the given tenant's database
   */
  async createRole(tenantId: string, data: CreateRoleData): Promise<Role> {
    if (isReservedRoleName(data.name)) {
      throw new BadRequestException(`'${data.name}' is a reserved role name`);
    }

    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const existing = await RoleModel.findOne({ where: { name: data.name } });
    if (existing) {
      throw new BadRequestException(`Role '${data.name}' already exists in this organization`);
    }

    const role = await RoleModel.create({
      name: data.name,
      description: data.description,
      isSystemRole: data.isSystemRole ?? false,
      permissionsConfigured: true,
      dataScope: data.dataScope ?? null,
    });

    if (data.permissionIds && data.permissionIds.length > 0) {
      const resolvedIds = await this.permissionRegistryService.resolvePermissionIds(tenantId, data.permissionIds);
      const RolePermissionModel = await this.modelProvider.getRolePermissionModel(tenantId);
      for (const pId of resolvedIds) {
        await RolePermissionModel.create({
          roleId: role.id,
          permissionId: pId,
        });
      }
    }

    return this.getRoleById(tenantId, role.id);
  }

  /**
   * Get role by ID with associated permissions, scoped to the given tenant's database
   */
  async getRoleById(tenantId: string, id: string): Promise<Role> {
    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const PermissionModel = await this.modelProvider.getPermissionModel(tenantId);
    const role = await RoleModel.findByPk(id, {
      include: [
        {
          model: PermissionModel,
          through: { attributes: [] },
        },
      ],
    });

    if (!role) {
      throw new NotFoundException(`Role ${id} not found in tenant database`);
    }

    return role;
  }

  /**
   * Get all roles in the given tenant's database
   */
  /**
   * Get roles for a tenant, one bounded page at a time.
   *
   * Roles are few, but each one eager-loads its whole permission set, so the
   * unbounded `findAll` this replaces returned roles × permissions rows —
   * the one list in this service whose payload grows with the permission
   * catalogue as well as with tenant data. Bounded for the same reason as
   * `UserService.getAllUsers`; return shape is unchanged.
   */
  async getAllRoles(
    tenantId: string,
    bounds?: ListBoundsInput,
  ): Promise<Role[]> {
    const { rows } = await this.getAllRolesPage(tenantId, bounds);
    return rows;
  }

  /** As `getAllRoles`, but returns the total alongside the page. */
  async getAllRolesPage(
    tenantId: string,
    bounds?: ListBoundsInput,
  ): Promise<PaginatedResult<Role>> {
    await this.ensureSystemRoles(tenantId);

    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const PermissionModel = await this.modelProvider.getPermissionModel(tenantId);
    const resolved = resolveListBounds(bounds);

    const { rows, count } = await RoleModel.findAndCountAll({
      attributes: {
        include: [
          [
            literal(
              `(SELECT COUNT(*)::int FROM user_roles ur WHERE ur."roleId" = "Role"."id")`,
            ),
            'userCount',
          ],
        ],
      },
      include: [
        {
          model: PermissionModel,
          through: { attributes: [] },
        },
      ],
      order: [
        ['name', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: resolved.limit,
      offset: resolved.offset,
      // See UserService.getAllUsersPage: without `distinct`, `count` counts
      // role×permission join rows rather than roles.
      distinct: true,
    });

    return buildPaginatedResult(rows, count, resolved);
  }

  /**
   * Update role
   */
  async updateRole(tenantId: string, id: string, data: UpdateRoleData): Promise<Role> {
    const role = await this.getRoleById(tenantId, id);
    if (role.isSystemRole || PROTECTED_SYSTEM_ROLES.includes(role.name.toUpperCase())) {
      throw new BadRequestException(`System role '${role.name}' cannot be modified`);
    }
    if (data.name && isReservedRoleName(data.name)) {
      throw new BadRequestException(`'${data.name}' is a reserved role name`);
    }
    await role.update(data);
    return this.getRoleById(tenantId, id);
  }

  /**
   * Delete role with active assignment check
   */
  async deleteRole(tenantId: string, id: string): Promise<void> {
    const role = await this.getRoleById(tenantId, id);
    if (role.isSystemRole || PROTECTED_SYSTEM_ROLES.includes(role.name.toUpperCase())) {
      throw new BadRequestException(`System role '${role.name}' cannot be deleted`);
    }

    const UserRoleModel = await this.modelProvider.getUserRoleModel(tenantId);
    const assignedUserCount = await UserRoleModel.count({ where: { roleId: id } });
    if (assignedUserCount > 0) {
      throw new BadRequestException(
        `Cannot delete role '${role.name}' because ${assignedUserCount} user(s) are currently assigned to it. Reassign users first.`,
      );
    }

    const RolePermissionModel = await this.modelProvider.getRolePermissionModel(tenantId);
    await RolePermissionModel.destroy({ where: { roleId: id } });
    await role.destroy();
  }

  /**
   * Assign a permission to a role
   */
  async assignPermission(tenantId: string, roleId: string, permissionInput: string): Promise<void> {
    await this.getRoleById(tenantId, roleId);
    const resolvedIds = await this.permissionRegistryService.resolvePermissionIds(tenantId, [permissionInput]);
    const permissionId = resolvedIds[0];

    const RolePermissionModel = await this.modelProvider.getRolePermissionModel(tenantId);
    const existing = await RolePermissionModel.findOne({
      where: { roleId, permissionId },
    });

    if (!existing) {
      await RolePermissionModel.create({ roleId, permissionId });
    }
  }

  /**
   * Revoke a permission from a role
   */
  async revokePermission(tenantId: string, roleId: string, permissionInput: string): Promise<void> {
    await this.getRoleById(tenantId, roleId);
    const resolvedIds = await this.permissionRegistryService.resolvePermissionIds(tenantId, [permissionInput]);
    const permissionId = resolvedIds[0];

    const RolePermissionModel = await this.modelProvider.getRolePermissionModel(tenantId);
    await RolePermissionModel.destroy({
      where: { roleId, permissionId },
    });
  }

  /**
   * Transaction-safe replace/set of all permissions for a role
   */
  async setRolePermissions(tenantId: string, roleId: string, permissionInputs: string[]): Promise<Role> {
    const role = await this.getRoleById(tenantId, roleId);
    if (role.name === ORG_ADMIN_ROLE_NAME) {
      throw new BadRequestException('The Organization Admin role always has full access and cannot be edited');
    }
    const resolvedPermissionIds = await this.permissionRegistryService.resolvePermissionIds(tenantId, permissionInputs);

    const sequelize = await this.modelProvider.getConnection(tenantId);
    const transaction = await sequelize.transaction();

    try {
      const RolePermissionModel = await this.modelProvider.getRolePermissionModel(tenantId);

      // Clear current permissions
      await RolePermissionModel.destroy({ where: { roleId }, transaction });

      // Bulk create new permissions
      for (const pId of resolvedPermissionIds) {
        await RolePermissionModel.create({ roleId, permissionId: pId }, { transaction });
      }

      await role.update({ permissionsConfigured: true }, { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    return this.getRoleById(tenantId, roleId);
  }

  /**
   * Makes sure every system role exists, and gives each one its default
   * permissions the first time it is set up. Idempotent and cheap once done:
   * one query when nothing is missing.
   */
  async ensureSystemRoles(tenantId: string): Promise<void> {
    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const existing = await RoleModel.findAll({
      where: { name: SYSTEM_TENANT_ROLES.map((def) => def.name) },
    });
    const byName = new Map(existing.map((role) => [role.name, role]));

    for (const def of SYSTEM_TENANT_ROLES) {
      let role = byName.get(def.name);
      if (role?.permissionsConfigured) continue;

      if (!role) {
        try {
          role = await RoleModel.create({
            name: def.name,
            description: def.description,
            isSystemRole: true,
          });
        } catch {
          // A concurrent caller created it first (unique name).
          role = await RoleModel.findOne({ where: { name: def.name } });
          if (!role || role.permissionsConfigured) continue;
        }
      }

      if (def.locked) {
        await role.update({ permissionsConfigured: true });
      } else {
        await this.setRolePermissions(tenantId, role.id, def.defaultPermissions);
      }
    }
  }

  /**
   * The permission keys (`resource.action`) a signed-in credential carries in
   * its access token. Admin-tier credentials get none: an empty claim is what
   * gives them unrestricted access in PermissionsGuard. An unknown role
   * resolves to none too — the safe default.
   */
  async resolveCredentialPermissions(tenantId: string, credentialRole: string): Promise<string[]> {
    if (!credentialRole || isAdminTierCredentialRole(credentialRole)) return [FULL_ACCESS_PERMISSION];

    await this.ensureSystemRoles(tenantId);

    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const PermissionModel = await this.modelProvider.getPermissionModel(tenantId);
    const role = await RoleModel.findOne({
      where: { name: roleNameForCredentialRole(credentialRole) },
      include: [{ model: PermissionModel, through: { attributes: [] } }],
    });
    if (!role) return [];

    return (role.permissions ?? []).map((perm) => `${perm.resource}.${perm.action}`);
  }

  /**
   * Resolves the user's effective authorization from the tenant database:
   * User -> UserRole -> Role -> RolePermission -> Permission.
   *
   * Single source of truth for all authorization decisions.
   * If a user has multiple roles, their effective permissions are the union.
   * Organization Admin gets explicit full access (isFullAccess: true, permissions: ['*']).
   * An empty permissions list means no permissions.
   */
  async resolveEffectiveAuthorization(
    tenantId: string,
    email: string,
    credentialRole?: string,
  ): Promise<EffectiveAuthorization> {
    await this.ensureSystemRoles(tenantId);

    const UserModel = await this.modelProvider.getUserModel(tenantId);
    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const PermissionModel = await this.modelProvider.getPermissionModel(tenantId);
    const UserRoleModel = await this.modelProvider.getUserRoleModel(tenantId);

    let user = await UserModel.findOne({
      where: { email },
      include: [
        {
          model: RoleModel,
          include: [{ model: PermissionModel, through: { attributes: [] } }],
          through: { attributes: [] },
        },
      ],
    });

    // Backward compatibility & safe auto-migration:
    // 1. If tenant user doesn't exist yet, but credential exists (e.g. Org Admin registering before activation):
    if (!user) {
      if (credentialRole && isAdminTierCredentialRole(credentialRole)) {
        const adminRole = await RoleModel.findOne({ where: { name: ORG_ADMIN_ROLE_NAME } });
        user = await UserModel.create({
          email,
          firstName: 'Admin',
          lastName: '',
          isActive: true,
        });
        if (adminRole) {
          await UserRoleModel.findOrCreate({
            where: { userId: user.id, roleId: adminRole.id },
            defaults: { userId: user.id, roleId: adminRole.id },
          });
        }
        user = await UserModel.findByPk(user.id, {
          include: [
            {
              model: RoleModel,
              include: [{ model: PermissionModel, through: { attributes: [] } }],
              through: { attributes: [] },
            },
          ],
        });
      }
    } else if ((!user.roles || user.roles.length === 0) && credentialRole) {
      // 2. Legacy user exists in tenant DB but has no rows in user_roles yet:
      const targetRoleName = roleNameForCredentialRole(credentialRole);
      let matchedRole = await RoleModel.findOne({ where: { name: targetRoleName } });
      if (!matchedRole && isAdminTierCredentialRole(credentialRole)) {
        matchedRole = await RoleModel.findOne({ where: { name: ORG_ADMIN_ROLE_NAME } });
      }
      if (matchedRole) {
        await UserRoleModel.findOrCreate({
          where: { userId: user.id, roleId: matchedRole.id },
          defaults: { userId: user.id, roleId: matchedRole.id },
        });
        user = await UserModel.findByPk(user.id, {
          include: [
            {
              model: RoleModel,
              include: [{ model: PermissionModel, through: { attributes: [] } }],
              through: { attributes: [] },
            },
          ],
        });
      }
    }

    if (!user) {
      return {
        userId: null,
        isActive: false,
        roles: [],
        roleIds: [],
        permissions: [],
        isFullAccess: false,
        primaryRole: credentialRole,
      };
    }

    const roles = user.roles || [];
    const roleNames = roles.map((r) => r.name);
    const roleIds = roles.map((r) => r.id);

    const isFullAccess =
      roleNames.includes(ORG_ADMIN_ROLE_NAME) ||
      roleNames.some((r) => ['admin', 'organization_admin'].includes(r.toLowerCase()));

    const permissionSet = new Set<string>();
    if (isFullAccess) {
      permissionSet.add(FULL_ACCESS_PERMISSION);
    } else {
      for (const role of roles) {
        for (const perm of role.permissions || []) {
          permissionSet.add(`${perm.resource}.${perm.action}`);
        }
      }
    }

    let primaryRole = credentialRole;
    if (roleNames.includes(ORG_ADMIN_ROLE_NAME)) {
      primaryRole = ORG_ADMIN_ROLE_NAME;
    } else if (roleNames.length > 0) {
      primaryRole = roleNames[0];
    }

    return {
      userId: user.id,
      isActive: user.isActive,
      roles: roleNames,
      roleIds,
      permissions: Array.from(permissionSet),
      isFullAccess,
      primaryRole,
      // Full access is never narrowed; otherwise the widest scope any of the
      // user's roles grants, so adding a role can only widen what they see.
      dataScope: isFullAccess
        ? DataScope.ORGANIZATION
        : widestDataScope(roles.map((role) => effectiveRoleScope(role))),
    };
  }
}
