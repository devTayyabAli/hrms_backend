import { HttpStatus, Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  DataScope,
  MicroserviceAuthContext,
  TenantErrorCode,
  TenantException,
  roleDataScope,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';

/** Deep enough for any real org chart; a cycle in the data can't loop forever. */
const MAX_TEAM_DEPTH = 12;

/**
 * Row-level access: *whose* records the caller's permissions reach.
 *
 * Permissions say what someone may do (view employees, approve leave); the
 * role's data scope — signed into every message from the caller's JWT —
 * says on whom:
 *
 * - ORGANIZATION: everyone. Also full-access callers, unsigned/system calls
 *   and older tokens without a scope — i.e. exactly how things worked before.
 * - DEPARTMENT: the departments they manage (and those departments'
 *   sub-departments); if they manage none, their own department.
 * - TEAM: everyone who reports to them, directly or further down.
 * - SELF: only their own record.
 *
 * The caller themselves is always included. Services ask for
 * `visibleEmployeeIds()` and add it to their query; `null` means "no filter".
 */
@Injectable()
export class DataScopeService {
  /** One resolution per message: the actor object is the same for its whole handling. */
  private readonly cache = new WeakMap<MicroserviceAuthContext, Map<string, Promise<string[] | null>>>();

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  /** The caller's scope, or ORGANIZATION when nothing narrows it. */
  scope(): DataScope {
    const actor = currentRpcActor();
    if (!actor || actor.isFullAccess || actor.isSuperAdmin) return DataScope.ORGANIZATION;
    return roleDataScope(actor.dataScope);
  }

  /** Employee ids the caller may see, or `null` for organization-wide. */
  visibleEmployeeIds(tenantId: string): Promise<string[] | null> {
    const actor = currentRpcActor();
    if (!actor || this.scope() === DataScope.ORGANIZATION) return Promise.resolve(null);

    let perTenant = this.cache.get(actor);
    if (!perTenant) {
      perTenant = new Map();
      this.cache.set(actor, perTenant);
    }
    let pending = perTenant.get(tenantId);
    if (!pending) {
      pending = this.resolve(tenantId, actor, this.scope());
      perTenant.set(tenantId, pending);
    }
    return pending;
  }

  /**
   * A `where` fragment limiting a query to visible employees — `{}` when the
   * caller sees everyone. `field` is the column holding the employee id.
   */
  async employeeWhere(tenantId: string, field = 'employeeId'): Promise<Record<string, unknown>> {
    const ids = await this.visibleEmployeeIds(tenantId);
    return ids === null ? {} : { [field]: { [Op.in]: ids } };
  }

  /** True when the caller may see this employee's records. */
  async canSee(tenantId: string, employeeId: string | null | undefined): Promise<boolean> {
    const ids = await this.visibleEmployeeIds(tenantId);
    return ids === null || (Boolean(employeeId) && ids.includes(employeeId as string));
  }

  /** Throws a not-found — the record is outside the caller's scope, so it doesn't exist for them. */
  async assertCanSee(tenantId: string, employeeId: string | null | undefined, what = 'Record'): Promise<void> {
    if (await this.canSee(tenantId, employeeId)) return;
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `${what} not found in your team or department.`,
      HttpStatus.NOT_FOUND,
    );
  }

  /** The caller's own employee record id — for "you can't approve your own…" checks. */
  async actorEmployeeId(tenantId: string): Promise<string | null> {
    const actor = currentRpcActor();
    if (!actor) return null;
    return (await this.findSelf(tenantId, actor))?.id ?? null;
  }

  /**
   * The caller's employee record — by login email, then by the linked user
   * id, the same two ways the employee portal recognises "me".
   */
  private async findSelf(tenantId: string, actor: MicroserviceAuthContext) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const email = actor.email?.trim();
    const byEmail = email
      ? await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email } }, attributes: ['id', 'departmentId'] })
      : null;
    if (byEmail || !actor.userId) return byEmail;
    return Employee.findOne({ where: { tenantId, userId: actor.userId }, attributes: ['id', 'departmentId'] });
  }

  private async resolve(tenantId: string, actor: MicroserviceAuthContext, scope: DataScope): Promise<string[]> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const me = await this.findSelf(tenantId, actor);
    // A narrowed caller with no employee record of their own sees nothing.
    if (!me) return [];

    if (scope === DataScope.SELF) return [me.id];
    if (scope === DataScope.TEAM) return [me.id, ...(await this.reportsOf(tenantId, me.id))];

    // DEPARTMENT: what they manage (and its sub-departments), else their own.
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const managed = (await Department.findAll({
      where: { tenantId, managerId: me.id },
      attributes: ['id'],
      raw: true,
    })) as { id: string }[];
    let departmentIds = managed.map((row) => row.id);
    if (departmentIds.length) {
      departmentIds = await this.withSubDepartments(tenantId, departmentIds);
    } else if (me.departmentId) {
      departmentIds = [me.departmentId];
    }

    const inDepartments = departmentIds.length
      ? ((await Employee.findAll({
          where: { tenantId, departmentId: { [Op.in]: departmentIds } },
          attributes: ['id'],
          raw: true,
        })) as { id: string }[]).map((row) => row.id)
      : [];
    // Their own reports count too, even ones seated in another department.
    const team = await this.reportsOf(tenantId, me.id);
    return [...new Set([me.id, ...inDepartments, ...team])];
  }

  /** Everyone under `managerId` in the reporting line, breadth-first. */
  private async reportsOf(tenantId: string, managerId: string): Promise<string[]> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const seen = new Set<string>([managerId]);
    let frontier = [managerId];
    for (let depth = 0; depth < MAX_TEAM_DEPTH && frontier.length; depth++) {
      const rows = (await Employee.findAll({
        where: { tenantId, reportingManagerId: { [Op.in]: frontier } },
        attributes: ['id'],
        raw: true,
      })) as { id: string }[];
      frontier = rows.map((row) => row.id).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
    }
    seen.delete(managerId);
    return [...seen];
  }

  private async withSubDepartments(tenantId: string, roots: string[]): Promise<string[]> {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const seen = new Set(roots);
    let frontier = roots;
    for (let depth = 0; depth < MAX_TEAM_DEPTH && frontier.length; depth++) {
      const rows = (await Department.findAll({
        where: { tenantId, parentDepartmentId: { [Op.in]: frontier } },
        attributes: ['id'],
        raw: true,
      })) as { id: string }[];
      frontier = rows.map((row) => row.id).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
    }
    return [...seen];
  }
}
