import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, Sequelize, WhereOptions, literal } from 'sequelize';
import {
  CreateWorkspaceTaskDto,
  EmployeeStatus,
  EXPORT_MAX_ROWS,
  ExportResult,
  GetMyTasksQueryDto,
  GetWorkspaceTasksQueryDto,
  UpdateWorkspaceTaskDto,
  WorkspaceTaskFiltersDto,
  WorkspaceTaskPriority,
  WorkspaceTaskStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { WorkspaceProjectService } from './workspace-project.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import {
  diffFields,
  employeeInclude,
  employeeSummary,
  findSelfEmployee,
  formatDay,
  fullName,
  notifyEmployee,
  todayIso,
  workspaceError,
} from './workspace-shared';

export interface WorkspaceTaskRow {
  id: string;
  title: string;
  description: string | null;
  project: { id: string; name: string } | null;
  assignee: ReturnType<typeof employeeSummary>;
  dueDate: string;
  priority: WorkspaceTaskPriority;
  status: WorkspaceTaskStatus;
  overdue: boolean;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Urgent first when sorting by priority. */
const PRIORITY_RANK = `CASE "WorkspaceTask"."priority" WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END`;
/** Open work first, then completed. */
const STATUS_RANK = `CASE "WorkspaceTask"."status" WHEN 'IN_PROGRESS' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END`;

/** Employees who can still be given work. */
const ASSIGNABLE_STATUSES = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

/**
 * Workspace › Tasks: the team task list, its KPI cards, and an employee's own
 * "My Tasks". A scoped role (team lead, department head) only sees and assigns
 * tasks for the people its data scope reaches.
 */
@Injectable()
export class WorkspaceTaskService {
  private readonly logger = new Logger(WorkspaceTaskService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly projects?: WorkspaceProjectService,
  ) {}

  private scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, 'assigneeEmployeeId') : Promise.resolve({});
  }

  private async include(tenantId: string) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    return [
      await employeeInclude(this.modelProvider, tenantId, 'assignee'),
      { model: Project, as: 'project', attributes: ['id', 'name'], required: false },
    ];
  }

  private toRow(task: any, today = todayIso()): WorkspaceTaskRow {
    return {
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      project: task.project ? { id: task.project.id, name: task.project.name } : null,
      assignee: employeeSummary(task.assignee),
      dueDate: task.dueDate,
      priority: task.priority,
      status: task.status,
      overdue: task.status !== WorkspaceTaskStatus.COMPLETED && task.dueDate < today,
      completedAt: task.completedAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private filtersWhere(tenantId: string, filters: WorkspaceTaskFiltersDto & { status?: WorkspaceTaskStatus }): WhereOptions {
    const and: any[] = [{ tenantId }];
    if (filters.status) and.push({ status: filters.status });
    if (filters.priority) and.push({ priority: filters.priority });
    if (filters.projectId) and.push({ projectId: filters.projectId });
    if (filters.assigneeEmployeeId) and.push({ assigneeEmployeeId: filters.assigneeEmployeeId });
    if (filters.overdue) {
      and.push({ status: { [Op.ne]: WorkspaceTaskStatus.COMPLETED } }, { dueDate: { [Op.lt]: todayIso() } });
    }
    const search = filters.search?.trim();
    if (search) {
      const like = `%${search}%`;
      and.push({
        [Op.or]: [
          { title: { [Op.iLike]: like } },
          Sequelize.where(
            Sequelize.fn('concat', Sequelize.col('assignee.firstName'), ' ', Sequelize.col('assignee.lastName')),
            { [Op.iLike]: like },
          ),
          { '$project.name$': { [Op.iLike]: like } },
        ],
      });
    }
    return { [Op.and]: and };
  }

  private order(sortBy?: string, sortOrder?: 'ASC' | 'DESC'): any[] {
    const dir = sortOrder === 'DESC' ? 'DESC' : 'ASC';
    switch (sortBy) {
      case 'priority':
        return [[literal(PRIORITY_RANK), dir], ['dueDate', 'ASC']];
      case 'title':
        return [['title', dir]];
      case 'createdAt':
        return [['createdAt', sortOrder ?? 'DESC']];
      case 'status':
        return [[literal(STATUS_RANK), dir], ['dueDate', 'ASC']];
      default:
        // Soonest first, so overdue and due-today work leads the list.
        return [['dueDate', dir], [literal(PRIORITY_RANK), 'ASC'], ['createdAt', 'DESC']];
    }
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(tenantId: string, query: GetWorkspaceTasksQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);

    const { rows, count } = await Task.findAndCountAll({
      where: { [Op.and]: [this.filtersWhere(tenantId, query), await this.scopeWhere(tenantId)] },
      include: await this.include(tenantId),
      order: this.order(query.sortBy, query.sortOrder),
      offset: (page - 1) * limit,
      limit,
      subQuery: false,
      distinct: true,
    });

    const today = todayIso();
    return {
      data: rows.map((row) => this.toRow(row, today)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /** KPI cards and tab counts for the current filters (every status). */
  async getStats(tenantId: string, filters: WorkspaceTaskFiltersDto) {
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const where = { [Op.and]: [this.filtersWhere(tenantId, { ...filters, overdue: false }), await this.scopeWhere(tenantId)] };
    const include = await this.include(tenantId);
    // The joins are only there for the search filter, so they select nothing.
    const slim = include.map((inc: any) => ({
      ...inc,
      attributes: [],
      ...(inc.include ? { include: inc.include.map((i: any) => ({ ...i, attributes: [] })) } : {}),
    }));

    const rows = (await Task.findAll({
      where,
      include: slim,
      attributes: [
        'status',
        [Sequelize.fn('COUNT', Sequelize.col('WorkspaceTask.id')), 'count'],
        [
          Sequelize.fn(
            'SUM',
            literal(`CASE WHEN "WorkspaceTask"."status" <> 'COMPLETED' AND "WorkspaceTask"."dueDate" < '${todayIso()}' THEN 1 ELSE 0 END`),
          ),
          'overdue',
        ],
      ],
      group: ['WorkspaceTask.status'],
      raw: true,
    })) as unknown as { status: WorkspaceTaskStatus; count: string; overdue: string }[];

    const countOf = (status: WorkspaceTaskStatus) => Number(rows.find((r) => r.status === status)?.count ?? 0);
    const pending = countOf(WorkspaceTaskStatus.PENDING);
    const inProgress = countOf(WorkspaceTaskStatus.IN_PROGRESS);
    const completed = countOf(WorkspaceTaskStatus.COMPLETED);
    return {
      total: pending + inProgress + completed,
      pending,
      inProgress,
      completed,
      overdue: rows.reduce((sum, r) => sum + Number(r.overdue ?? 0), 0),
    };
  }

  async getAllForExport(tenantId: string, query: WorkspaceTaskFiltersDto & { status?: WorkspaceTaskStatus }): Promise<ExportResult<WorkspaceTaskRow>> {
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const { rows, count } = await Task.findAndCountAll({
      where: { [Op.and]: [this.filtersWhere(tenantId, query), await this.scopeWhere(tenantId)] },
      include: await this.include(tenantId),
      order: this.order(),
      limit: EXPORT_MAX_ROWS,
      subQuery: false,
      distinct: true,
    });
    const today = todayIso();
    return { rows: rows.map((r) => this.toRow(r, today)), totalMatched: count, truncated: count > rows.length, limit: EXPORT_MAX_ROWS };
  }

  private async findScoped(tenantId: string, taskId: string) {
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const task = await Task.findOne({
      where: { [Op.and]: [{ id: taskId, tenantId }, await this.scopeWhere(tenantId)] },
      include: await this.include(tenantId),
    });
    if (!task) workspaceError('Task not found.', HttpStatus.NOT_FOUND);
    return task!;
  }

  async getOne(tenantId: string, taskId: string) {
    return this.toRow(await this.findScoped(tenantId, taskId));
  }

  // ==========================================
  // Writes
  // ==========================================

  /** The assignee must exist, still work here, and be inside the caller's data scope. */
  private async assertAssignable(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) workspaceError('The selected assignee was not found.', HttpStatus.BAD_REQUEST);
    if (!ASSIGNABLE_STATUSES.includes(employee!.status)) {
      workspaceError(`${fullName(employee)} is no longer active and can't be assigned work.`, HttpStatus.BAD_REQUEST);
    }
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, employeeId, 'Employee');
    return employee!;
  }

  private async assertProject(tenantId: string, projectId: string | null | undefined) {
    if (!projectId) return null;
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.findOne({ where: { id: projectId, tenantId } });
    if (!project) workspaceError('The selected project was not found.', HttpStatus.BAD_REQUEST);
    return project!;
  }

  private async notifyAssignee(tenantId: string, task: any, projectName: string | null) {
    // Don't notify someone about a task they just gave themselves.
    const self = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
    if (self && self === task.assigneeEmployeeId) return;
    const details = [`Due ${formatDay(task.dueDate)}`, projectName, `${task.priority.charAt(0)}${task.priority.slice(1).toLowerCase()} priority`]
      .filter(Boolean)
      .join(' · ');
    await notifyEmployee(this.modelProvider, this.logger, tenantId, task.assigneeEmployeeId, `New task: ${task.title}`, details);
  }

  async create(tenantId: string, dto: CreateWorkspaceTaskDto, actorUserId?: string) {
    await this.assertAssignable(tenantId, dto.assigneeEmployeeId);
    const project = await this.assertProject(tenantId, dto.projectId);

    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const status = dto.status ?? WorkspaceTaskStatus.PENDING;
    const task = await Task.create({
      tenantId,
      title: dto.title.trim(),
      description: dto.description?.trim() || null,
      projectId: dto.projectId ?? null,
      assigneeEmployeeId: dto.assigneeEmployeeId,
      dueDate: dto.dueDate,
      priority: dto.priority ?? WorkspaceTaskPriority.NORMAL,
      status,
      completedAt: status === WorkspaceTaskStatus.COMPLETED ? new Date() : null,
      createdByUserId: actorUserId ?? null,
    });

    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', task.id, 'CREATE', {
      title: { from: null, to: task.title },
      assigneeEmployeeId: { from: null, to: task.assigneeEmployeeId },
      dueDate: { from: null, to: task.dueDate },
    });
    await this.notifyAssignee(tenantId, task, project?.name ?? null);
    return this.getOne(tenantId, task.id);
  }

  async update(tenantId: string, taskId: string, dto: UpdateWorkspaceTaskDto) {
    const task: any = await this.findScoped(tenantId, taskId);
    const reassigned = dto.assigneeEmployeeId && dto.assigneeEmployeeId !== task.assigneeEmployeeId;
    if (reassigned) await this.assertAssignable(tenantId, dto.assigneeEmployeeId!);
    const project = dto.projectId !== undefined ? await this.assertProject(tenantId, dto.projectId) : null;

    const next: Record<string, unknown> = {
      title: dto.title?.trim(),
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      projectId: dto.projectId === undefined ? undefined : dto.projectId,
      assigneeEmployeeId: dto.assigneeEmployeeId,
      dueDate: dto.dueDate,
      priority: dto.priority,
      status: dto.status,
    };
    const changes = diffFields(task.get({ plain: true }), next);
    if (!Object.keys(changes).length) return this.toRow(task);

    if (changes.status) {
      next.completedAt = dto.status === WorkspaceTaskStatus.COMPLETED ? new Date() : null;
    }
    await task.update(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', task.id, 'UPDATE', changes);

    if (reassigned) {
      const projectName = project?.name ?? task.project?.name ?? null;
      await this.notifyAssignee(tenantId, task, projectName);
    } else if (changes.dueDate || changes.priority) {
      // The same person, but the deadline or urgency moved under them.
      const what = [
        changes.dueDate && `now due ${formatDay(task.dueDate)}`,
        changes.priority && `priority ${String(task.priority).toLowerCase()}`,
      ]
        .filter(Boolean)
        .join(', ');
      await notifyEmployee(this.modelProvider, this.logger, tenantId, task.assigneeEmployeeId, `Task updated: ${task.title}`, `This task is ${what}.`);
    }
    return this.getOne(tenantId, task.id);
  }

  async remove(tenantId: string, taskId: string) {
    const task = await this.findScoped(tenantId, taskId);
    await task.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', taskId, 'DELETE', {
      title: { from: task.title, to: null },
    });
    return { success: true };
  }

  /**
   * People the caller can assign work to or make a project lead: current
   * staff, narrowed to the caller's data scope. Its own list rather than the
   * employee directory, so a role with task rights but no `employee.view`
   * still gets a picker.
   */
  async getPeople(tenantId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const visible = this.dataScope ? await this.dataScope.visibleEmployeeIds(tenantId) : null;
    const rows = await Employee.findAll({
      where: {
        tenantId,
        status: { [Op.in]: ASSIGNABLE_STATUSES },
        ...(visible ? { id: { [Op.in]: visible } } : {}),
      },
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl', 'departmentId'],
      include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
      order: [['firstName', 'ASC'], ['lastName', 'ASC']],
    });
    return rows.map((row) => employeeSummary(row));
  }

  // ==========================================
  // My Tasks (self-service)
  // ==========================================

  async getMine(tenantId: string, userId: string, email: string | undefined, query: GetMyTasksQueryDto) {
    const me = await findSelfEmployee(this.modelProvider, tenantId, userId, email);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const rows = await Task.findAll({
      where: { tenantId, assigneeEmployeeId: me.id, ...(query.status ? { status: query.status } : {}) },
      include: await this.include(tenantId),
      order: [[literal(STATUS_RANK), 'ASC'], ['dueDate', 'ASC']],
      limit: 200,
    });
    const today = todayIso();
    const assigners = await this.assignerNames(tenantId, rows);
    const data = rows.map((r: any) => ({
      ...this.toRow(r, today),
      assignedBy: r.createdByUserId ? (assigners.get(r.createdByUserId) ?? 'Management') : null,
    }));
    const projectIds = [...new Set(data.map((t) => t.project?.id).filter((id): id is string => Boolean(id)))];
    const projects = this.projects ? await this.projects.getForEmployee(tenantId, me.id, projectIds) : [];
    // How many of each project's tasks are mine, for the project cards.
    const mine = new Map<string, { open: number; total: number }>();
    for (const t of data) {
      if (!t.project) continue;
      const m = mine.get(t.project.id) ?? { open: 0, total: 0 };
      m.total += 1;
      if (t.status !== WorkspaceTaskStatus.COMPLETED) m.open += 1;
      mine.set(t.project.id, m);
    }
    return {
      data,
      projects: projects.map((p) => ({ ...p, myTasks: mine.get(p.id)?.total ?? 0, myOpenTasks: mine.get(p.id)?.open ?? 0 })),
      stats: {
        total: data.length,
        pending: data.filter((t) => t.status === WorkspaceTaskStatus.PENDING).length,
        inProgress: data.filter((t) => t.status === WorkspaceTaskStatus.IN_PROGRESS).length,
        completed: data.filter((t) => t.status === WorkspaceTaskStatus.COMPLETED).length,
        overdue: data.filter((t) => t.overdue).length,
      },
    };
  }

  /** "Ali Khan" for each task creator who has an employee record; admins without one have none. */
  private async assignerNames(tenantId: string, rows: any[]) {
    const names = new Map<string, string>();
    const userIds = [...new Set(rows.map((r) => r.createdByUserId).filter(Boolean))];
    if (!userIds.length) return names;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const people = await Employee.findAll({
      where: { tenantId, userId: { [Op.in]: userIds } },
      attributes: ['userId', 'firstName', 'lastName'],
    });
    for (const p of people as any[]) names.set(p.userId, fullName(p));
    return names;
  }

  /** The project lead hears when work on their project is finished — unless they finished it. */
  private async notifyLeadOfCompletion(tenantId: string, task: any, me: any) {
    if (!task.projectId) return;
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.findOne({ where: { id: task.projectId, tenantId }, attributes: ['name', 'leadEmployeeId'] });
    if (!project?.leadEmployeeId || project.leadEmployeeId === me.id) return;
    await notifyEmployee(
      this.modelProvider,
      this.logger,
      tenantId,
      project.leadEmployeeId,
      `Task completed: ${task.title}`,
      `${fullName(me)} completed this task on ${project.name}.`,
    );
  }

  /** An assignee moves their own task along; nothing else about it is theirs to change. */
  async updateMyStatus(tenantId: string, userId: string, email: string | undefined, taskId: string, status: WorkspaceTaskStatus) {
    const me = await findSelfEmployee(this.modelProvider, tenantId, userId, email);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const task = await Task.findOne({ where: { id: taskId, tenantId, assigneeEmployeeId: me.id } });
    if (!task) workspaceError('Task not found.', HttpStatus.NOT_FOUND);
    if (task!.status !== status) {
      const from = task!.status;
      await task!.update({ status, completedAt: status === WorkspaceTaskStatus.COMPLETED ? new Date() : null });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', taskId, 'UPDATE', {
        status: { from, to: status },
      });
      if (status === WorkspaceTaskStatus.COMPLETED) await this.notifyLeadOfCompletion(tenantId, task, me);
    }
    return this.toRow(await Task.findOne({ where: { id: taskId }, include: await this.include(tenantId) }));
  }
}
