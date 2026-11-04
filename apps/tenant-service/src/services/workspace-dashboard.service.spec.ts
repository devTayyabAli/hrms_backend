import { WorkspaceDashboardService } from './workspace-dashboard.service';

describe('WorkspaceDashboardService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const ME = '22222222-2222-4222-8222-222222222222';
  const REPORT = '33333333-3333-4333-8333-333333333333';

  let taskModel: { findAll: jest.Mock };
  let projectModel: { findAll: jest.Mock };
  let assigneeModel: { findAll: jest.Mock };
  let memberModel: { findAll: jest.Mock };
  let employeeModel: { findOne: jest.Mock; findAll: jest.Mock };
  let departmentModel: { findAll: jest.Mock };
  let dataScope: { scope: jest.Mock; visibleEmployeeIds: jest.Mock; actorEmployeeId: jest.Mock };
  let service: WorkspaceDashboardService;

  beforeEach(() => {
    taskModel = { findAll: jest.fn().mockResolvedValue([]) };
    projectModel = { findAll: jest.fn().mockResolvedValue([]) };
    assigneeModel = { findAll: jest.fn().mockResolvedValue([]) };
    memberModel = { findAll: jest.fn().mockResolvedValue([]) };
    employeeModel = { findOne: jest.fn().mockResolvedValue({ id: ME }), findAll: jest.fn().mockResolvedValue([]) };
    departmentModel = { findAll: jest.fn().mockResolvedValue([]) };
    dataScope = {
      scope: jest.fn().mockReturnValue('ORGANIZATION'),
      visibleEmployeeIds: jest.fn().mockResolvedValue(null),
      actorEmployeeId: jest.fn().mockResolvedValue(ME),
    };
    service = new WorkspaceDashboardService(
      {
        getWorkspaceTaskModel: jest.fn().mockResolvedValue(taskModel),
        getWorkspaceProjectModel: jest.fn().mockResolvedValue(projectModel),
        getWorkspaceTaskAssigneeModel: jest.fn().mockResolvedValue(assigneeModel),
        getWorkspaceProjectMemberModel: jest.fn().mockResolvedValue(memberModel),
        getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
        getDepartmentModel: jest.fn().mockResolvedValue(departmentModel),
      } as any,
      dataScope as any,
    );
  });

  it('shows my overdue work, a recent completion and a project I belong to', async () => {
    taskModel.findAll
      .mockResolvedValueOnce([
        {
          id: 't1',
          title: 'Prep',
          status: 'PENDING',
          dueDate: '2020-01-01',
          completedAt: null,
          projectId: 'p1',
          assigneeEmployeeId: ME,
          needsReassignment: false,
          project: { name: 'Portal' },
        },
        {
          id: 't2',
          title: 'Done',
          status: 'COMPLETED',
          dueDate: '2020-01-01',
          completedAt: '2026-10-01',
          projectId: 'p1',
          assigneeEmployeeId: ME,
          project: { name: 'Portal' },
        },
      ])
      .mockResolvedValueOnce([{ projectId: 'p1', status: 'PENDING', count: '1', overdue: '1' }]);
    memberModel.findAll.mockResolvedValue([{ projectId: 'p1' }]);
    projectModel.findAll.mockResolvedValue([{ id: 'p1', name: 'Portal', status: 'ACTIVE' }]);

    const board = await service.getMine(TENANT, 'user-1', 'ali@example.com');

    expect(board.kind).toBe('employee');
    expect(board.overdue).toBe(1);
    expect(board.completed).toBe(1);
    expect(board.deadlines[0]).toMatchObject({ title: 'Prep', overdue: true, projectName: 'Portal' });
    expect(board.recentlyCompleted[0]).toMatchObject({ title: 'Done', completedAt: '2026-10-01' });
    expect(board.projects[0]).toMatchObject({ name: 'Portal', openTasks: 1, progress: 0 });
  });

  it('counts a team lead’s own projects and the team’s open tasks', async () => {
    dataScope.scope.mockReturnValue('TEAM');
    dataScope.visibleEmployeeIds.mockResolvedValue([ME, REPORT]);
    taskModel.findAll
      .mockResolvedValueOnce([
        {
          id: 't1',
          title: 'Prep',
          status: 'PENDING',
          dueDate: '2099-01-01',
          projectId: 'p1',
          assigneeEmployeeId: REPORT,
          needsReassignment: null,
          project: { name: 'Portal' },
        },
      ])
      .mockResolvedValueOnce([
        { projectId: 'p1', status: 'PENDING', count: '2', overdue: '0' },
        { projectId: 'p1', status: 'COMPLETED', count: '2', overdue: '0' },
      ]);
    projectModel.findAll.mockResolvedValue([{ id: 'p1', name: 'Portal', status: 'ACTIVE' }]);

    const board = await service.getForCaller(TENANT);

    expect(board.kind).toBe('manager');
    expect(board.pending).toBe(1);
    expect(board.projects[0]).toMatchObject({ name: 'Portal', progress: 50, openTasks: 2 });
    expect(projectModel.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ leadEmployeeId: ME }) }));
  });

  it('summarises a department’s projects and who is carrying the open work', async () => {
    dataScope.scope.mockReturnValue('DEPARTMENT');
    dataScope.visibleEmployeeIds.mockResolvedValue([ME, REPORT]);
    employeeModel.findAll.mockResolvedValue([
      { id: ME, firstName: 'Ali', lastName: 'Khan', departmentId: 'd1', department: { id: 'd1', name: 'Kitchen' } },
      { id: REPORT, firstName: 'Sara', lastName: 'Ahmed', departmentId: 'd1', department: { id: 'd1', name: 'Kitchen' } },
    ]);
    taskModel.findAll.mockResolvedValueOnce([
      { id: 't1', title: 'Prep', status: 'PENDING', dueDate: '2020-01-01', projectId: 'p1', assigneeEmployeeId: REPORT, needsReassignment: false },
      { id: 't2', title: 'Other', status: 'IN_PROGRESS', dueDate: '2099-01-01', projectId: 'p1', assigneeEmployeeId: ME, needsReassignment: false },
    ]);
    projectModel.findAll.mockResolvedValue([
      { id: 'p1', name: 'Portal', status: 'ACTIVE', departmentId: 'd1' },
      { id: 'p2', name: 'Old', status: 'COMPLETED', departmentId: 'd1' },
    ]);

    const board = await service.getForCaller(TENANT);

    expect(board.kind).toBe('department');
    expect(board.activeProjects).toBe(1);
    expect(board.completedProjects).toBe(1);
    expect(board.pending).toBe(1);
    expect(board.inProgress).toBe(1);
    expect(board.workload[0]).toMatchObject({ name: 'Sara Ahmed', overdue: 1 });
  });

  it('rolls the organization up by people and department', async () => {
    taskModel.findAll
      .mockResolvedValueOnce([
        { status: 'COMPLETED', count: '3', overdue: '0', reassign: '0' },
        { status: 'PENDING', count: '1', overdue: '1', reassign: '1' },
      ])
      .mockResolvedValueOnce([{ assigneeEmployeeId: ME }, { assigneeEmployeeId: REPORT }])
      .mockResolvedValueOnce([{ assigneeEmployeeId: ME }])
      .mockResolvedValueOnce([
        { assigneeEmployeeId: ME, status: 'PENDING', count: '1', overdue: '1' },
        { assigneeEmployeeId: REPORT, status: 'COMPLETED', count: '3', overdue: '0' },
      ]);
    assigneeModel.findAll.mockResolvedValue([{ employeeId: 'extra-1' }]);
    projectModel.findAll.mockResolvedValue([
      { departmentId: 'd1', status: 'ACTIVE' },
      { departmentId: 'd1', status: 'COMPLETED' },
    ]);
    departmentModel.findAll.mockResolvedValue([{ id: 'd1', name: 'Kitchen' }]);
    employeeModel.findAll.mockResolvedValue([
      { id: ME, departmentId: 'd1' },
      { id: REPORT, departmentId: 'd1' },
    ]);

    const board = await service.getForCaller(TENANT);

    expect(board.kind).toBe('organization');
    expect(board.completed).toBe(3);
    expect(board.openTasks).toBe(1);
    expect(board.needsReassignment).toBe(1);
    expect(board.participation).toEqual({ peopleWithTasks: 3, peopleWithOpenTasks: 1 });
    expect(board.departments[0]).toMatchObject({
      name: 'Kitchen',
      activeProjects: 1,
      completedProjects: 1,
      openTasks: 1,
      completedTasks: 3,
      overdue: 1,
    });
  });
});
