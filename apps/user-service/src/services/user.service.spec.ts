import { BadRequestException } from '@nestjs/common';
import { UserService } from './user.service';

describe('UserService - Role Assignment & Tenant Isolation', () => {
  const TENANT_A = '11111111-1111-4111-8111-111111111111';
  const TENANT_B = '22222222-2222-4222-8222-222222222222';
  const USER_ID = '33333333-3333-4333-8333-333333333333';
  const ROLE_1 = 'role-1111-1111-1111-111111111111';
  const ROLE_2 = 'role-2222-2222-2222-222222222222';

  let userService: UserService;
  let modelProvider: any;
  let tenantContextService: any;
  let directory: any;

  let mockUserModel: any;
  let mockRoleModel: any;
  let mockUserRoleModel: any;
  let mockTransaction: any;

  beforeEach(() => {
    mockTransaction = {
      commit: jest.fn(),
      rollback: jest.fn(),
    };

    mockUserModel = {
      findOne: jest.fn(),
      findByPk: jest.fn(),
      create: jest.fn(),
      sequelize: {
        transaction: jest.fn().mockImplementation((cb) => cb(mockTransaction)),
      },
    };

    mockRoleModel = {
      findAll: jest.fn(),
      findByPk: jest.fn(),
      findOne: jest.fn(),
    };

    mockUserRoleModel = {
      findOne: jest.fn(),
      create: jest.fn(),
      destroy: jest.fn(),
    };

    modelProvider = {
      getUserModel: jest.fn().mockResolvedValue(mockUserModel),
      getRoleModel: jest.fn().mockResolvedValue(mockRoleModel),
      getUserRoleModel: jest.fn().mockResolvedValue(mockUserRoleModel),
      getConnection: jest.fn().mockResolvedValue({
        transaction: jest.fn().mockResolvedValue(mockTransaction),
      }),
    };

    tenantContextService = {
      run: jest.fn().mockImplementation((_, fn) => fn()),
    };

    directory = {
      emitUpsert: jest.fn().mockResolvedValue(undefined),
      emitDelete: jest.fn().mockResolvedValue(undefined),
      flush: jest.fn().mockResolvedValue(undefined),
    };

    userService = new UserService(modelProvider, tenantContextService, directory);
  });

  describe('Role Assignment (User -> Role)', () => {
    it('successfully replaces user roles using setUserRoles', async () => {
      mockUserModel.findByPk.mockResolvedValue({
        id: USER_ID,
        email: 'dev@acme.com',
        roles: [{ id: ROLE_1 }, { id: ROLE_2 }],
      });

      // Both role IDs exist in this tenant DB
      mockRoleModel.findAll.mockResolvedValue([
        { id: ROLE_1, name: 'Developer' },
        { id: ROLE_2, name: 'Team Lead' },
      ]);

      const result = await userService.setUserRoles(TENANT_A, USER_ID, [ROLE_1, ROLE_2]);

      expect(modelProvider.getRoleModel).toHaveBeenCalledWith(TENANT_A);
      expect(mockUserRoleModel.destroy).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        transaction: mockTransaction,
      });
      expect(mockUserRoleModel.create).toHaveBeenCalledWith(
        { userId: USER_ID, roleId: ROLE_1 },
        { transaction: mockTransaction },
      );
      expect(mockUserRoleModel.create).toHaveBeenCalledWith(
        { userId: USER_ID, roleId: ROLE_2 },
        { transaction: mockTransaction },
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
      expect(result.id).toBe(USER_ID);
    });

    it('rejects role assignment when role IDs belong to another tenant or do not exist', async () => {
      mockUserModel.findByPk.mockResolvedValue({
        id: USER_ID,
        email: 'dev@acme.com',
      });

      // Role exists in Tenant B, but querying Tenant A returns empty
      mockRoleModel.findAll.mockResolvedValue([]);

      await expect(
        userService.setUserRoles(TENANT_A, USER_ID, ['foreign-role-from-tenant-b']),
      ).rejects.toThrow(BadRequestException);

      expect(mockUserRoleModel.create).not.toHaveBeenCalled();
    });
  });

  describe('User Creation with Default Role', () => {
    it('assigns default Employee role when createUser is called without roleIds', async () => {
      const createdUser = {
        id: USER_ID,
        email: 'newuser@acme.com',
      };
      mockUserModel.findOne.mockResolvedValue(null);
      mockUserModel.create.mockResolvedValue(createdUser);
      mockUserModel.findByPk.mockResolvedValue({
        ...createdUser,
        roles: [{ id: 'role-emp-id', name: 'Employee' }],
      });
      mockRoleModel.findOne.mockResolvedValue({
        id: 'role-emp-id',
        name: 'Employee',
      });

      await userService.createUser(TENANT_A, {
        email: 'newuser@acme.com',
        firstName: 'New',
        lastName: 'User',
      });

      expect(mockUserRoleModel.create).toHaveBeenCalledWith(
        { userId: USER_ID, roleId: 'role-emp-id' },
        { transaction: mockTransaction },
      );
    });
  });
});
