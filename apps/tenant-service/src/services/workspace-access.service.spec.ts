import { HttpStatus } from '@nestjs/common';
import { runAsRpcActor } from '@app/tenant-context';
import { WORKSPACE_GRANTS } from '@app/common';
import { WorkspaceAccessService } from './workspace-access.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const SOMEONE = '33333333-3333-4333-8333-333333333333';
const MINE = '55555555-5555-4555-8555-555555555555';
const THEIRS = '66666666-6666-4666-8666-666666666666';
const TASK = '77777777-7777-4777-8777-777777777777';

const asEmployee = <T>(permissions: string[], work: () => Promise<T>) =>
  runAsRpcActor({ permissions, isFullAccess: false, isSuperAdmin: false, roles: [] } as any, work);

describe('WorkspaceAccessService', () => {
  let projectModel: { findOne: jest.Mock; count: jest.Mock };
  let taskModel: { findOne: jest.Mock };
  let dataScope: { actorEmployeeId: jest.Mock };
  let service: WorkspaceAccessService;

  beforeEach(() => {
    // I own MINE; THEIRS belongs to someone else.
    projectModel = {
      findOne: jest.fn(async ({ where }: any) => ({ leadEmployeeId: where.id === MINE ? ME : SOMEONE })),
      count: jest.fn().mockResolvedValue(1),
    };
    taskModel = { findOne: jest.fn().mockResolvedValue({ projectId: MINE }) };
    dataScope = { actorEmployeeId: jest.fn().mockResolvedValue(ME) };
    const provider: any = {
      getWorkspaceProjectModel: jest.fn().mockResolvedValue(projectModel),
      getWorkspaceTaskModel: jest.fn().mockResolvedValue(taskModel),
    };
    service = new WorkspaceAccessService(provider, dataScope as any);
  });

  describe('holding a permission', () => {
    it('lets through someone who holds one of the grants, without looking anything up', async () => {
      await asEmployee(['projects.edit'], () => service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, THEIRS));

      expect(projectModel.findOne).not.toHaveBeenCalled();
    });

    it('treats <resource>.manage, the wildcard and full access as holding it', async () => {
      await asEmployee(['projects.manage'], () => service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, THEIRS));
      await asEmployee(['*'], () => service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, THEIRS));
      await runAsRpcActor({ permissions: [], isFullAccess: true, isSuperAdmin: false, roles: [] } as any, () =>
        service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, THEIRS),
      );

      expect(projectModel.findOne).not.toHaveBeenCalled();
    });

    it('does not refuse a job or a test that is not a signed person', async () => {
      await expect(service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, THEIRS)).resolves.toBeUndefined();
    });
  });

  describe('owning the project', () => {
    it('lets the owner act on their own project', async () => {
      await expect(asEmployee(['tasks.view'], () => service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, MINE))).resolves.toBeUndefined();
    });

    it('refuses someone with no permission on a project that is not theirs', async () => {
      await expect(asEmployee(['tasks.view'], () => service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, THEIRS))).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
        message: expect.stringContaining('project owner'),
      });
    });

    it('refuses a caller with no employee record, who cannot own anything', async () => {
      dataScope.actorEmployeeId.mockResolvedValue(null);

      await expect(asEmployee([], () => service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, MINE))).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
    });

    it('refuses a project that does not exist, the same way', async () => {
      projectModel.findOne.mockResolvedValue(null);

      await expect(asEmployee([], () => service.assertProject(TENANT, WORKSPACE_GRANTS.projectEdit, MINE))).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
    });
  });

  describe('a task', () => {
    it('is the owner\'s to manage when it is on a project they own', async () => {
      await expect(asEmployee([], () => service.assertTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK))).resolves.toBeUndefined();
    });

    it('is not, on someone else\'s project, on no project, or when it does not exist', async () => {
      taskModel.findOne.mockResolvedValue({ projectId: THEIRS });
      await expect(asEmployee([], () => service.assertTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

      taskModel.findOne.mockResolvedValue({ projectId: null });
      await expect(asEmployee([], () => service.assertTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

      taskModel.findOne.mockResolvedValue(null);
      await expect(asEmployee([], () => service.assertTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('can be created by the owner of its project only', async () => {
      await expect(asEmployee([], () => service.assertCreateTask(TENANT, WORKSPACE_GRANTS.taskCreate, MINE))).resolves.toBeUndefined();
      await expect(asEmployee([], () => service.assertCreateTask(TENANT, WORKSPACE_GRANTS.taskCreate, THEIRS))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(asEmployee([], () => service.assertCreateTask(TENANT, WORKSPACE_GRANTS.taskCreate, undefined))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(asEmployee(['tasks.create'], () => service.assertCreateTask(TENANT, WORKSPACE_GRANTS.taskCreate, undefined))).resolves.toBeUndefined();
    });

    it('stays on projects the owner owns when edited: not moved elsewhere, or out of every project', async () => {
      await expect(asEmployee([], () => service.assertEditTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK, undefined))).resolves.toBeUndefined();
      await expect(asEmployee([], () => service.assertEditTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK, MINE))).resolves.toBeUndefined();
      await expect(asEmployee([], () => service.assertEditTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK, THEIRS))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(asEmployee([], () => service.assertEditTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK, null))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      // Someone with the permission can move it wherever they like.
      await expect(asEmployee(['tasks.edit'], () => service.assertEditTask(TENANT, WORKSPACE_GRANTS.taskEdit, TASK, null))).resolves.toBeUndefined();
    });
  });

  describe('the lists an owner needs', () => {
    it('are open to someone who owns at least one project, and to nobody else without the permission', async () => {
      await expect(asEmployee([], () => service.assertViewOrOwn(TENANT, WORKSPACE_GRANTS.taskView))).resolves.toBeUndefined();

      projectModel.count.mockResolvedValue(0);
      await expect(asEmployee([], () => service.assertViewOrOwn(TENANT, WORKSPACE_GRANTS.taskView))).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      await expect(asEmployee(['tasks.view'], () => service.assertViewOrOwn(TENANT, WORKSPACE_GRANTS.taskView))).resolves.toBeUndefined();
    });
  });
});
