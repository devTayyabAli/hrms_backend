import { Op } from 'sequelize';
import { ApprovalPolicyService } from './approval-policy.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DIRECTOR = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

describe('ApprovalPolicyService', () => {
  let saved: any;
  let policyModel: any;
  let employeeModel: any;
  let settingModel: any;
  let auditModel: { create: jest.Mock };
  let service: ApprovalPolicyService;

  const row = (stages: any[]) => {
    const r: any = { stages, updatedAt: new Date('2026-11-01'), updatedByEmail: 'admin@example.com' };
    r.update = jest.fn(async (patch: any) => Object.assign(r, patch));
    r.destroy = jest.fn(async () => {
      saved = null;
    });
    return r;
  };

  beforeEach(() => {
    saved = null;
    policyModel = {
      findOne: jest.fn(async () => saved),
      create: jest.fn(async (values: any) => {
        saved = row(values.stages);
        return saved;
      }),
    };
    employeeModel = { findAll: jest.fn(async () => [{ id: DIRECTOR, firstName: 'Dina', lastName: 'Shah' }]) };
    settingModel = { findOne: jest.fn().mockResolvedValue(null) };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getApprovalPolicyModel: async () => policyModel,
      getEmployeeModel: async () => employeeModel,
      getApprovalSettingModel: async () => settingModel,
      getEntityAuditLogModel: async () => auditModel,
    };
    service = new ApprovalPolicyService(provider);
  });

  describe('reading', () => {
    it('shows the built-in route for leave until one is saved, and employee requests as the two-step setting', async () => {
      const { data, limits } = await service.list(TENANT);

      expect(data[0]).toMatchObject({ requestType: 'LEAVE', editable: true, isDefault: true, updatedAt: null });
      expect(data[0].stages.map((s: any) => s.label)).toEqual(['Reporting manager', 'Reporting manager, 2 levels up']);
      expect(data.map((d: any) => d.requestType)).toEqual(['LEAVE', 'REIMBURSEMENT', 'SALARY_REVISION', 'FINAL_SETTLEMENT', 'EMPLOYEE_REQUEST']);
      expect(data[0]).toMatchObject({ approvalRequired: true });
      // Reimbursements and salary changes have no route until the organization saves one.
      expect(data[1]).toMatchObject({ requestType: 'REIMBURSEMENT', editable: true, isDefault: true, approvalRequired: false, stages: [] });
      expect(data[2]).toMatchObject({ requestType: 'SALARY_REVISION', editable: true, isDefault: true, approvalRequired: false, stages: [] });
      // A final settlement is always approved: by anyone with payroll.approve until the organization chooses.
      expect(data[3]).toMatchObject({ requestType: 'FINAL_SETTLEMENT', editable: true, isDefault: true, approvalRequired: true });
      expect(data[3].stages.map((s: any) => [s.kind, s.permission])).toEqual([['PERMISSION', 'payroll.approve']]);
      expect(data[4]).toMatchObject({ requestType: 'EMPLOYEE_REQUEST', editable: true, isDefault: true, managedBy: 'approval-flow', flow: 'SINGLE' });
      expect(data[4].stages.map((s: any) => s.kind)).toEqual(['HR']);
      expect(limits).toEqual({ maxStages: 3, maxManagerLevel: 3 });
    });

    it('shows the manager step for the manager-then-HR setting', async () => {
      settingModel.findOne.mockResolvedValue({ flow: 'MANAGER_THEN_HR' });
      const { data } = await service.list(TENANT);
      expect((data[4] as any).flow).toBe('MANAGER_THEN_HR');
      expect(data[4].stages.map((s: any) => s.kind)).toEqual(['REPORTING_MANAGER', 'HR']);
    });

    it('shows a saved route with the names of the people in it', async () => {
      saved = row([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'EMPLOYEE', employeeId: DIRECTOR }, { kind: 'PERMISSION', permission: 'payroll.approve' }]);

      const { data } = await service.list(TENANT);

      expect(data[0]).toMatchObject({ isDefault: false, updatedBy: 'admin@example.com' });
      expect(data[0].stages.map((s: any) => s.label)).toEqual(['Reporting manager', 'Dina Shah (named approver)', 'Anyone with payroll.approve']);
    });
  });

  describe('saving', () => {
    const save = (stages: any[]) => service.update(TENANT, 'LEAVE', { stages } as any, 'admin@example.com');

    it('saves a route, records who and what changed, and shows it', async () => {
      const result = await save([{ kind: 'REPORTING_MANAGER' }, { kind: 'DEPARTMENT_HEAD' }, { kind: 'HR' }]);

      expect(policyModel.create).toHaveBeenCalledWith({
        tenantId: TENANT,
        requestType: 'LEAVE',
        stages: [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'DEPARTMENT_HEAD' }, { kind: 'HR' }],
        updatedByEmail: 'admin@example.com',
      });
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({ tableName: 'approval_policies', action: 'UPDATE' });
      expect(result).toMatchObject({ requestType: 'LEAVE', isDefault: false });
    });

    it('replaces the route that was saved', async () => {
      saved = row([{ kind: 'HR' }]);
      const existing = saved;
      await save([{ kind: 'REPORTING_MANAGER', level: 2 }]);
      expect(existing.update).toHaveBeenCalledWith({ stages: [{ kind: 'REPORTING_MANAGER', level: 2 }], updatedByEmail: 'admin@example.com' });
      expect(policyModel.create).not.toHaveBeenCalled();
    });

    it('checks the named approver is someone who works here', async () => {
      await save([{ kind: 'EMPLOYEE', employeeId: DIRECTOR }]);
      expect(employeeModel.findAll.mock.calls[0][0].where).toMatchObject({ id: { [Op.in]: [DIRECTOR] }, tenantId: TENANT });

      employeeModel.findAll.mockResolvedValueOnce([]);
      await expect(save([{ kind: 'EMPLOYEE', employeeId: DIRECTOR }])).rejects.toMatchObject({ status: 400, message: expect.stringContaining('named approver') });
    });

    it.each([
      ['a stage that needs a person but names none', [{ kind: 'EMPLOYEE' }], 'choose the person'],
      ['a permission stage with no permission', [{ kind: 'PERMISSION' }], 'choose the permission'],
      ['a level on a kind that has none', [{ kind: 'HR', level: 2 }], 'does not apply'],
      ['a person on a permission stage', [{ kind: 'PERMISSION', permission: 'a.b', employeeId: DIRECTOR }], 'does not apply'],
      ['the same manager level twice', [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER' }], 'already a stage'],
      ['the department head twice', [{ kind: 'DEPARTMENT_HEAD' }, { kind: 'DEPARTMENT_HEAD' }], 'already a stage'],
      ['the same person twice', [{ kind: 'EMPLOYEE', employeeId: DIRECTOR }, { kind: 'EMPLOYEE', employeeId: DIRECTOR }], 'already a stage'],
      ['HR before the last stage', [{ kind: 'HR' }, { kind: 'REPORTING_MANAGER' }], 'only be the last'],
    ])('refuses %s', async (_name, stages, message) => {
      await expect(save(stages as any[])).rejects.toMatchObject({ status: 400, message: expect.stringContaining(message) });
      expect(policyModel.create).not.toHaveBeenCalled();
    });

    it('lets a salary change be approved only by people holding a permission', async () => {
      await expect(service.update(TENANT, 'SALARY_REVISION', { stages: [{ kind: 'REPORTING_MANAGER' }, { kind: 'PERMISSION', permission: 'payroll.compensation.approve' }] } as any)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('permission stages'),
      });

      const result = await service.update(TENANT, 'SALARY_REVISION', { stages: [{ kind: 'PERMISSION', permission: 'payroll.compensation.approve' }, { kind: 'PERMISSION', permission: 'payroll.approve' }] } as any, 'admin@example.com');
      expect(result).toMatchObject({ requestType: 'SALARY_REVISION', isDefault: false, approvalRequired: true });
      expect(result.stages.map((s: any) => s.label)).toEqual(['Anyone with payroll.compensation.approve', 'Anyone with payroll.approve']);
    });

    it('lets a final settlement be approved only by people holding a permission', async () => {
      await expect(service.update(TENANT, 'FINAL_SETTLEMENT', { stages: [{ kind: 'HR' }] } as any)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('permission stages') });
      const result = await service.update(TENANT, 'FINAL_SETTLEMENT', { stages: [{ kind: 'PERMISSION', permission: 'payroll.approve' }, { kind: 'PERMISSION', permission: 'payroll.manage' }] } as any);
      expect(result.stages).toHaveLength(2);
    });

    it('lets a reimbursement pass through managers but end with payroll', async () => {
      await expect(service.update(TENANT, 'REIMBURSEMENT', { stages: [{ kind: 'REPORTING_MANAGER' }] } as any)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('end with a permission stage') });
      await expect(service.update(TENANT, 'REIMBURSEMENT', { stages: [{ kind: 'REPORTING_MANAGER' }, { kind: 'HR' }] } as any)).rejects.toMatchObject({ status: 400 });

      const result = await service.update(TENANT, 'REIMBURSEMENT', { stages: [{ kind: 'REPORTING_MANAGER' }, { kind: 'PERMISSION', permission: 'payroll.adjustments.manage' }] } as any);
      expect(result.stages.map((s: any) => s.kind)).toEqual(['REPORTING_MANAGER', 'PERMISSION']);
    });

    it('goes back to no approval for a reimbursement when it is reset', async () => {
      await service.update(TENANT, 'REIMBURSEMENT', { stages: [{ kind: 'PERMISSION', permission: 'payroll.adjustments.manage' }] } as any);
      const result = await service.reset(TENANT, 'REIMBURSEMENT');
      expect(result).toMatchObject({ isDefault: true, approvalRequired: false, stages: [] });
    });

    it('gives employee requests their own route, which replaces the approval-flow setting until reset', async () => {
      await expect(service.update(TENANT, 'EMPLOYEE_REQUEST', { stages: [{ kind: 'REPORTING_MANAGER' }] } as any)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('end with HR') });
      const saved = await service.update(TENANT, 'EMPLOYEE_REQUEST', { stages: [{ kind: 'REPORTING_MANAGER' }, { kind: 'HR' }] } as any);
      expect(saved).toMatchObject({ requestType: 'EMPLOYEE_REQUEST', isDefault: false, managedBy: 'policy', approvalRequired: true });
      expect(saved.stages.map((s: any) => s.kind)).toEqual(['REPORTING_MANAGER', 'HR']);

      const back = await service.reset(TENANT, 'EMPLOYEE_REQUEST');
      expect(back).toMatchObject({ isDefault: true, managedBy: 'approval-flow', flow: 'SINGLE' });
    });

    it('refuses an unknown type', async () => {
      await expect(service.update(TENANT, 'PAYROLL', { stages: [{ kind: 'HR' }] } as any)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('going back to the built-in route', () => {
    it('removes what was saved and records it', async () => {
      saved = row([{ kind: 'HR' }]);
      const existing = saved;

      const result = await service.reset(TENANT, 'LEAVE', 'admin@example.com');

      expect(existing.destroy).toHaveBeenCalled();
      expect(auditModel.create).toHaveBeenCalled();
      expect(result).toMatchObject({ isDefault: true });
    });

    it('does nothing when nothing was saved', async () => {
      await service.reset(TENANT, 'LEAVE');
      expect(auditModel.create).not.toHaveBeenCalled();
    });
  });
});
