import { Op } from 'sequelize';
import { runAsRpcActor } from '@app/tenant-context';
import { OffboardingService } from './offboarding.service';
import { addDays } from './learning-shared';
import { todayIso } from './workspace-shared';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CASE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const SARA = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const OMAR = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';

const row = (values: Record<string, any>) => {
  const r: any = { createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01'), ...values };
  r.get = () => ({ ...r });
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const HR = { roles: ['HR'], isSuperAdmin: false, isFullAccess: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['offboarding.manage'] };
const FINANCE = { roles: ['Finance'], isSuperAdmin: false, isFullAccess: false, userId: 'u-fin', email: 'fin@x.com', permissions: ['payroll.adjustments.manage'] };
const IT = { roles: ['IT'], isSuperAdmin: false, isFullAccess: false, userId: 'u-it', email: 'it@x.com', permissions: ['assets.edit'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

describe('OffboardingService', () => {
  let settings: any;
  let cases: any[];
  let clearances: any[];
  let employees: Record<string, any>;
  let notices: any[];
  let audits: any[];
  let assetState: any;
  let actorEmployee: string | null;
  let service: OffboardingService;

  const matching = (r: any, where: any = {}) => {
    const parts: any[] = where[Op.and] ?? [where];
    return parts.every((part) =>
      Reflect.ownKeys(part).every((key) => {
        const wanted = part[key as any];
        if (key === Op.and || key === Op.or) return true;
        const value = r[key as string];
        if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
          if (Op.in in wanted) return wanted[Op.in].includes(value);
          if (Op.lt in wanted) return value < wanted[Op.lt];
          return true;
        }
        return value === wanted;
      }),
    );
  };

  beforeEach(() => {
    settings = null;
    cases = [];
    clearances = [];
    notices = [];
    audits = [];
    actorEmployee = null;
    assetState = { cleared: false, blockers: ['1 asset is still with Anna Khan: AST-1.'], confirmation: null, assets: [{ assetCode: 'AST-1' }], pendingDeductions: [] };
    employees = {
      [ANNA]: { id: ANNA, firstName: 'Anna', lastName: 'Khan', employeeCode: 'E-1', status: 'ACTIVE', joiningDate: '2024-01-01', reportingManagerId: SARA },
      [SARA]: { id: SARA, firstName: 'Sara', lastName: 'Lead', employeeCode: 'E-2', status: 'ACTIVE', joiningDate: '2023-01-01', reportingManagerId: null },
      [OMAR]: { id: OMAR, firstName: 'Omar', lastName: 'Ali', employeeCode: 'E-3', status: 'ACTIVE', joiningDate: '2023-01-01', reportingManagerId: null },
    };

    const Case: any = {
      findOne: jest.fn(async ({ where }: any) => cases.find((c) => matching(c, where)) ?? null),
      findAndCountAll: jest.fn(async ({ where }: any) => {
        const found = cases.filter((c) => matching(c, where));
        return { rows: found, count: found.length };
      }),
      findAll: jest.fn(async ({ where }: any) => cases.filter((c) => matching(c, where))),
      count: jest.fn(async ({ where }: any) => cases.filter((c) => matching(c, where)).length),
      create: jest.fn(async (values: any) => {
        const created = row({ id: CASE, ...values });
        cases.push(created);
        return created;
      }),
    };
    const Clearance: any = {
      findAll: jest.fn(async ({ where }: any) => clearances.filter((c) => matching(c, where))),
      findOne: jest.fn(async ({ where }: any) => clearances.find((c) => matching(c, where)) ?? null),
      bulkCreate: jest.fn(async (values: any[]) => values.map((v) => (clearances.push(row({ id: `cl-${clearances.length}`, ...v })), v))),
    };
    const Setting: any = {
      findOne: jest.fn(async () => settings),
      create: jest.fn(async (values: any) => (settings = row(values))),
    };
    const Employee: any = {
      findOne: jest.fn(async ({ where }: any) => employees[where.id] ?? Object.values(employees).find((e: any) => e.userId === where.userId) ?? null),
      findAll: jest.fn(async ({ where }: any) => {
        if (where.reportingManagerId) return Object.values(employees).filter((e: any) => e.reportingManagerId === where.reportingManagerId);
        if (where.id) return where.id[Op.in].map((id: string) => employees[id]).filter(Boolean);
        return Object.values(employees);
      }),
    };
    const provider: any = {
      getOffboardingSettingModel: async () => Setting,
      getOffboardingCaseModel: async () => Case,
      getOffboardingClearanceModel: async () => Clearance,
      getFinalSettlementModel: async () => ({ findOne: jest.fn().mockResolvedValue(null) }),
      getEmployeeModel: async () => Employee,
      getEmployeeLoanModel: async () => ({ count: jest.fn().mockResolvedValue(2) }),
      getReimbursementModel: async () => ({ count: jest.fn().mockResolvedValue(1) }),
      getEmployeeNotificationModel: async () => ({ create: jest.fn(async (n: any) => notices.push(n)) }),
      getEntityAuditLogModel: async () => ({ create: jest.fn(async (a: any) => audits.push(a)) }),
    };
    const assetClearance: any = { getClearance: jest.fn(async () => assetState) };
    const dataScope: any = { assertCanSee: jest.fn().mockResolvedValue(undefined), employeeWhere: jest.fn().mockResolvedValue({}), actorEmployeeId: jest.fn(async () => actorEmployee) };
    service = new OffboardingService(provider, assetClearance, dataScope);
    employees[SARA].userId = 'u-sara';
    employees[ANNA].userId = 'u-anna';
  });

  const initiate = (over: Record<string, any> = {}) =>
    as(HR, () => service.initiate(TENANT, { employeeId: ANNA, type: 'RESIGNATION', lastWorkingDay: addDays(todayIso(), 30), noticeDate: todayIso(), ...over } as any));

  describe('settings', () => {
    it('start with the gate off and all four clearances', async () => {
      expect(await service.getSettings(TENANT)).toMatchObject({ gateEnabled: false, stages: ['MANAGER', 'HR', 'IT', 'FINANCE'] });
    });

    it('turns the gate on and picks clearances, in their usual order', async () => {
      const result = await as(HR, () => service.updateSettings(TENANT, { gateEnabled: true, stages: ['FINANCE', 'HR'] } as any));
      expect(result).toMatchObject({ gateEnabled: true, stages: ['HR', 'FINANCE'] });
      expect(audits[0]).toMatchObject({ tableName: 'offboarding_settings', action: 'UPDATE' });
    });
  });

  describe('why someone is leaving', () => {
    it('is shown to HR, who may see offboarding, and kept from Finance and IT', async () => {
      await initiate({ reason: 'Performance concerns' });

      const hr: any = await as(HR, () => service.getCase(TENANT, CASE));
      const finance: any = await as(FINANCE, () => service.getCase(TENANT, CASE));
      const it: any = await as(IT, () => service.getCase(TENANT, CASE));

      expect(hr).toMatchObject({ reason: 'Performance concerns', reasonHidden: false });
      expect(finance).toMatchObject({ reason: null, reasonHidden: true });
      expect(it).toMatchObject({ reason: null, reasonHidden: true });
      expect(JSON.stringify(finance)).not.toContain('Performance concerns');
    });

    it('is kept out of the list for them too, and from a cancellation reason', async () => {
      await initiate({ reason: 'Performance concerns' });
      await as(HR, () => service.cancel(TENANT, CASE, { reason: 'Resignation withdrawn' } as any));

      const list: any = await as(FINANCE, () => service.getCases(TENANT, { status: 'ALL' as any }));

      expect(list.data[0]).toMatchObject({ reason: null, cancelReason: null, reasonHidden: true });
      expect(JSON.stringify(list)).not.toContain('Resignation withdrawn');
    });

    it('shows no flag when there was no reason to hide', async () => {
      await initiate({});
      expect(await as(FINANCE, () => service.getCase(TENANT, CASE))).toMatchObject({ reason: null, reasonHidden: false });
    });
  });

  describe('starting', () => {
    it('opens a case with each clearance pending, tells the manager, and records it', async () => {
      const result: any = await initiate({ reason: 'Moving abroad' });

      expect(result).toMatchObject({ type: 'RESIGNATION', status: 'INITIATED', reason: 'Moving abroad', initiatedBy: 'hr@x.com', employee: { name: 'Anna Khan' } });
      expect(result.stages.map((s: any) => [s.stage, s.status, s.source])).toEqual([['MANAGER', 'PENDING', 'MANUAL'], ['HR', 'PENDING', 'MANUAL'], ['IT', 'PENDING', 'ASSETS'], ['FINANCE', 'PENDING', 'MANUAL']]);
      expect(result.progress).toEqual({ cleared: 0, total: 4 });
      expect(notices[0]).toMatchObject({ employeeId: SARA, title: 'Offboarding started: Anna Khan' });
      expect(audits[0]).toMatchObject({ tableName: 'offboarding_cases', action: 'CREATE' });
    });

    it('only creates the clearances the organization asks for', async () => {
      settings = row({ tenantId: TENANT, gateEnabled: false, stages: ['HR', 'FINANCE'] });
      const result: any = await initiate();
      expect(result.stages.map((s: any) => s.stage)).toEqual(['HR', 'FINANCE']);
      expect(notices).toHaveLength(0);
    });

    it('refuses a second open case, someone who has left, and impossible dates', async () => {
      await initiate();
      await expect(initiate()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already been started') });

      employees[OMAR].status = 'RESIGNED';
      await expect(initiate({ employeeId: OMAR })).rejects.toMatchObject({ status: 409 });

      cases.length = 0;
      await expect(initiate({ noticeDate: '2027-01-01', lastWorkingDay: '2026-12-01' })).rejects.toMatchObject({ status: 400 });
      await expect(initiate({ lastWorkingDay: '2020-01-01', noticeDate: null })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('before they joined') });
    });
  });

  describe('clearing', () => {
    beforeEach(async () => {
      await initiate();
    });

    it('lets HR clear HR and the manager part, and moves the case along', async () => {
      const afterHr: any = await as(HR, () => service.clearStage(TENANT, CASE, 'HR' as any, 'Exit interview done'));
      expect(afterHr.stages.find((s: any) => s.stage === 'HR')).toMatchObject({ status: 'CLEARED', clearedBy: 'hr@x.com', note: 'Exit interview done' });
      expect(afterHr.status).toBe('IN_CLEARANCE');
      expect(afterHr.progress.cleared).toBe(1);

      const afterManager: any = await as(HR, () => service.clearStage(TENANT, CASE, 'MANAGER' as any));
      expect(afterManager.progress.cleared).toBe(2);
    });

    it('lets Finance clear Finance with its payroll grant, and nothing else', async () => {
      expect(((await as(FINANCE, () => service.clearStage(TENANT, CASE, 'FINANCE' as any))) as any).stages.find((s: any) => s.stage === 'FINANCE').status).toBe('CLEARED');
      await expect(as(FINANCE, () => service.clearStage(TENANT, CASE, 'HR' as any))).rejects.toMatchObject({ status: 403 });
    });

    it('does not let someone clear a stage they have no say in', async () => {
      await expect(as(IT, () => service.clearStage(TENANT, CASE, 'HR' as any))).rejects.toMatchObject({ status: 403 });
      await expect(as(IT, () => service.clearStage(TENANT, CASE, 'FINANCE' as any))).rejects.toMatchObject({ status: 403 });
    });

    it('never lets the person leaving clear their own', async () => {
      actorEmployee = ANNA;
      await expect(as({ ...HR, userId: 'u-anna' }, () => service.clearStage(TENANT, CASE, 'HR' as any))).rejects.toMatchObject({ status: 403, message: expect.stringContaining('your own') });
    });

    it('does not take a hand-written IT clearance: it comes from the assets', async () => {
      await expect(as(HR, () => service.clearStage(TENANT, CASE, 'IT' as any))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('asset clearance') });
    });

    it('shows IT as cleared exactly when the asset clearance is, with what is stopping it until then', async () => {
      const before: any = await service.getCase(TENANT, CASE);
      expect(before.stages.find((s: any) => s.stage === 'IT')).toMatchObject({ status: 'PENDING', blockers: ['1 asset is still with Anna Khan: AST-1.'] });
      expect(before.assets).toMatchObject({ held: [{ assetCode: 'AST-1' }] });
      expect(before.finance).toEqual({ activeLoans: 2, reimbursementsInProgress: 1, pendingAssetDeductions: 0 });

      assetState = { cleared: true, blockers: [], confirmation: { confirmedBy: 'it@x.com', confirmedAt: new Date('2026-11-10'), note: 'All back' }, assets: [], pendingDeductions: [] };
      const after: any = await service.getCase(TENANT, CASE);
      expect(after.stages.find((s: any) => s.stage === 'IT')).toMatchObject({ status: 'CLEARED', clearedBy: 'it@x.com', note: 'All back' });
    });

    it('is cleared once every clearance is in', async () => {
      assetState = { cleared: true, blockers: [], confirmation: null, assets: [], pendingDeductions: [] };
      await as(HR, () => service.clearStage(TENANT, CASE, 'HR' as any));
      await as(HR, () => service.clearStage(TENANT, CASE, 'MANAGER' as any));
      const done: any = await as(FINANCE, () => service.clearStage(TENANT, CASE, 'FINANCE' as any));
      expect(done.status).toBe('CLEARED');
    });

    it('takes a clearance back', async () => {
      await as(HR, () => service.clearStage(TENANT, CASE, 'HR' as any));
      const back: any = await as(HR, () => service.reopenStage(TENANT, CASE, 'HR' as any, 'A laptop turned up'));
      expect(back.stages.find((s: any) => s.stage === 'HR')).toMatchObject({ status: 'PENDING', clearedBy: null });
    });

    it('does nothing the second time it is cleared', async () => {
      await as(HR, () => service.clearStage(TENANT, CASE, 'HR' as any));
      audits.length = 0;
      await as(HR, () => service.clearStage(TENANT, CASE, 'HR' as any));
      expect(audits).toHaveLength(0);
    });
  });

  describe('the reporting manager', () => {
    beforeEach(async () => {
      await initiate();
    });

    it('sees the offboarding of the people who report to them, while their clearance is wanted', async () => {
      const mine = await service.getWaitingOnMe(TENANT, 'u-sara');
      expect(mine.total).toBe(1);
      expect((mine.data[0] as any).employee.name).toBe('Anna Khan');

      await service.clearAsManager(TENANT, 'u-sara', undefined, CASE);
      expect((await service.getWaitingOnMe(TENANT, 'u-sara')).total).toBe(0);
    });

    it('clears only their report\'s, not anyone else\'s', async () => {
      const stranger = { id: 'x', firstName: 'No', lastName: 'Relation', userId: 'u-x', status: 'ACTIVE', reportingManagerId: null };
      employees.x = stranger;
      await expect(service.clearAsManager(TENANT, 'u-x', undefined, CASE)).rejects.toMatchObject({ status: 403 });
      await expect(service.clearAsManager(TENANT, 'u-anna', undefined, CASE)).rejects.toMatchObject({ status: 403 });
    });

    it('has nothing waiting when they manage nobody', async () => {
      expect(await service.getWaitingOnMe(TENANT, 'u-anna')).toEqual({ data: [], total: 0 });
    });
  });

  describe('changing and ending', () => {
    beforeEach(async () => {
      await initiate();
    });

    it('changes the dates of an open case, and refuses once it is closed', async () => {
      const result: any = await service.update(TENANT, CASE, { lastWorkingDay: addDays(todayIso(), 45) } as any);
      expect(result.lastWorkingDay).toBe(addDays(todayIso(), 45));

      await service.cancel(TENANT, CASE, { reason: 'Withdrawn' } as any);
      await expect(service.update(TENANT, CASE, { reason: 'x' } as any)).rejects.toMatchObject({ status: 409 });
    });

    it('can be cancelled with a reason, and then a new one can be started', async () => {
      const cancelled: any = await service.cancel(TENANT, CASE, { reason: 'Resignation withdrawn' } as any);
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Resignation withdrawn' });
      expect(await initiate()).toBeDefined();
    });

    it('lists open cases by default, and filters by status', async () => {
      await service.cancel(TENANT, CASE, {} as any);
      expect((await service.getCases(TENANT, {})).data).toHaveLength(0);
      const all = await service.getCases(TENANT, { status: 'ALL' as any });
      expect(all.data).toHaveLength(1);
      expect(all.summary).toEqual({ open: 0, completed: 0, cancelled: 1 });
    });
  });

  describe('the gate on leaving', () => {
    const turnOn = () => as(HR, () => service.updateSettings(TENANT, { gateEnabled: true } as any));

    it('lets anyone go while the gate is off', async () => {
      await expect(service.assertCanLeave(TENANT, ANNA)).resolves.toBeUndefined();
    });

    it('needs an open offboarding once it is on', async () => {
      await turnOn();
      await expect(service.assertCanLeave(TENANT, ANNA)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Start offboarding') });
    });

    it('says which clearances are still missing', async () => {
      await turnOn();
      await initiate();
      await as(HR, () => service.clearStage(TENANT, CASE, 'HR' as any));
      await expect(service.assertCanLeave(TENANT, ANNA)).rejects.toMatchObject({ status: 409, message: 'Offboarding is not cleared yet. Still waiting for: Reporting manager, IT and assets, Finance.' });
    });

    it('lets them go once everything is cleared', async () => {
      await turnOn();
      await initiate();
      assetState = { cleared: true, blockers: [], confirmation: null, assets: [], pendingDeductions: [] };
      await as(HR, () => service.clearStage(TENANT, CASE, 'HR' as any));
      await as(HR, () => service.clearStage(TENANT, CASE, 'MANAGER' as any));
      await as(FINANCE, () => service.clearStage(TENANT, CASE, 'FINANCE' as any));
      await expect(service.assertCanLeave(TENANT, ANNA)).resolves.toBeUndefined();
    });
  });

  describe('when they leave', () => {
    it('completes the open case, and keeps IT\'s answer as it stood', async () => {
      await initiate();
      assetState = { cleared: true, blockers: [], confirmation: null, assets: [], pendingDeductions: [] };

      await service.completeForExit(TENANT, ANNA);

      expect(cases[0]).toMatchObject({ status: 'COMPLETED' });
      expect(cases[0].completedAt).toBeInstanceOf(Date);
      expect(clearances.find((c) => c.stage === 'IT').status).toBe('CLEARED');
    });

    it('does nothing when there was no offboarding', async () => {
      await expect(service.completeForExit(TENANT, OMAR)).resolves.toBeUndefined();
    });

    it('offers the last working day to fill in the exit date', async () => {
      await initiate({ lastWorkingDay: '2026-12-15' });
      expect(await service.lastWorkingDayOf(TENANT, ANNA)).toBe('2026-12-15');
      expect(await service.lastWorkingDayOf(TENANT, OMAR)).toBeNull();
    });
  });
});
