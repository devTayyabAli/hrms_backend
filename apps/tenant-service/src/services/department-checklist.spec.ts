import { HttpStatus } from '@nestjs/common';
import { runAsRpcActor } from '@app/tenant-context';
import { DepartmentChecklistService } from './department-checklist.service';
import { onboardingTasksFor, offboardingStepsFor } from './department-checklist';
import { OffboardingService } from './offboarding.service';
import { table } from './testing/fake-table';

/**
 * What a department adds to onboarding and offboarding, and who owns it:
 * configuring it, what a new hire's checklist gets, and how a department step
 * is cleared when someone leaves.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';
const HR = { roles: ['HR'], isSuperAdmin: false, isFullAccess: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['offboarding.manage'] };
const PLAIN = { roles: [], isSuperAdmin: false, userId: 'u-x', email: 'x@x.com', permissions: [] };
const FACILITIES = { roles: [], isSuperAdmin: false, userId: 'u-fac', email: 'fac@x.com', permissions: ['facilities.manage'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', departmentId: null, reportingManagerId: null, joiningDate: '2024-01-01', ...over });

describe('Department checklists', () => {
  let models: Record<string, any>;
  let provider: any;
  let service: DepartmentChecklistService;
  let eng: any;
  let backend: any;
  let sales: any;
  let dev: any;
  let boss: any;
  let lead: any;
  let iris: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Dev', lastName: 'Person', userId: 'u-dev', email: 'dev@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Eng', lastName: 'Head', userId: 'u-boss', email: 'boss@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Team', lastName: 'Lead', userId: 'u-lead', email: 'lead@x.com' }),
        person({ employeeCode: 'E4', firstName: 'Iris', lastName: 'Gone', userId: 'u-iris', email: 'iris@x.com', status: 'RESIGNED' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Engineering' }, { tenantId: TENANT, name: 'Backend' }, { tenantId: TENANT, name: 'Sales' }]),
      Item: table(),
      Case: table(),
      Clearance: table(),
      Setting: table(),
      Notification: table(),
      Audit: table(),
    };
    [dev, boss, lead, iris] = models.Employee.rows;
    [eng, backend, sales] = models.Department.rows;
    eng.managerId = boss.id;
    backend.parentDepartmentId = eng.id;
    dev.departmentId = backend.id;
    dev.reportingManagerId = lead.id;
    provider = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDepartmentChecklistItemModel: async () => models.Item,
      getEntityAuditLogModel: async () => models.Audit,
    };
    service = new DepartmentChecklistService(provider);
  });

  const item = (over: Record<string, unknown> = {}) => ({ kind: 'ONBOARDING', departmentId: eng.id, title: 'Grant repository access', ownerKind: 'DEPARTMENT_HEAD', ...over });
  const create = (over: Record<string, unknown> = {}) => as(HR, () => service.create(TENANT, item(over) as any)) as Promise<any>;

  describe('setting them up', () => {
    it('adds an onboarding task owned by the department head, with its due date and category', async () => {
      const created = await create({ category: 'IT_SETUP', dueInDays: -1, description: 'Before day one' });

      expect(created).toMatchObject({ kind: 'ONBOARDING', department: { name: 'Engineering' }, title: 'Grant repository access', owner: { kind: 'DEPARTMENT_HEAD', employee: null, permission: null }, category: 'IT_SETUP', dueInDays: -1, isActive: true });
      expect(models.Audit.rows.map((row: any) => row.action)).toEqual(['CREATE']);
    });

    it('adds a clearance step owned by a permission or a named person', async () => {
      expect(await create({ kind: 'OFFBOARDING', title: 'Return keys', ownerKind: 'PERMISSION', ownerPermission: 'facilities.manage' })).toMatchObject({ owner: { permission: 'facilities.manage' }, category: null, dueInDays: null });
      expect(await create({ kind: 'OFFBOARDING', title: 'Hand over files', ownerKind: 'EMPLOYEE', ownerEmployeeId: lead.id })).toMatchObject({ owner: { employee: { name: 'Team Lead' } } });
    });

    it('applies to every department when none is named', async () => {
      expect((await create({ departmentId: undefined, title: 'Sign the handbook' })).department).toBeNull();
    });

    it('checks the owner fits the kind, and that every reference is real', async () => {
      await expect(create({ ownerKind: 'PERMISSION', ownerPermission: 'x.manage' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(create({ kind: 'OFFBOARDING', ownerKind: 'NONE' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(create({ ownerKind: 'EMPLOYEE' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(create({ ownerKind: 'EMPLOYEE', ownerEmployeeId: iris.id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(create({ kind: 'OFFBOARDING', ownerKind: 'PERMISSION' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(create({ departmentId: GHOST })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(models.Item.rows).toHaveLength(0);
    });

    it('refuses the same title twice in a department, and more than twenty of a kind', async () => {
      await create();
      await expect(create({ title: 'grant repository access' })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      for (let i = 1; i < 20; i++) await create({ title: `Task ${i}` });
      await expect(create({ title: 'One too many' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('changes an item, switches it off, and removes it', async () => {
      const created = await create();
      expect(await as(HR, () => service.update(TENANT, created.id, { title: 'Grant access', ownerKind: 'EMPLOYEE', ownerEmployeeId: lead.id, dueInDays: 3 } as any))).toMatchObject({ title: 'Grant access', owner: { kind: 'EMPLOYEE', employee: { name: 'Team Lead' } }, dueInDays: 3 });
      expect((await as(HR, () => service.update(TENANT, created.id, { isActive: false } as any))).isActive).toBe(false);
      expect(await service.remove(TENANT, created.id)).toEqual({ deleted: true, id: created.id });
      await expect(service.remove(TENANT, created.id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('lists by kind', async () => {
      await create();
      await create({ kind: 'OFFBOARDING', title: 'Return keys', ownerKind: 'REPORTING_MANAGER' });
      expect((await service.list(TENANT, { kind: 'OFFBOARDING' } as any)).data.map((row: any) => row.title)).toEqual(['Return keys']);
    });
  });

  describe('a new hire\'s checklist', () => {
    const hire = (over: Record<string, unknown> = {}) => ({ departmentId: backend.id, joiningDate: '2026-12-01', reportingManagerEmployeeId: lead.id, ...over });
    const tasks = (over: Record<string, unknown> = {}) => onboardingTasksFor(provider, TENANT, 'hire-1', hire(over)) as Promise<any[]>;

    it('gets what its department, the departments above it and every department add, after the standard items', async () => {
      await create({ title: 'Grant repository access', category: 'IT_SETUP', dueInDays: 0 });
      await create({ departmentId: backend.id, title: 'Pair with a senior', ownerKind: 'REPORTING_MANAGER', dueInDays: 2 });
      await create({ departmentId: undefined, title: 'Sign the handbook', ownerKind: 'NONE', dueInDays: -1 });
      await create({ departmentId: sales.id, title: 'Sales only', ownerKind: 'NONE' });

      const result = await tasks();

      expect(result.map((t) => t.title)).toEqual(['Grant repository access', 'Pair with a senior', 'Sign the handbook']);
      expect(result.map((t) => [t.assignedToEmployeeId, t.dueDate, t.category, t.sortOrder])).toEqual([
        [boss.id, '2026-12-01', 'IT_SETUP', 100],
        [lead.id, '2026-12-03', 'OTHER', 101],
        [null, '2026-11-30', 'OTHER', 102],
      ]);
      expect(result[0]).toMatchObject({ tenantId: TENANT, newHireId: 'hire-1', status: 'PENDING' });
    });

    it('leaves out an item that is switched off, and adds nothing when nothing is set', async () => {
      const created = await create();
      await as(HR, () => service.update(TENANT, created.id, { isActive: false } as any));
      expect(await tasks()).toEqual([]);
    });

    it('never holds up the hire when the table cannot be read', async () => {
      provider.getDepartmentChecklistItemModel = async () => {
        throw new Error('no table');
      };
      expect(await tasks()).toEqual([]);
    });
  });

  describe('when someone leaves', () => {
    let offboarding: OffboardingService;
    let tell: jest.Mock;
    const assetState = { cleared: true, blockers: [], confirmation: null, assets: [], pendingDeductions: [] };

    beforeEach(() => {
      const all: any = {
        ...provider,
        getOffboardingCaseModel: async () => models.Case,
        getOffboardingClearanceModel: async () => models.Clearance,
        getOffboardingSettingModel: async () => models.Setting,
        getFinalSettlementModel: async () => ({ findOne: async () => null }),
        getEmployeeLoanModel: async () => ({ count: async () => 0 }),
        getReimbursementModel: async () => ({ count: async () => 0 }),
        getEmployeeNotificationModel: async () => models.Notification,
      };
      tell = jest.fn();
      const dataScope: any = { assertCanSee: async () => undefined, employeeWhere: async () => ({}), actorEmployeeId: async () => null };
      offboarding = new OffboardingService(all, { getClearance: async () => assetState } as any, dataScope, { tellPermission: tell } as any);
    });

    const leave = (employee = dev) => as(HR, () => offboarding.initiate(TENANT, { employeeId: employee.id, type: 'RESIGNATION', lastWorkingDay: '2099-01-31' } as any)) as Promise<any>;

    it('works out the steps for the leaver\'s department, with who owns each', async () => {
      await create({ kind: 'OFFBOARDING', title: 'Revoke repository access', ownerKind: 'DEPARTMENT_HEAD' });
      await create({ kind: 'OFFBOARDING', departmentId: backend.id, title: 'Hand over on-call', ownerKind: 'REPORTING_MANAGER' });
      await create({ kind: 'OFFBOARDING', departmentId: undefined, title: 'Return keys', ownerKind: 'PERMISSION', ownerPermission: 'facilities.manage' });
      await create({ kind: 'OFFBOARDING', departmentId: sales.id, title: 'Sales only', ownerKind: 'PERMISSION', ownerPermission: 'sales.manage' });

      const steps = await offboardingStepsFor(provider, TENANT, 'case-1', dev);

      expect(steps.map((s) => [s.row.stage, s.title, s.ownerEmployeeId, s.ownerPermission])).toEqual([
        ['DEPT-1', 'Revoke repository access', boss.id, null],
        ['DEPT-2', 'Hand over on-call', lead.id, null],
        ['DEPT-3', 'Return keys', null, 'facilities.manage'],
      ]);
    });

    it('adds them to the case after the standard clearances, and tells each owner', async () => {
      await create({ kind: 'OFFBOARDING', title: 'Revoke repository access', ownerKind: 'DEPARTMENT_HEAD' });
      await create({ kind: 'OFFBOARDING', departmentId: undefined, title: 'Return keys', ownerKind: 'PERMISSION', ownerPermission: 'facilities.manage' });

      const result = await leave();

      expect(result.stages.map((s: any) => [s.stage, s.label, s.source])).toEqual([
        ['MANAGER', 'Reporting manager', 'MANUAL'],
        ['HR', 'HR', 'MANUAL'],
        ['IT', 'IT and assets', 'ASSETS'],
        ['FINANCE', 'Finance', 'MANUAL'],
        ['DEPT-1', 'Revoke repository access', 'DEPARTMENT'],
        ['DEPT-2', 'Return keys', 'DEPARTMENT'],
      ]);
      expect(result.stages[4].owner).toEqual({ kind: 'DEPARTMENT_HEAD', employeeId: boss.id, permission: null });
      expect(result.progress).toEqual({ cleared: 1, total: 6 });
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toContainEqual([boss.id, 'Offboarding started: Dev Person']);
      expect(tell).toHaveBeenCalledWith(TENANT, 'facilities.manage', [dev.id], 'Offboarding started: Dev Person', expect.stringContaining('Return keys'));
    });

    it('is cleared by its owner from their own list, and by nobody else', async () => {
      await create({ kind: 'OFFBOARDING', title: 'Revoke repository access', ownerKind: 'DEPARTMENT_HEAD' });
      const opened = await leave();

      const mine: any = await offboarding.getWaitingOnMe(TENANT, 'u-boss');
      expect(mine.total).toBe(1);
      expect(mine.data[0]).toMatchObject({ employee: { name: 'Dev Person' }, waitingOnMe: [{ stage: 'DEPT-1', label: 'Revoke repository access' }] });
      expect(mine.data[0].reason).toBeNull();

      await expect(offboarding.clearAsManager(TENANT, 'u-iris', undefined, 'x', null, 'DEPT-1')).rejects.toBeDefined();
      await expect(offboarding.clearAsManager(TENANT, 'u-lead', undefined, models.Case.rows[0].id, null, 'DEPT-1')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

      const cleared: any = await offboarding.clearAsManager(TENANT, 'u-boss', undefined, models.Case.rows[0].id, 'Access revoked', 'DEPT-1');
      expect(cleared.stages.find((s: any) => s.stage === 'DEPT-1')).toMatchObject({ status: 'CLEARED', note: 'Access revoked' });
      expect((await offboarding.getWaitingOnMe(TENANT, 'u-boss')).total).toBe(0);
      expect(opened.stages).toHaveLength(5);
    });

    it('is cleared by anyone holding the permission it names, or by HR', async () => {
      await create({ kind: 'OFFBOARDING', departmentId: undefined, title: 'Return keys', ownerKind: 'PERMISSION', ownerPermission: 'facilities.manage' });
      await leave();
      const id = models.Case.rows[0].id;
      models.Employee.rows.push(person({ id: 'fac-employee', employeeCode: 'E9', firstName: 'Fac', lastName: 'Officer', userId: 'u-fac', email: 'fac@x.com' }));

      const waiting: any = await as(FACILITIES, () => offboarding.getWaitingOnMe(TENANT, 'u-fac'));
      expect(waiting.data[0].waitingOnMe).toEqual([{ stage: 'DEPT-1', label: 'Return keys' }]);
      expect((await as(PLAIN, () => offboarding.getWaitingOnMe(TENANT, 'u-fac'))).total).toBe(0);

      await expect(as(PLAIN, () => offboarding.clearStage(TENANT, id, 'DEPT-1'))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      const byHr: any = await as(HR, () => offboarding.clearStage(TENANT, id, 'DEPT-1'));
      expect(byHr.stages.find((s: any) => s.stage === 'DEPT-1').status).toBe('CLEARED');
      await as(HR, () => offboarding.reopenStage(TENANT, id, 'DEPT-1'));
      const byPermission: any = await as(FACILITIES, () => offboarding.clearAsManager(TENANT, 'u-fac', undefined, id, null, 'DEPT-1'));
      expect(byPermission.stages.find((s: any) => s.stage === 'DEPT-1').status).toBe('CLEARED');
    });

    it('holds back being marked as resigned until it is cleared, when the organization asks for that', async () => {
      await create({ kind: 'OFFBOARDING', title: 'Revoke repository access', ownerKind: 'DEPARTMENT_HEAD' });
      await leave();
      models.Setting.create({ tenantId: TENANT, gateEnabled: true });
      const everything = { ...HR, permissions: ['offboarding.manage', 'payroll.adjustments.manage'] };
      for (const stage of ['MANAGER', 'HR', 'FINANCE']) await as(everything, () => offboarding.clearStage(TENANT, models.Case.rows[0].id, stage));

      await expect(offboarding.assertCanLeave(TENANT, dev.id)).rejects.toThrow('Revoke repository access');
      await as(HR, () => offboarding.clearStage(TENANT, models.Case.rows[0].id, 'DEPT-1'));
      await expect(offboarding.assertCanLeave(TENANT, dev.id)).resolves.toBeUndefined();
    });

    it('leaves a step to HR when it would fall to the leaver themself', async () => {
      await create({ kind: 'OFFBOARDING', title: 'Sign off the department', ownerKind: 'DEPARTMENT_HEAD' });
      const steps = await offboardingStepsFor(provider, TENANT, 'case-1', { id: boss.id, departmentId: eng.id, reportingManagerId: null });
      expect(steps[0].ownerEmployeeId).toBeNull();
    });

    it('asks for nothing extra when the department adds nothing', async () => {
      const result = await leave();
      expect(result.stages.map((s: any) => s.stage)).toEqual(['MANAGER', 'HR', 'IT', 'FINANCE']);
    });
  });
});
