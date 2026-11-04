import { EmployeeStatus } from '@app/common';
import { EmployeeService } from './employee.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const BRANCH = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

describe('EmployeeService: branch', () => {
  let employee: any;
  let branchModel: { findOne: jest.Mock };
  let service: EmployeeService;

  beforeEach(() => {
    employee = {
      id: EMPLOYEE,
      tenantId: TENANT,
      status: EmployeeStatus.ACTIVE,
      exitDate: null,
      email: 'ayesha@example.com',
      employeeCode: 'EMP-1',
      userId: null,
      update: jest.fn(async (patch: any) => Object.assign(employee, patch)),
    };
    branchModel = { findOne: jest.fn().mockResolvedValue({ id: BRANCH, isActive: true }) };
    const provider: any = {
      getEmployeeModel: jest.fn().mockResolvedValue({ findOne: jest.fn().mockResolvedValue(employee) }),
      getBranchModel: jest.fn().mockResolvedValue(branchModel),
    };
    const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
    const assetClearance: any = { assertCanLeave: jest.fn() };
    service = new EmployeeService(provider, {} as any, invitations, assetClearance);
    jest.spyOn(service, 'getOne').mockResolvedValue({} as any);
  });

  it('puts an employee in a branch', async () => {
    await service.update(TENANT, EMPLOYEE, { branchId: BRANCH } as any);

    expect(branchModel.findOne.mock.calls[0][0].where).toEqual({ id: BRANCH, tenantId: TENANT });
    expect(employee.update).toHaveBeenCalledWith(expect.objectContaining({ branchId: BRANCH }));
  });

  it('refuses a branch that is not in this organization', async () => {
    branchModel.findOne.mockResolvedValue(null);
    await expect(service.update(TENANT, EMPLOYEE, { branchId: BRANCH } as any)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Branch not found') });
    expect(employee.update).not.toHaveBeenCalled();
  });

  it('refuses an inactive branch', async () => {
    branchModel.findOne.mockResolvedValue({ id: BRANCH, isActive: false });
    await expect(service.update(TENANT, EMPLOYEE, { branchId: BRANCH } as any)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('inactive') });
    expect(employee.update).not.toHaveBeenCalled();
  });

  it('does not look a branch up when it is not being set', async () => {
    await service.update(TENANT, EMPLOYEE, { phone: '0300' } as any);
    expect(branchModel.findOne).not.toHaveBeenCalled();
    expect(employee.update.mock.calls[0][0].branchId).toBeUndefined();
  });
});
