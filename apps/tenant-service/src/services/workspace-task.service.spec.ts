import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { runAsRpcActor } from '@app/tenant-context';
import { WorkspaceTaskService } from './workspace-task.service';

/**
 * A task due date has to sit inside the project's start and expected end.
 * An editor can keep a date outside that window by recording an exception.
 */
describe('WorkspaceTaskService project dates', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const ASSIGNEE = '33333333-3333-4333-8333-333333333333';
  const PROJECT = '55555555-5555-4555-8555-555555555555';
  const TASK = '66666666-6666-4666-8666-666666666666';

  let taskModel: { create: jest.Mock; findOne: jest.Mock; findAll: jest.Mock; update: jest.Mock };
  let projectModel: { findOne: jest.Mock; findAll: jest.Mock };
  let commentModel: { count: jest.Mock; create: jest.Mock; findAll: jest.Mock; findOne: jest.Mock; destroy: jest.Mock };
  let checklistModel: { count: jest.Mock; create: jest.Mock; findAll: jest.Mock; findOne: jest.Mock; destroy: jest.Mock };
  let attachmentModel: { count: jest.Mock; create: jest.Mock; findAll: jest.Mock; findOne: jest.Mock };
  let service: WorkspaceTaskService;

  const savedTask = (dueDateException: boolean) => ({
    id: TASK,
    title: 'Prep',
    description: null,
    dueDate: '2026-11-02',
    dueDateException,
    priority: 'NORMAL',
    status: 'PENDING',
    completedAt: null,
    assignee: null,
    project: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    taskModel = { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue([0]) };
    projectModel = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]) };
    commentModel = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'comment' }),
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      destroy: jest.fn(),
    };
    checklistModel = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'line' }),
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      destroy: jest.fn().mockResolvedValue(1),
    };
    attachmentModel = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'file' }),
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const modelProvider = {
      getWorkspaceTaskModel: jest.fn().mockResolvedValue(taskModel),
      getWorkspaceProjectModel: jest.fn().mockResolvedValue(projectModel),
      getWorkspaceTaskCommentModel: jest.fn().mockResolvedValue(commentModel),
      getWorkspaceTaskChecklistItemModel: jest.fn().mockResolvedValue(checklistModel),
      getWorkspaceTaskAttachmentModel: jest.fn().mockResolvedValue(attachmentModel),
      getWorkspaceTaskAssigneeModel: jest.fn().mockResolvedValue({
        findAll: jest.fn().mockResolvedValue([]),
        destroy: jest.fn().mockResolvedValue(0),
        bulkCreate: jest.fn().mockResolvedValue([]),
      }),
      getWorkspaceSettingModel: jest.fn().mockResolvedValue({ findOne: jest.fn().mockResolvedValue(null) }),
      getEmployeeModel: jest.fn().mockResolvedValue({
        findOne: jest.fn().mockResolvedValue({ id: ASSIGNEE, status: 'ACTIVE', firstName: 'Ali', lastName: 'Khan' }),
        findAll: jest.fn().mockResolvedValue([{ id: ASSIGNEE, status: 'ACTIVE', firstName: 'Ali', lastName: 'Khan' }]),
      }),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
      getEntityAuditLogModel: jest.fn().mockResolvedValue({ create: jest.fn() }),
      getEmployeeNotificationModel: jest.fn().mockResolvedValue({ create: jest.fn() }),
    };
    service = new WorkspaceTaskService(modelProvider as any);
  });

  it('refuses a due date after the expected end', async () => {
    projectModel.findOne.mockResolvedValue({ id: PROJECT, name: 'Portal', startDate: '2026-10-01', dueDate: '2026-10-31' });

    await expect(
      service.create(TENANT, {
        title: 'Prep',
        assigneeEmployeeId: ASSIGNEE,
        projectId: PROJECT,
        dueDate: '2026-11-02',
      } as any),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(taskModel.create).not.toHaveBeenCalled();
  });

  it('keeps an outside due date when an exception is recorded', async () => {
    projectModel.findOne.mockResolvedValue({ id: PROJECT, name: 'Portal', startDate: '2026-10-01', dueDate: '2026-10-31' });
    taskModel.create.mockResolvedValue({ id: TASK, title: 'Prep', dueDate: '2026-11-02', assigneeEmployeeId: ASSIGNEE, priority: 'NORMAL' });
    taskModel.findOne.mockResolvedValue({ ...savedTask(true), project: { id: PROJECT, name: 'Portal' } });

    const row = await service.create(TENANT, {
      title: 'Prep',
      assigneeEmployeeId: ASSIGNEE,
      projectId: PROJECT,
      dueDate: '2026-11-02',
      dueDateException: true,
    } as any);

    expect(taskModel.create).toHaveBeenCalledWith(expect.objectContaining({ dueDate: '2026-11-02', dueDateException: true }));
    expect(row.dueDateException).toBe(true);
  });

  it('does not apply the window when the task has no project', async () => {
    taskModel.create.mockResolvedValue({ id: TASK, title: 'Prep', dueDate: '2026-01-01', assigneeEmployeeId: ASSIGNEE, priority: 'NORMAL' });
    taskModel.findOne.mockResolvedValue(savedTask(false));

    await service.create(TENANT, {
      title: 'Prep',
      assigneeEmployeeId: ASSIGNEE,
      dueDate: '2026-01-01',
    } as any);

    expect(projectModel.findOne).not.toHaveBeenCalled();
    expect(taskModel.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: null, dueDateException: false }));
  });

  it('keeps a second assignee and stores the first as the primary', async () => {
    const OTHER = '77777777-7777-4777-8777-777777777777';
    const employees = service as any;
    const employeeModel = await employees.modelProvider.getEmployeeModel();
    employeeModel.findAll.mockResolvedValue([
      { id: ASSIGNEE, status: 'ACTIVE', firstName: 'Ali', lastName: 'Khan' },
      { id: OTHER, status: 'ACTIVE', firstName: 'Sara', lastName: 'Noor' },
    ]);
    taskModel.create.mockResolvedValue({ id: TASK, title: 'Prep', dueDate: '2026-11-02', assigneeEmployeeId: ASSIGNEE, priority: 'NORMAL' });
    taskModel.findOne.mockResolvedValue(savedTask(false));
    const assigneeModel = await employees.modelProvider.getWorkspaceTaskAssigneeModel();

    await service.create(TENANT, {
      title: 'Prep',
      assigneeEmployeeId: ASSIGNEE,
      assigneeEmployeeIds: [ASSIGNEE, OTHER],
      dueDate: '2026-11-02',
    } as any);

    expect(taskModel.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeEmployeeId: ASSIGNEE }));
    expect(assigneeModel.bulkCreate).toHaveBeenCalledWith([
      expect.objectContaining({ taskId: TASK, employeeId: OTHER }),
    ]);
  });

  it('holds a review task for the project owner instead of completing it', async () => {
    const settingModel = await (service as any).modelProvider.getWorkspaceSettingModel();
    settingModel.findOne.mockResolvedValue({ taskReviewEnabled: true });
    const update = jest.fn().mockResolvedValue(undefined);
    taskModel.findOne
      .mockResolvedValueOnce({
        id: TASK,
        title: 'Prep',
        status: 'IN_PROGRESS',
        requiresReview: true,
        reviewStatus: null,
        assigneeEmployeeId: ASSIGNEE,
        projectId: PROJECT,
        dueDate: '2026-11-02',
        priority: 'NORMAL',
        get: () => ({
          title: 'Prep',
          status: 'IN_PROGRESS',
          requiresReview: true,
          reviewStatus: null,
          assigneeEmployeeId: ASSIGNEE,
          dueDate: '2026-11-02',
          priority: 'NORMAL',
        }),
        update,
      })
      .mockResolvedValue(savedTask(false));
    projectModel.findOne.mockResolvedValue({ id: PROJECT, name: 'Portal', leadEmployeeId: 'lead', startDate: null, dueDate: null });

    await service.update(TENANT, TASK, { status: 'COMPLETED' } as any);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'IN_PROGRESS', reviewStatus: 'PENDING', completedAt: null }));
  });

  it('completes a review task directly while the setting is off', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    taskModel.findOne
      .mockResolvedValueOnce({
        id: TASK,
        title: 'Prep',
        status: 'IN_PROGRESS',
        requiresReview: true,
        reviewStatus: null,
        assigneeEmployeeId: ASSIGNEE,
        projectId: null,
        dueDate: '2026-11-02',
        priority: 'NORMAL',
        get: () => ({
          title: 'Prep',
          status: 'IN_PROGRESS',
          requiresReview: true,
          reviewStatus: null,
          assigneeEmployeeId: ASSIGNEE,
          dueDate: '2026-11-02',
          priority: 'NORMAL',
        }),
        update,
      })
      .mockResolvedValue({ ...savedTask(false), status: 'COMPLETED' });

    await service.update(TENANT, TASK, { status: 'COMPLETED' } as any);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'COMPLETED', reviewStatus: 'APPROVED' }));
  });

  it('keeps a comment on a completed task', async () => {
    const USER = '77777777-7777-4777-8777-777777777777';
    taskModel.findOne.mockResolvedValue({ ...savedTask(false), status: 'COMPLETED' });
    commentModel.findAll.mockResolvedValue([
      { id: 'c1', taskId: TASK, body: 'Shipped the login', authorName: 'Ali Khan', authorUserId: USER, createdAt: new Date('2026-11-02') },
    ]);

    const row = await service.addComment(TENANT, TASK, 'Shipped the login', USER, 'ali@example.com', 'manage');

    expect(commentModel.create).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK, body: 'Shipped the login', authorUserId: USER }));
    expect(row.status).toBe('COMPLETED');
    expect(row.comments).toEqual([expect.objectContaining({ body: 'Shipped the login' })]);
    expect(commentModel.destroy).not.toHaveBeenCalled();
  });

  it('stores a checklist line and can mark it done', async () => {
    taskModel.findOne.mockResolvedValue(savedTask(false));
    const update = jest.fn().mockResolvedValue(undefined);
    checklistModel.findOne.mockResolvedValue({ id: 'line', position: 1, update });
    checklistModel.findAll.mockResolvedValue([{ id: 'line', taskId: TASK, label: 'Write tests', done: true }]);

    await service.addChecklistItem(TENANT, TASK, 'Write tests');
    const row = await service.updateChecklistItem(TENANT, TASK, 'line', { done: true }, 'manage');

    expect(checklistModel.create).toHaveBeenCalledWith(expect.objectContaining({ label: 'Write tests', done: false }));
    expect(update).toHaveBeenCalledWith({ done: true });
    expect(row.checklist).toEqual([expect.objectContaining({ label: 'Write tests', done: true })]);
  });

  it('stores an attachment without removing it when the task is completed', async () => {
    const USER = '77777777-7777-4777-8777-777777777777';
    taskModel.findOne.mockResolvedValue(savedTask(false));
    attachmentModel.findAll.mockResolvedValue([
      { id: 'file', taskId: TASK, fileId: 'file-1', fileName: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 12, uploadedByUserId: USER },
    ]);

    const row = await service.addAttachment(
      TENANT,
      TASK,
      { fileId: 'file-1', fileName: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 12 },
      USER,
      undefined,
      'manage',
    );

    expect(attachmentModel.create).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'file-1', fileName: 'notes.pdf' }));
    expect(row.attachments).toEqual([expect.objectContaining({ fileName: 'notes.pdf' })]);
    expect(row.status).toBe('PENDING');
  });

  it('flags open tasks when an assignee leaves and leaves completed tasks alone', async () => {
    const assigneeModel = { findAll: jest.fn().mockResolvedValue([{ taskId: TASK }]) };
    (service as any).modelProvider.getWorkspaceTaskAssigneeModel.mockResolvedValue(assigneeModel);
    taskModel.update.mockResolvedValue([2]);

    const count = await service.flagOpenTasksForExit(TENANT, ASSIGNEE);

    expect(count).toBe(2);
    expect(taskModel.update).toHaveBeenCalledWith(
      { needsReassignment: true },
      expect.objectContaining({
        where: expect.objectContaining({
          status: { [Op.ne]: 'COMPLETED' },
        }),
      }),
    );
  });

  it('refuses a member change once the project is complete', async () => {
    taskModel.findOne.mockResolvedValue({
      id: TASK,
      projectId: PROJECT,
      assigneeEmployeeId: ASSIGNEE,
      status: 'PENDING',
    });
    projectModel.findOne.mockResolvedValue({ id: PROJECT, status: 'COMPLETED' });

    await expect(service.updateMyStatus(TENANT, 'user-1', 'ali@example.com', TASK, 'COMPLETED' as any)).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    });
  });

  const reminderTask = (overrides: Record<string, unknown>) => ({
    id: TASK,
    title: 'Prep',
    dueDate: '2026-11-03',
    status: 'PENDING',
    assigneeEmployeeId: ASSIGNEE,
    deadlineReminderSent: null,
    overdueReminderSent: null,
    reviewStatus: null,
    reviewReminderSent: null,
    updatedAt: '2026-11-02',
    project: { id: PROJECT, name: 'Portal', status: 'ACTIVE', leadEmployeeId: 'lead-1' },
    update: jest.fn(),
    ...overrides,
  });

  it('tells an assignee the day before a due date, and only once', async () => {
    const notices = { create: jest.fn() };
    (service as any).modelProvider.getEmployeeNotificationModel.mockResolvedValue(notices);
    const task = reminderTask({});
    taskModel.findAll.mockResolvedValue([task]);

    await service.sendReminders(TENANT, '2026-11-02');

    expect(notices.create).toHaveBeenCalledWith(expect.objectContaining({ employeeId: ASSIGNEE, title: 'Due tomorrow: Prep' }));
    expect(task.update).toHaveBeenCalledWith({ deadlineReminderSent: true });
    task.deadlineReminderSent = true;
    notices.create.mockClear();

    await service.sendReminders(TENANT, '2026-11-02');

    expect(notices.create).not.toHaveBeenCalled();
  });

  it('tells the assignee and the project owner once a task is overdue', async () => {
    const notices = { create: jest.fn() };
    (service as any).modelProvider.getEmployeeNotificationModel.mockResolvedValue(notices);
    taskModel.findAll.mockResolvedValue([reminderTask({ dueDate: '2026-11-01' })]);

    await service.sendReminders(TENANT, '2026-11-02');

    const told = notices.create.mock.calls.map((call) => call[0].employeeId);
    expect(told).toEqual(expect.arrayContaining([ASSIGNEE, 'lead-1']));
    expect(notices.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Overdue: Prep' }));
  });

  it('reminds the project owner the next day when a review is still waiting, and stays quiet when that reminder is off', async () => {
    const notices = { create: jest.fn() };
    (service as any).modelProvider.getEmployeeNotificationModel.mockResolvedValue(notices);
    taskModel.findAll.mockResolvedValue([
      reminderTask({ dueDate: '2026-12-01', reviewStatus: 'PENDING', updatedAt: '2026-10-01' }),
    ]);

    await service.sendReminders(TENANT, '2026-11-02');

    expect(notices.create).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'lead-1', title: 'Still waiting for review: Prep' }),
    );

    notices.create.mockClear();
    (service as any).modelProvider.getWorkspaceSettingModel.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ reviewRemindersEnabled: false, deadlineRemindersEnabled: false, overdueRemindersEnabled: false }),
    });

    await expect(service.sendReminders(TENANT, '2026-11-02')).resolves.toBe(0);
    expect(notices.create).not.toHaveBeenCalled();
  });

  it('hides tasks on a confidential project from someone who is not on it', async () => {
    const dataScope = {
      visibleEmployeeIds: jest.fn().mockResolvedValue(null),
      actorEmployeeId: jest.fn().mockResolvedValue(null),
    };
    const local = new WorkspaceTaskService((service as any).modelProvider, dataScope as any);
    projectModel.findAll.mockResolvedValue([{ id: PROJECT }]);
    const findAndCountAll = jest.fn().mockResolvedValue({ rows: [], count: 0 });
    (taskModel as any).findAndCountAll = findAndCountAll;

    await runAsRpcActor({ permissions: ['tasks.view'], isFullAccess: false } as any, () => local.getAll(TENANT, {} as any));

    expect(findAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          [Op.and]: expect.arrayContaining([
            { [Op.or]: [{ projectId: null }, { projectId: { [Op.notIn]: [PROJECT] } }] },
          ]),
        }),
      }),
    );
  });

  describe('assignment notices and work history', () => {
    const createDto = { title: 'Prep', assigneeEmployeeId: ASSIGNEE, dueDate: '2026-11-02' } as any;

    const arrangeCreate = (settings: Record<string, unknown> | null) => {
      const notices = { create: jest.fn() };
      const provider = (service as any).modelProvider;
      provider.getEmployeeNotificationModel.mockResolvedValue(notices);
      provider.getWorkspaceSettingModel.mockResolvedValue({ findOne: jest.fn().mockResolvedValue(settings) });
      taskModel.create.mockResolvedValue({ id: TASK, title: 'Prep', dueDate: '2026-11-02', assigneeEmployeeId: ASSIGNEE, priority: 'NORMAL' });
      taskModel.findOne.mockResolvedValue(savedTask(false));
      return notices;
    };

    it('tells the assignee about a new task by default', async () => {
      const notices = arrangeCreate(null);

      await service.create(TENANT, createDto);

      expect(notices.create).toHaveBeenCalledWith(expect.objectContaining({ employeeId: ASSIGNEE, title: 'New task: Prep' }));
    });

    it('says nothing about a new task when the organization has switched assignment notices off', async () => {
      const notices = arrangeCreate({ assignmentNotificationsEnabled: false });

      await service.create(TENANT, createDto);

      expect(taskModel.create).toHaveBeenCalled();
      expect(notices.create).not.toHaveBeenCalled();
    });

    it('still tells people about a new task when the settings cannot be read', async () => {
      const notices = arrangeCreate(null);
      (service as any).modelProvider.getWorkspaceSettingModel.mockRejectedValue(new Error('older schema'));

      await service.create(TENANT, createDto);

      expect(notices.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'New task: Prep' }));
    });

    it('reports and saves the assignment notice setting', async () => {
      const row = { update: jest.fn(), taskReviewEnabled: false, assignmentNotificationsEnabled: null as boolean | null };
      const findOne = jest.fn().mockResolvedValue(row);
      (service as any).modelProvider.getWorkspaceSettingModel.mockResolvedValue({ findOne, create: jest.fn() });

      await service.updateSettings(TENANT, { assignmentNotificationsEnabled: false });
      expect(row.update).toHaveBeenCalledWith({ assignmentNotificationsEnabled: false });

      row.assignmentNotificationsEnabled = false;
      const settings = await service.getSettings(TENANT);
      expect(settings.assignmentNotificationsEnabled).toBe(false);
      expect(settings.deadlineRemindersEnabled).toBe(true);
    });

    it('counts the tasks a person is on (main or extra assignee) and the projects they own', async () => {
      const provider = (service as any).modelProvider;
      provider.getWorkspaceTaskAssigneeModel.mockResolvedValue({ findAll: jest.fn().mockResolvedValue([{ taskId: 'extra-1' }]) });
      (taskModel as any).count = jest.fn().mockResolvedValue(3);
      (projectModel as any).count = jest.fn().mockResolvedValue(1);

      await expect(service.workHistoryOf(TENANT, [ASSIGNEE])).resolves.toEqual({ tasks: 3, projectsOwned: 1 });

      const where = (taskModel as any).count.mock.calls[0][0].where;
      expect(where[Op.or]).toEqual([{ assigneeEmployeeId: { [Op.in]: [ASSIGNEE] } }, { id: { [Op.in]: ['extra-1'] } }]);
      await expect(service.workHistoryOf(TENANT, [])).resolves.toEqual({ tasks: 0, projectsOwned: 0 });
    });
  });

  describe('a project owner who has no wider reach', () => {
    const ME = '88888888-8888-4888-8888-888888888888';
    const OUTSIDER = '99999999-9999-4999-8999-999999999999';
    let dataScope: { visibleEmployeeIds: jest.Mock; actorEmployeeId: jest.Mock; assertCanSee: jest.Mock };
    let local: WorkspaceTaskService;
    let employeeModel: { findAll: jest.Mock; findOne: jest.Mock };
    let memberModel: { findAll: jest.Mock };

    beforeEach(() => {
      // Their data scope is just themselves; they own PROJECT.
      dataScope = {
        visibleEmployeeIds: jest.fn().mockResolvedValue([ME]),
        actorEmployeeId: jest.fn().mockResolvedValue(ME),
        assertCanSee: jest.fn(async (_tenant: string, id: string) => {
          if (id !== ME) throw Object.assign(new Error('Employee not found'), { status: 404 });
        }),
      };
      projectModel.findAll.mockResolvedValue([{ id: PROJECT, leadEmployeeId: ME }]);
      projectModel.findOne.mockResolvedValue({ id: PROJECT, name: 'Portal', leadEmployeeId: ME, startDate: null, dueDate: null, confidential: false });
      memberModel = { findAll: jest.fn().mockResolvedValue([{ employeeId: OUTSIDER }]) };
      employeeModel = {
        findOne: jest.fn().mockResolvedValue({ id: OUTSIDER, status: 'ACTIVE', firstName: 'Omar', lastName: 'Sheikh' }),
        findAll: jest.fn().mockResolvedValue([{ id: OUTSIDER, status: 'ACTIVE', firstName: 'Omar', lastName: 'Sheikh' }]),
      };
      const provider = (service as any).modelProvider;
      provider.getWorkspaceProjectMemberModel = jest.fn().mockResolvedValue(memberModel);
      provider.getEmployeeModel.mockResolvedValue(employeeModel);
      local = new WorkspaceTaskService(provider, dataScope as any);
    });

    /** The data-scope part of the query: getAll ANDs the filters with it. */
    const scopeOf = (call: jest.Mock) => call.mock.calls[0][0].where[Op.and][1];

    it('sees every task on their own project, whoever it is assigned to', async () => {
      const findAndCountAll = jest.fn().mockResolvedValue({ rows: [], count: 0 });
      (taskModel as any).findAndCountAll = findAndCountAll;

      await local.getAll(TENANT, {} as any);

      const clauses = scopeOf(findAndCountAll)[Op.or];
      expect(clauses).toEqual(expect.arrayContaining([{ assigneeEmployeeId: { [Op.in]: [ME] } }, { projectId: { [Op.in]: [PROJECT] } }]));
    });

    it('sees only their own project\'s tasks when their scope reaches nobody', async () => {
      dataScope.visibleEmployeeIds.mockResolvedValue([]);
      const findAndCountAll = jest.fn().mockResolvedValue({ rows: [], count: 0 });
      (taskModel as any).findAndCountAll = findAndCountAll;

      await local.getAll(TENANT, {} as any);

      expect(scopeOf(findAndCountAll)[Op.or]).toEqual([{ projectId: { [Op.in]: [PROJECT] } }]);
    });

    it('sees nothing extra when they own no project', async () => {
      dataScope.visibleEmployeeIds.mockResolvedValue([]);
      projectModel.findAll.mockResolvedValue([]);
      const findAndCountAll = jest.fn().mockResolvedValue({ rows: [], count: 0 });
      (taskModel as any).findAndCountAll = findAndCountAll;

      await local.getAll(TENANT, {} as any);

      expect(scopeOf(findAndCountAll)).toEqual({ id: null });
    });

    const newTask = (projectId: string | undefined) =>
      ({ title: 'Prep', assigneeEmployeeId: OUTSIDER, projectId, dueDate: '2026-11-02' }) as any;

    const arrangeSave = () => {
      taskModel.create.mockResolvedValue({ id: TASK, title: 'Prep', dueDate: '2026-11-02', assigneeEmployeeId: OUTSIDER, priority: 'NORMAL' });
      taskModel.findOne.mockResolvedValue(savedTask(false));
    };

    it('can give work to someone already on their project, even outside their own scope', async () => {
      arrangeSave();

      await local.create(TENANT, newTask(PROJECT));

      expect(taskModel.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeEmployeeId: OUTSIDER, projectId: PROJECT }));
      expect(dataScope.assertCanSee).not.toHaveBeenCalledWith(TENANT, OUTSIDER, expect.anything());
    });

    it('still cannot give work to someone who is not on their project and is outside their scope', async () => {
      arrangeSave();
      memberModel.findAll.mockResolvedValue([]);

      await expect(local.create(TENANT, newTask(PROJECT))).rejects.toMatchObject({ status: 404 });
      expect(taskModel.create).not.toHaveBeenCalled();
    });

    it('gets no such allowance on a project that is not theirs', async () => {
      arrangeSave();
      projectModel.findOne.mockResolvedValue({ id: PROJECT, name: 'Portal', leadEmployeeId: 'someone-else', startDate: null, dueDate: null, confidential: false });

      await expect(local.create(TENANT, newTask(PROJECT))).rejects.toMatchObject({ status: 404 });
      expect(dataScope.assertCanSee).toHaveBeenCalledWith(TENANT, OUTSIDER, 'Employee');
    });

    it('can pick from the people on their projects as well as the people in their scope', async () => {
      employeeModel.findAll.mockResolvedValue([]);

      await local.getPeople(TENANT);

      const reachable = employeeModel.findAll.mock.calls[0][0].where.id[Op.in];
      expect([...reachable].sort()).toEqual([ME, OUTSIDER].sort());
    });

    it('picks only from their scope when they own no project', async () => {
      projectModel.findAll.mockResolvedValue([]);
      employeeModel.findAll.mockResolvedValue([]);

      await local.getPeople(TENANT);

      expect(employeeModel.findAll.mock.calls[0][0].where.id[Op.in]).toEqual([ME]);
    });
  });
});
