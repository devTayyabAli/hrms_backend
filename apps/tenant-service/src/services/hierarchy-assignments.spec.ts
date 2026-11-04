import { Op } from 'sequelize';
import { DataScope } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { DataScopeService } from './data-scope.service';
import { OrganizationSetupService } from './organization-setup.service';
import { BranchService } from './branch.service';
import { table } from './testing/fake-table';

/**
 * What an additional assignment (a dotted-line manager, a second department)
 * adds to who a manager or department head can see, and how departments are
 * tied to branches.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const BRANCH_A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const BRANCH_B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const GHOST = '99999999-9999-4999-8999-999999999999';

describe('Additional assignments in what a manager can see', () => {
  const people = [
    { id: 'lead', email: 'lead@x.com', departmentId: 'eng', reportingManagerId: null },
    { id: 'dev', email: 'dev@x.com', departmentId: 'eng', reportingManagerId: 'lead' },
    { id: 'designer', email: 'designer@x.com', departmentId: 'design', reportingManagerId: null },
    { id: 'writer', email: 'writer@x.com', departmentId: 'content', reportingManagerId: null },
    { id: 'old', email: 'old@x.com', departmentId: 'content', reportingManagerId: null },
  ];
  const departments = [
    { id: 'eng', managerId: 'lead', parentDepartmentId: null },
    { id: 'design', managerId: null, parentDepartmentId: null },
    { id: 'content', managerId: null, parentDepartmentId: null },
  ];
  const inList = (value: any, rowValue: any) => (value && typeof value === 'object' && Op.in in value ? value[Op.in].includes(rowValue) : value === rowValue);
  let assignments: any[];
  const provider: any = {
    getEmployeeModel: async () => ({
      findOne: async ({ where }: any) => people.find((p) => p.email === String(where.email[Op.iLike]).toLowerCase()) ?? null,
      findAll: async ({ where }: any) => people.filter((p) => (where.reportingManagerId === undefined || inList(where.reportingManagerId, p.reportingManagerId)) && (where.departmentId === undefined || inList(where.departmentId, p.departmentId))),
    }),
    getDepartmentModel: async () => ({ findAll: async ({ where }: any) => departments.filter((d) => (where.managerId === undefined || d.managerId === where.managerId) && (where.parentDepartmentId === undefined || inList(where.parentDepartmentId, d.parentDepartmentId))) }),
    getEmployeeAssignmentModel: async () => ({
      findAll: async ({ where }: any) =>
        assignments.filter((a) =>
          (where[Op.or] as any[]).some((cond) => (cond.reportingManagerId !== undefined && a.reportingManagerId === cond.reportingManagerId) || (cond.departmentId !== undefined && inList(cond.departmentId, a.departmentId))),
        ),
    }),
  };
  const service = new DataScopeService(provider);
  const visible = (email: string, dataScope: DataScope) => runAsRpcActor({ roles: [], isSuperAdmin: false, email, dataScope }, () => service.visibleEmployeeIds(TENANT));

  beforeEach(() => {
    assignments = [
      { employeeId: 'designer', reportingManagerId: 'lead', departmentId: null, endDate: null },
      { employeeId: 'writer', reportingManagerId: null, departmentId: 'eng', endDate: '2999-01-01' },
      { employeeId: 'old', reportingManagerId: 'lead', departmentId: null, endDate: '2020-01-01' },
    ];
  });

  it('shows a manager the people who also work for them, as well as their team', async () => {
    expect((await visible('lead@x.com', DataScope.TEAM))!.sort()).toEqual(['designer', 'dev', 'lead']);
  });

  it('shows a department head the people who also work in their department', async () => {
    expect((await visible('lead@x.com', DataScope.DEPARTMENT))!.sort()).toEqual(['designer', 'dev', 'lead', 'writer']);
  });

  it('does not show someone whose assignment has ended', async () => {
    expect(await visible('lead@x.com', DataScope.TEAM)).not.toContain('old');
    expect(await visible('lead@x.com', DataScope.DEPARTMENT)).not.toContain('old');
  });

  it('shows nothing extra when the assignments cannot be read', async () => {
    provider.getEmployeeAssignmentModel = async () => {
      throw new Error('no table');
    };
    expect((await visible('lead@x.com', DataScope.TEAM))!.sort()).toEqual(['dev', 'lead']);
  });
});

describe('Departments and their branches', () => {
  let models: Record<string, any>;
  let setup: OrganizationSetupService;

  beforeEach(() => {
    models = {
      Department: table([{ tenantId: TENANT, name: 'Sales', branchIds: [BRANCH_A] }, { tenantId: TENANT, name: 'Support', branchIds: [] }]),
      Branch: table([{ id: BRANCH_A, tenantId: TENANT, name: 'Lahore HQ' }, { id: BRANCH_B, tenantId: TENANT, name: 'Karachi' }]),
    };
    const provider: any = { getDepartmentModel: async () => models.Department, getBranchModel: async () => models.Branch };
    setup = new OrganizationSetupService({ getTenantById: async () => ({}) } as any, provider);
  });

  it('creates a department tied to branches, once each', async () => {
    const created: any = await setup.createDepartment(TENANT, { name: 'Finance', branchIds: [BRANCH_A, BRANCH_B, BRANCH_A] } as any);
    expect(created.branchIds).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('refuses a branch that is not in the organization', async () => {
    await expect(setup.createDepartment(TENANT, { name: 'Finance', branchIds: [GHOST] } as any)).rejects.toThrow('branch was not found');
    expect(models.Department.rows.map((row: any) => row.name)).not.toContain('Finance');
  });

  it('replaces the branches on update, and an empty list clears them', async () => {
    const sales = models.Department.rows[0];
    await setup.updateDepartment(TENANT, sales.id, { branchIds: [BRANCH_B] } as any);
    expect(sales.branchIds).toEqual([BRANCH_B]);
    await setup.updateDepartment(TENANT, sales.id, { branchIds: [] } as any);
    expect(sales.branchIds).toEqual([]);
    await setup.updateDepartment(TENANT, sales.id, { description: 'x' } as any);
    expect(sales.branchIds).toEqual([]);
    await expect(setup.updateDepartment(TENANT, sales.id, { branchIds: [GHOST] } as any)).rejects.toThrow('branch was not found');
  });

  it('lists each department with the branches it works from', async () => {
    const list: any[] = await setup.getDepartments(TENANT);
    expect(list.find((d) => d.name === 'Sales')).toMatchObject({ branchIds: [BRANCH_A], branches: [{ id: BRANCH_A, name: 'Lahore HQ' }] });
    expect(list.find((d) => d.name === 'Support')).toMatchObject({ branchIds: [], branches: [] });
  });

  it('keeps only the departments that work from a branch when asked', async () => {
    models.Department.findAll.mockImplementationOnce(async ({ where }: any) => {
      expect(where.branchIds[Op.contains]).toEqual([BRANCH_A]);
      return models.Department.rows.filter((row: any) => row.branchIds.includes(BRANCH_A));
    });
    expect((await setup.getDepartments(TENANT, BRANCH_A)).map((d: any) => d.name)).toEqual(['Sales']);
  });

  it('shows a branch the departments tied to it', async () => {
    const employees = { findAll: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    models.Department.findAll.mockImplementation(async ({ where }: any) => (where.branchIds ? models.Department.rows.filter((row: any) => row.branchIds.includes(BRANCH_A)) : []));
    const provider: any = { getBranchModel: async () => models.Branch, getEmployeeModel: async () => employees, getDepartmentModel: async () => models.Department };
    const branches = new BranchService(provider, undefined as any);
    const detail: any = await branches.getBranch(TENANT, BRANCH_A);
    expect(detail.linkedDepartments).toEqual([expect.objectContaining({ name: 'Sales' })]);
  });
});
