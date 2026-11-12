import { HttpStatus } from '@nestjs/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PerformanceCycleService } from './performance-cycle.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { DEFAULT_ELIGIBILITY, EligibilityEmployee, evaluateEligibility, normalizeEligibility } from './performance-eligibility';
import { table } from './testing/fake-table';

/**
 * Review cycles and eligibility: who the rules include and why not, what
 * happens when a cycle launches, and how someone who becomes eligible later
 * (hired, confirmed after probation) is picked up.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['performance.manage'] };
const EDITOR = { roles: [], isSuperAdmin: false, userId: 'u-ed', email: 'ed@x.com', permissions: ['performance.edit'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

describe('evaluateEligibility', () => {
  const cycle = { startDate: '2026-07-01', endDate: '2026-12-31' };
  const rules = (over: Record<string, unknown> = {}) => normalizeEligibility(over as any);
  const employee = (over: Partial<EligibilityEmployee> = {}): EligibilityEmployee => ({ id: 'e1', status: 'ACTIVE', joiningDate: '2025-01-01', employmentType: 'PERMANENT', departmentId: 'eng', designationId: 'dev', ...over });
  const decide = (over: Partial<EligibilityEmployee> = {}, ruleOver: Record<string, unknown> = {}, departments: string[] = [], today = '2026-11-01') =>
    evaluateEligibility(employee(over), cycle, rules(ruleOver), new Set(departments), today);

  it('starts from sensible defaults', () => {
    expect(normalizeEligibility(undefined)).toEqual(DEFAULT_ELIGIBILITY);
    expect(normalizeEligibility({ minTenureDays: -5, probation: 'nonsense' as any })).toMatchObject({ minTenureDays: 90, probation: 'EXCLUDE' });
  });

  it('includes an established employee with no rules in the way', () => {
    expect(decide()).toEqual({ eligible: true, reason: null, code: 'ELIGIBLE' });
  });

  it('leaves out someone who has not served the minimum time, counted to today or the cycle end, whichever is first', () => {
    expect(decide({ joiningDate: '2026-09-01' })).toMatchObject({ eligible: false, code: 'TENURE', reason: 'Has worked 61 of the 90 days required.' });
    expect(decide({ joiningDate: '2026-09-01' }, {}, [], '2027-03-01')).toMatchObject({ eligible: true });
    // Time after the cycle ended does not count towards it.
    expect(decide({ joiningDate: '2026-11-15' }, {}, [], '2027-03-01')).toMatchObject({ eligible: false, code: 'TENURE' });
    expect(decide({ joiningDate: '2026-09-01' }, { minTenureDays: 30 })).toMatchObject({ eligible: true });
    expect(decide({ joiningDate: '2026-12-30' }, { minTenureDays: 0 }, [], '2026-12-31')).toMatchObject({ eligible: true });
  });

  it('leaves out someone who joined after the cycle ended, or left before it began', () => {
    expect(decide({ joiningDate: '2027-02-01' })).toMatchObject({ code: 'JOINED_AFTER_CYCLE', eligible: false });
    expect(decide({ exitDate: '2026-05-01' })).toMatchObject({ code: 'LEFT_BEFORE_CYCLE', eligible: false });
    expect(decide({ exitDate: '2026-09-01' })).toMatchObject({ eligible: true });
  });

  it('follows the probation rule, by employment type or by the probation end date', () => {
    expect(decide({ employmentType: 'PROBATION' })).toMatchObject({ code: 'PROBATION', eligible: false });
    expect(decide({ probationEndDate: '2026-12-01' })).toMatchObject({ code: 'PROBATION', reason: 'On probation until 2026-12-01.' });
    expect(decide({ probationEndDate: '2026-08-01' })).toMatchObject({ eligible: true });
    expect(decide({ employmentType: 'PROBATION' }, { probation: 'INCLUDE' })).toMatchObject({ eligible: true });
  });

  it('keeps to the employment types, departments and designations a cycle names, with the departments under them', () => {
    expect(decide({}, { employmentTypes: ['CONTRACT'] })).toMatchObject({ code: 'EMPLOYMENT_TYPE', eligible: false });
    expect(decide({}, { employmentTypes: ['PERMANENT', 'CONTRACT'] })).toMatchObject({ eligible: true });
    expect(decide({ departmentId: 'backend' }, { departmentIds: ['eng'] }, ['eng', 'backend'])).toMatchObject({ eligible: true });
    expect(decide({ departmentId: 'sales' }, { departmentIds: ['eng'] }, ['eng', 'backend'])).toMatchObject({ code: 'DEPARTMENT', eligible: false });
    expect(decide({ departmentId: null }, { departmentIds: ['eng'] }, ['eng'])).toMatchObject({ code: 'DEPARTMENT' });
    expect(decide({}, { designationIds: ['lead'] })).toMatchObject({ code: 'DESIGNATION', eligible: false });
    expect(decide({}, { designationIds: ['dev'] })).toMatchObject({ eligible: true });
  });

  it('lets HR include or exclude people whatever the rules say, but never someone who has left', () => {
    expect(decide({ joiningDate: '2026-12-01', employmentType: 'PROBATION' }, { includeEmployeeIds: ['e1'] })).toEqual({ eligible: true, reason: null, code: 'INCLUDED_BY_HR' });
    expect(decide({}, { excludeEmployeeIds: ['e1'] })).toMatchObject({ code: 'EXCLUDED_BY_HR', eligible: false });
    expect(decide({ status: 'RESIGNED' }, { includeEmployeeIds: ['e1'] })).toMatchObject({ code: 'NOT_EMPLOYED', eligible: false });
    expect(decide({ status: 'INACTIVE' })).toMatchObject({ code: 'NOT_EMPLOYED' });
    expect(decide({ status: 'ON_LEAVE' })).toMatchObject({ eligible: true });
  });
});

describe('PerformanceCycleService', () => {
  let models: Record<string, any>;
  let provider: any;
  let service: PerformanceCycleService;
  let boss: any;
  let sara: any;
  let ayesha: any;
  let omar: any;
  let newbie: any;
  let probie: any;
  let orphan: any;
  let gone: any;
  let eng: any;
  let backend: any;

  const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', joiningDate: '2024-01-01', employmentType: 'PERMANENT', reportingManagerId: null, departmentId: null, ...over });
  const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E0', firstName: 'Boss', lastName: 'Head', userId: 'u-boss', email: 'boss@x.com' }),
        person({ employeeCode: 'E1', firstName: 'Sara', lastName: 'Manager', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Sales', userId: 'u-omar', email: 'omar@x.com' }),
        person({ employeeCode: 'E4', firstName: 'Newbie', lastName: 'Joiner', userId: 'u-new', email: 'new@x.com', joiningDate: daysFromNow(-20) }),
        person({ employeeCode: 'E5', firstName: 'Probie', lastName: 'Tester', userId: 'u-probie', email: 'probie@x.com', employmentType: 'PROBATION' }),
        person({ employeeCode: 'E6', firstName: 'Orphan', lastName: 'NoManager', userId: 'u-orphan', email: 'orphan@x.com' }),
        person({ employeeCode: 'E7', firstName: 'Gone', lastName: 'Away', userId: 'u-gone', email: 'gone@x.com', status: 'RESIGNED' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Engineering' }, { tenantId: TENANT, name: 'Backend' }, { tenantId: TENANT, name: 'Sales' }]),
      Designation: table(),
      Review: table(),
      Cycle: table(),
      Notification: table(),
      Audit: table(),
    };
    [boss, sara, ayesha, omar, newbie, probie, orphan, gone] = models.Employee.rows;
    const [engRow, backendRow, salesRow] = models.Department.rows;
    eng = engRow;
    backend = backendRow;
    backend.parentDepartmentId = eng.id;
    ayesha.departmentId = backend.id;
    ayesha.reportingManagerId = sara.id;
    sara.departmentId = eng.id;
    omar.departmentId = salesRow.id;
    omar.reportingManagerId = sara.id;
    newbie.departmentId = eng.id;
    newbie.reportingManagerId = sara.id;
    probie.departmentId = eng.id;
    probie.reportingManagerId = sara.id;
    orphan.departmentId = eng.id;
    provider = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => models.Designation,
      getPerformanceReviewModel: async () => models.Review,
      getPerformanceCycleModel: async () => models.Cycle,
      getEmployeeNotificationModel: async () => models.Notification,
      getEntityAuditLogModel: async () => models.Audit,
    };
    service = new PerformanceCycleService(provider, new PerformanceDashboardService(provider));
  });

  const draft = (over: Record<string, unknown> = {}) =>
    as(HR, () => service.create(TENANT, { name: 'H2 2026', startDate: '2026-07-01', endDate: '2026-12-31', dueDate: daysFromNow(30), ...over } as any)) as Promise<any>;
  const live = async (over: Record<string, unknown> = {}) => {
    const cycle = await draft(over);
    await as(HR, () => service.launch(TENANT, cycle.id));
    return cycle;
  };
  const reviewers = () => models.Review.rows.map((r: any) => [models.Employee.rows.find((e: any) => e.id === r.employeeId).firstName, r.reviewerId ? models.Employee.rows.find((e: any) => e.id === r.reviewerId).firstName : null]);

  describe('setting one up', () => {
    it('creates a draft with the rules filled in, and refuses bad periods, repeated names and unknown references', async () => {
      const cycle = await draft({ eligibility: { minTenureDays: 60, departmentIds: [eng.id] } });
      expect(cycle).toMatchObject({ name: 'H2 2026', status: 'DRAFT', enrolmentMode: 'AUTO_ENROL', eligibility: { minTenureDays: 60, probation: 'EXCLUDE', departmentIds: [eng.id] }, enrolled: 0 });

      await expect(draft({ name: ' h2 2026 ' })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(draft({ name: 'Other', endDate: '2026-06-01' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(draft({ name: 'Other', eligibility: { departmentIds: [GHOST] } })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(draft({ name: 'Other', eligibility: { includeEmployeeIds: [ayesha.id], excludeEmployeeIds: [ayesha.id] } })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(draft({ name: 'Other', fallbackReviewerId: gone.id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('changes freely as a draft, narrowly once launched, and not at all once closed', async () => {
      const cycle = await draft();
      expect(await as(HR, () => service.update(TENANT, cycle.id, { name: 'H2', eligibility: { minTenureDays: 30 } } as any))).toMatchObject({ name: 'H2', eligibility: { minTenureDays: 30 } });

      await as(HR, () => service.launch(TENANT, cycle.id));
      await expect(as(HR, () => service.update(TENANT, cycle.id, { name: 'New name' } as any))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(as(HR, () => service.update(TENANT, cycle.id, { endDate: '2027-01-31' } as any))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(await as(HR, () => service.update(TENANT, cycle.id, { dueDate: '2027-02-28', enrolmentMode: 'HR_QUEUE' } as any))).toMatchObject({ dueDate: '2027-02-28', enrolmentMode: 'HR_QUEUE' });

      await as(HR, () => service.close(TENANT, cycle.id));
      await expect(as(HR, () => service.update(TENANT, cycle.id, { dueDate: '2027-03-31' } as any))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('deletes only a cycle that has not launched', async () => {
      const cycle = await draft();
      expect(await service.remove(TENANT, cycle.id)).toEqual({ deleted: true, id: cycle.id });
      const launched = await live({ name: 'Live one' });
      await expect(service.remove(TENANT, launched.id)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(service.get(TENANT, GHOST)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('seeing who is in', () => {
    it('shows who the rules include and why not, counting those who have left without listing them', async () => {
      const cycle = await draft();

      const preview: any = await service.preview(TENANT, cycle.id);

      expect(preview.byReason).toMatchObject({ ELIGIBLE: 5, TENURE: 1, PROBATION: 1, NOT_EMPLOYED: 1 });
      expect(preview.summary).toEqual({ eligible: 5, excluded: 2, enrolled: 0 });
      expect(preview.total).toBe(7);
      expect(preview.data.find((row: any) => row.name === 'Newbie Joiner')).toMatchObject({ eligible: false, code: 'TENURE', reason: expect.stringContaining('of the 90 days') });
      expect(preview.data.find((row: any) => row.name === 'Gone Away')).toBeUndefined();
    });

    it('counts what a cycle needs for HR to act', async () => {
      const cycle = await draft({ eligibility: { departmentIds: [eng.id] } });
      expect(((await service.get(TENANT, cycle.id)) as any).counts).toEqual({ eligible: 3, excluded: 4, waiting: 3 });
    });
  });

  describe('launching', () => {
    it('gives each eligible person their review, with the reviewer the rules give, and nobody else', async () => {
      const cycle = await draft({ fallbackReviewerId: boss.id });

      const launched: any = await as(HR, () => service.launch(TENANT, cycle.id));

      expect(launched).toMatchObject({ status: 'ACTIVE', launched: { enrolled: 5, queued: 0 }, enrolled: 5 });
      expect(reviewers().sort()).toEqual([['Ayesha', 'Sara'], ['Boss', null], ['Omar', 'Sara'], ['Orphan', 'Boss'], ['Sara', 'Boss']].sort());
      expect(models.Review.rows.every((r: any) => r.cycleId === cycle.id && r.cycle === 'H2 2026' && r.employeeSnapshot)).toBe(true);
      const named = models.Review.rows.map((r: any) => r.employeeId);
      expect([newbie.id, probie.id, gone.id].some((id) => named.includes(id))).toBe(false);
      expect(models.Audit.rows.map((row: any) => row.changes?.event?.to)).toContain('CYCLE_LAUNCHED');
    });

    it('leaves someone with no manager and no fallback for HR, and asks the eligible employees for a self-assessment', async () => {
      await live();
      expect(reviewers()).toContainEqual(['Orphan', null]);
      expect(models.Notification.rows.filter((n: any) => n.employeeId === orphan.id).map((n: any) => n.title)).toEqual(['Self-assessment requested: H2 2026']);
      expect(models.Notification.rows.some((n: any) => n.employeeId === sara.id && n.title === 'Review to complete: Ayesha Khan')).toBe(true);
    });

    it('does not enrol anyone by itself in HR_QUEUE mode, but lists them', async () => {
      const cycle = await live({ enrolmentMode: 'HR_QUEUE', name: 'Queue' });
      expect(models.Review.rows).toHaveLength(0);
      const queue: any = await service.queue(TENANT, cycle.id);
      expect(queue.total).toBe(5);
      expect(queue.data.every((row: any) => row.eligible && !row.enrolled)).toBe(true);
    });

    it('cannot be launched twice, nor closed before it is running', async () => {
      const cycle = await live();
      await expect(as(HR, () => service.launch(TENANT, cycle.id))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      const other = await draft({ name: 'Other' });
      await expect(as(HR, () => service.close(TENANT, other.id))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });
  });

  describe('enrolling by hand', () => {
    it('enrols eligible people, notes who is already in, and refuses those the rules leave out with the reason', async () => {
      const cycle = await live({ enrolmentMode: 'HR_QUEUE', name: 'Queue' });

      const result: any = await as(HR, () => service.enrol(TENANT, cycle.id, { employeeIds: [ayesha.id, newbie.id, ayesha.id, GHOST] } as any));

      expect(result.enrolled).toEqual([ayesha.id]);
      expect(result.refused.map((r: any) => [r.employeeId, r.reason])).toEqual([[newbie.id, expect.stringContaining('of the 90 days')], [GHOST, expect.any(String)]]);
      expect((await as(HR, () => service.enrol(TENANT, cycle.id, { employeeIds: [ayesha.id] } as any))).alreadyIn).toEqual([ayesha.id]);
      expect((await service.queue(TENANT, cycle.id)).total).toBe(4);
    });

    it('enrols someone the rules leave out only with an override, only by someone who manages performance, and records it', async () => {
      const cycle = await live({ enrolmentMode: 'HR_QUEUE', name: 'Queue' });

      await expect(as(EDITOR, () => service.enrol(TENANT, cycle.id, { employeeIds: [newbie.id], override: true } as any))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      const result: any = await as(HR, () => service.enrol(TENANT, cycle.id, { employeeIds: [newbie.id, gone.id], override: true } as any));

      expect(result.enrolled.sort()).toEqual([newbie.id, gone.id].sort());
      expect(models.Audit.rows.filter((row: any) => row.changes?.event?.to === 'ELIGIBILITY_OVERRIDDEN')).toHaveLength(2);
    });

    it('only works on a cycle that is running', async () => {
      const cycle = await draft();
      await expect(as(HR, () => service.enrol(TENANT, cycle.id, { employeeIds: [ayesha.id] } as any))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });
  });

  describe('when Employee Management changes someone', () => {
    it('enrols a person who becomes eligible, such as one confirmed after probation, once', async () => {
      await live();
      expect(models.Review.rows.map((r: any) => r.employeeId)).not.toContain(probie.id);

      probie.employmentType = 'PERMANENT';
      expect(await service.onEmployeeChange(TENANT, probie.id)).toBe(1);
      expect(await service.onEmployeeChange(TENANT, probie.id)).toBe(0);
      expect(models.Review.rows.filter((r: any) => r.employeeId === probie.id)).toHaveLength(1);
    });

    it('does nothing for someone still left out, in an HR_QUEUE cycle, in a closed one, or after the due date', async () => {
      await live({ name: 'Auto' });
      expect(await service.onEmployeeChange(TENANT, newbie.id)).toBe(0);

      probie.employmentType = 'PERMANENT';
      const queue = await live({ enrolmentMode: 'HR_QUEUE', name: 'Queue' });
      const auto = models.Cycle.rows.find((c: any) => c.name === 'Auto');
      await as(HR, () => service.close(TENANT, auto.id));
      expect(await service.onEmployeeChange(TENANT, probie.id)).toBe(0);

      await as(HR, () => service.close(TENANT, queue.id));
      const late = await live({ name: 'Late', dueDate: daysFromNow(-1) });
      expect(await service.onEmployeeChange(TENANT, probie.id)).toBe(0);
      expect(late.status).toBe('DRAFT');
    });

    it('does not make a second review when one exists under the same cycle name', async () => {
      const cycle = await live();
      const before = models.Review.rows.length;
      models.Review.rows.splice(0, models.Review.rows.length);
      models.Review.create({ tenantId: TENANT, employeeId: ayesha.id, cycle: ' h2 2026 ', status: 'PENDING' });

      expect(await service.onEmployeeChange(TENANT, ayesha.id)).toBe(0);
      expect(before).toBeGreaterThan(1);
      expect(cycle.id).toBeDefined();
    });
  });

  describe('the daily sweep', () => {
    // A cycle that runs long enough for time alone to change who is in it.
    const long = (over: Record<string, unknown> = {}) => live({ endDate: '2099-12-31', dueDate: daysFromNow(400), ...over });

    it('enrols someone whom time alone has made eligible, once, and writes it down', async () => {
      await long();
      expect(models.Review.rows.map((r: any) => r.employeeId)).not.toContain(newbie.id);

      // Twenty days in, the 90 required have not passed; a hundred days on, they have.
      expect(await service.sweep(TENANT, daysFromNow(10))).toMatchObject({ cycles: 1, enrolled: 0 });
      const result = await service.sweep(TENANT, daysFromNow(100));

      expect(result).toMatchObject({ cycles: 1, enrolled: 1, flagged: 0, cleared: 0 });
      expect(models.Review.rows.filter((r: any) => r.employeeId === newbie.id)).toHaveLength(1);
      expect(models.Review.rows.find((r: any) => r.employeeId === newbie.id).reviewerId).toBe(sara.id);
      expect(models.Audit.rows.map((row: any) => row.changes?.event?.to)).toContain('CYCLE_SWEEP_ENROLLED');
      expect(await service.sweep(TENANT, daysFromNow(101))).toMatchObject({ enrolled: 0 });
    });

    it('lists, but does not enrol, in an HR_QUEUE cycle, and takes no one new after the due date or in a closed cycle', async () => {
      const queue = await long({ name: 'Queue', enrolmentMode: 'HR_QUEUE' });
      expect(await service.sweep(TENANT, daysFromNow(100))).toMatchObject({ enrolled: 0 });
      expect(models.Review.rows.map((r: any) => r.employeeId)).not.toContain(newbie.id);
      await as(HR, () => service.close(TENANT, queue.id));

      await long({ name: 'Auto', dueDate: daysFromNow(50) });
      expect(await service.sweep(TENANT, daysFromNow(100))).toMatchObject({ enrolled: 0 });
      expect(models.Review.rows.map((r: any) => r.employeeId)).not.toContain(newbie.id);
    });

    it('never enrols someone who has left, or whom HR left out', async () => {
      await long({ eligibility: { minTenureDays: 0, excludeEmployeeIds: [omar.id] } });
      const before = models.Review.rows.length;

      expect(await service.sweep(TENANT, daysFromNow(100))).toMatchObject({ enrolled: expect.any(Number) });
      const enrolled = models.Review.rows.map((r: any) => r.employeeId);
      expect(enrolled).not.toContain(gone.id);
      expect(enrolled).not.toContain(omar.id);
      expect(models.Review.rows.length).toBeGreaterThanOrEqual(before);
    });

    it('does nothing when there is no running cycle', async () => {
      await draft({ name: 'Not yet' });
      expect(await service.sweep(TENANT)).toEqual({ cycles: 0, enrolled: 0, flagged: 0, cleared: 0 });
    });

    it('goes on with the other cycles when one cannot be read', async () => {
      await long({ name: 'Broken', eligibility: { minTenureDays: 0 } });
      const second = await long({ name: 'Fine' });
      expect(second.id).toBeDefined();
      const original = models.Employee.findAll;
      let calls = 0;
      models.Employee.findAll = jest.fn(async (query: any) => {
        if (++calls === 1) throw new Error('database hiccup');
        return original(query);
      });

      await expect(service.sweep(TENANT, daysFromNow(100))).resolves.toMatchObject({ cycles: 2 });
      expect(calls).toBeGreaterThan(1);
    });
  });
});
