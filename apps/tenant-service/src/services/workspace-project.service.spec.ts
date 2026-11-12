import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { runAsRpcActor } from '@app/tenant-context';
import { WorkspaceProjectService } from './workspace-project.service';

/**
 * A scoped role reaches a project through its owner, a team member, or a
 * task assigned to someone they reach. Creating a project requires an owner.
 * Team members are notified and can see the project before they have a task.
 */
describe('WorkspaceProjectService data scope', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const LEAD = '22222222-2222-4222-8222-222222222222';
  const REPORT = '33333333-3333-4333-8333-333333333333';
  const OUTSIDER = '44444444-4444-4444-8444-444444444444';
  const PROJECT = '55555555-5555-4555-8555-555555555555';

  let projectModel: any;
  let taskModel: any;
  let memberModel: any;
  let employeeModel: any;
  let notices: { create: jest.Mock };
  let settingModel: { findOne: jest.Mock };
  let modelProvider: any;
  let dataScope: any;

  const whereOf = (call: any) => call.mock.calls[0][0].where;

  beforeEach(() => {
    projectModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    };
    taskModel = {
      findAll: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue([0]),
    };
    memberModel = {
      findAll: jest.fn().mockResolvedValue([]),
      destroy: jest.fn().mockResolvedValue(0),
      bulkCreate: jest.fn().mockResolvedValue([]),
    };
    notices = { create: jest.fn() };
    settingModel = { findOne: jest.fn().mockResolvedValue(null) };
    employeeModel = {
      findOne: jest.fn().mockResolvedValue({ id: LEAD, departmentId: 'd1', status: 'ACTIVE', firstName: 'Tayyaba', lastName: 'Sabir' }),
      findAll: jest.fn().mockResolvedValue([]),
    };
    modelProvider = {
      getWorkspaceProjectModel: jest.fn().mockResolvedValue(projectModel),
      getWorkspaceTaskModel: jest.fn().mockResolvedValue(taskModel),
      getWorkspaceProjectMemberModel: jest.fn().mockResolvedValue(memberModel),
      getWorkspaceTaskAssigneeModel: jest.fn().mockResolvedValue({ findAll: jest.fn().mockResolvedValue([]) }),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getDepartmentModel: jest.fn().mockResolvedValue({ findOne: jest.fn().mockResolvedValue({ id: 'd1' }) }),
      getEntityAuditLogModel: jest.fn().mockResolvedValue({ create: jest.fn() }),
      getEmployeeNotificationModel: jest.fn().mockResolvedValue(notices),
      getWorkspaceSettingModel: jest.fn().mockResolvedValue(settingModel),
    };
    dataScope = {
      visibleEmployeeIds: jest.fn().mockResolvedValue([LEAD, REPORT]),
      canSee: jest.fn().mockImplementation(async (_t: string, id: string) => [LEAD, REPORT].includes(id)),
      actorEmployeeId: jest.fn().mockResolvedValue(null),
    };
  });

  const scoped = () => new WorkspaceProjectService(modelProvider, dataScope);

  it('lists projects led by, or holding tasks for, the people in scope', async () => {
    taskModel.findAll.mockResolvedValue([{ projectId: PROJECT }]);

    await scoped().getAll(TENANT, {} as any);

    const where = whereOf(projectModel.findAll);
    const scope = where[Op.and][1];
    expect(scope[Op.or]).toEqual([
      { leadEmployeeId: { [Op.in]: [LEAD, REPORT] } },
      { id: { [Op.in]: [PROJECT] } },
    ]);
    // Tasks were looked up for the visible people only.
    expect(whereOf(taskModel.findAll)).toMatchObject({ assigneeEmployeeId: { [Op.in]: [LEAD, REPORT] } });
    // The KPI counts use the same scope as the cards.
    expect(whereOf(projectModel.count)[Op.and][1]).toBe(scope);
  });

  it('shows nothing to a scoped caller with no employee record', async () => {
    dataScope.visibleEmployeeIds.mockResolvedValue([]);

    await scoped().getOptions(TENANT);

    expect(whereOf(projectModel.findAll)[Op.and][1]).toEqual({ id: null });
    expect(taskModel.findAll).not.toHaveBeenCalled();
  });

  it('treats a project outside the scope as not found', async () => {
    await expect(scoped().update(TENANT, PROJECT, { name: 'X' } as any)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(whereOf(projectModel.findOne)[Op.and][1][Op.or][0]).toEqual({
      leadEmployeeId: { [Op.in]: [LEAD, REPORT] },
    });
  });

  it('refuses a lead outside the scope on create', async () => {
    employeeModel.findOne.mockResolvedValue({ id: OUTSIDER, departmentId: 'd9', status: 'ACTIVE', firstName: 'Out', lastName: 'Sider' });

    await expect(
      scoped().create(TENANT, { name: 'Portal', leadEmployeeId: OUTSIDER } as any),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(projectModel.create).not.toHaveBeenCalled();
  });

  it('requires a scoped caller to name a lead, so the project stays in their list', async () => {
    await expect(scoped().create(TENANT, { name: 'Portal' } as any)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(projectModel.create).not.toHaveBeenCalled();
  });

  it('leaves an organization-wide caller unscoped', async () => {
    dataScope.visibleEmployeeIds.mockResolvedValue(null);

    await scoped().getAll(TENANT, {} as any);

    expect(whereOf(projectModel.findAll)[Op.and][1]).toEqual({});
    expect(taskModel.findAll).not.toHaveBeenCalled();
  });

  it('works without a DataScopeService at all', async () => {
    const service = new WorkspaceProjectService(modelProvider);
    await service.getOptions(TENANT);
    expect(whereOf(projectModel.findAll)[Op.and][1]).toEqual({});
  });

  it('requires an owner even for an organization-wide caller', async () => {
    dataScope.visibleEmployeeIds.mockResolvedValue(null);

    await expect(scoped().create(TENANT, { name: 'Portal' } as any)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(projectModel.create).not.toHaveBeenCalled();
  });

  it('refuses a team member who no longer works here', async () => {
    employeeModel.findAll.mockResolvedValue([{ id: REPORT, status: 'INACTIVE', firstName: 'Ali', lastName: 'Khan' }]);

    await expect(
      scoped().create(TENANT, { name: 'Portal', leadEmployeeId: LEAD, memberEmployeeIds: [REPORT] } as any),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(projectModel.create).not.toHaveBeenCalled();
  });

  it('notifies a new team member and keeps the owner off the team list', async () => {
    employeeModel.findAll.mockResolvedValue([{ id: REPORT, status: 'ACTIVE', firstName: 'Ali', lastName: 'Khan' }]);
    projectModel.create.mockResolvedValue({ id: PROJECT, name: 'Portal' });
    projectModel.findOne.mockResolvedValueOnce(null).mockResolvedValue({
      id: PROJECT,
      name: 'Portal',
      status: 'ACTIVE',
      leadEmployeeId: LEAD,
      lead: { id: LEAD, firstName: 'Tayyaba', lastName: 'Sabir' },
      department: null,
      createdAt: new Date(),
    });

    await scoped().create(TENANT, {
      name: 'Portal',
      leadEmployeeId: LEAD,
      memberEmployeeIds: [LEAD, REPORT],
    } as any);

    expect(memberModel.bulkCreate).toHaveBeenCalledWith([
      expect.objectContaining({ tenantId: TENANT, projectId: expect.any(String), employeeId: REPORT }),
    ]);
    expect(notices.create).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: REPORT, title: 'Added to a project', body: 'You were added to Portal.' }),
    );
    expect(notices.create).not.toHaveBeenCalledWith(expect.objectContaining({ employeeId: LEAD }));
  });

  it('does not tell new team members when assignment notices are switched off', async () => {
    employeeModel.findAll.mockResolvedValue([{ id: REPORT, status: 'ACTIVE', firstName: 'Ali', lastName: 'Khan' }]);
    projectModel.create.mockResolvedValue({ id: PROJECT, name: 'Portal' });
    projectModel.findOne.mockResolvedValueOnce(null).mockResolvedValue({
      id: PROJECT,
      name: 'Portal',
      status: 'ACTIVE',
      leadEmployeeId: LEAD,
      lead: { id: LEAD, firstName: 'Tayyaba', lastName: 'Sabir' },
      department: null,
      createdAt: new Date(),
    });
    settingModel.findOne.mockResolvedValue({ assignmentNotificationsEnabled: false });

    await scoped().create(TENANT, { name: 'Portal', leadEmployeeId: LEAD, memberEmployeeIds: [LEAD, REPORT] } as any);

    // The member is still added; they just are not told.
    expect(memberModel.bulkCreate).toHaveBeenCalledWith([expect.objectContaining({ employeeId: REPORT })]);
    expect(notices.create).not.toHaveBeenCalled();
  });

  it('refuses an expected end before the start date', async () => {
    await expect(
      scoped().create(TENANT, {
        name: 'Portal',
        leadEmployeeId: LEAD,
        startDate: '2026-12-01',
        dueDate: '2026-10-01',
      } as any),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(projectModel.create).not.toHaveBeenCalled();
  });

  it('stores the schedule, priority, location and tags', async () => {
    projectModel.create.mockResolvedValue({ id: PROJECT, name: 'Portal' });
    projectModel.findOne.mockResolvedValueOnce(null).mockResolvedValue({
      id: PROJECT,
      name: 'Portal',
      status: 'PLANNED',
      priority: 'HIGH',
      startDate: '2026-10-01',
      dueDate: '2026-12-31',
      location: 'Kitchen',
      tags: ['Q4'],
      leadEmployeeId: LEAD,
      lead: { id: LEAD, firstName: 'Tayyaba', lastName: 'Sabir' },
      department: null,
      createdAt: new Date(),
    });

    await scoped().create(TENANT, {
      name: 'Portal',
      leadEmployeeId: LEAD,
      status: 'PLANNED',
      priority: 'HIGH',
      startDate: '2026-10-01',
      dueDate: '2026-12-31',
      location: ' Kitchen ',
      tags: [' Q4 ', 'q4', ''],
    } as any);

    expect(projectModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PLANNED',
        priority: 'HIGH',
        startDate: '2026-10-01',
        dueDate: '2026-12-31',
        location: 'Kitchen',
        tags: ['Q4'],
      }),
    );
  });

  const savedProject = (status: string) => ({
    id: PROJECT,
    name: 'Portal',
    status,
    leadEmployeeId: LEAD,
    tags: [],
    lead: { id: LEAD, firstName: 'Tayyaba', lastName: 'Sabir' },
    department: null,
    createdAt: new Date(),
    get: () => ({ name: 'Portal', status, leadEmployeeId: LEAD, tags: [] }),
    update: jest.fn().mockResolvedValue(undefined),
  });

  it('shows incomplete and blocked tasks before a project can be closed', async () => {
    projectModel.findOne.mockResolvedValue(savedProject('ACTIVE'));
    taskModel.findAll.mockResolvedValue([
      { id: 't1', title: 'Prep', status: 'PENDING', assignee: { firstName: 'Ali', lastName: 'Khan' } },
      { id: 't2', title: 'Wait', status: 'BLOCKED', assignee: { firstName: 'Sara', lastName: 'Ahmed' } },
    ]);

    await expect(scoped().update(TENANT, PROJECT, { status: 'COMPLETED' } as any)).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
    const open = await scoped().openWork(TENANT, PROJECT);
    expect(open.incomplete).toEqual([expect.objectContaining({ title: 'Prep', status: 'PENDING' })]);
    expect(open.blocked).toEqual([expect.objectContaining({ title: 'Wait', assigneeName: 'Sara Ahmed' })]);
  });

  it('closes after those tasks are acknowledged and tells the owner', async () => {
    const project = savedProject('ACTIVE');
    projectModel.findOne.mockResolvedValue(project);
    taskModel.findAll.mockResolvedValue([{ id: 't1', title: 'Prep', status: 'IN_PROGRESS', assignee: null }]);

    await scoped().update(TENANT, PROJECT, { status: 'COMPLETED', acknowledgeOpenTasks: true } as any);

    expect(project.update).toHaveBeenCalled();
    expect(notices.create).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: LEAD, title: 'Project completed: Portal' }),
    );
  });

  it('refuses to reopen a completed project without the reopen permission and audits it when allowed', async () => {
    const project = savedProject('COMPLETED');
    projectModel.findOne.mockResolvedValue(project);
    const audits = { create: jest.fn() };
    modelProvider.getEntityAuditLogModel.mockResolvedValue(audits);

    await expect(scoped().update(TENANT, PROJECT, { status: 'ACTIVE' } as any, undefined, false)).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    });

    await scoped().update(TENANT, PROJECT, { status: 'ACTIVE' } as any, undefined, true);

    expect(project.update).toHaveBeenCalled();
    expect(audits.create).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({ reopened: { from: 'COMPLETED', to: 'ACTIVE' } }),
      }),
    );
  });

  it('tells the owner when the status changes, and stays quiet when that notice is off', async () => {
    const project = savedProject('ACTIVE');
    projectModel.findOne.mockResolvedValue(project);

    await scoped().update(TENANT, PROJECT, { status: 'ON_HOLD' } as any);

    expect(notices.create).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: LEAD, title: 'Project update: Portal', body: 'Portal is now On hold.' }),
    );

    notices.create.mockClear();
    settingModel.findOne.mockResolvedValue({ projectStatusNotificationsEnabled: false });
    project.update.mockClear();

    await scoped().update(TENANT, PROJECT, { status: 'AT_RISK' } as any);

    expect(notices.create).not.toHaveBeenCalled();
  });

  it('refuses to mark a project confidential without the permission, and still keeps assignment inside data scope', async () => {
    await runAsRpcActor({ permissions: ['projects.edit'], isFullAccess: false } as any, async () => {
      await expect(
        scoped().create(TENANT, { name: 'Portal', leadEmployeeId: LEAD, confidential: true } as any),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    employeeModel.findOne.mockResolvedValue({ id: OUTSIDER, departmentId: 'd9', status: 'ACTIVE', firstName: 'Out', lastName: 'Sider' });
    await runAsRpcActor({ permissions: ['projects.confidential'], isFullAccess: false } as any, async () => {
      await expect(
        scoped().create(TENANT, { name: 'Portal', leadEmployeeId: OUTSIDER, confidential: true } as any),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });
    expect(projectModel.create).not.toHaveBeenCalled();
  });

  it('hides confidential projects from someone without the permission, and keeps one visible to its owner', async () => {
    dataScope.visibleEmployeeIds.mockResolvedValue(null);
    dataScope.actorEmployeeId.mockResolvedValue(null);
    await runAsRpcActor({ permissions: ['projects.view'], isFullAccess: false } as any, async () => {
      await scoped().getOptions(TENANT);
    });
    expect(whereOf(projectModel.findAll)[Op.and][1][Op.or]).toEqual([
      { confidential: { [Op.not]: true } },
      { confidential: null },
    ]);

    projectModel.findAll.mockClear();
    dataScope.actorEmployeeId.mockResolvedValue(LEAD);
    projectModel.findAll.mockResolvedValueOnce([{ id: PROJECT }]);
    await runAsRpcActor({ permissions: ['projects.view'], isFullAccess: false } as any, async () => {
      await scoped().getOptions(TENANT);
    });
    const listed = projectModel.findAll.mock.calls.at(-1)[0].where;
    expect(listed[Op.and][1][Op.or]).toEqual(
      expect.arrayContaining([{ id: { [Op.in]: [PROJECT] } }]),
    );
  });

  describe('branch', () => {
    const BRANCH = '66666666-6666-4666-8666-666666666666';
    const OTHER_BRANCH = '77777777-7777-4777-8777-777777777777';
    let branchModel: { findAll: jest.Mock };

    const branchRow = (id: string, name: string, isActive = true) => ({ id, name, isActive });

    beforeEach(() => {
      branchModel = { findAll: jest.fn().mockResolvedValue([branchRow(BRANCH, 'Lahore', true)]) };
      modelProvider.getBranchModel = jest.fn().mockResolvedValue(branchModel);
    });

    // The real model's plain copy carries the branch, which is what the update compares against.
    const withBranch = (status: string, branchId: string | null) => ({
      ...savedProject(status),
      branchId,
      get: () => ({ name: 'Portal', status, leadEmployeeId: LEAD, tags: [], branchId }),
    });

    it('refuses a branch that does not exist', async () => {
      branchModel.findAll.mockResolvedValue([]);

      await expect(scoped().create(TENANT, { name: 'Portal', leadEmployeeId: LEAD, branchId: BRANCH } as any)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
      expect(projectModel.create).not.toHaveBeenCalled();
    });

    it('refuses an inactive branch on create', async () => {
      branchModel.findAll.mockResolvedValue([branchRow(BRANCH, 'Lahore', false)]);

      await expect(scoped().create(TENANT, { name: 'Portal', leadEmployeeId: LEAD, branchId: BRANCH } as any)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: expect.objectContaining({ message: expect.stringContaining('inactive') }),
      });
      expect(projectModel.create).not.toHaveBeenCalled();
    });

    it('stores the branch on create, audits it, and returns its name', async () => {
      const audits = { create: jest.fn() };
      modelProvider.getEntityAuditLogModel.mockResolvedValue(audits);
      projectModel.create.mockResolvedValue({ id: PROJECT, name: 'Portal' });
      projectModel.findOne.mockResolvedValueOnce(null).mockResolvedValue(withBranch('ACTIVE', BRANCH));

      const row = await scoped().create(TENANT, { name: 'Portal', leadEmployeeId: LEAD, branchId: BRANCH } as any);

      expect(projectModel.create).toHaveBeenCalledWith(expect.objectContaining({ branchId: BRANCH }));
      expect(audits.create).toHaveBeenCalledWith(
        expect.objectContaining({ changes: expect.objectContaining({ branchId: { from: null, to: BRANCH } }) }),
      );
      expect(row.branch).toEqual({ id: BRANCH, name: 'Lahore', isActive: true });
    });

    it('leaves the branch empty when none is sent, without looking any up', async () => {
      projectModel.create.mockResolvedValue({ id: PROJECT, name: 'Portal' });
      projectModel.findOne.mockResolvedValueOnce(null).mockResolvedValue(withBranch('ACTIVE', null));

      const row = await scoped().create(TENANT, { name: 'Portal', leadEmployeeId: LEAD } as any);

      expect(projectModel.create).toHaveBeenCalledWith(expect.objectContaining({ branchId: null }));
      expect(branchModel.findAll).not.toHaveBeenCalled();
      expect(row.branch).toBeNull();
    });

    it('checks a branch only when it changes, and lets a project keep one that has gone inactive', async () => {
      const project = withBranch('ACTIVE', BRANCH);
      projectModel.findOne.mockResolvedValue(project);
      branchModel.findAll.mockResolvedValue([branchRow(BRANCH, 'Lahore', false), branchRow(OTHER_BRANCH, 'Karachi', true)]);

      await scoped().update(TENANT, PROJECT, { branchId: BRANCH } as any);
      await scoped().update(TENANT, PROJECT, { branchId: OTHER_BRANCH } as any);
      expect(project.update).toHaveBeenLastCalledWith(expect.objectContaining({ branchId: OTHER_BRANCH }));

      branchModel.findAll.mockResolvedValue([branchRow(OTHER_BRANCH, 'Karachi', false)]);
      await expect(scoped().update(TENANT, PROJECT, { branchId: OTHER_BRANCH } as any)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('clears the branch when null is sent', async () => {
      const project = withBranch('ACTIVE', BRANCH);
      projectModel.findOne.mockResolvedValue(project);

      await scoped().update(TENANT, PROJECT, { branchId: null } as any);

      expect(project.update).toHaveBeenCalledWith(expect.objectContaining({ branchId: null }));
    });

    it('filters the list by branch and names each project’s branch', async () => {
      projectModel.findAll.mockResolvedValue([
        { ...withBranch('ACTIVE', BRANCH), id: 'p1' },
        { ...withBranch('ACTIVE', null), id: 'p2' },
      ]);

      const result = await scoped().getAll(TENANT, { branchId: BRANCH } as any);

      expect(whereOf(projectModel.findAll)[Op.and][0][Op.and]).toEqual(expect.arrayContaining([{ branchId: BRANCH }]));
      expect(result.data.map((row) => row.branch?.name ?? null)).toEqual(['Lahore', null]);
    });

    it('shows no branch when the one a project pointed at has been removed', async () => {
      branchModel.findAll.mockResolvedValue([]);
      projectModel.findAll.mockResolvedValue([{ ...withBranch('ACTIVE', BRANCH), id: 'p1' }]);

      const result = await scoped().getAll(TENANT, {} as any);

      expect(result.data[0].branch).toBeNull();
    });
  });
});
