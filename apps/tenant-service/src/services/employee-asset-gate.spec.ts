import { EmployeeStatus, TenantErrorCode, TenantException } from '@app/common';
import { EmployeeService } from './employee.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

const blocked = () =>
  new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Asset clearance is not complete. 1 asset is still with Ayesha Khan: AST-0001.', 409);

/**
 * Leaving the company is gated on assets: an employee cannot be marked Resigned
 * (by either route that changes a status) while equipment is with them or the
 * clearance is unsettled, and cannot be deleted while they hold assets.
 */
describe('EmployeeService asset gates', () => {
  let employee: any;
  let employeeModel: any;
  let assetClearance: { assertCanLeave: jest.Mock; assertHoldsNoAssets: jest.Mock };
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
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    employeeModel = { findOne: jest.fn().mockResolvedValue(employee) };
    assetClearance = { assertCanLeave: jest.fn().mockResolvedValue(undefined), assertHoldsNoAssets: jest.fn().mockResolvedValue(undefined) };
    const provider: any = { getEmployeeModel: jest.fn().mockResolvedValue(employeeModel) };
    const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
    service = new EmployeeService(provider, {} as any, invitations, assetClearance as any);
    jest.spyOn(service, 'getOne').mockResolvedValue({} as any);
  });

  it('refuses to mark an employee Resigned while the asset clearance is not complete', async () => {
    assetClearance.assertCanLeave.mockRejectedValue(blocked());

    await expect(service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED)).rejects.toMatchObject({ status: 409 });

    expect(assetClearance.assertCanLeave).toHaveBeenCalledWith(TENANT, EMPLOYEE);
    expect(employee.update).not.toHaveBeenCalled();
  });

  it('lets a cleared employee be marked Resigned', async () => {
    await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED, '2026-10-31');

    expect(assetClearance.assertCanLeave).toHaveBeenCalledTimes(1);
    expect(employee.update).toHaveBeenCalledWith({ status: EmployeeStatus.RESIGNED, exitDate: '2026-10-31' });
  });

  it('does not ask about assets for any other status, or for someone who is already Resigned', async () => {
    await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.ON_LEAVE);
    employee.status = EmployeeStatus.RESIGNED;
    await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED);

    expect(assetClearance.assertCanLeave).not.toHaveBeenCalled();
  });

  it('applies the same gate when the status is changed through the general edit', async () => {
    assetClearance.assertCanLeave.mockRejectedValue(blocked());

    await expect(service.update(TENANT, EMPLOYEE, { status: EmployeeStatus.RESIGNED } as any)).rejects.toMatchObject({ status: 409 });

    expect(employee.update).not.toHaveBeenCalled();
  });

  describe('offboarding when someone leaves', () => {
    let offboarding: { assertCanLeave: jest.Mock; completeForExit: jest.Mock; lastWorkingDayOf: jest.Mock };

    beforeEach(() => {
      offboarding = {
        assertCanLeave: jest.fn().mockResolvedValue(undefined),
        completeForExit: jest.fn().mockResolvedValue(undefined),
        lastWorkingDayOf: jest.fn().mockResolvedValue('2026-12-15'),
      };
      const provider: any = { getEmployeeModel: jest.fn().mockResolvedValue(employeeModel) };
      const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
      service = new EmployeeService(provider, {} as any, invitations, assetClearance as any, undefined, undefined, undefined, undefined, undefined, offboarding as any);
      jest.spyOn(service, 'getOne').mockResolvedValue({} as any);
    });

    it('asks whether their offboarding is cleared, before marking them Resigned', async () => {
      offboarding.assertCanLeave.mockRejectedValue(new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Offboarding is not cleared yet.', 409));

      await expect(service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED)).rejects.toMatchObject({ status: 409 });
      await expect(service.update(TENANT, EMPLOYEE, { status: EmployeeStatus.RESIGNED } as any)).rejects.toMatchObject({ status: 409 });

      expect(employee.update).not.toHaveBeenCalled();
      expect(offboarding.completeForExit).not.toHaveBeenCalled();
    });

    it('uses the last working day of their offboarding as the exit date, unless one is given', async () => {
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED);
      expect(employee.update).toHaveBeenCalledWith({ status: EmployeeStatus.RESIGNED, exitDate: '2026-12-15' });

      employee.status = EmployeeStatus.ACTIVE;
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED, '2026-12-01');
      expect(employee.update).toHaveBeenLastCalledWith({ status: EmployeeStatus.RESIGNED, exitDate: '2026-12-01' });
    });

    it('completes their offboarding once they are Resigned', async () => {
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED);
      expect(offboarding.completeForExit).toHaveBeenCalledWith(TENANT, EMPLOYEE);
    });

    it('does not ask for any other status, or for someone who has already left', async () => {
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.INACTIVE);
      employee.status = EmployeeStatus.RESIGNED;
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED);
      expect(offboarding.assertCanLeave).not.toHaveBeenCalled();
      expect(offboarding.completeForExit).not.toHaveBeenCalled();
    });

    it('does not undo the exit when completing the offboarding fails', async () => {
      offboarding.completeForExit.mockRejectedValue(new Error('db down'));
      await expect(service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED)).resolves.toBeDefined();
      expect(employee.update).toHaveBeenCalled();
    });
  });

  describe('open courses when someone leaves', () => {
    let learning: { cancelOpenForExit: jest.Mock };

    beforeEach(() => {
      learning = { cancelOpenForExit: jest.fn().mockResolvedValue(2) };
      const provider: any = { getEmployeeModel: jest.fn().mockResolvedValue(employeeModel) };
      const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
      service = new EmployeeService(provider, {} as any, invitations, assetClearance as any, undefined, undefined, undefined, learning as any);
      jest.spyOn(service, 'getOne').mockResolvedValue({} as any);
    });

    it('withdraws them when the status changes to Resigned', async () => {
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED, '2026-10-31');
      expect(learning.cancelOpenForExit).toHaveBeenCalledWith(TENANT, EMPLOYEE);
    });

    it('withdraws them through the general edit too', async () => {
      await service.update(TENANT, EMPLOYEE, { status: EmployeeStatus.RESIGNED } as any);
      expect(learning.cancelOpenForExit).toHaveBeenCalledWith(TENANT, EMPLOYEE);
    });

    it('leaves them alone for any other status, or when already Resigned', async () => {
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.INACTIVE);
      employee.status = EmployeeStatus.RESIGNED;
      await service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED);
      expect(learning.cancelOpenForExit).not.toHaveBeenCalled();
    });

    it('does not undo the exit when withdrawing fails', async () => {
      learning.cancelOpenForExit.mockRejectedValue(new Error('db down'));
      await expect(service.updateStatus(TENANT, EMPLOYEE, EmployeeStatus.RESIGNED)).resolves.toBeDefined();
      expect(employee.update).toHaveBeenCalled();
    });
  });

  describe('deleting an employee who has work history', () => {
    let workspaceTasks: { workHistoryOf: jest.Mock };
    let payrollModel: { count: jest.Mock };

    beforeEach(() => {
      workspaceTasks = { workHistoryOf: jest.fn().mockResolvedValue({ tasks: 0, projectsOwned: 0 }) };
      payrollModel = { count: jest.fn().mockResolvedValue(0) };
      const provider: any = {
        getEmployeeModel: jest.fn().mockResolvedValue({
          ...employeeModel,
          findAll: jest.fn().mockResolvedValue([{ id: EMPLOYEE, userId: null, email: 'ayesha@example.com' }]),
        }),
        getPayrollRecordModel: jest.fn().mockResolvedValue(payrollModel),
        getDepartmentModel: jest.fn().mockResolvedValue({}),
        getDesignationModel: jest.fn().mockResolvedValue({}),
      };
      const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
      // Constructor: …, assetClearance, dataScope, hierarchy, workspaceTasks.
      service = new EmployeeService(provider, {} as any, invitations, assetClearance as any, undefined, undefined, workspaceTasks as any);
    });

    it('refuses with the reason when they have tasks, and does not delete', async () => {
      workspaceTasks.workHistoryOf.mockResolvedValue({ tasks: 4, projectsOwned: 0 });

      await expect(service.remove(TENANT, EMPLOYEE)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('4 tasks in Projects & Tasks'),
      });
      expect(employee.destroy).not.toHaveBeenCalled();
      expect(assetClearance.assertHoldsNoAssets).not.toHaveBeenCalled();
    });

    it('names the projects they own and says to hand them over', async () => {
      workspaceTasks.workHistoryOf.mockResolvedValue({ tasks: 1, projectsOwned: 2 });

      await expect(service.remove(TENANT, EMPLOYEE)).rejects.toMatchObject({
        message: expect.stringMatching(/1 task and 2 projects they own.*Hand over their projects.*Resigned/s),
      });
    });

    it('refuses a bulk delete when any of them has work history', async () => {
      const OTHER = '99999999-9999-4999-8999-999999999999';
      (service as any).modelProvider.getEmployeeModel.mockResolvedValue({
        ...employeeModel,
        findAll: jest.fn().mockResolvedValue([
          { id: EMPLOYEE, userId: null, email: 'ayesha@example.com' },
          { id: OTHER, userId: null, email: 'bilal@example.com' },
        ]),
      });
      workspaceTasks.workHistoryOf.mockResolvedValue({ tasks: 2, projectsOwned: 0 });

      await expect(service.bulkRemove(TENANT, [EMPLOYEE, OTHER])).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('Some of these employees have 2 tasks'),
      });
      expect(workspaceTasks.workHistoryOf).toHaveBeenCalledWith(TENANT, [EMPLOYEE, OTHER]);
    });
  });

  describe('deleting an employee who has training records', () => {
    const arrange = (learningCount: number, work?: { tasks: number; projectsOwned: number }) => {
      const learningAssignments = { countFor: jest.fn().mockResolvedValue(learningCount) };
      const workspaceTasks = work ? { workHistoryOf: jest.fn().mockResolvedValue(work) } : undefined;
      const provider: any = {
        getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
        getPayrollRecordModel: jest.fn().mockResolvedValue({ count: jest.fn().mockResolvedValue(0) }),
        getDepartmentModel: jest.fn().mockResolvedValue({}),
        getDesignationModel: jest.fn().mockResolvedValue({}),
      };
      const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
      // Constructor: ..., assetClearance, dataScope, hierarchy, workspaceTasks, learningAssignments.
      service = new EmployeeService(provider, {} as any, invitations, assetClearance as any, undefined, undefined, workspaceTasks as any, learningAssignments as any);
      return learningAssignments;
    };

    it('refuses with the reason, and does not delete', async () => {
      const learningAssignments = arrange(3);

      await expect(service.remove(TENANT, EMPLOYEE)).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/3 training records in Learning.*Mark them Resigned/s),
      });
      expect(employee.destroy).not.toHaveBeenCalled();
      expect(learningAssignments.countFor).toHaveBeenCalledWith(TENANT, [EMPLOYEE]);
    });

    it('names both when they have tasks and training', async () => {
      arrange(1, { tasks: 2, projectsOwned: 0 });

      await expect(service.remove(TENANT, EMPLOYEE)).rejects.toMatchObject({
        message: expect.stringContaining('2 tasks and 1 training record in Projects & Tasks and Learning'),
      });
    });
  });
});
