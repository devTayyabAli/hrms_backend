import { MyTeamService } from './my-team.service';

const TENANT = '11111111-1111-1111-1111-111111111111';

/**
 *   Admin-level (no manager)
 *   └─ ceo
 *      ├─ lead            ← a Team Lead signed in as a plain Employee
 *      │  └─ dev
 *      │     └─ intern
 *      └─ sales           ← a plain employee, leads no one
 *   hrPerson (no manager)
 */
const EMPLOYEES = [
  { id: 'ceo', firstName: 'Cara', lastName: 'Chief', reportingManagerId: null, departmentId: 'mgmt', userId: 'u-ceo' },
  { id: 'lead', firstName: 'Tayyaba', lastName: 'Sabir', reportingManagerId: 'ceo', departmentId: 'eng', userId: 'u-lead' },
  { id: 'dev', firstName: 'Naveed', lastName: 'Ahmad', reportingManagerId: 'lead', departmentId: 'eng', userId: 'u-dev' },
  { id: 'intern', firstName: 'Ian', lastName: 'Intern', reportingManagerId: 'dev', departmentId: 'eng', userId: 'u-intern' },
  { id: 'sales', firstName: 'Sam', lastName: 'Sales', reportingManagerId: 'ceo', departmentId: 'sales', userId: 'u-sales' },
  { id: 'hrPerson', firstName: 'Tahir', lastName: 'Ali', reportingManagerId: null, departmentId: 'hr', userId: 'u-hr' },
].map((row) => ({ ...row, tenantId: TENANT, status: 'ACTIVE', employeeCode: row.id.toUpperCase(), email: `${row.id}@x.com` }));

const DEPARTMENTS = [
  { id: 'eng', name: 'Engineering', managerId: null as string | null },
  { id: 'sales', name: 'Sales', managerId: null as string | null },
];

const build = (departments = DEPARTMENTS) => {
  const Employee = {
    findOne: jest.fn(async ({ where }: any) =>
      EMPLOYEES.find((e) => (where.userId ? e.userId === where.userId : e.id === where.id)) ?? null,
    ),
    findAll: jest.fn(async () => EMPLOYEES),
    count: jest.fn(async ({ where }: any) =>
      EMPLOYEES.filter((e) => e.reportingManagerId === where.reportingManagerId).length,
    ),
  };
  const Department = {
    findAll: jest.fn(async () => departments),
    count: jest.fn(async ({ where }: any) => departments.filter((d) => d.managerId === where.managerId).length),
  };
  const modelProvider: any = {
    getEmployeeModel: jest.fn(async () => Employee),
    getDepartmentModel: jest.fn(async () => Department),
    getDesignationModel: jest.fn(async () => ({})),
  };
  return new MyTeamService(modelProvider);
};

const ids = (result: { nodes: { id: string }[] }) => result.nodes.map((node) => node.id).sort();

describe('MyTeamService: employment history', () => {
  const changes = [
    { changeType: 'DEPARTMENT', previousId: 'sales', previousLabel: 'Sales', nextId: 'eng', nextLabel: 'Engineering', effectiveFrom: '2025-06-01', createdAt: new Date('2025-05-20'), note: 'Internal note', changedByEmail: 'hr@x.com' },
    { changeType: 'REPORTING_MANAGER', previousId: null, previousLabel: null, nextId: 'lead', nextLabel: 'Tayyaba Sabir', effectiveFrom: '2024-02-01', createdAt: new Date('2024-02-01') },
    { changeType: 'DEPARTMENT_HEAD', previousId: null, previousLabel: null, nextId: 'x', nextLabel: 'Someone', effectiveFrom: '2024-03-01', createdAt: new Date('2024-03-01') },
  ];

  const service = (overrides: Record<string, any> = {}) => {
    const dev = { ...EMPLOYEES.find((e) => e.id === 'dev')!, joiningDate: '2024-01-15', exitDate: null, designation: { id: 'd', title: 'Developer' }, department: { id: 'eng', name: 'Engineering' }, reportingManager: { id: 'lead', firstName: 'Tayyaba', lastName: 'Sabir' }, ...overrides };
    const Employee = { findOne: jest.fn(async ({ where }: any) => (where.userId === 'u-dev' || where.id === 'dev' ? dev : null)) };
    const Change = { findAll: jest.fn(async (_query?: any) => changes) };
    const provider: any = {
      getEmployeeModel: async () => Employee,
      getDepartmentModel: async () => ({}),
      getDesignationModel: async () => ({}),
      getHierarchyChangeModel: async () => Change,
    };
    return { service: new MyTeamService(provider), Change };
  };

  it('shows when I joined and each change of my manager or department, newest first', async () => {
    const { service: s, Change } = service();

    const result = await s.getMyEmploymentHistory(TENANT, 'u-dev');

    expect(Change.findAll.mock.calls[0][0].where).toEqual({ tenantId: TENANT, subjectType: 'EMPLOYEE', subjectId: 'dev' });
    expect(result.data.map((e) => [e.type, e.title, e.from, e.to, e.date])).toEqual([
      ['DEPARTMENT', 'Department changed', 'Sales', 'Engineering', '2025-06-01'],
      ['REPORTING_MANAGER', 'Reporting manager set', null, 'Tayyaba Sabir', '2024-02-01'],
      ['JOINED', 'Joined the organization', null, null, '2024-01-15'],
    ]);
    expect(result.current).toMatchObject({ status: 'ACTIVE', joiningDate: '2024-01-15', designation: 'Developer', department: { name: 'Engineering' }, reportingManager: { id: 'lead', name: 'Tayyaba Sabir' } });
  });

  it('leaves out who recorded a change and the note HR wrote, and changes that are not about me', async () => {
    const { service: s } = service();
    const result = await s.getMyEmploymentHistory(TENANT, 'u-dev');
    expect(JSON.stringify(result)).not.toContain('Internal note');
    expect(JSON.stringify(result)).not.toContain('hr@x.com');
    expect(result.data.some((e) => e.type === 'DEPARTMENT_HEAD')).toBe(false);
  });

  it('shows when I left', async () => {
    const { service: s } = service({ status: 'RESIGNED', exitDate: '2026-12-15' });
    const result = await s.getMyEmploymentHistory(TENANT, 'u-dev');
    expect(result.data[0]).toMatchObject({ type: 'LEFT', title: 'Left the organization', date: '2026-12-15' });
  });

  it('says so when the login has no employee profile', async () => {
    const { service: s } = service();
    await expect(s.getMyEmploymentHistory(TENANT, 'u-nobody')).rejects.toMatchObject({ status: 404 });
  });
});

describe('MyTeamService', () => {
  describe('getLeadership', () => {
    it('counts direct reports for a Team Lead signed in as an Employee', async () => {
      await expect(build().getLeadership(TENANT, 'u-lead')).resolves.toMatchObject({
        directReports: 1,
        isLead: true,
      });
    });

    it('says a plain employee leads no one', async () => {
      await expect(build().getLeadership(TENANT, 'u-sales')).resolves.toMatchObject({ isLead: false });
    });

    it('never throws for a login with no employee record', async () => {
      await expect(build().getLeadership(TENANT, 'u-admin-without-record')).resolves.toEqual({
        directReports: 0,
        departmentsHeaded: 0,
        isLead: false,
        hasEmployeeProfile: false,
      });
    });

    it('says an employee has a profile, and an admin without a record does not', async () => {
      await expect(build().getLeadership(TENANT, 'u-sales')).resolves.toMatchObject({ hasEmployeeProfile: true });
      await expect(build().getLeadership(TENANT, 'u-admin-without-record')).resolves.toMatchObject({
        hasEmployeeProfile: false,
      });
    });
  });

  describe('getMyTeam', () => {
    it('refuses a plain employee', async () => {
      await expect(build().getMyTeam(TENANT, 'u-sales')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('getHierarchy', () => {
    it('shows HR and admins the whole organization', async () => {
      const result = await build().getHierarchy(TENANT, 'u-hr', undefined, true);
      expect(result.scope).toBe('ORGANIZATION');
      expect(ids(result)).toEqual(EMPLOYEES.map((e) => e.id).sort());
    });

    it('shows a lead only their branch: everyone under them and the line above', async () => {
      const result = await build().getHierarchy(TENANT, 'u-lead');
      expect(result.scope).toBe('BRANCH');
      // Not `sales` (a peer's side of the tree) and not `hrPerson`.
      expect(ids(result)).toEqual(['ceo', 'dev', 'intern', 'lead']);
    });

    it('adds a department head’s whole department', async () => {
      const result = await build([{ id: 'sales', name: 'Sales', managerId: 'lead' }]).getHierarchy(TENANT, 'u-lead');
      expect(ids(result)).toEqual(['ceo', 'dev', 'intern', 'lead', 'sales']);
    });

    it('refuses a plain employee', async () => {
      await expect(build().getHierarchy(TENANT, 'u-sales')).rejects.toMatchObject({ status: 403 });
    });

    it('refuses a login with no employee record unless it can view everyone', async () => {
      await expect(build().getHierarchy(TENANT, 'u-nobody')).rejects.toMatchObject({ status: 403 });
    });
  });
});
