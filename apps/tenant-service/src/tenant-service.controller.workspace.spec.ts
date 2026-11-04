import { TenantServiceController } from './tenant-service.controller';

/**
 * The gateway lets a caller without a route's permission through on the routes
 * a project owner may use, and trusts these handlers to refuse everyone who is
 * not the owner. So every one of them must ask WorkspaceAccessService first —
 * and not run the work when it says no.
 *
 * Handlers are exercised on a bare controller object, with only the pieces
 * they touch replaced, rather than building the whole service.
 */
describe('TenantServiceController: project owner routes', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const TASK = '77777777-7777-4777-8777-777777777777';
  const PROJECT = '55555555-5555-4555-8555-555555555555';
  const refusal = Object.assign(new Error('Only the project owner can do this.'), { status: 403 });

  let access: Record<string, jest.Mock>;
  let tasks: Record<string, jest.Mock>;
  let projects: Record<string, jest.Mock>;
  let controller: any;

  beforeEach(() => {
    const refuse = () => jest.fn().mockRejectedValue(refusal);
    access = {
      assertViewOrOwn: refuse(),
      assertTask: refuse(),
      assertCreateTask: refuse(),
      assertEditTask: refuse(),
      assertProject: refuse(),
    };
    tasks = Object.fromEntries(
      [
        'getAll',
        'getOne',
        'create',
        'update',
        'remove',
        'getPeople',
        'addComment',
        'deleteComment',
        'addChecklistItem',
        'updateChecklistItem',
        'deleteChecklistItem',
        'addAttachment',
        'deleteAttachment',
        'attachmentFile',
        'decideReview',
      ].map((name) => [name, jest.fn().mockResolvedValue({ ok: true })]),
    );
    projects = { update: jest.fn().mockResolvedValue({ ok: true }), openWork: jest.fn().mockResolvedValue({ ok: true }) };
    controller = Object.create(TenantServiceController.prototype);
    controller.workspaceAccess = access;
    controller.workspaceTaskService = tasks;
    controller.workspaceProjectService = projects;
  });

  const manage = { tenantId: TENANT, taskId: TASK, userId: 'u', email: 'e', scope: 'manage' };
  const mine = { ...manage, scope: 'mine' };

  /** [handler, payload, the service that must not run, its method] */
  const guarded: [string, Record<string, unknown>, () => Record<string, jest.Mock>, string][] = [
    ['handleGetWorkspaceTasks', { tenantId: TENANT, query: {} }, () => tasks, 'getAll'],
    ['handleGetWorkspaceTask', { tenantId: TENANT, taskId: TASK }, () => tasks, 'getOne'],
    ['handleCreateWorkspaceTask', { tenantId: TENANT, dto: { projectId: PROJECT }, actorUserId: 'u' }, () => tasks, 'create'],
    ['handleUpdateWorkspaceTask', { tenantId: TENANT, taskId: TASK, dto: {} }, () => tasks, 'update'],
    ['handleGetWorkspacePeople', { tenantId: TENANT }, () => tasks, 'getPeople'],
    ['handleAddTaskComment', { ...manage, body: 'hi' }, () => tasks, 'addComment'],
    ['handleDeleteTaskComment', { ...manage, commentId: 'c', canModerate: false }, () => tasks, 'deleteComment'],
    ['handleAddChecklistItem', { tenantId: TENANT, taskId: TASK, label: 'x' }, () => tasks, 'addChecklistItem'],
    ['handleUpdateChecklistItem', { ...manage, itemId: 'i', done: true }, () => tasks, 'updateChecklistItem'],
    ['handleDeleteChecklistItem', { tenantId: TENANT, taskId: TASK, itemId: 'i' }, () => tasks, 'deleteChecklistItem'],
    ['handleAddTaskAttachment', { ...manage, fileId: 'f', fileName: 'a.pdf', sizeBytes: 1 }, () => tasks, 'addAttachment'],
    ['handleDeleteTaskAttachment', { ...manage, attachmentId: 'a', canModerate: false }, () => tasks, 'deleteAttachment'],
    ['handleGetTaskAttachment', { ...manage, attachmentId: 'a' }, () => tasks, 'attachmentFile'],
    ['handleUpdateWorkspaceProject', { tenantId: TENANT, projectId: PROJECT, dto: {}, actorUserId: 'u', canReopen: false }, () => projects, 'update'],
    ['handleGetProjectOpenTasks', { tenantId: TENANT, projectId: PROJECT }, () => projects, 'openWork'],
  ];

  it.each(guarded)('%s refuses without doing the work when access is denied', async (handler, payload, service, method) => {
    await expect(controller[handler](payload)).rejects.toBe(refusal);

    expect(service()[method]).not.toHaveBeenCalled();
  });

  it.each(guarded)('%s does the work once access is granted', async (handler, payload, service, method) => {
    Object.values(access).forEach((fn) => fn.mockResolvedValue(undefined));

    await controller[handler](payload);

    expect(service()[method]).toHaveBeenCalled();
  });

  it('asks about the right project: the one the task is being moved to, not only where it is', async () => {
    Object.values(access).forEach((fn) => fn.mockResolvedValue(undefined));

    await controller.handleUpdateWorkspaceTask({ tenantId: TENANT, taskId: TASK, dto: { projectId: PROJECT } });
    await controller.handleCreateWorkspaceTask({ tenantId: TENANT, dto: { projectId: PROJECT }, actorUserId: 'u' });

    expect(access.assertEditTask).toHaveBeenCalledWith(TENANT, expect.arrayContaining(['tasks.edit']), TASK, PROJECT);
    expect(access.assertCreateTask).toHaveBeenCalledWith(TENANT, expect.arrayContaining(['tasks.create']), PROJECT);
  });

  describe('an assignee working on their own task', () => {
    it.each([
      ['handleAddTaskComment', { ...mine, body: 'hi' }, 'addComment'],
      ['handleDeleteTaskComment', { ...mine, commentId: 'c', canModerate: false }, 'deleteComment'],
      ['handleUpdateChecklistItem', { ...mine, itemId: 'i', done: true }, 'updateChecklistItem'],
      ['handleAddTaskAttachment', { ...mine, fileId: 'f', fileName: 'a.pdf', sizeBytes: 1 }, 'addAttachment'],
      ['handleDeleteTaskAttachment', { ...mine, attachmentId: 'a', canModerate: false }, 'deleteAttachment'],
      ['handleGetTaskAttachment', { ...mine, attachmentId: 'a' }, 'attachmentFile'],
    ])('%s needs no owner check', async (handler, payload, method) => {
      await controller[handler](payload);

      expect(access.assertTask).not.toHaveBeenCalled();
      expect(tasks[method]).toHaveBeenCalled();
    });
  });

  it('leaves deleting a task to the role permission: an owner cannot delete tasks', async () => {
    await controller.handleDeleteWorkspaceTask({ tenantId: TENANT, taskId: TASK });

    expect(Object.values(access).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(tasks.remove).toHaveBeenCalled();
  });

  it('passes the review decision on with only what the permission said, so the owner path stays in the service', async () => {
    await controller.handleDecideWorkspaceTaskReview({ tenantId: TENANT, taskId: TASK, decision: 'APPROVE', canManage: false });

    expect(tasks.decideReview).toHaveBeenCalledWith(TENANT, TASK, 'APPROVE', false);
  });
});
