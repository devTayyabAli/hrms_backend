import { HttpStatus } from '@nestjs/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PerformanceWorkService } from './performance-work.service';

/**
 * The work summary is supporting evidence for a review. It lists projects, tasks
 * and feedback for a person and a period, hides confidential projects from people
 * who are not on them, and never produces a score.
 */
describe('PerformanceWorkService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const EMP = '22222222-2222-4222-8222-222222222222';
  const READER = '33333333-3333-4333-8333-333333333333';
  const OPEN_PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SECRET_PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const OWNED_PROJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const REVIEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const CYCLE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  const PAST = '2020-01-10';
  const FUTURE = '2999-01-01';

  const task = (overrides: Record<string, unknown>) => ({
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Task',
    projectId: OPEN_PROJECT,
    dueDate: PAST,
    priority: 'NORMAL',
    status: 'PENDING',
    completedAt: null,
    reviewStatus: null,
    reviewFeedback: null,
    reviewedAt: null,
    reviewedByName: null,
    ...overrides,
  });

  const projects = [
    { id: OPEN_PROJECT, name: 'Website', status: 'ACTIVE', startDate: '2020-01-01', dueDate: '2999-12-31', leadEmployeeId: READER, confidential: false },
    { id: SECRET_PROJECT, name: 'Acquisition', status: 'ACTIVE', startDate: null, dueDate: null, leadEmployeeId: null, confidential: true },
    { id: OWNED_PROJECT, name: 'Branch opening', status: 'PLANNED', startDate: '2020-01-01', dueDate: '2999-12-31', leadEmployeeId: EMP, confidential: false },
  ];

  let tasks: any[];
  let memberOf: Record<string, string[]>;
  let projectsEnabled: boolean;
  let reviewRow: any;
  let cycleRow: any;
  let dataScope: any;
  let dashboard: any;
  let service: PerformanceWorkService;

  const build = (withScope = true) => {
    const taskModel = {
      findAll: jest.fn().mockImplementation(async (options: any) => {
        // involvedProjectIds asks about the reader's own tasks; the summary asks about the employee's.
        if (options.where.assigneeEmployeeId === READER) return [];
        return tasks;
      }),
    };
    const projectModel = {
      findAll: jest.fn().mockImplementation(async (options: any) => {
        const where = options.where;
        if (where.leadEmployeeId) return projects.filter((p) => p.leadEmployeeId === where.leadEmployeeId).map((p) => ({ id: p.id }));
        if (where.confidential === true) return projects.filter((p) => p.confidential).map((p) => ({ id: p.id }));
        if (where.id) return projects.filter((p) => where.id[Object.getOwnPropertySymbols(where.id)[0]].includes(p.id));
        return [];
      }),
    };
    const memberModel = { findAll: jest.fn().mockImplementation(async (options: any) => (memberOf[options.where.employeeId] ?? []).map((projectId) => ({ projectId }))) };
    const assigneeModel = { findAll: jest.fn().mockResolvedValue([]) };
    const employeeModel = {
      findOne: jest.fn().mockResolvedValue({ id: EMP, firstName: 'Ali', lastName: 'Khan', employeeCode: 'E-1' }),
    };
    const reviewModel = { findOne: jest.fn().mockImplementation(async () => reviewRow) };
    const cycleModel = { findOne: jest.fn().mockImplementation(async () => cycleRow) };
    const modelProvider = {
      getWorkspaceTaskModel: jest.fn().mockResolvedValue(taskModel),
      getWorkspaceProjectModel: jest.fn().mockResolvedValue(projectModel),
      getWorkspaceProjectMemberModel: jest.fn().mockResolvedValue(memberModel),
      getWorkspaceTaskAssigneeModel: jest.fn().mockResolvedValue(assigneeModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getPerformanceReviewModel: jest.fn().mockResolvedValue(reviewModel),
      getPerformanceCycleModel: jest.fn().mockResolvedValue(cycleModel),
    };
    const modules = { isModuleEnabled: jest.fn().mockImplementation(async () => ({ enabled: projectsEnabled, allowed: projectsEnabled })) };
    return new PerformanceWorkService(modelProvider as any, withScope ? dataScope : undefined, withScope ? dashboard : undefined, modules as any);
  };

  beforeEach(() => {
    tasks = [];
    memberOf = {};
    projectsEnabled = true;
    reviewRow = { id: REVIEW, employeeId: EMP, cycleId: CYCLE, status: 'COMPLETED', closedAt: null, publishedAt: new Date() };
    cycleRow = { name: 'H2 2026', startDate: '2026-07-01', endDate: '2026-12-31' };
    dataScope = {
      assertCanSee: jest.fn().mockResolvedValue(undefined),
      actorEmployeeId: jest.fn().mockResolvedValue(READER),
    };
    dashboard = { reviewScope: jest.fn().mockResolvedValue({}) };
    service = build();
  });

  it('says so, instead of returning zeros, when the Projects module is off', async () => {
    projectsEnabled = false;

    const result = await service.forEmployee(TENANT, EMP);

    expect(result.available).toBe(false);
    expect(result.projects).toEqual([]);
  });

  it('counts what they finished, what ran late, what is open and what is overdue', async () => {
    tasks = [
      task({ id: 't1', status: 'COMPLETED', dueDate: '2026-03-10', completedAt: new Date('2026-03-08T10:00:00Z') }),
      task({ id: 't2', status: 'COMPLETED', dueDate: '2026-03-10', completedAt: new Date('2026-03-15T10:00:00Z') }),
      task({ id: 't3', status: 'IN_PROGRESS', dueDate: PAST }),
      task({ id: 't4', status: 'PENDING', dueDate: FUTURE }),
    ];

    const result = await service.forEmployee(TENANT, EMP);

    expect(result.summary).toMatchObject({ tasksAssigned: 4, completed: 2, completedLate: 1, open: 2, overdue: 1 });
    expect(result.completedTasks.map((row) => [row.id, row.late])).toEqual([
      ['t2', true],
      ['t1', false],
    ]);
    expect(result.overdueTasks).toEqual([expect.objectContaining({ id: 't3', status: 'IN_PROGRESS', daysOverdue: expect.any(Number) })]);
    expect(result.overdueTasks[0].daysOverdue).toBeGreaterThan(0);
  });

  it('limits everything to the period of a review’s cycle', async () => {
    tasks = [
      task({ id: 'in', status: 'COMPLETED', dueDate: '2026-09-10', completedAt: new Date('2026-09-09T10:00:00Z') }),
      task({ id: 'before', status: 'COMPLETED', dueDate: '2026-02-10', completedAt: new Date('2026-02-09T10:00:00Z') }),
      task({ id: 'old-overdue', status: 'PENDING', dueDate: '2026-01-10' }),
      task({ id: 'new-overdue', status: 'PENDING', dueDate: '2026-10-10' }),
    ];

    const result = await service.forEmployee(TENANT, EMP, { reviewId: REVIEW });

    expect(result.period).toEqual({ from: '2026-07-01', to: '2026-12-31', label: 'H2 2026' });
    expect(result.completedTasks.map((row) => row.id)).toEqual(['in']);
    expect(result.overdueTasks.map((row) => row.id)).toEqual(['new-overdue']);
    expect(result.summary.tasksAssigned).toBe(2);
  });

  it('takes an explicit range, and asks for both ends', async () => {
    tasks = [task({ id: 'in', status: 'COMPLETED', dueDate: '2026-05-10', completedAt: new Date('2026-05-09T10:00:00Z') })];

    const result = await service.forEmployee(TENANT, EMP, { from: '2026-05-01', to: '2026-05-31' });
    expect(result.completedTasks.map((row) => row.id)).toEqual(['in']);

    await expect(service.forEmployee(TENANT, EMP, { from: '2026-05-01' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    await expect(service.forEmployee(TENANT, EMP, { from: '2026-06-01', to: '2026-05-01' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('refuses a review that is not theirs, or has no cycle dates', async () => {
    reviewRow = null;
    await expect(service.forEmployee(TENANT, EMP, { reviewId: REVIEW })).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });

    reviewRow = { id: REVIEW, employeeId: EMP, cycleId: null };
    await expect(service.forEmployee(TENANT, EMP, { reviewId: REVIEW })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('treats a person outside the reader’s scope as not found', async () => {
    dataScope.assertCanSee.mockRejectedValue(Object.assign(new Error('not found'), { status: HttpStatus.NOT_FOUND }));

    await expect(service.forEmployee(TENANT, EMP)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it('lists projects they own or belong to even with no task yet, owner first', async () => {
    memberOf[EMP] = [OPEN_PROJECT];
    tasks = [];

    const result = await service.forEmployee(TENANT, EMP);

    expect(result.projects.map((p) => [p.name, p.isOwner, p.isMember])).toEqual([
      ['Branch opening', true, false],
      ['Website', false, true],
    ]);
    expect(result.summary).toMatchObject({ projects: 2, projectsOwned: 1 });
  });

  it('counts a confidential project’s work but never names it, for a reader who is not on it', async () => {
    tasks = [task({ id: 'secret', projectId: SECRET_PROJECT, status: 'COMPLETED', dueDate: PAST, completedAt: new Date('2020-01-09T10:00:00Z') }), task({ id: 'plain', status: 'COMPLETED', dueDate: PAST, completedAt: new Date('2020-01-09T10:00:00Z') })];

    await runAsRpcActor({ permissions: ['performance.view'], isFullAccess: false } as any, async () => {
      const result = await service.forEmployee(TENANT, EMP);

      expect(result.access.hiddenTasks).toBe(1);
      expect(result.completedTasks.map((row) => row.id)).toEqual(['plain']);
      expect(JSON.stringify(result)).not.toContain('Acquisition');
    });
  });

  it('shows the confidential project to a reader with that permission, and to one who is on it', async () => {
    tasks = [task({ id: 'secret', projectId: SECRET_PROJECT, status: 'COMPLETED', dueDate: PAST, completedAt: new Date('2020-01-09T10:00:00Z') })];

    await runAsRpcActor({ permissions: ['performance.view', 'projects.confidential'], isFullAccess: false } as any, async () => {
      const result = await service.forEmployee(TENANT, EMP);
      expect(result.access.hiddenTasks).toBe(0);
      expect(result.completedTasks[0].project).toEqual({ id: SECRET_PROJECT, name: 'Acquisition' });
    });

    // The reader belongs to the project themselves.
    memberOf[READER] = [SECRET_PROJECT];
    await runAsRpcActor({ permissions: ['performance.view'], isFullAccess: false } as any, async () => {
      const result = await service.forEmployee(TENANT, EMP);
      expect(result.access.hiddenTasks).toBe(0);
    });
  });

  it('gathers a reviewer’s feedback, newest first, only from decisions made in the period', async () => {
    tasks = [
      task({ id: 'a', status: 'COMPLETED', completedAt: new Date('2026-08-02T10:00:00Z'), reviewStatus: 'APPROVED', reviewFeedback: 'Clean work', reviewedAt: new Date('2026-08-02T11:00:00Z'), reviewedByName: 'Sana Malik' }),
      task({ id: 'b', status: 'COMPLETED', completedAt: new Date('2026-10-02T10:00:00Z'), reviewStatus: 'APPROVED', reviewFeedback: 'Good, add tests next time', reviewedAt: new Date('2026-10-02T11:00:00Z'), reviewedByName: 'Sana Malik' }),
      task({ id: 'old', status: 'COMPLETED', completedAt: new Date('2026-01-02T10:00:00Z'), reviewStatus: 'APPROVED', reviewFeedback: 'Last cycle', reviewedAt: new Date('2026-01-02T11:00:00Z'), reviewedByName: 'Sana Malik' }),
      task({ id: 'noted', status: 'COMPLETED', completedAt: new Date('2026-09-02T10:00:00Z'), reviewStatus: 'APPROVED', reviewFeedback: null, reviewedAt: new Date('2026-09-02T11:00:00Z') }),
    ];

    const result = await service.forEmployee(TENANT, EMP, { reviewId: REVIEW });

    expect(result.feedback.map((row) => row.taskId)).toEqual(['b', 'a']);
    expect(result.feedback[0]).toMatchObject({ decision: 'APPROVED', feedback: 'Good, add tests next time', reviewedBy: 'Sana Malik', reviewedAt: '2026-10-02' });
    expect(result.summary.feedbackNotes).toBe(2);
  });

  it('gives the employee their own work, with no one else’s ids', async () => {
    tasks = [task({ id: 'mine', status: 'COMPLETED', completedAt: new Date('2020-01-09T10:00:00Z'), reviewStatus: 'APPROVED', reviewFeedback: 'Clean work', reviewedAt: new Date('2020-01-09T11:00:00Z'), reviewedByName: 'Sana Malik' })];
    const Employee = await (service as any).modelProvider.getEmployeeModel();
    Employee.findOne.mockResolvedValue({ id: EMP, firstName: 'Ali', lastName: 'Khan', employeeCode: 'E-1', userId: 'user-1' });

    const result = await service.mine(TENANT, 'user-1', undefined);

    expect(result.employee.id).toBe(EMP);
    expect(result.feedback[0]).toMatchObject({ feedback: 'Clean work', reviewedBy: 'Sana Malik' });
    expect(JSON.stringify(result)).not.toContain('reviewedByEmployeeId');
    expect(dataScope.assertCanSee).not.toHaveBeenCalled();
  });

  it('only opens a review for the employee when it has been shared with them', async () => {
    reviewRow = { id: REVIEW, employeeId: EMP, cycleId: CYCLE, status: 'COMPLETED', closedAt: null, publishedAt: null };
    const Employee = await (service as any).modelProvider.getEmployeeModel();
    Employee.findOne.mockResolvedValue({ id: EMP, firstName: 'Ali', lastName: 'Khan', userId: 'user-1' });

    await expect(service.mine(TENANT, 'user-1', undefined, { reviewId: REVIEW })).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it('says there is no employee profile when the login has none', async () => {
    const Employee = await (service as any).modelProvider.getEmployeeModel();
    Employee.findOne.mockResolvedValue(null);

    await expect(service.mine(TENANT, 'user-1', undefined)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it('never returns a rating, score or ranking, and says it is evidence only', async () => {
    tasks = [task({ status: 'COMPLETED', completedAt: new Date('2020-01-09T10:00:00Z') })];

    const result = await service.forEmployee(TENANT, EMP);

    const keys = JSON.stringify(result);
    expect(keys).not.toMatch(/"(rating|score|rank|grade)"/i);
    expect(result.note).toMatch(/not a rating/i);
  });
});
