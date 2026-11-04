import { Op } from 'sequelize';
import { DataScope, effectiveRoleScope, widestDataScope } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { DataScopeService } from './data-scope.service';

/**
 * Org chart used below:
 *
 *   lead (Engineering, manages Engineering)
 *   ├── dev1
 *   │   └── intern
 *   └── dev2
 *   hr   (Human Resources)
 *   sales (Sales, reports to nobody)
 */
describe('DataScopeService', () => {
  const TENANT = 'tenant-1';
  const people = [
    { id: 'lead', email: 'lead@x.com', departmentId: 'eng', reportingManagerId: null },
    { id: 'dev1', email: 'dev1@x.com', departmentId: 'eng', reportingManagerId: 'lead' },
    { id: 'dev2', email: 'dev2@x.com', departmentId: 'eng', reportingManagerId: 'lead' },
    { id: 'intern', email: 'intern@x.com', departmentId: 'eng', reportingManagerId: 'dev1' },
    { id: 'hr', email: 'hr@x.com', departmentId: 'hr-dept', reportingManagerId: null },
    { id: 'sales', email: 'sales@x.com', departmentId: 'sales-dept', reportingManagerId: null },
  ];
  const departments = [
    { id: 'eng', managerId: 'lead', parentDepartmentId: null },
    { id: 'eng-qa', managerId: null, parentDepartmentId: 'eng' },
    { id: 'hr-dept', managerId: null, parentDepartmentId: null },
    { id: 'sales-dept', managerId: null, parentDepartmentId: null },
  ];

  const inList = (value: any, rowValue: any) =>
    value && typeof value === 'object' && Op.in in value ? value[Op.in].includes(rowValue) : value === rowValue;

  const employeeModel = {
    findOne: jest.fn(async ({ where }: any) => {
      const email = String(where.email[Op.iLike]).toLowerCase();
      return people.find((p) => p.email === email) ?? null;
    }),
    findAll: jest.fn(async ({ where }: any) =>
      people.filter(
        (p) =>
          (where.reportingManagerId === undefined || inList(where.reportingManagerId, p.reportingManagerId)) &&
          (where.departmentId === undefined || inList(where.departmentId, p.departmentId)),
      ),
    ),
  };
  const departmentModel = {
    findAll: jest.fn(async ({ where }: any) =>
      departments.filter(
        (d) =>
          (where.managerId === undefined || d.managerId === where.managerId) &&
          (where.parentDepartmentId === undefined || inList(where.parentDepartmentId, d.parentDepartmentId)),
      ),
    ),
  };
  const service = new DataScopeService({
    getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
    getDepartmentModel: jest.fn().mockResolvedValue(departmentModel),
  } as any);

  const as = (email: string, dataScope?: string, extra: Record<string, unknown> = {}) => ({
    roles: [],
    isSuperAdmin: false,
    email,
    dataScope,
    ...extra,
  });
  const visible = (actor: any) => runAsRpcActor(actor, () => service.visibleEmployeeIds(TENANT));

  it('does not narrow organization-wide, full-access or unsigned callers', async () => {
    expect(await visible(as('hr@x.com', DataScope.ORGANIZATION))).toBeNull();
    expect(await visible(as('lead@x.com', DataScope.TEAM, { isFullAccess: true }))).toBeNull();
    expect(await visible(as('lead@x.com'))).toBeNull(); // older token, no scope claim
    expect(await service.visibleEmployeeIds(TENANT)).toBeNull(); // no signed actor at all
  });

  it('TEAM covers everyone down the reporting line, and the lead themself', async () => {
    expect((await visible(as('lead@x.com', DataScope.TEAM)))!.sort()).toEqual(['dev1', 'dev2', 'intern', 'lead']);
    expect((await visible(as('dev1@x.com', DataScope.TEAM)))!.sort()).toEqual(['dev1', 'intern']);
  });

  it('DEPARTMENT covers the managed department and its sub-departments', async () => {
    expect((await visible(as('lead@x.com', DataScope.DEPARTMENT)))!.sort()).toEqual([
      'dev1',
      'dev2',
      'intern',
      'lead',
    ]);
    expect(departmentModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ parentDepartmentId: expect.anything() }) }),
    );
  });

  it('DEPARTMENT falls back to their own department when they manage none', async () => {
    expect(await visible(as('sales@x.com', DataScope.DEPARTMENT))).toEqual(['sales']);
  });

  it('SELF is only their own record; no employee record means nothing', async () => {
    expect(await visible(as('dev2@x.com', DataScope.SELF))).toEqual(['dev2']);
    expect(await visible(as('nobody@x.com', DataScope.TEAM))).toEqual([]);
  });

  it('builds a where fragment and answers canSee', async () => {
    await runAsRpcActor(as('lead@x.com', DataScope.TEAM), async () => {
      const where = await service.employeeWhere(TENANT);
      expect((where.employeeId as any)[Op.in].sort()).toEqual(['dev1', 'dev2', 'intern', 'lead']);
      expect(await service.canSee(TENANT, 'intern')).toBe(true);
      expect(await service.canSee(TENANT, 'sales')).toBe(false);
      await expect(service.assertCanSee(TENANT, 'hr', 'Employee')).rejects.toMatchObject({
        message: expect.stringContaining('team or department'),
      });
    });
  });
});

describe('role data scopes', () => {
  it('defaults the Employee role to SELF and every other role to ORGANIZATION', () => {
    expect(effectiveRoleScope({ name: 'Employee' })).toBe(DataScope.SELF);
    expect(effectiveRoleScope({ name: 'HR' })).toBe(DataScope.ORGANIZATION);
    expect(effectiveRoleScope({ name: 'Team Lead', dataScope: 'TEAM' })).toBe(DataScope.TEAM);
  });

  it('takes the widest scope across a user’s roles', () => {
    // A Team Lead who keeps the Employee role is still a Team Lead…
    expect(widestDataScope([DataScope.SELF, DataScope.TEAM])).toBe(DataScope.TEAM);
    // …and HR plus Team Lead stays organization-wide.
    expect(widestDataScope([DataScope.ORGANIZATION, DataScope.TEAM])).toBe(DataScope.ORGANIZATION);
    expect(widestDataScope([])).toBe(DataScope.ORGANIZATION);
  });
});

describe('DataScopeService: branch scope', () => {
  const TENANT = 'tenant-1';
  const people = [
    { id: 'bhead', email: 'bhead@x.com', branchId: 'lhe', reportingManagerId: null },
    { id: 'a', email: 'a@x.com', branchId: 'lhe', reportingManagerId: 'bhead' },
    { id: 'b', email: 'b@x.com', branchId: 'lhe', reportingManagerId: null },
    { id: 'c', email: 'c@x.com', branchId: 'khi', reportingManagerId: null },
    { id: 'floater', email: 'floater@x.com', branchId: null, reportingManagerId: null },
    { id: 'floater-report', email: 'fr@x.com', branchId: 'khi', reportingManagerId: 'floater' },
    { id: 'old-head', email: 'oldhead@x.com', branchId: 'closed', reportingManagerId: null },
    { id: 'old-member', email: 'oldmember@x.com', branchId: 'closed', reportingManagerId: null },
  ];
  const branches = [
    { id: 'lhe', headEmployeeId: 'bhead', isActive: true },
    { id: 'khi', headEmployeeId: null, isActive: true },
    { id: 'closed', headEmployeeId: 'old-head', isActive: false },
  ];
  const inList = (value: any, rowValue: any) => (value && typeof value === 'object' && Op.in in value ? value[Op.in].includes(rowValue) : value === rowValue);

  const service = new DataScopeService({
    getEmployeeModel: jest.fn().mockResolvedValue({
      findOne: jest.fn(async ({ where }: any) => people.find((p) => p.email === String(where.email[Op.iLike]).toLowerCase()) ?? null),
      findAll: jest.fn(async ({ where }: any) =>
        people.filter(
          (p) => (where.reportingManagerId === undefined || inList(where.reportingManagerId, p.reportingManagerId)) && (where.branchId === undefined || inList(where.branchId, p.branchId)),
        ),
      ),
    }),
    getBranchModel: jest.fn().mockResolvedValue({
      findAll: jest.fn(async ({ where }: any) => branches.filter((b) => b.headEmployeeId === where.headEmployeeId && b.isActive === where.isActive)),
    }),
  } as any);
  const actor = (email: string) => ({ roles: [], isSuperAdmin: false, email, dataScope: DataScope.BRANCH });
  const visible = (email: string) => runAsRpcActor(actor(email) as any, () => service.visibleEmployeeIds(TENANT));

  it('lets the head of a branch see everyone who works there', async () => {
    expect((await visible('bhead@x.com'))!.sort()).toEqual(['a', 'b', 'bhead']);
  });

  it('lets anyone else see the branch they work in', async () => {
    expect((await visible('a@x.com'))!.sort()).toEqual(['a', 'b', 'bhead']);
    expect((await visible('c@x.com'))!.sort()).toEqual(['c', 'floater-report']);
  });

  it('gives someone with no branch themselves and their own reports', async () => {
    expect((await visible('floater@x.com'))!.sort()).toEqual(['floater', 'floater-report']);
  });

  it('ignores a branch that is no longer active as something to head, and falls back to where they work', async () => {
    expect((await visible('oldhead@x.com'))!.sort()).toEqual(['old-head', 'old-member']);
  });

  it('is narrower than the organization and wider than a department or a team', () => {
    expect(widestDataScope([DataScope.BRANCH, DataScope.DEPARTMENT, DataScope.TEAM])).toBe(DataScope.BRANCH);
    expect(widestDataScope([DataScope.ORGANIZATION, DataScope.BRANCH])).toBe(DataScope.ORGANIZATION);
    expect(effectiveRoleScope({ name: 'Branch Manager', dataScope: 'BRANCH' })).toBe(DataScope.BRANCH);
  });
});
