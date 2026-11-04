import {
  Actor,
  DEFAULT_LEAVE_POLICY,
  PolicyStage,
  RoutePerson,
  advanceApproval,
  approvedStages,
  buildApproval,
  canActOnStage,
  completeApproval,
  handOnApproval,
  rejectApproval,
  rerouteApproval,
  resolveStages,
  stagesOf,
} from './approval-engine';

const people: Record<string, RoutePerson> = {
  emp: { id: 'emp', firstName: 'Naveed', lastName: 'Ahmad', reportingManagerId: 'lead', designationId: null, departmentId: 'eng', status: 'ACTIVE' },
  lead: { id: 'lead', firstName: 'Tayyaba', lastName: 'Sabir', reportingManagerId: 'mgr', designationId: 'des-lead', departmentId: 'eng', status: 'ACTIVE' },
  mgr: { id: 'mgr', firstName: 'Ali', lastName: 'Khan', reportingManagerId: 'director', designationId: 'des-mgr', departmentId: 'eng', status: 'ACTIVE' },
  director: { id: 'director', firstName: 'Dina', lastName: 'Shah', reportingManagerId: null, designationId: 'des-dir', departmentId: 'ops', status: 'ACTIVE' },
  head: { id: 'head', firstName: 'Hira', lastName: 'Noor', reportingManagerId: null, designationId: null, departmentId: 'eng', status: 'ACTIVE' },
  gone: { id: 'gone', firstName: 'Gul', lastName: 'Zar', reportingManagerId: null, designationId: null, departmentId: 'eng', status: 'RESIGNED' },
};
const titles: Record<string, string> = { 'des-lead': 'Team Lead', 'des-mgr': 'Engineering Manager', 'des-dir': 'Director' };

const lookup = (overrides: Record<string, RoutePerson> = {}, heads: Record<string, string | null> = { eng: 'head' }) => {
  const all = { ...people, ...overrides };
  return {
    person: async (id: string) => all[id] ?? null,
    designationTitle: async (id: string) => titles[id] ?? null,
    departmentHead: async (id: string) => heads[id] ?? null,
  };
};

const route = (policy: PolicyStage[], requester = 'emp', overrides: Record<string, RoutePerson> = {}, heads?: Record<string, string | null>) =>
  resolveStages(policy, requester, lookup(overrides, heads));

describe('resolveStages', () => {
  it('follows the built-in route: the manager, then their manager', async () => {
    const stages = await route(DEFAULT_LEAVE_POLICY);
    expect(stages.map((s) => [s.approverId, s.title])).toEqual([['lead', 'Team Lead'], ['mgr', 'Engineering Manager']]);
  });

  it('ends at HR when the line above runs out', async () => {
    const stages = await route(DEFAULT_LEAVE_POLICY, 'emp', { lead: { ...people.lead, reportingManagerId: null } });
    expect(stages.map((s) => [s.kind, s.approverId])).toEqual([['REPORTING_MANAGER', 'lead'], ['HR', null]]);
  });

  it('sends a request straight to HR when nobody manages the requester', async () => {
    const stages = await route(DEFAULT_LEAVE_POLICY, 'emp', { emp: { ...people.emp, reportingManagerId: null } });
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ kind: 'HR', approverId: null, title: 'HR' });
  });

  it('never asks the requester, and a reporting loop ends at HR', async () => {
    const looped = await route(DEFAULT_LEAVE_POLICY, 'emp', { mgr: { ...people.mgr, reportingManagerId: 'emp' } });
    expect(looped.map((s) => s.approverId)).toEqual(['lead', 'mgr']);
    const third = await route([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }], 'emp', {
      mgr: { ...people.mgr, reportingManagerId: 'emp' },
    });
    expect(third.map((s) => s.approverId)).toEqual(['lead', 'mgr', null]);
    expect(third[2].kind).toBe('HR');
  });

  it('reaches up to three levels', async () => {
    const stages = await route([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }]);
    expect(stages.map((s) => s.approverId)).toEqual(['lead', 'mgr', 'director']);
    expect(stages[0].title).toBe('Team Lead');
  });

  it('names a fallback title when the person has no designation', async () => {
    const stages = await route([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }], 'emp', {
      lead: { ...people.lead, designationId: null },
      mgr: { ...people.mgr, designationId: null },
    });
    expect(stages.map((s) => s.title)).toEqual(['Reporting manager', 'Manager']);
  });

  it('resolves the head of the requester\'s department', async () => {
    const stages = await route([{ kind: 'DEPARTMENT_HEAD' }]);
    expect(stages).toEqual([{ kind: 'DEPARTMENT_HEAD', approverId: 'head', name: 'Hira Noor', title: 'Department head', permission: null }]);
  });

  it('goes to HR when the department has no head, or the head is the requester', async () => {
    expect((await route([{ kind: 'DEPARTMENT_HEAD' }], 'emp', {}, { eng: null }))[0].kind).toBe('HR');
    expect((await route([{ kind: 'DEPARTMENT_HEAD' }], 'head'))[0].kind).toBe('HR');
  });

  it('resolves a named approver, and skips them as HR when they have left', async () => {
    expect((await route([{ kind: 'EMPLOYEE', employeeId: 'director' }]))[0]).toMatchObject({ kind: 'EMPLOYEE', approverId: 'director', title: 'Director' });
    expect((await route([{ kind: 'EMPLOYEE', employeeId: 'gone' }]))[0].kind).toBe('HR');
    expect((await route([{ kind: 'EMPLOYEE', employeeId: 'nobody' }]))[0].kind).toBe('HR');
  });

  it('a manager who has left ends the route at HR', async () => {
    const stages = await route(DEFAULT_LEAVE_POLICY, 'emp', { lead: { ...people.lead, status: 'RESIGNED' } });
    expect(stages.map((s) => s.kind)).toEqual(['HR']);
  });

  it('asks anyone holding a permission, without naming a person', async () => {
    const stages = await route([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'PERMISSION', permission: 'payroll.approve' }]);
    expect(stages[1]).toEqual({ kind: 'PERMISSION', approverId: null, name: null, title: 'Payroll Approve', permission: 'payroll.approve' });
  });

  it('does not ask the same person twice', async () => {
    const stages = await route([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'EMPLOYEE', employeeId: 'lead' }, { kind: 'HR' }]);
    expect(stages.map((s) => s.kind)).toEqual(['REPORTING_MANAGER', 'HR']);
  });

  it('always has a stage', async () => {
    expect((await route([])).map((s) => s.kind)).toEqual(['HR']);
  });
});

describe('the approval a request carries', () => {
  const build = async (policy = DEFAULT_LEAVE_POLICY, overrides: Record<string, RoutePerson> = {}) => buildApproval(await route(policy, 'emp', overrides), 'Naveed Ahmad', '2026-11-01T00:00:00.000Z');

  it('starts at the first stage with the sentences the employee reads', async () => {
    const approval = await build();
    expect(approval).toMatchObject({
      stage: 'WITH_APPROVER',
      statusText: 'With Tayyaba Sabir (Team Lead). Not approved yet.',
      currentApproverId: 'lead',
      currentApproverName: 'Tayyaba Sabir',
      currentApproverTitle: 'Team Lead',
      finalStep: false,
      nextApproverId: 'mgr',
      nextApproverName: 'Ali Khan',
      nextApproverTitle: 'Engineering Manager',
      stageIndex: 0,
    });
    expect(approval.workflow.map((s) => [s.step, s.status])).toEqual([['SUBMITTED', 'COMPLETED'], ['FIRST_REVIEW', 'PENDING'], ['SECOND_REVIEW', 'WAITING']]);
    expect(approval.workflow[0]).toMatchObject({ description: 'Submitted by Naveed Ahmad', at: '2026-11-01T00:00:00.000Z' });
    expect(approval.workflow[2].description).toBe('After Tayyaba Sabir approves, it goes to Ali Khan (Engineering Manager)');
  });

  it('shows the reporting manager step as skipped when it goes straight to HR', async () => {
    const approval = await build(DEFAULT_LEAVE_POLICY, { emp: { ...people.emp, reportingManagerId: null } });
    expect(approval).toMatchObject({ stage: 'WITH_HR', statusText: 'With HR. Not approved yet.', currentApproverId: null, finalStep: true, nextApproverId: null });
    expect(approval.workflow.map((s) => [s.step, s.status])).toEqual([['SUBMITTED', 'COMPLETED'], ['FIRST_REVIEW', 'SKIPPED'], ['SECOND_REVIEW', 'PENDING']]);
  });

  it('shows a third stage as its own step', async () => {
    const approval = await build([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }]);
    expect(approval.workflow.map((s) => s.step)).toEqual(['SUBMITTED', 'FIRST_REVIEW', 'SECOND_REVIEW', 'THIRD_REVIEW']);
    expect(approval.finalStep).toBe(false);
  });

  it('moves one stage at a time, and only the last grants it', async () => {
    let approval = await build([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }]);

    approval = advanceApproval(approval, 'Tayyaba Sabir (Team Lead)', '2026-11-02T00:00:00.000Z');
    expect(approval).toMatchObject({ stageIndex: 1, currentApproverId: 'mgr', finalStep: false, nextApproverId: 'director' });
    expect(approval.statusText).toBe('Tayyaba Sabir (Team Lead) approved your leave. It is now with Ali Khan (Engineering Manager).');
    expect(approval.workflow.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED', 'PENDING', 'WAITING']);

    approval = advanceApproval(approval, 'Ali Khan (Engineering Manager)');
    expect(approval).toMatchObject({ stageIndex: 2, currentApproverId: 'director', finalStep: true, nextApproverId: null });

    const done = completeApproval(approval, 'Dina Shah (Director)');
    expect(done.statusText).toBe('Approved by Dina Shah (Director).');
    expect(done.workflow.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
  });

  it('moves to HR in words an employee can read', async () => {
    const approval = advanceApproval(await build([{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'HR' }]), 'Tayyaba Sabir (Team Lead)');
    expect(approval).toMatchObject({ stage: 'WITH_HR', currentApproverId: null, currentApproverTitle: 'HR', finalStep: true });
    expect(approval.statusText).toBe('Tayyaba Sabir (Team Lead) approved your leave. It is now with HR.');
  });

  it('records a rejection and ends the trail there', async () => {
    const rejected = rejectApproval(await build(), 'Tayyaba Sabir (Team Lead)');
    expect(rejected.statusText).toBe('Rejected by Tayyaba Sabir (Team Lead).');
    expect(rejected.workflow[1]).toMatchObject({ status: 'REJECTED', description: 'Rejected by Tayyaba Sabir (Team Lead)' });
  });

  it('reads a route back from a request made before stages existed', async () => {
    const built = await build();
    const { stages: _stages, stageIndex: _index, currentPermission: _p, ...legacy } = built;

    const { stages, index } = stagesOf(legacy);

    expect(index).toBe(0);
    expect(stages.map((s) => s.approverId)).toEqual(['lead', 'mgr']);
    const moved = advanceApproval(legacy, 'Tayyaba Sabir (Team Lead)');
    expect(moved).toMatchObject({ currentApproverId: 'mgr', finalStep: true, stageIndex: 1 });
    expect(stagesOf({ ...legacy, finalStep: true, nextApproverId: null }).stages).toHaveLength(1);
  });

  describe('when the approver cannot act', () => {
    it('hands the request to the next stage, or HR when there is none', async () => {
      const approval = await build();
      const next = handOnApproval(approval, 'Tayyaba Sabir (Team Lead) is no longer with the organization.');
      expect(next).toMatchObject({ currentApproverId: 'mgr', finalStep: true, stageIndex: 1 });
      expect(next.statusText).toContain('no longer with the organization. It is now with Ali Khan (Engineering Manager).');
      expect(next.workflow[1]).toMatchObject({ status: 'SKIPPED' });

      const toHr = handOnApproval(next, 'Ali Khan (Engineering Manager) is no longer with the organization.');
      expect(toHr).toMatchObject({ stage: 'WITH_HR', currentApproverId: null, finalStep: true });
      expect(toHr.statusText).toContain('It is now with HR.');
    });
  });

  describe('when the reporting line changes', () => {
    it('rebuilds a request nobody has approved, keeping when it was submitted', async () => {
      const approval = await build();
      const fresh = await route(DEFAULT_LEAVE_POLICY, 'emp', { emp: { ...people.emp, reportingManagerId: 'mgr' } });

      const next = rerouteApproval(approval, fresh, '2026-11-05T00:00:00.000Z');

      expect(next).toMatchObject({ currentApproverId: 'mgr', nextApproverId: 'director', stageIndex: 0 });
      expect(next!.workflow[0]).toMatchObject({ step: 'SUBMITTED', at: '2026-11-01T00:00:00.000Z' });
    });

    it('leaves it alone when the route is the same', async () => {
      const approval = await build();
      expect(rerouteApproval(approval, await route(DEFAULT_LEAVE_POLICY))).toBeNull();
    });

    it('once a stage is approved, only moves when the current approver is off the route', async () => {
      const approved = advanceApproval(await build(), 'Tayyaba Sabir (Team Lead)');
      expect(approvedStages(approved)).toBe(1);
      expect(rerouteApproval(approved, await route(DEFAULT_LEAVE_POLICY))).toBeNull();

      const moved = rerouteApproval(approved, await route(DEFAULT_LEAVE_POLICY, 'emp', { emp: { ...people.emp, reportingManagerId: 'director' } }));
      expect(moved).toMatchObject({ stage: 'WITH_HR', currentApproverId: null });
      expect(moved!.workflow[1].status).toBe('COMPLETED');
    });
  });
});

describe('canActOnStage', () => {
  const actor = (over: Partial<Actor> = {}): Actor => ({ employeeId: null, orgWide: false, permissions: [], isFullAccess: false, ...over });
  const named = { kind: 'REPORTING_MANAGER' as const, approverId: 'lead', name: 'T', title: 'Lead', permission: null };
  const hr = { kind: 'HR' as const, approverId: null, name: null, title: 'HR', permission: null };
  const finance = { kind: 'PERMISSION' as const, approverId: null, name: null, title: 'Payroll Approve', permission: 'payroll.approve' };

  it('lets only the named person decide their stage, whatever their scope', () => {
    expect(canActOnStage(named, actor({ employeeId: 'lead' }))).toBe(true);
    expect(canActOnStage(named, actor({ employeeId: 'other', orgWide: true }))).toBe(false);
    expect(canActOnStage(named, actor())).toBe(false);
  });

  it('lets anyone with an organization-wide scope decide HR\'s stage', () => {
    expect(canActOnStage(hr, actor({ orgWide: true }))).toBe(true);
    expect(canActOnStage(hr, actor({ employeeId: 'lead' }))).toBe(false);
  });

  it('lets anyone holding the permission decide, and full access always', () => {
    expect(canActOnStage(finance, actor({ permissions: ['payroll.approve'] }))).toBe(true);
    expect(canActOnStage(finance, actor({ permissions: ['payroll.view'], orgWide: true }))).toBe(false);
    expect(canActOnStage(finance, actor({ isFullAccess: true }))).toBe(true);
    expect(canActOnStage(finance, actor({ permissions: ['*'] }))).toBe(true);
  });
});
