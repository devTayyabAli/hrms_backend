import { HttpStatus } from '@nestjs/common';
import { MyTeamService } from './my-team.service';
import { table } from './testing/fake-table';

/**
 * The department head's view of what they head: the departments under it, the
 * managers and their teams, everyone in it, and who also works for it.
 *
 *   Engineering (head: Hana)
 *   ├── Backend (head: Bilal)   Bilal -> Dev, Dina
 *   └── QA                      Quinn
 *   Sales (head: nobody)
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const BRANCH = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', reportingManagerId: null, ...over });

describe('MyTeamService: the departments I head', () => {
  let models: Record<string, any>;
  let service: MyTeamService;
  let hana: any;
  let bilal: any;
  let dev: any;
  let dina: any;
  let quinn: any;
  let sam: any;
  let eng: any;
  let backend: any;
  let qa: any;
  let sales: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Hana', lastName: 'Head', userId: 'u-hana', email: 'hana@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Bilal', lastName: 'Manager', userId: 'u-bilal', email: 'bilal@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Dev', lastName: 'One', userId: 'u-dev', email: 'dev@x.com' }),
        person({ employeeCode: 'E4', firstName: 'Dina', lastName: 'Two', userId: 'u-dina', email: 'dina@x.com' }),
        person({ employeeCode: 'E5', firstName: 'Quinn', lastName: 'Tester', userId: 'u-quinn', email: 'quinn@x.com' }),
        person({ employeeCode: 'E6', firstName: 'Sam', lastName: 'Sales', userId: 'u-sam', email: 'sam@x.com' }),
      ]),
      Department: table([
        { tenantId: TENANT, name: 'Engineering', code: 'ENG' },
        { tenantId: TENANT, name: 'Backend' },
        { tenantId: TENANT, name: 'QA' },
        { tenantId: TENANT, name: 'Sales' },
      ]),
      Branch: table([{ id: BRANCH, tenantId: TENANT, name: 'Lahore HQ' }]),
      Assignment: table(),
      Attendance: table(),
      Leave: table(),
      Request: table(),
    };
    [hana, bilal, dev, dina, quinn, sam] = models.Employee.rows;
    [eng, backend, qa, sales] = models.Department.rows;
    eng.managerId = hana.id;
    eng.branchIds = [BRANCH];
    backend.parentDepartmentId = eng.id;
    backend.managerId = bilal.id;
    qa.parentDepartmentId = eng.id;
    hana.departmentId = eng.id;
    bilal.departmentId = backend.id;
    dev.departmentId = backend.id;
    dev.reportingManagerId = bilal.id;
    dev.designation = { id: 'd1', title: 'Developer' };
    dina.departmentId = backend.id;
    dina.reportingManagerId = bilal.id;
    quinn.departmentId = qa.id;
    quinn.reportingManagerId = hana.id;
    sam.departmentId = sales.id;
    for (const employee of models.Employee.rows) employee.department = models.Department.rows.find((d: any) => d.id === employee.departmentId) ?? null;

    const provider: any = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => table(),
      getBranchModel: async () => models.Branch,
      getEmployeeAssignmentModel: async () => models.Assignment,
      getAttendanceRecordModel: async () => models.Attendance,
      getLeaveRequestModel: async () => models.Leave,
      getLeavePolicyModel: async () => ({}),
      getEmployeeRequestModel: async () => models.Request,
    };
    service = new MyTeamService(provider);
  });

  const mine = (user = 'u-hana') => service.getMyDepartments(TENANT, user) as Promise<any>;

  it('is only for someone who heads a department', async () => {
    await expect(mine('u-dev')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    await expect(mine('u-nobody')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it('shows the department with its sub-departments, heads, branches and headcounts', async () => {
    const result = await mine();

    expect(result.departments).toHaveLength(1);
    const engineering = result.departments[0];
    expect(engineering).toMatchObject({ name: 'Engineering', code: 'ENG', head: { name: 'Hana Head' }, branches: [{ id: BRANCH, name: 'Lahore HQ' }], directHeadcount: 1, headcount: 5 });
    expect(engineering.subDepartments.map((sub: any) => [sub.name, sub.head?.name ?? null, sub.directHeadcount, sub.headcount])).toEqual([
      ['Backend', 'Bilal Manager', 3, 3],
      ['QA', null, 1, 1],
    ]);
  });

  it('lists the managers in it with their teams, and everyone in it but the head', async () => {
    const engineering = (await mine()).departments[0];

    expect(engineering.managers.map((m: any) => [m.name, m.team.map((t: any) => t.name)])).toEqual([['Bilal Manager', ['Dev One', 'Dina Two']]]);
    expect(engineering.employees.map((e: any) => e.name).sort()).toEqual(['Bilal Manager', 'Dev One', 'Dina Two', 'Quinn Tester']);
    expect(engineering.employees.find((e: any) => e.name === 'Dev One')).toMatchObject({ designation: 'Developer', reportingManagerId: bilal.id, department: { name: 'Backend' } });
    expect(engineering.summary).toBeDefined();
  });

  it('shows who else works for it through an additional assignment, and not ended ones', async () => {
    models.Assignment.create({ tenantId: TENANT, employeeId: sam.id, departmentId: backend.id, title: 'Sales engineer', startDate: '2026-01-01', endDate: null });
    models.Assignment.create({ tenantId: TENANT, employeeId: sam.id, departmentId: qa.id, title: 'Old', startDate: '2020-01-01', endDate: '2020-06-01' });

    const engineering = (await mine()).departments[0];

    expect(engineering.alsoWorkingHere).toEqual([{ employee: expect.objectContaining({ name: 'Sam Sales', primaryDepartment: 'Sales' }), title: 'Sales engineer', since: '2026-01-01' }]);
  });

  it('shows a head of a department with no sub-departments their own, and stays up when assignments cannot be read', async () => {
    sales.managerId = sam.id;
    models.Assignment.findAll.mockRejectedValueOnce(new Error('no table'));

    const result = await mine('u-sam');

    expect(result.departments[0]).toMatchObject({ name: 'Sales', subDepartments: [], headcount: 1, managers: [], employees: [], alsoWorkingHere: [] });
  });

  it('shows nothing from a department the person does not head', async () => {
    const engineering = (await mine()).departments[0];
    expect(JSON.stringify(engineering)).not.toContain('Sam Sales');
  });
});
