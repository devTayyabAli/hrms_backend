import { BadRequestException } from '@nestjs/common';
import { RoleService } from './role.service';
import {
  ADMIN_REQUIRED_PERMISSIONS,
  ADMINISTRATION_ROLE_NAME,
  FULL_ACCESS_PERMISSION,
  ORG_ADMIN_ROLE_NAME,
  SYSTEM_TENANT_ROLES,
} from '@app/common';

describe('RoleService - Authorization & Role Resolution', () => {
  const TENANT_A = '11111111-1111-4111-8111-111111111111';
  const TENANT_B = '22222222-2222-4222-8222-222222222222';

  let roleService: RoleService;
  let modelProvider: any;
  let permissionRegistry: any;

  let mockUserModel: any;
  let mockRoleModel: any;
  let mockPermissionModel: any;
  let mockUserRoleModel: any;
  let mockRolePermissionModel: any;

  beforeEach(() => {
    mockUserModel = {
      findOne: jest.fn(),
      findByPk: jest.fn(),
      create: jest.fn(),
    };

    mockRoleModel = {
      findOne: jest.fn(),
      findAll: jest.fn().mockResolvedValue(
        SYSTEM_TENANT_ROLES.map((def) => ({
          id: `role-${def.name}`,
          name: def.name,
          permissionsConfigured: true,
          dataScope: def.dataScope ?? null,
          update: jest.fn(),
        })),
      ),
      findByPk: jest.fn(),
      create: jest.fn().mockImplementation((data) => Promise.resolve({ ...data, id: 'mock-id', update: jest.fn() })),
    };

    mockPermissionModel = {
      findAll: jest.fn().mockResolvedValue([]),
    };

    mockUserRoleModel = {
      findOne: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      findOrCreate: jest.fn().mockResolvedValue([{}, true]),
      create: jest.fn(),
      destroy: jest.fn(),
    };

    mockRolePermissionModel = {
      create: jest.fn(),
      destroy: jest.fn(),
      // The admin role already has its rows: no upgrade seeding.
      count: jest.fn().mockResolvedValue(ADMIN_REQUIRED_PERMISSIONS.length),
    };

    modelProvider = {
      getUserModel: jest.fn().mockResolvedValue(mockUserModel),
      getRoleModel: jest.fn().mockResolvedValue(mockRoleModel),
      getPermissionModel: jest.fn().mockResolvedValue(mockPermissionModel),
      getUserRoleModel: jest.fn().mockResolvedValue(mockUserRoleModel),
      getRolePermissionModel: jest.fn().mockResolvedValue(mockRolePermissionModel),
      getConnection: jest.fn().mockResolvedValue({
        transaction: jest.fn().mockResolvedValue({
          commit: jest.fn(),
          rollback: jest.fn(),
        }),
      }),
    };

    permissionRegistry = {
      resolvePermissionIds: jest.fn().mockImplementation((_, ids) => Promise.resolve(ids)),
    };

    roleService = new RoleService(modelProvider, permissionRegistry);
  });

  describe('Effective Authorization Resolution (user_roles as Source of Truth)', () => {
    it('resolves User -> Role -> Permission for a user with single role', async () => {
      mockUserModel.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'priya@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-recruiter',
            name: 'Recruiter',
            permissions: [
              { resource: 'recruitment', action: 'view' },
              { resource: 'recruitment', action: 'create' },
            ],
          },
        ],
      });

      const effective = await roleService.resolveEffectiveAuthorization(TENANT_A, 'priya@acme.com');

      expect(effective.userId).toBe('user-1');
      expect(effective.isActive).toBe(true);
      expect(effective.roles).toEqual(['Recruiter']);
      expect(effective.roleIds).toEqual(['role-recruiter']);
      expect(effective.isFullAccess).toBe(false);
      expect(effective.permissions).toEqual(['recruitment.view', 'recruitment.create']);
    });

    it('unions and deduplicates permissions for a user with multiple roles', async () => {
      mockUserModel.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'alex@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-a',
            name: 'Role A',
            permissions: [
              { resource: 'employees', action: 'read' },
              { resource: 'employees', action: 'edit' },
            ],
          },
          {
            id: 'role-b',
            name: 'Role B',
            permissions: [
              { resource: 'employees', action: 'read' }, // duplicate
              { resource: 'attendance', action: 'read' },
              { resource: 'attendance', action: 'manage' },
            ],
          },
        ],
      });

      const effective = await roleService.resolveEffectiveAuthorization(TENANT_A, 'alex@acme.com');

      expect(effective.roles).toEqual(['Role A', 'Role B']);
      expect(effective.roleIds).toEqual(['role-a', 'role-b']);
      expect(effective.isFullAccess).toBe(false);
      expect(effective.permissions).toHaveLength(4);
      expect(effective.permissions).toEqual(
        expect.arrayContaining([
          'employees.read',
          'employees.edit',
          'attendance.read',
          'attendance.manage',
        ]),
      );
    });

    it('assigns explicit full access to ORGANIZATION_ADMIN, and not to Administration', async () => {
      mockUserModel.findOne.mockResolvedValueOnce({
        id: 'user-admin',
        email: 'admin@acme.com',
        isActive: true,
        roles: [{ id: 'role-admin', name: ORG_ADMIN_ROLE_NAME, permissions: [] }],
      });

      const admin = await roleService.resolveEffectiveAuthorization(TENANT_A, 'admin@acme.com');

      expect(admin.isFullAccess).toBe(true);
      expect(admin.permissions).toEqual([FULL_ACCESS_PERMISSION]);
      expect(admin.primaryRole).toBe(ORG_ADMIN_ROLE_NAME);
      expect(admin.dataScope).toBe('ORGANIZATION');

      mockUserModel.findOne.mockResolvedValueOnce({
        id: 'user-ops',
        email: 'ops@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-administration',
            name: ADMINISTRATION_ROLE_NAME,
            permissions: [
              { resource: 'settings', action: 'manage' },
              { resource: 'employee', action: 'view' },
            ],
          },
        ],
      });

      const ops = await roleService.resolveEffectiveAuthorization(TENANT_A, 'ops@acme.com');

      expect(ops.isFullAccess).toBe(false);
      expect(ops.permissions).toEqual(['settings.manage', 'employee.view']);
      expect(ops.permissions).not.toContain(FULL_ACCESS_PERMISSION);
      expect(ops.permissions).not.toContain('payroll.view');
    });

    it('returns empty permissions for non-admin user with no role permissions', async () => {
      mockUserModel.findOne.mockResolvedValue({
        id: 'user-empty',
        email: 'empty@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-guest',
            name: 'Guest',
            permissions: [],
          },
        ],
      });

      const effective = await roleService.resolveEffectiveAuthorization(TENANT_A, 'empty@acme.com');

      expect(effective.isFullAccess).toBe(false);
      expect(effective.permissions).toEqual([]);
    });

    it('removes permissions immediately when role permissions are updated', async () => {
      // Before update: Role A had employees.read and employees.edit
      mockUserModel.findOne.mockResolvedValueOnce({
        id: 'user-3',
        email: 'carol@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-a',
            name: 'Role A',
            permissions: [
              { resource: 'employees', action: 'read' },
              { resource: 'employees', action: 'edit' },
            ],
          },
        ],
      });

      const initial = await roleService.resolveEffectiveAuthorization(TENANT_A, 'carol@acme.com');
      expect(initial.permissions).toContain('employees.edit');

      // Admin removes employees.edit from Role A -> next resolution returns only employees.read
      mockUserModel.findOne.mockResolvedValueOnce({
        id: 'user-3',
        email: 'carol@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-a',
            name: 'Role A',
            permissions: [{ resource: 'employees', action: 'read' }],
          },
        ],
      });

      const refreshed = await roleService.resolveEffectiveAuthorization(TENANT_A, 'carol@acme.com');
      expect(refreshed.permissions).not.toContain('employees.edit');
      expect(refreshed.permissions).toEqual(['employees.read']);
    });

    it('auto-backfills legacy user without user_roles rows to credential role', async () => {
      mockUserModel.findOne.mockResolvedValueOnce({
        id: 'user-legacy',
        email: 'legacy@acme.com',
        isActive: true,
        roles: [], // No roles in user_roles yet
      });

      mockRoleModel.findOne.mockResolvedValue({
        id: 'role-emp-id',
        name: 'Employee',
      });

      mockUserModel.findByPk.mockResolvedValue({
        id: 'user-legacy',
        email: 'legacy@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-emp-id',
            name: 'Employee',
            permissions: [{ resource: 'profile', action: 'view' }],
          },
        ],
      });

      const effective = await roleService.resolveEffectiveAuthorization(
        TENANT_A,
        'legacy@acme.com',
        'Employee',
      );

      expect(mockUserRoleModel.findOrCreate).toHaveBeenCalledWith({
        where: { userId: 'user-legacy', roleId: 'role-emp-id' },
        defaults: { userId: 'user-legacy', roleId: 'role-emp-id' },
      });
      expect(effective.roles).toEqual(['Employee']);
      expect(effective.permissions).toEqual(['profile.view']);
    });
  });

  describe('Who holds a permission', () => {
    const role = (name: string, perms: string[], users: any[]) => ({
      id: `r-${name}`,
      name,
      permissions: perms.map((p) => ({ resource: p.split('.').slice(0, -1).join('.'), action: p.split('.').pop() })),
      users,
    });

    it('finds the active users whose roles grant it, the manage umbrella, and the organization admins', async () => {
      mockRoleModel.findAll.mockResolvedValue([
        role('Finance', ['payroll.approve'], [{ id: 'u1', email: 'fin@x.com', isActive: true }, { id: 'u2', email: 'gone@x.com', isActive: false }]),
        role('Payroll lead', ['payroll.manage'], [{ id: 'u3', email: 'lead@x.com', isActive: true }]),
        role('Viewer', ['payroll.view'], [{ id: 'u4', email: 'view@x.com', isActive: true }]),
        role(ORG_ADMIN_ROLE_NAME, [], [{ id: 'u5', email: 'admin@x.com', isActive: true }]),
      ]);

      const holders = await roleService.findPermissionHolders(TENANT_A, 'payroll.approve');

      expect(holders.map((h) => h.id).sort()).toEqual(['u1', 'u3', 'u5']);
    });

    it('lets payroll.manage stand in for a nested payroll permission', async () => {
      mockRoleModel.findAll.mockResolvedValue([role('Payroll lead', ['payroll.manage'], [{ id: 'u3', email: 'lead@x.com', isActive: true }])]);
      expect(await roleService.findPermissionHolders(TENANT_A, 'payroll.adjustments.manage')).toEqual([{ id: 'u3', email: 'lead@x.com' }]);
    });
  });

  describe('Tenant Isolation & Role Assignment', () => {
    it('scopes role lookup strictly to the requesting tenant database', async () => {
      await roleService.getRoleById(TENANT_A, 'some-role-id').catch(() => {});
      expect(modelProvider.getRoleModel).toHaveBeenCalledWith(TENANT_A);
      expect(modelProvider.getRoleModel).not.toHaveBeenCalledWith(TENANT_B);
    });

    it('prevents modifying protected system roles', async () => {
      mockRoleModel.findByPk.mockResolvedValue({
        id: 'admin-role-id',
        name: 'ORGANIZATION_ADMIN',
        isSystemRole: true,
      });

      await expect(
        roleService.updateRole(TENANT_A, 'admin-role-id', { name: 'New Name' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('lets an organization change a starter role’s data scope, not its name', async () => {
      const update = jest.fn().mockResolvedValue(undefined);
      mockRoleModel.findByPk.mockResolvedValue({
        id: 'team-lead-id',
        name: 'Team Lead',
        isSystemRole: true,
        dataScope: 'TEAM',
        update,
        permissions: [],
      });

      await expect(
        roleService.updateRole(TENANT_A, 'team-lead-id', { name: 'Supervisor' }),
      ).rejects.toThrow(BadRequestException);

      await roleService.updateRole(TENANT_A, 'team-lead-id', { dataScope: 'DEPARTMENT' as any });
      expect(update).toHaveBeenCalledWith({ dataScope: 'DEPARTMENT' });
    });

    it('keeps HR data scope fixed', async () => {
      mockRoleModel.findByPk.mockResolvedValue({
        id: 'hr-id',
        name: 'HR',
        isSystemRole: true,
        update: jest.fn(),
      });

      await expect(
        roleService.updateRole(TENANT_A, 'hr-id', { dataScope: 'TEAM' as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Administration role', () => {
    const administrationRole = () => ({
      id: 'administration-id',
      name: ADMINISTRATION_ROLE_NAME,
      isSystemRole: true,
      permissionsConfigured: true,
      update: jest.fn(),
      permissions: [],
    });

    it('lets Administration be edited, payroll included, but not stripped of roles and settings', async () => {
      mockRoleModel.findByPk.mockResolvedValue(administrationRole());

      await roleService.setRolePermissions(TENANT_A, 'administration-id', [
        ...ADMIN_REQUIRED_PERMISSIONS,
        'payroll.manage',
      ]);
      expect(mockRolePermissionModel.create).toHaveBeenCalledTimes(3);

      await expect(
        roleService.setRolePermissions(TENANT_A, 'administration-id', ['settings.manage', 'payroll.view']),
      ).rejects.toThrow(/user_management\.manage/);
    });

    it('refuses to edit the Organization Admin role', async () => {
      mockRoleModel.findByPk.mockResolvedValue({
        id: 'admin-role-id',
        name: ORG_ADMIN_ROLE_NAME,
        isSystemRole: true,
        update: jest.fn(),
        permissions: [],
      });

      await expect(
        roleService.setRolePermissions(TENANT_A, 'admin-role-id', [...ADMIN_REQUIRED_PERMISSIONS]),
      ).rejects.toThrow(/full access/);
      expect(mockRolePermissionModel.destroy).not.toHaveBeenCalled();
    });

    it('seeds Administration with the narrow default, and marks Organization Admin configured without grants', async () => {
      const createdAdmin = {
        id: 'admin-role-id',
        name: ORG_ADMIN_ROLE_NAME,
        permissionsConfigured: false,
        update: jest.fn(),
        permissions: [],
      };
      const createdOps = {
        id: 'administration-id',
        name: ADMINISTRATION_ROLE_NAME,
        permissionsConfigured: false,
        dataScope: 'ORGANIZATION',
        update: jest.fn(),
        permissions: [],
      };
      mockRoleModel.findAll.mockResolvedValue(
        SYSTEM_TENANT_ROLES.filter(
          (def) => def.name !== ORG_ADMIN_ROLE_NAME && def.name !== ADMINISTRATION_ROLE_NAME,
        ).map((def) => ({
          id: `role-${def.name}`,
          name: def.name,
          permissionsConfigured: true,
          dataScope: def.dataScope ?? null,
          update: jest.fn(),
        })),
      );
      mockRoleModel.create.mockImplementation((data: { name: string }) =>
        Promise.resolve(data.name === ORG_ADMIN_ROLE_NAME ? createdAdmin : createdOps),
      );
      mockRoleModel.findByPk.mockImplementation((id: string) =>
        Promise.resolve(id === 'admin-role-id' ? createdAdmin : createdOps),
      );

      await roleService.ensureSystemRoles(TENANT_A);

      expect(createdAdmin.update).toHaveBeenCalledWith({ permissionsConfigured: true });
      const ops = SYSTEM_TENANT_ROLES.find((def) => def.name === ADMINISTRATION_ROLE_NAME)!;
      expect(permissionRegistry.resolvePermissionIds).toHaveBeenCalledWith(TENANT_A, ops.defaultPermissions);
      expect(ops.defaultPermissions).toEqual(expect.arrayContaining(ADMIN_REQUIRED_PERMISSIONS));
      expect(ops.defaultPermissions.some((key) => key.startsWith('payroll'))).toBe(false);
      expect(ops.defaultPermissions.some((key) => key.startsWith('performance'))).toBe(false);
      // It sets the approval routes and sees who is leaving, but does not run offboarding or approve pay.
      expect(ops.defaultPermissions).toEqual(expect.arrayContaining(['workflows.manage', 'offboarding.view']));
      expect(ops.defaultPermissions).not.toContain('offboarding.manage');
      expect(ops.defaultPermissions).not.toContain('payroll.compensation.approve');
      expect(ops.locked).toBeUndefined();
    });

    it('gives a new HR role a view-only workspace, and leaves a configured role alone', async () => {
      const hr = SYSTEM_TENANT_ROLES.find((def) => def.name === 'HR');
      expect(hr?.defaultPermissions).toEqual(expect.arrayContaining(['tasks.view', 'projects.view']));
      expect(hr?.defaultPermissions).not.toContain('tasks.manage');
      expect(hr?.defaultPermissions).not.toContain('projects.manage');

      await roleService.ensureSystemRoles(TENANT_A);
      expect(permissionRegistry.resolvePermissionIds).not.toHaveBeenCalled();
    });

    it('does not reseed roles that are already configured', async () => {
      await roleService.ensureSystemRoles(TENANT_A);
      expect(permissionRegistry.resolvePermissionIds).not.toHaveBeenCalled();
    });

    it('gives an admin credential the wildcard, and reads Administration from its role', async () => {
      await expect(roleService.resolveCredentialPermissions(TENANT_A, 'Admin')).resolves.toEqual([
        FULL_ACCESS_PERMISSION,
      ]);

      mockRoleModel.findOne.mockResolvedValue({
        name: ADMINISTRATION_ROLE_NAME,
        permissions: [{ resource: 'settings', action: 'manage' }],
      });
      await expect(roleService.resolveCredentialPermissions(TENANT_A, ADMINISTRATION_ROLE_NAME)).resolves.toEqual([
        'settings.manage',
      ]);
    });
  });

  describe('starter roles', () => {
    it('seeds a missing starter once, with its scope and default permissions', async () => {
      const created = {
        id: 'finance-id',
        name: 'Finance',
        permissionsConfigured: false,
        dataScope: 'ORGANIZATION',
        update: jest.fn(),
        permissions: [],
      };
      mockRoleModel.findAll.mockResolvedValue(
        SYSTEM_TENANT_ROLES.filter((def) => def.name !== 'Finance').map((def) => ({
          id: `role-${def.name}`,
          name: def.name,
          permissionsConfigured: true,
          dataScope: def.dataScope ?? null,
          update: jest.fn(),
        })),
      );
      mockRoleModel.create.mockResolvedValue(created);
      mockRoleModel.findByPk.mockResolvedValue(created);

      await roleService.resolveEffectiveAuthorization(TENANT_A, 'nobody@acme.com');

      expect(mockRoleModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Finance',
          isSystemRole: true,
          dataScope: 'ORGANIZATION',
        }),
      );
      const finance = SYSTEM_TENANT_ROLES.find((def) => def.name === 'Finance');
      expect(permissionRegistry.resolvePermissionIds).toHaveBeenCalledWith(
        TENANT_A,
        finance?.defaultPermissions,
      );
    });
  });
});
