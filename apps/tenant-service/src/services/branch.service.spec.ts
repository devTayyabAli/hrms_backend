import { Op } from 'sequelize';
import { BranchService } from './branch.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LHE = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const KHI = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const BEN = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const ENG = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';

const row = (values: Record<string, any>) => {
  const r: any = { createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01'), ...values };
  r.get = () => ({ ...r });
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  r.destroy = jest.fn().mockResolvedValue(undefined);
  return r;
};

describe('BranchService', () => {
  let branchModel: any;
  let employeeModel: any;
  let departmentModel: any;
  let auditModel: { create: jest.Mock };
  let dataScope: { employeeWhere: jest.Mock };
  let service: BranchService;

  beforeEach(() => {
    branchModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (values: any) => row({ id: LHE, ...values })),
    };
    employeeModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({ id: ANNA, status: 'ACTIVE' }),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue([1]),
    };
    departmentModel = { findAll: jest.fn().mockResolvedValue([]) };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    dataScope = { employeeWhere: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getBranchModel: async () => branchModel,
      getEmployeeModel: async () => employeeModel,
      getDepartmentModel: async () => departmentModel,
      getEntityAuditLogModel: async () => auditModel,
    };
    service = new BranchService(provider, dataScope as any);
  });

  describe('the list', () => {
    it('shows each branch with its head and how many people work there, and who has no branch', async () => {
      branchModel.findAll
        .mockResolvedValueOnce([row({ id: LHE, name: 'Lahore HQ', code: 'LHE', city: 'Lahore', headEmployeeId: ANNA, isActive: true }), row({ id: KHI, name: 'Karachi', isActive: false })])
        .mockResolvedValueOnce([{ isActive: true }, { isActive: false }]);
      employeeModel.findAll
        .mockResolvedValueOnce([{ id: ANNA, firstName: 'Anna', lastName: 'Khan', employeeCode: 'E-1', avatarUrl: null }])
        .mockResolvedValueOnce([{ branchId: LHE, count: '12' }]);
      employeeModel.count.mockResolvedValue(3);

      const { data, summary } = await service.getBranches(TENANT, {});

      expect(data[0]).toMatchObject({ id: LHE, name: 'Lahore HQ', code: 'LHE', city: 'Lahore', isActive: true, employeeCount: 12, head: { employeeId: ANNA, name: 'Anna Khan', employeeCode: 'E-1' } });
      expect(data[1]).toMatchObject({ name: 'Karachi', isActive: false, employeeCount: 0, head: null });
      expect(summary).toEqual({ total: 2, active: 1, inactive: 1, employeesWithoutBranch: 3 });
    });

    it('filters by status and search', async () => {
      await service.getBranches(TENANT, { status: 'ACTIVE' as any, search: 'lah' });
      const where = branchModel.findAll.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: TENANT, isActive: true });
      expect(where[Op.or]).toHaveLength(3);
    });

    it('shows one branch with its departments', async () => {
      branchModel.findOne.mockResolvedValue(row({ id: LHE, name: 'Lahore HQ', headEmployeeId: null }));
      // A branch with no head looks no head up: the headcounts come first, then the departments.
      employeeModel.findAll.mockResolvedValueOnce([{ branchId: LHE, count: '5' }]).mockResolvedValueOnce([{ departmentId: ENG, count: '4' }, { departmentId: null, count: '1' }]);
      departmentModel.findAll.mockResolvedValue([{ id: ENG, name: 'Engineering' }]);

      const result = await service.getBranch(TENANT, LHE);

      expect(result.employeeCount).toBe(5);
      expect(result.departments).toEqual([
        { departmentId: ENG, name: 'Engineering', employeeCount: 4 },
        { departmentId: null, name: 'No department', employeeCount: 1 },
      ]);
    });

    it('404s for a branch that is not there', async () => {
      await expect(service.getBranch(TENANT, LHE)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('adding and changing', () => {
    const stubOne = () => branchModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(row({ id: LHE, name: 'Lahore HQ', headEmployeeId: ANNA }));

    it('adds a branch with a head and records it', async () => {
      stubOne();
      await service.createBranch(TENANT, { name: 'Lahore HQ', code: 'LHE', headEmployeeId: ANNA } as any);

      expect(branchModel.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, name: 'Lahore HQ', code: 'LHE', headEmployeeId: ANNA, isActive: true }));
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({ tableName: 'branches', action: 'CREATE' });
    });

    it('refuses a name or a code that is taken, ignoring case', async () => {
      branchModel.findOne.mockResolvedValueOnce(row({ name: 'Lahore HQ' }));
      await expect(service.createBranch(TENANT, { name: 'lahore hq' } as any)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already exists') });
      expect(branchModel.findOne.mock.calls[0][0].where.name[Op.iLike]).toBe('lahore hq');

      branchModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ name: 'Karachi' }));
      await expect(service.createBranch(TENANT, { name: 'Other', code: 'KHI' } as any)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('code') });
    });

    it('refuses a head who is not here or has left', async () => {
      employeeModel.findOne.mockResolvedValueOnce(null);
      await expect(service.createBranch(TENANT, { name: 'X', headEmployeeId: ANNA } as any)).rejects.toMatchObject({ status: 400 });
      employeeModel.findOne.mockResolvedValueOnce({ id: ANNA, status: 'RESIGNED' });
      await expect(service.createBranch(TENANT, { name: 'X', headEmployeeId: ANNA } as any)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('no longer works') });
      expect(branchModel.create).not.toHaveBeenCalled();
    });

    it('changes only what was sent, and records what changed', async () => {
      const existing = row({ id: LHE, name: 'Lahore HQ', city: 'Lahore', headEmployeeId: null, isActive: true });
      branchModel.findOne.mockResolvedValueOnce(existing).mockResolvedValue(existing);

      await service.updateBranch(TENANT, LHE, { city: 'Lahore Cantt', isActive: false } as any);

      expect(existing.update).toHaveBeenCalledWith({ city: 'Lahore Cantt', isActive: false });
      expect(auditModel.create.mock.calls[0][0].changes).toMatchObject({ city: { from: 'Lahore', to: 'Lahore Cantt' }, isActive: { from: true, to: false } });
    });

    it('writes nothing when nothing changed', async () => {
      const existing = row({ id: LHE, name: 'Lahore HQ', isActive: true });
      branchModel.findOne.mockResolvedValue(existing);
      await service.updateBranch(TENANT, LHE, { isActive: true } as any);
      expect(existing.update).not.toHaveBeenCalled();
      expect(auditModel.create).not.toHaveBeenCalled();
    });
  });

  describe('deleting', () => {
    it('deletes a branch nobody works from', async () => {
      const existing = row({ id: LHE, name: 'Lahore HQ' });
      branchModel.findOne.mockResolvedValue(existing);
      expect(await service.deleteBranch(TENANT, LHE)).toEqual({ deleted: true, id: LHE });
      expect(existing.destroy).toHaveBeenCalled();
    });

    it('refuses while people are assigned, and says how to get out of it', async () => {
      const existing = row({ id: LHE, name: 'Lahore HQ' });
      branchModel.findOne.mockResolvedValue(existing);
      employeeModel.count.mockResolvedValue(2);
      await expect(service.deleteBranch(TENANT, LHE)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('2 people are assigned') });
      expect(existing.destroy).not.toHaveBeenCalled();
    });
  });

  describe('who works where', () => {
    beforeEach(() => branchModel.findOne.mockResolvedValue(row({ id: LHE, name: 'Lahore HQ', isActive: true })));

    it('moves people in, leaves those already there, and counts those it could not find', async () => {
      employeeModel.findAll.mockResolvedValue([{ id: ANNA, branchId: null }, { id: BEN, branchId: LHE }]);

      const result = await service.assignEmployees(TENANT, LHE, { employeeIds: [ANNA, BEN, 'gone'] } as any);

      expect(result).toEqual({ branchId: LHE, moved: 1, alreadyThere: 1, notFound: 1 });
      expect(employeeModel.update).toHaveBeenCalledWith({ branchId: LHE }, { where: { tenantId: TENANT, id: { [Op.in]: [ANNA] } } });
    });

    it('only reaches the people the caller can see', async () => {
      dataScope.employeeWhere.mockResolvedValue({ id: { [Op.in]: [ANNA] } });
      employeeModel.findAll.mockResolvedValue([]);
      await service.assignEmployees(TENANT, LHE, { employeeIds: [ANNA] } as any);
      expect(employeeModel.findAll.mock.calls[0][0].where.id).toEqual({ [Op.in]: [ANNA] });
    });

    it('will not move people into an inactive branch', async () => {
      branchModel.findOne.mockResolvedValue(row({ id: LHE, isActive: false }));
      await expect(service.assignEmployees(TENANT, LHE, { employeeIds: [ANNA] } as any)).rejects.toMatchObject({ status: 409 });
      expect(employeeModel.update).not.toHaveBeenCalled();
    });

    it('takes people out, only those who are in this branch', async () => {
      employeeModel.findAll.mockResolvedValue([{ id: ANNA, branchId: LHE }, { id: BEN, branchId: KHI }]);

      const result = await service.removeEmployees(TENANT, LHE, { employeeIds: [ANNA, BEN] } as any);

      expect(result).toEqual({ branchId: LHE, removed: 1, notInThisBranch: 1 });
      expect(employeeModel.update).toHaveBeenCalledWith({ branchId: null }, { where: { tenantId: TENANT, id: { [Op.in]: [ANNA] } } });
    });
  });

  describe('from department locations', () => {
    beforeEach(() => {
      departmentModel.findAll.mockResolvedValue([
        { id: 'd1', location: 'Lahore HQ' },
        { id: 'd2', location: ' lahore hq ' },
        { id: 'd3', location: 'Remote' },
        { id: 'd4', location: '   ' },
      ]);
      branchModel.findAll.mockResolvedValue([{ id: LHE, name: 'Lahore HQ' }]);
      employeeModel.findAll.mockImplementation(async ({ where }: any) => (where.departmentId[Op.in].includes('d1') ? [{ id: ANNA }, { id: BEN }] : [{ id: 'remote-1' }]));
    });

    it('shows what it would do, and changes nothing, until told to apply', async () => {
      const result = await service.fromLocations(TENANT, false);

      expect(result).toMatchObject({ applied: false, created: 0, employeesMoved: 0 });
      expect(result.branches).toEqual([
        { name: 'Lahore HQ', departments: 2, employees: 2, exists: true },
        { name: 'Remote', departments: 1, employees: 1, exists: false },
      ]);
      expect(branchModel.create).not.toHaveBeenCalled();
      expect(employeeModel.update).not.toHaveBeenCalled();
    });

    it('creates the branches that are missing and puts only people with no branch into them', async () => {
      branchModel.create.mockImplementation(async (values: any) => row({ id: KHI, ...values }));

      const result = await service.fromLocations(TENANT, true);

      expect(result).toMatchObject({ applied: true, created: 1, employeesMoved: 3 });
      expect(branchModel.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Remote' }));
      expect(employeeModel.update).toHaveBeenCalledWith({ branchId: LHE }, { where: { tenantId: TENANT, id: { [Op.in]: [ANNA, BEN] } } });
      expect(employeeModel.update).toHaveBeenCalledWith({ branchId: KHI }, { where: { tenantId: TENANT, id: { [Op.in]: ['remote-1'] } } });
      // Only people who have no branch yet are considered.
      expect(employeeModel.findAll.mock.calls[0][0].where.branchId).toBeNull();
    });
  });
});
