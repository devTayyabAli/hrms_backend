import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { grantsPermission } from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { workspaceError } from './workspace-shared';

const NOT_ALLOWED = 'Only the project owner, or someone with the right permission, can do this.';

/**
 * Who may manage a project and its tasks: a role with the permission, or the
 * project's own owner.
 *
 * Being an owner covers one project at a time — an employee can own one
 * project and be an ordinary member of another — and only what an owner
 * needs: editing the project, closing it, choosing its team, and creating and
 * managing its tasks. Deleting a project or a task, the Confidential flag and
 * reopening a completed project stay with the role permissions.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  /** Whether the signed-in caller holds one of these grants. Outside a signed request (a job, a test) there is no person to refuse. */
  holdsAny(grants: readonly string[]): boolean {
    const actor = currentRpcActor();
    if (!actor) return true;
    if (actor.isFullAccess || actor.isSuperAdmin) return true;
    const permissions = actor.permissions ?? [];
    return grants.some((grant) => grantsPermission(permissions, grant));
  }

  private async myEmployeeId(tenantId: string): Promise<string | null> {
    if (!this.dataScope) return null;
    return this.dataScope.actorEmployeeId(tenantId).catch(() => null);
  }

  private async leadOf(tenantId: string, projectId: string): Promise<string | null> {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project: any = await Project.findOne({ where: { id: projectId, tenantId }, attributes: ['leadEmployeeId'] });
    return project?.leadEmployeeId ?? null;
  }

  /** Whether the caller is the owner of this project. */
  async ownsProject(tenantId: string, projectId: string): Promise<boolean> {
    const me = await this.myEmployeeId(tenantId);
    if (!me) return false;
    return (await this.leadOf(tenantId, projectId)) === me;
  }

  /** Whether the caller owns at least one project. */
  async ownsAnyProject(tenantId: string): Promise<boolean> {
    const me = await this.myEmployeeId(tenantId);
    if (!me) return false;
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    return (await Project.count({ where: { tenantId, leadEmployeeId: me } })) > 0;
  }

  private refuse(): never {
    return workspaceError(NOT_ALLOWED, HttpStatus.FORBIDDEN);
  }

  /** The permission, or ownership of this project. */
  async assertProject(tenantId: string, grants: readonly string[], projectId: string): Promise<void> {
    if (this.holdsAny(grants)) return;
    if (!(await this.ownsProject(tenantId, projectId))) this.refuse();
  }

  /** The permission, or ownership of the project this task is on. A task on no project has no owner to act. */
  async assertTask(tenantId: string, grants: readonly string[], taskId: string): Promise<void> {
    if (this.holdsAny(grants)) return;
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const task: any = await Task.findOne({ where: { id: taskId, tenantId }, attributes: ['projectId'] });
    if (!task?.projectId || !(await this.ownsProject(tenantId, task.projectId))) this.refuse();
  }

  /** The permission, or ownership of the project the task is being created in. */
  async assertCreateTask(tenantId: string, grants: readonly string[], projectId: string | null | undefined): Promise<void> {
    if (this.holdsAny(grants)) return;
    if (!projectId || !(await this.ownsProject(tenantId, projectId))) this.refuse();
  }

  /**
   * Editing a task. An owner can keep it in their project but not move it to
   * a project they do not own, or out of every project.
   */
  async assertEditTask(
    tenantId: string,
    grants: readonly string[],
    taskId: string,
    newProjectId: string | null | undefined,
  ): Promise<void> {
    if (this.holdsAny(grants)) return;
    await this.assertTask(tenantId, grants, taskId);
    if (newProjectId === undefined) return;
    if (!newProjectId || !(await this.ownsProject(tenantId, newProjectId))) this.refuse();
  }

  /** The permission, or owning some project: enough to read the lists an owner needs. */
  async assertViewOrOwn(tenantId: string, grants: readonly string[]): Promise<void> {
    if (this.holdsAny(grants)) return;
    if (!(await this.ownsAnyProject(tenantId))) this.refuse();
  }
}
