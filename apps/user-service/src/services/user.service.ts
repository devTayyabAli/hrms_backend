import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { TenantContextService } from '@app/tenant-context';
import {
  buildPaginatedResult,
  ListBoundsInput,
  PaginatedResult,
  resolveListBounds,
} from '@app/common';
import { ProjectionEventType } from '@app/database';
import { User, Role } from '../models';
import { DirectoryEmitterService } from './directory-emitter.service';

export interface CreateUserData {
  email: string;
  passwordHash?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  department?: string;
  roleId?: string;
  roleIds?: string[];
  isActive?: boolean;
}

export interface UpdateUserData {
  email?: string;
  passwordHash?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  department?: string;
  isActive?: boolean;
}

@Injectable()
export class UserService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly tenantContextService: TenantContextService,
    private readonly directory: DirectoryEmitterService,
  ) {}

  /**
   * Create an Organization Admin User & assign ORGANIZATION_ADMIN role in tenant DB (Idempotent)
   */
  async createOrganizationAdminUser(data: {
    tenantId: string;
    email: string;
    firstName?: string;
    lastName?: string;
  }): Promise<User> {
    return this.tenantContextService.run({ tenantId: data.tenantId }, async () => {
      const UserModel = await this.modelProvider.getUserModel();
      const RoleModel = await this.modelProvider.getRoleModel();
      const UserRoleModel = await this.modelProvider.getUserRoleModel();

      let user = await UserModel.findOne({ where: { email: data.email } });
      if (!user) {
        user = await UserModel.create({
          email: data.email,
          firstName: data.firstName || 'Admin',
          lastName: data.lastName || '',
          isActive: true,
        });
      } else {
        await user.update({
          firstName: data.firstName || user.firstName,
          lastName: data.lastName || user.lastName,
          isActive: true,
        });
      }

      // Ensure ORGANIZATION_ADMIN role exists in tenant DB
      let adminRole = await RoleModel.findOne({ where: { name: 'ORGANIZATION_ADMIN' } });
      if (!adminRole) {
        adminRole = await RoleModel.findOne({ where: { name: 'Admin' } });
      }
      if (!adminRole) {
        adminRole = await RoleModel.create({
          name: 'ORGANIZATION_ADMIN',
          description: 'Organization Administrator with full tenant access',
          isSystemRole: true,
        });
      }

      // Idempotent Role assignment
      const existingUserRole = await UserRoleModel.findOne({
        where: { userId: user.id, roleId: adminRole.id },
      });
      if (!existingUserRole) {
        await UserRoleModel.create({
          userId: user.id,
          roleId: adminRole.id,
        });
      }

      return user;
    });
  }

  /**
   * Create an employee portal user & assign the portal role (HR | Employee) in
   * the tenant DB. Idempotent: mirrors createOrganizationAdminUser so a retried
   * activation converges instead of duplicating user/role rows.
   *
   * The role name comes from the invitation (already derived from designation
   * server-side) — never from client input.
   */
  async createEmployeeUser(data: {
    tenantId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    role: string;
  }): Promise<User> {
    return this.tenantContextService.run({ tenantId: data.tenantId }, async () => {
      const UserModel = await this.modelProvider.getUserModel();
      const RoleModel = await this.modelProvider.getRoleModel();
      const UserRoleModel = await this.modelProvider.getUserRoleModel();

      let user = await UserModel.findOne({ where: { email: data.email } });
      if (!user) {
        user = await UserModel.create({
          email: data.email,
          firstName: data.firstName || 'Employee',
          lastName: data.lastName || '',
          isActive: true,
        });
      } else {
        await user.update({
          firstName: data.firstName || user.firstName,
          lastName: data.lastName || user.lastName,
          isActive: true,
        });
      }

      // Ensure the portal role exists in tenant DB (get-or-create by name).
      let portalRole = await RoleModel.findOne({ where: { name: data.role } });
      if (!portalRole) {
        portalRole = await RoleModel.create({
          name: data.role,
          description:
            data.role === 'HR'
              ? 'Human Resources portal role'
              : 'Employee self-service portal role',
          isSystemRole: true,
        });
      }

      // Idempotent role assignment.
      const existingUserRole = await UserRoleModel.findOne({
        where: { userId: user.id, roleId: portalRole.id },
      });
      if (!existingUserRole) {
        await UserRoleModel.create({
          userId: user.id,
          roleId: portalRole.id,
        });
      }

      return user;
    });
  }

  /**
   * Create a user in the given tenant's database
   */
  async createUser(tenantId: string, data: CreateUserData): Promise<User> {
    const UserModel = await this.modelProvider.getUserModel(tenantId);
    const existing = await UserModel.findOne({ where: { email: data.email } });
    if (existing) {
      throw new BadRequestException(`User with email ${data.email} already exists`);
    }

    const UserRoleModel = await this.modelProvider.getUserRoleModel(tenantId);

    // The user row, its roles and the projection event commit together. A
    // partial commit here is what would leave the SuperAdmin directory
    // disagreeing with the tenant database.
    const user = await UserModel.sequelize!.transaction(async (transaction) => {
      const created = await UserModel.create(
        {
          email: data.email,
          passwordHash: data.passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          department: data.department,
          isActive: data.isActive ?? true,
        },
        { transaction },
      );

      let roleIds = data.roleIds || (data.roleId ? [data.roleId] : []);
      if (roleIds.length === 0) {
        const RoleModel = await this.modelProvider.getRoleModel(tenantId);
        const defaultRole = await RoleModel.findOne({ where: { name: 'Employee' } });
        if (defaultRole) {
          roleIds = [defaultRole.id];
        }
      }
      for (const rId of roleIds) {
        await UserRoleModel.create({ userId: created.id, roleId: rId }, { transaction });
      }

      return created;
    });

    const hydrated = await this.getUserById(tenantId, user.id);
    await this.emitDirectory(tenantId, hydrated, ProjectionEventType.CREATED);
    return hydrated;
  }

  /**
   * Queues a directory event and tries to apply it immediately.
   *
   * Never allowed to fail the caller: the tenant write has already committed,
   * and a projection that is briefly behind is a worse outcome to escalate
   * than to tolerate — the relay reconciles it either way.
   */
  private async emitDirectory(
    tenantId: string,
    user: User,
    eventType: ProjectionEventType,
  ): Promise<void> {
    try {
      await this.directory.emitUpsert(tenantId, user, eventType);
      await this.directory.flush(tenantId);
    } catch {
      // Logged inside the emitter; nothing actionable here.
    }
  }

  /**
   * Get user by ID with associated roles, scoped to the given tenant's database
   */
  async getUserById(tenantId: string, id: string): Promise<User> {
    const UserModel = await this.modelProvider.getUserModel(tenantId);
    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const user = await UserModel.findByPk(id, {
      include: [
        {
          model: RoleModel,
          through: { attributes: [] },
        },
      ],
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found in tenant database`);
    }

    return user;
  }

  /**
   * Get users in the given tenant's database, one bounded page at a time.
   *
   * Previously an unbounded `findAll` with the roles association eager-loaded:
   * every user row plus every one of their role rows, materialized in this
   * process and then serialized into a single TCP message. That is fine for
   * the ten-user tenants this was written against and is the largest single
   * response the service can produce once a tenant has real headcount.
   *
   * The page is capped rather than the caller's request being rejected, and
   * the return shape stays `User[]` so existing callers are unaffected — they
   * simply stop being able to ask for an unbounded read. `getAllUsersPage()`
   * is there for callers that need the total alongside the rows.
   */
  async getAllUsers(
    tenantId: string,
    bounds?: ListBoundsInput,
  ): Promise<User[]> {
    const { rows } = await this.getAllUsersPage(tenantId, bounds);
    return rows;
  }

  /**
   * As `getAllUsers`, but returns the page together with the total row count
   * so a caller can render "showing 1-200 of N" and page through.
   *
   * Ordered by `createdAt` with `id` as a tiebreaker: without a deterministic
   * ORDER BY, Postgres is free to return rows in any order it likes between
   * two queries, so a row can appear on two consecutive pages or on neither.
   */
  async getAllUsersPage(
    tenantId: string,
    bounds?: ListBoundsInput,
  ): Promise<PaginatedResult<User>> {
    const UserModel = await this.modelProvider.getUserModel(tenantId);
    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const resolved = resolveListBounds(bounds);

    const { rows, count } = await UserModel.findAndCountAll({
      include: [
        {
          model: RoleModel,
          through: { attributes: [] },
        },
      ],
      order: [
        ['createdAt', 'DESC'],
        ['id', 'ASC'],
      ],
      limit: resolved.limit,
      offset: resolved.offset,
      // Makes `count` COUNT(DISTINCT id) — the number of users — rather than
      // the number of rows in the user×role join product, which is what a
      // belongsToMany include otherwise produces. Without it a user with
      // three roles is counted three times and the caller pages through a
      // total that does not exist.
      //
      // The page itself is already correct: Sequelize applies the LIMIT in a
      // subquery when a limit is combined with a to-many include.
      distinct: true,
    });

    return buildPaginatedResult(rows, count, resolved);
  }

  /**
   * Update a user in the given tenant's database
   */
  async updateUser(tenantId: string, id: string, data: UpdateUserData): Promise<User> {
    const user = await this.getUserById(tenantId, id);
    await user.update(data);
    const updated = await this.getUserById(tenantId, id);
    await this.emitDirectory(tenantId, updated, ProjectionEventType.UPDATED);
    return updated;
  }

  /**
   * Delete a user from the given tenant's database
   */
  async deleteUser(tenantId: string, id: string): Promise<void> {
    const user = await this.getUserById(tenantId, id);
    const UserRoleModel = await this.modelProvider.getUserRoleModel(tenantId);
    const Outbox = await this.modelProvider.getProjectionOutboxModel(tenantId);

    // The DELETED event commits with the delete, so a crash cannot leave the
    // person listed on the SuperAdmin directory after they are gone here.
    await Outbox.sequelize!.transaction(async (transaction) => {
      await UserRoleModel.destroy({ where: { userId: id }, transaction });
      await user.destroy({ transaction });
      await this.directory.emitDelete(tenantId, id, transaction);
    });

    await this.directory.flush(tenantId).catch(() => undefined);
  }

  /**
   * Assign a role to a user
   */
  async assignRole(tenantId: string, userId: string, roleId: string): Promise<void> {
    await this.getUserById(tenantId, userId);
    const RoleModel = await this.modelProvider.getRoleModel(tenantId);
    const role = await RoleModel.findByPk(roleId);
    if (!role) {
      throw new NotFoundException(`Role ${roleId} not found`);
    }

    const UserRoleModel = await this.modelProvider.getUserRoleModel(tenantId);
    const existing = await UserRoleModel.findOne({ where: { userId, roleId } });
    if (!existing) {
      await UserRoleModel.create({ userId, roleId });
    }

    // roleCategory is derived from the primary role, so the directory row is
    // stale now even though the user row itself did not change — and
    // roleCategory is what the Clients list filters on.
    await this.emitDirectory(
      tenantId,
      await this.getUserById(tenantId, userId),
      ProjectionEventType.UPDATED,
    );
  }

  /**
   * Revoke a role from a user
   */
  async revokeRole(tenantId: string, userId: string, roleId: string): Promise<void> {
    await this.getUserById(tenantId, userId);
    const UserRoleModel = await this.modelProvider.getUserRoleModel(tenantId);
    await UserRoleModel.destroy({ where: { userId, roleId } });

    await this.emitDirectory(
      tenantId,
      await this.getUserById(tenantId, userId),
      ProjectionEventType.UPDATED,
    );
  }

  /**
   * Bulk set/replace roles assigned to a user in the given tenant's database
   */
  async setUserRoles(tenantId: string, userId: string, roleIds: string[]): Promise<User> {
    const user = await this.getUserById(tenantId, userId);
    const RoleModel = await this.modelProvider.getRoleModel(tenantId);

    // Verify all roleIds belong to current tenant database
    const validRoles = await RoleModel.findAll({ where: { id: roleIds } });
    if (validRoles.length !== roleIds.length) {
      throw new BadRequestException(
        'One or more specified role IDs do not exist in the current organization tenant database.',
      );
    }

    const sequelize = await this.modelProvider.getConnection(tenantId);
    const transaction = await sequelize.transaction();

    try {
      const UserRoleModel = await this.modelProvider.getUserRoleModel(tenantId);
      await UserRoleModel.destroy({ where: { userId }, transaction });

      for (const rId of roleIds) {
        await UserRoleModel.create({ userId, roleId: rId }, { transaction });
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const updated = await this.getUserById(tenantId, userId);
    await this.emitDirectory(tenantId, updated, ProjectionEventType.UPDATED);
    return updated;
  }
}
