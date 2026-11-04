import { Op } from 'sequelize';
import { DataScope } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { RouteLookup, resolveStages } from './approval-engine';
import { createRouteLookup } from './approval-route-lookup';
import { ApprovalPolicyService } from './approval-policy.service';
import { EmployeeAssignmentService } from './employee-assignment.service';
import { DataScopeService } from './data-scope.service';
import { notifyTaskOwners } from './department-checklist';
import { table } from './testing/fake-table';

/**
 * The last loose ends of the department hierarchy: an additional (dotted-line)
 * manager as an approver, a branch's departments in branch scope, and telling
 * the owner of an onboarding task.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', reportingManagerId: null, departmentId: null, designationId: null, ...over });
const asHr = <T>(work: () => Promise<T>) => runAsRpcActor({ roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['employee.edit'] } as any, work);

describe('An additional manager in an approval route', () => {
  const people: Record<string, any> = {
    ayesha: { id: 'ayesha', firstName: 'Ayesha', lastName: 'Khan', reportingManagerId: 'sara', status: 'ACTIVE' },
    sara: { id: 'sara', firstName: 'Sara', lastName: 'Primary', status: 'ACTIVE' },
    omar: { id: 'omar', firstName: 'Omar', lastName: 'Dotted', status: 'ACTIVE' },
    gone: { id: 'gone', firstName: 'Gone', lastName: 'Away', status: 'RESIGNED' },
  };
  const lookup = (extra: string | null): RouteLookup => ({
    person: async (id) => people[id] ?? null,
    designationTitle: async () => null,
    departmentHead: async () => null,
    additionalManager: async () => extra,
  });
  const route = async (extra: string | null, policy: any[] = [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'ADDITIONAL_MANAGER' }, { kind: 'HR' }]) =>
    (await resolveStages(policy, 'ayesha', lookup(extra))).map((stage) => [stage.kind, stage.approverId]);

  it('puts the additional manager on the route where the policy asks for one', async () => {
    expect(await route('omar')).toEqual([['REPORTING_MANAGER', 'sara'], ['ADDITIONAL_MANAGER', 'omar'], ['HR', null]]);
  });

  it('skips the stage for someone who has none, rather than sending them to HR early', async () => {
    expect(await route(null)).toEqual([['REPORTING_MANAGER', 'sara'], ['HR', null]]);
  });

  it('skips it when they have left, are the requester, or are already on the route', async () => {
    expect(await route('gone')).toEqual([['REPORTING_MANAGER', 'sara'], ['HR', null]]);
    expect(await route('ayesha')).toEqual([['REPORTING_MANAGER', 'sara'], ['HR', null]]);
    expect(await route('sara')).toEqual([['REPORTING_MANAGER', 'sara'], ['HR', null]]);
  });

  it('is HR when it is the only stage and there is nobody', async () => {
    expect(await route(null, [{ kind: 'ADDITIONAL_MANAGER' }])).toEqual([['HR', null]]);
  });

  describe('found from the running additional assignments', () => {
    const lookupFor = async (rows: any[]) => {
      const Assignment = table(rows);
      const provider: any = { getEmployeeModel: async () => table(), getEmployeeAssignmentModel: async () => Assignment };
      return createRouteLookup(provider, TENANT);
    };
    const row = (over: Record<string, unknown>) => ({ tenantId: TENANT, employeeId: 'ayesha', reportingManagerId: 'omar', startDate: '2026-01-01', endDate: null, ...over });

    it('is the manager of the earliest assignment still running', async () => {
      const found = await lookupFor([row({ reportingManagerId: 'later', startDate: '2026-05-01' }), row({}), row({ reportingManagerId: 'ended', startDate: '2025-01-01', endDate: '2025-06-01' })]);
      expect(await found.additionalManager!('ayesha')).toBe('omar');
    });

    it('is nobody without one, or when the table cannot be read', async () => {
      expect(await (await lookupFor([row({ reportingManagerId: null })])).additionalManager!('ayesha')).toBeNull();
      const provider: any = { getEmployeeModel: async () => table(), getEmployeeAssignmentModel: async () => { throw new Error('no table'); } };
      expect(await (await createRouteLookup(provider, TENANT)).additionalManager!('ayesha')).toBeNull();
    });
  });

  describe('as a stage in an organization\'s policy', () => {
    it('is accepted once, and described', async () => {
      const policies = table();
      const provider: any = { getApprovalPolicyModel: async () => policies, getEmployeeModel: async () => table(), getEntityAuditLogModel: async () => table() };
      const service = new ApprovalPolicyService(provider);

      const saved: any = await service.update(TENANT, 'LEAVE', { stages: [{ kind: 'REPORTING_MANAGER' }, { kind: 'ADDITIONAL_MANAGER' }] } as any);

      expect(saved.stages.map((s: any) => [s.kind, s.label])).toEqual([['REPORTING_MANAGER', 'Reporting manager'], ['ADDITIONAL_MANAGER', 'Additional (dotted-line) manager, when they have one']]);
      await expect(service.update(TENANT, 'LEAVE', { stages: [{ kind: 'ADDITIONAL_MANAGER' }, { kind: 'ADDITIONAL_MANAGER' }] } as any)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('when an assignment gives or takes the additional manager', () => {
    let models: Record<string, any>;
    let follow: jest.Mock;
    let service: EmployeeAssignmentService;

    beforeEach(() => {
      models = {
        Employee: table([person({ firstName: 'Ayesha', lastName: 'Khan' }), person({ firstName: 'Omar', lastName: 'Dotted' })]),
        Department: table([{ tenantId: TENANT, name: 'Marketing' }]),
        Assignment: table(),
        Change: table(),
        Notification: table(),
      };
      follow = jest.fn();
      const provider: any = {
        getEmployeeModel: async () => models.Employee,
        getDepartmentModel: async () => models.Department,
        getDesignationModel: async () => table(),
        getEmployeeAssignmentModel: async () => models.Assignment,
        getHierarchyChangeModel: async () => models.Change,
        getEmployeeNotificationModel: async () => models.Notification,
      };
      service = new EmployeeAssignmentService(provider, { assertCanSee: async () => undefined } as any, { followApprovalRoute: follow } as any);
    });

    it('re-routes their pending approvals when a manager is added, changed or ends', async () => {
      const [ayesha, omar] = [models.Employee.rows[0].id, models.Employee.rows[1].id];
      const added: any = await asHr(() => service.add(TENANT, ayesha, { reportingManagerId: omar } as any));
      expect(follow).toHaveBeenCalledWith(TENANT, ayesha);

      follow.mockClear();
      await asHr(() => service.update(TENANT, ayesha, added.id, { title: 'Liaison' } as any));
      expect(follow).not.toHaveBeenCalled();
      await asHr(() => service.update(TENANT, ayesha, added.id, { reportingManagerId: null } as any));
      expect(follow).toHaveBeenCalledWith(TENANT, ayesha);

      follow.mockClear();
      const another: any = await asHr(() => service.add(TENANT, ayesha, { reportingManagerId: omar, title: 'Other' } as any));
      follow.mockClear();
      await asHr(() => service.end(TENANT, ayesha, another.id));
      expect(follow).toHaveBeenCalledWith(TENANT, ayesha);
    });

    it('does nothing about approvals for an assignment with no manager, and survives a failure', async () => {
      const ayesha = models.Employee.rows[0].id;
      await asHr(() => service.add(TENANT, ayesha, { departmentId: models.Department.rows[0].id } as any));
      expect(follow).not.toHaveBeenCalled();

      follow.mockRejectedValue(new Error('down'));
      await expect(asHr(() => service.add(TENANT, ayesha, { reportingManagerId: models.Employee.rows[1].id, title: 'Dotted' } as any))).resolves.toBeDefined();
    });
  });
});

describe('Branch scope and the departments tied to a branch', () => {
  const people = [
    { id: 'bhead', email: 'bhead@x.com', branchId: 'lhe', departmentId: 'ops', reportingManagerId: null },
    { id: 'a', email: 'a@x.com', branchId: 'lhe', departmentId: null, reportingManagerId: null },
    { id: 'sales-1', email: 's1@x.com', branchId: null, departmentId: 'sales', reportingManagerId: null },
    { id: 'sales-khi', email: 's2@x.com', branchId: 'khi', departmentId: 'sales', reportingManagerId: null },
    { id: 'finance-1', email: 'f1@x.com', branchId: null, departmentId: 'finance', reportingManagerId: null },
  ];
  const departments = [
    { id: 'ops', branchIds: ['lhe'] },
    { id: 'sales', branchIds: ['lhe', 'khi'] },
    { id: 'finance', branchIds: [] },
  ];
  const inList = (value: any, rowValue: any) => (value && typeof value === 'object' && Op.in in value ? value[Op.in].includes(rowValue) : value === rowValue);
  const provider: any = {
    getEmployeeModel: async () => ({
      findOne: async ({ where }: any) => people.find((p) => p.email === String(where.email[Op.iLike]).toLowerCase()) ?? null,
      findAll: async ({ where }: any) =>
        people.filter((p) => {
          if (where.reportingManagerId !== undefined && !inList(where.reportingManagerId, p.reportingManagerId)) return false;
          if (where.branchId !== undefined && !inList(where.branchId, p.branchId)) return false;
          if (where.departmentId !== undefined && !inList(where.departmentId, p.departmentId)) return false;
          const or = where[Op.or] as any[] | undefined;
          return !or || or.some((cond) => (cond.branchId === null ? p.branchId === null : inList(cond.branchId, p.branchId)));
        }),
    }),
    getBranchModel: async () => ({ findAll: async ({ where }: any) => (where.headEmployeeId === 'bhead' ? [{ id: 'lhe' }] : []) }),
    getDepartmentModel: async () => ({
      findAll: async ({ where }: any) => departments.filter((d) => (where[Op.or] as any[]).some((cond) => d.branchIds.includes(cond.branchIds[Op.contains][0]))),
    }),
  };
  const service = new DataScopeService(provider);
  const visible = (email: string) => runAsRpcActor({ roles: [], isSuperAdmin: false, email, dataScope: DataScope.BRANCH } as any, () => service.visibleEmployeeIds(TENANT));

  it('adds the people of a department tied to the branch, unless they are placed in another branch', async () => {
    expect((await visible('bhead@x.com'))!.sort()).toEqual(['a', 'bhead', 'sales-1']);
  });

  it('leaves out departments that are not tied to the branch, and people placed elsewhere', async () => {
    const ids = (await visible('bhead@x.com'))!;
    expect(ids).not.toContain('finance-1');
    expect(ids).not.toContain('sales-khi');
  });

  it('adds no one when the departments cannot be read', async () => {
    const broken = new DataScopeService({ ...provider, getDepartmentModel: async () => { throw new Error('no column'); } });
    const ids = await runAsRpcActor({ roles: [], isSuperAdmin: false, email: 'bhead@x.com', dataScope: DataScope.BRANCH } as any, () => broken.visibleEmployeeIds(TENANT));
    expect(ids!.sort()).toEqual(['a', 'bhead']);
  });
});

describe('Telling the owner of an onboarding task', () => {
  const run = async (tasks: any[], hire: any = { firstName: 'Zain', lastName: 'New' }) => {
    const notifications = table();
    const provider: any = { getNewHireModel: async () => ({ findOne: async () => hire }), getEmployeeNotificationModel: async () => notifications };
    await notifyTaskOwners(provider, TENANT, 'hire-1', tasks);
    return notifications.rows;
  };

  it('tells each owner once, however many tasks they were given', async () => {
    const rows = await run([
      { assignedToEmployeeId: 'boss', title: 'Grant access' },
      { assignedToEmployeeId: 'lead', title: 'Pair with a senior' },
      { assignedToEmployeeId: 'boss', title: 'Set up desk' },
      { assignedToEmployeeId: null, title: 'Sign the handbook' },
    ]);

    expect(rows.map((n: any) => [n.employeeId, n.title])).toEqual([['boss', '2 onboarding tasks for Zain New'], ['lead', 'Onboarding task for Zain New']]);
    expect(rows[0].body).toContain('Grant access; Set up desk');
  });

  it('shortens a long list, and says nothing when nobody owns a task', async () => {
    const many = await run(['a', 'b', 'c', 'd', 'e'].map((title) => ({ assignedToEmployeeId: 'boss', title })));
    expect(many[0].body).toContain('a; b; c and 2 more');
    expect(await run([{ assignedToEmployeeId: null, title: 'x' }])).toEqual([]);
  });

  it('never fails what it reports on', async () => {
    const provider: any = { getNewHireModel: async () => { throw new Error('down'); } };
    await expect(notifyTaskOwners(provider, TENANT, 'hire-1', [{ assignedToEmployeeId: 'boss', title: 'x' }])).resolves.toBeUndefined();
  });
});
