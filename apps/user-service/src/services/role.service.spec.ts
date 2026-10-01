import { BadRequestException } from '@nestjs/common';
import { RoleService } from './role.service';
import {
  FULL_ACCESS_PERMISSION,
  ORG_ADMIN_ROLE_NAME,
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
      findAll: jest.fn().mockResolvedValue([
        { id: 'role-org-admin', name: ORG_ADMIN_ROLE_NAME, permissionsConfigured: true, update: jest.fn() },
        { id: 'role-hr', name: 'HR', permissionsConfigured: true, update: jest.fn() },
        { id: 'role-emp', name: 'Employee', permissionsConfigured: true, update: jest.fn() },
      ]),
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

    it('assigns explicit full access to ORGANIZATION_ADMIN role with wildcard permission', async () => {
      mockUserModel.findOne.mockResolvedValue({
        id: 'user-admin',
        email: 'admin@acme.com',
        isActive: true,
        roles: [
          {
            id: 'role-admin',
            name: ORG_ADMIN_ROLE_NAME,
            permissions: [],
          },
        ],
      });

      const effective = await roleService.resolveEffectiveAuthorization(TENANT_A, 'admin@acme.com');

      expect(effective.isFullAccess).toBe(true);
      expect(effective.permissions).toEqual([FULL_ACCESS_PERMISSION]);
      expect(effective.primaryRole).toBe(ORG_ADMIN_ROLE_NAME);
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
  });
});
