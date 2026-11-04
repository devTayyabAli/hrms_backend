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
  WorkspaceProjectStatus,
  WorkspaceTaskPriority,
  WorkspaceTaskStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { WorkspaceProjectService } from './workspace-project.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import {
  addDays,
  calendarDay,
  diffFields,
  employeeInclude,
  employeeSummary,
  findSelfEmployee,
  formatDay,
  fullName,
  involvedProjectIds,
  ledProjectIds,
  seesConfidentialProjects,
  workspaceNoticePrefs,
  notifyEmployee,
  taskDueOutsideProject,
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
  /** True when the due date was kept outside the project's dates on purpose. */
  dueDateException: boolean;
  priority: WorkspaceTaskPriority;
  status: WorkspaceTaskStatus;
  /** Everyone responsible. The first is also `assignee`. */
  assignees: NonNullable<ReturnType<typeof employeeSummary>>[];
  requiresReview: boolean;
  reviewStatus: 'PENDING' | 'APPROVED' | 'RETURNED' | null;
  overdue: boolean;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** An assignee left the organization and this task is still open. */
  needsReassignment: boolean;
  comments: { id: string; body: string; authorName: string; authorUserId: string | null; createdAt: Date }[];
  checklist: { id: string; label: string; done: boolean }[];
  attachments: { id: string; fileId: string; fileName: string; mimeType: string | null; sizeBytes: number | null; uploadedByUserId: string | null }[];
}

/** Urgent first when sorting by priority. */
const PRIORITY_RANK = `CASE "WorkspaceTask"."priority" WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END`;
/** Open work first, blocked next, then to-do, then completed. */
const STATUS_RANK = `CASE "WorkspaceTask"."status" WHEN 'IN_PROGRESS' THEN 0 WHEN 'BLOCKED' THEN 1 WHEN 'PENDING' THEN 2 ELSE 3 END`;

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

  /** Task ids where one of these employees is an assignee, including a second assignee. */
  private async taskIdsForEmployees(tenantId: string, employeeIds: string[]): Promise<string[]> {
    if (!employeeIds.length) return [];
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const rows = (await Assignee.findAll({
      where: { tenantId, employeeId: { [Op.in]: employeeIds } },
      attributes: ['taskId'],
      raw: true,
    })) as unknown as { taskId: string }[];
    return [...new Set(rows.map((row) => row.taskId))];
  }

  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    const base = await this.dataScopeWhere(tenantId);
    if (seesConfidentialProjects()) return base;
    const hidden = await this.hiddenProjectClause(tenantId);
    if (!hidden) return base;
    const blank = Object.keys(base).length === 0 && Object.getOwnPropertySymbols(base).length === 0;
    return blank ? hidden : { [Op.and]: [base, hidden] };
  }

  /**
   * Tasks the caller may see because of whose work they can reach — and every
   * task on a project they own, whoever it is assigned to.
   */
  private async dataScopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    if (!this.dataScope) return {};
    const visible = await this.dataScope.visibleEmployeeIds(tenantId);
    if (visible === null) return {};
    const me = await this.dataScope.actorEmployeeId(tenantId).catch(() => null);
    const owned = me ? await ledProjectIds(this.modelProvider, tenantId, me) : [];
    const ownedClause = owned.length ? [{ projectId: { [Op.in]: owned } }] : [];
    if (!visible.length) return ownedClause.length ? { [Op.or]: ownedClause } : { id: null };
    const extra = await this.taskIdsForEmployees(tenantId, visible);
    return {
      [Op.or]: [
        { assigneeEmployeeId: { [Op.in]: visible } },
        ...(extra.length ? [{ id: { [Op.in]: extra } }] : []),
        ...ownedClause,
      ],
    };
  }

  /** Drop tasks on confidential projects the caller is not personally on. */
  private async hiddenProjectClause(tenantId: string): Promise<Record<string, unknown> | null> {
    const me = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId) : null;
    const mine = me ? await involvedProjectIds(this.modelProvider, tenantId, me) : [];
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = (await Project.findAll({
      where: { tenantId, confidential: true, ...(mine.length ? { id: { [Op.notIn]: mine } } : {}) },
      attributes: ['id'],
      raw: true,
    })) as unknown as { id: string }[];
    if (!rows.length) return null;
    const hidden = rows.map((row) => row.id);
    return { [Op.or]: [{ projectId: null }, { projectId: { [Op.notIn]: hidden } }] };
  }

  private async include(tenantId: string) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    return [
      await employeeInclude(this.modelProvider, tenantId, 'assignee'),
      { model: Project, as: 'project', attributes: ['id', 'name'], required: false },
    ];
  }

  private toRow(
    task: any,
    today = todayIso(),
    assignees?: NonNullable<ReturnType<typeof employeeSummary>>[],
    activity?: { comments: any[]; checklist: any[]; attachments: any[] },
  ): WorkspaceTaskRow {
    const primary = employeeSummary(task.assignee);
    const people = [...(assignees ?? [])];
    if (primary && !people.some((person) => person.id === primary.id)) people.unshift(primary);
    return {
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      project: task.project ? { id: task.project.id, name: task.project.name } : null,
      assignee: primary,
      assignees: people,
      dueDate: task.dueDate,
      dueDateException: task.dueDateException === true,
      requiresReview: task.requiresReview === true,
      reviewStatus: task.reviewStatus ?? null,
      priority: task.priority,
      status: task.status,
      overdue: task.status !== WorkspaceTaskStatus.COMPLETED && task.dueDate < today,
      completedAt: task.completedAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      needsReassignment: task.needsReassignment === true,
      comments: (activity?.comments ?? []).map((row) => ({
        id: row.id,
        body: row.body,
        authorName: row.authorName,
        authorUserId: row.authorUserId ?? null,
        createdAt: row.createdAt,
      })),
      checklist: (activity?.checklist ?? []).map((row) => ({ id: row.id, label: row.label, done: row.done === true })),
      attachments: (activity?.attachments ?? []).map((row) => ({
        id: row.id,
        fileId: row.fileId,
        fileName: row.fileName,
        mimeType: row.mimeType ?? null,
        sizeBytes: row.sizeBytes ?? null,
        uploadedByUserId: row.uploadedByUserId ?? null,
      })),
    };
  }

  private async filtersWhere(tenantId: string, filters: WorkspaceTaskFiltersDto & { status?: WorkspaceTaskStatus }): Promise<WhereOptions> {
    const and: any[] = [{ tenantId }];
    if (filters.status) and.push({ status: filters.status });
    if (filters.priority) and.push({ priority: filters.priority });
    if (filters.projectId) and.push({ projectId: filters.projectId });
    if (filters.assigneeEmployeeId) {
      const extra = await this.taskIdsForEmployees(tenantId, [filters.assigneeEmployeeId]);
      and.push({
        [Op.or]: [
          { assigneeEmployeeId: filters.assigneeEmployeeId },
          ...(extra.length ? [{ id: { [Op.in]: extra } }] : []),
        ],
      });
    }
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
      where: { [Op.and]: [await this.filtersWhere(tenantId, query), await this.scopeWhere(tenantId)] },
      include: await this.include(tenantId),
      order: this.order(query.sortBy, query.sortOrder),
      offset: (page - 1) * limit,
      limit,
      subQuery: false,
      distinct: true,
    });

    const today = todayIso();
    return {
      data: await this.present(tenantId, rows, today),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /** KPI cards and tab counts for the current filters (every status). */
  async getStats(tenantId: string, filters: WorkspaceTaskFiltersDto) {
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const where = { [Op.and]: [await this.filtersWhere(tenantId, { ...filters, overdue: false }), await this.scopeWhere(tenantId)] };
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
    const blocked = countOf(WorkspaceTaskStatus.BLOCKED);
    const completed = countOf(WorkspaceTaskStatus.COMPLETED);
    return {
      total: pending + inProgress + blocked + completed,
      pending,
      inProgress,
      blocked,
      completed,
      overdue: rows.reduce((sum, r) => sum + Number(r.overdue ?? 0), 0),
    };
  }

  async getAllForExport(tenantId: string, query: WorkspaceTaskFiltersDto & { status?: WorkspaceTaskStatus }): Promise<ExportResult<WorkspaceTaskRow>> {
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const { rows, count } = await Task.findAndCountAll({
      where: { [Op.and]: [await this.filtersWhere(tenantId, query), await this.scopeWhere(tenantId)] },
      include: await this.include(tenantId),
      order: this.order(),
      limit: EXPORT_MAX_ROWS,
      subQuery: false,
      distinct: true,
    });
    const today = todayIso();
    return { rows: await this.present(tenantId, rows, today), totalMatched: count, truncated: count > rows.length, limit: EXPORT_MAX_ROWS };
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

  private async assigneesByTask(tenantId: string, taskIds: string[]) {
    const grouped = new Map<string, NonNullable<ReturnType<typeof employeeSummary>>[]>();
    if (!taskIds.length) return grouped;
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const rows = (await Assignee.findAll({
      where: { tenantId, taskId: { [Op.in]: taskIds } },
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl'],
          include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
        },
      ],
    })) as any[];
    for (const row of rows) {
      const person = employeeSummary(row.employee);
      if (!person) continue;
      const list = grouped.get(row.taskId) ?? [];
      list.push(person);
      grouped.set(row.taskId, list);
    }
    for (const list of grouped.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return grouped;
  }

  private async present(tenantId: string, tasks: any[], today = todayIso()) {
    const ids = tasks.map((task) => task.id).filter(Boolean);
    const [grouped, activity] = await Promise.all([this.assigneesByTask(tenantId, ids), this.activityByTask(tenantId, ids)]);
    return tasks.map((task) => this.toRow(task, today, grouped.get(task.id), activity.get(task.id)));
  }

  /** Comments, checklist lines, and files. Completing a task never deletes these. */
  private async activityByTask(tenantId: string, taskIds: string[]) {
    const grouped = new Map<string, { comments: any[]; checklist: any[]; attachments: any[] }>();
    const bucket = (taskId: string) => {
      let row = grouped.get(taskId);
      if (!row) {
        row = { comments: [], checklist: [], attachments: [] };
        grouped.set(taskId, row);
      }
      return row;
    };
    if (!taskIds.length) return grouped;
    const [Comment, Item, Attachment] = await Promise.all([
      this.modelProvider.getWorkspaceTaskCommentModel(tenantId),
      this.modelProvider.getWorkspaceTaskChecklistItemModel(tenantId),
      this.modelProvider.getWorkspaceTaskAttachmentModel(tenantId),
    ]);
    const where = { tenantId, taskId: { [Op.in]: taskIds } };
    const [comments, checklist, attachments] = await Promise.all([
      Comment.findAll({ where, order: [['createdAt', 'ASC']] }),
      Item.findAll({ where, order: [['position', 'ASC'], ['createdAt', 'ASC']] }),
      Attachment.findAll({ where, order: [['createdAt', 'ASC']] }),
    ]);
    for (const row of comments as any[]) bucket(row.taskId).comments.push(row);
    for (const row of checklist as any[]) bucket(row.taskId).checklist.push(row);
    for (const row of attachments as any[]) bucket(row.taskId).attachments.push(row);
    return grouped;
  }

  async getOne(tenantId: string, taskId: string) {
    const [row] = await this.present(tenantId, [await this.findScoped(tenantId, taskId)]);
    return row;
  }

  // ==========================================
  // Writes
  // ==========================================

  private async assertProject(tenantId: string, projectId: string | null | undefined) {
    if (!projectId) return null;
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.findOne({ where: { id: projectId, tenantId } });
    if (!project) workspaceError('The selected project was not found.', HttpStatus.BAD_REQUEST);
    if (project.confidential === true && this.projects && !(await this.projects.isVisible(tenantId, projectId))) {
      workspaceError('The selected project was not found.', HttpStatus.BAD_REQUEST);
    }
    return project!;
  }

  /**
   * A task on a project must fall on or between its start and expected end.
   * Returns whether the saved row should keep the authorized-exception flag.
   */
  private dueExceptionFlag(
    project: { startDate?: string | null; dueDate?: string | null } | null,
    dueDate: string,
    exceptionRequested: boolean,
  ) {
    const check = taskDueOutsideProject(dueDate, project);
    if (check.outside && !exceptionRequested) workspaceError(check.message!, HttpStatus.BAD_REQUEST);
    return check.outside;
  }

  private chosenAssignees(ids: string[] | undefined, primary: string | undefined): string[] {
    const source = ids?.length ? ids : primary ? [primary] : [];
    return [...new Set(source.filter(Boolean))];
  }

  /** No saved row means review is off, so tasks complete directly. */
  private async reviewEnabled(tenantId: string): Promise<boolean> {
    const Setting = await this.modelProvider.getWorkspaceSettingModel(tenantId);
    const row = await Setting.findOne({ where: { tenantId }, attributes: ['taskReviewEnabled'] });
    return row?.taskReviewEnabled === true;
  }

  /**
   * Asking to complete a task that needs review, while the organization has
   * review on, parks it for the project owner instead of closing it.
   */
  private async nextStatus(tenantId: string, task: { requiresReview?: boolean | null; reviewStatus?: string | null }, requested: WorkspaceTaskStatus) {
    if (requested !== WorkspaceTaskStatus.COMPLETED) {
      return {
        status: requested,
        completedAt: null as Date | null,
        reviewStatus: task.reviewStatus === 'RETURNED' ? 'RETURNED' : null,
        submittedForReview: false,
      };
    }
    const waiting = (await this.reviewEnabled(tenantId)) && task.requiresReview === true && task.reviewStatus !== 'APPROVED';
    if (waiting) {
      return { status: WorkspaceTaskStatus.IN_PROGRESS, completedAt: null, reviewStatus: 'PENDING' as const, submittedForReview: true };
    }
    return {
      status: WorkspaceTaskStatus.COMPLETED,
      completedAt: new Date(),
      reviewStatus: task.requiresReview ? ('APPROVED' as const) : null,
      submittedForReview: false,
    };
  }

  private async notifyPeople(tenantId: string, employeeIds: string[], title: string, body: string) {
    const self = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
    for (const employeeId of employeeIds) {
      if (self && self === employeeId) continue;
      await notifyEmployee(this.modelProvider, this.logger, tenantId, employeeId, title, body);
    }
  }

  /** The organization's choice about assignment notices. A settings row that cannot be read means "on". */
  private async assignmentNoticesOn(tenantId: string): Promise<boolean> {
    try {
      return (await workspaceNoticePrefs(this.modelProvider, tenantId)).assignmentNotices;
    } catch {
      return true;
    }
  }

  private async notifyAssignees(tenantId: string, task: any, employeeIds: string[], projectName: string | null) {
    if (!(await this.assignmentNoticesOn(tenantId))) return;
    const details = [`Due ${formatDay(task.dueDate)}`, projectName, `${task.priority.charAt(0)}${task.priority.slice(1).toLowerCase()} priority`]
      .filter(Boolean)
      .join(' · ');
    await this.notifyPeople(tenantId, employeeIds, `New task: ${task.title}`, details);
  }

  /**
   * The people already on a project the caller owns: its owner and team. The
   * owner can give them work even when they sit outside the owner's own data
   * scope, since whoever put them on the project has already vouched for them.
   * Empty when the caller does not own the project.
   */
  private async ownedProjectPeople(tenantId: string, projectId: string | null | undefined): Promise<Set<string>> {
    if (!projectId || !this.dataScope) return new Set();
    const me = await this.dataScope.actorEmployeeId(tenantId).catch(() => null);
    if (!me) return new Set();
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project: any = await Project.findOne({ where: { id: projectId, tenantId }, attributes: ['leadEmployeeId'] });
    if (project?.leadEmployeeId !== me) return new Set();
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const members = (await Member.findAll({ where: { tenantId, projectId }, attributes: ['employeeId'], raw: true })) as unknown as {
      employeeId: string;
    }[];
    return new Set([me, ...members.map((row) => row.employeeId)]);
  }

  /** Every id must be a current employee the caller is allowed to assign. */
  private async assertAssignees(tenantId: string, ids: string[], projectId?: string | null) {
    if (!ids.length) workspaceError('Choose at least one assignee.', HttpStatus.BAD_REQUEST);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({
      where: { tenantId, id: { [Op.in]: ids } },
      attributes: ['id', 'status', 'firstName', 'lastName'],
    })) as any[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const onProject = await this.ownedProjectPeople(tenantId, projectId);
    for (const id of ids) {
      const employee = byId.get(id);
      if (!employee) workspaceError('A selected assignee was not found.', HttpStatus.BAD_REQUEST);
      if (!ASSIGNABLE_STATUSES.includes(employee.status)) {
        workspaceError(`${fullName(employee)} is no longer active and can't be assigned work.`, HttpStatus.BAD_REQUEST);
      }
      if (this.dataScope && !onProject.has(id)) await this.dataScope.assertCanSee(tenantId, id, 'Employee');
    }
  }

  /**
   * Replaces the assignee list when `wanted` is sent. Returns who was added.
   * People already on the task are not checked again, so someone who later
   * leaves can stay until they are removed.
   */
  private async replaceAssignees(
    tenantId: string,
    taskId: string,
    primaryId: string,
    wanted: string[] | undefined,
    actorUserId?: string,
    projectId?: string | null,
  ) {
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const current = (await Assignee.findAll({
      where: { tenantId, taskId },
      attributes: ['employeeId'],
      raw: true,
    })) as unknown as { employeeId: string }[];
    const stored = current.map((row) => row.employeeId);
    // A task from before this list existed still counts its primary assignee.
    const baseline = stored.length ? stored : [primaryId];
    const nextIds = wanted ?? baseline;
    if (!nextIds.length) workspaceError('Choose at least one assignee.', HttpStatus.BAD_REQUEST);
    const added = nextIds.filter((id) => !baseline.includes(id));
    const removed = stored.filter((id) => !nextIds.includes(id));
    if (added.length) await this.assertAssignees(tenantId, added, projectId);
    if (removed.length) await Assignee.destroy({ where: { tenantId, taskId, employeeId: { [Op.in]: removed } } });
    if (added.length) {
      await Assignee.bulkCreate(added.map((employeeId) => ({ tenantId, taskId, employeeId, addedByUserId: actorUserId ?? null })));
    }
    await this.refreshReassignmentFlag(tenantId, taskId, [...new Set([primaryId, ...nextIds])]);
    return { added, ids: nextIds };
  }

  /** The flag stays while any current assignee has left. A completed task is never flagged here. */
  private async refreshReassignmentFlag(tenantId: string, taskId: string, employeeIds: string[]) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const people = employeeIds.length
      ? ((await Employee.findAll({
          where: { tenantId, id: { [Op.in]: employeeIds } },
          attributes: ['status'],
        })) as { status?: string }[])
      : [];
    const needs = people.some((person) => person.status === EmployeeStatus.RESIGNED);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    await Task.update({ needsReassignment: needs }, { where: { id: taskId, tenantId } });
  }

  /**
   * Marks this person's open tasks for reassignment. Completed tasks keep
   * their assignee and are not flagged.
   */
  async flagOpenTasksForExit(tenantId: string, employeeId: string): Promise<number> {
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const extras = (await Assignee.findAll({
      where: { tenantId, employeeId },
      attributes: ['taskId'],
      raw: true,
    })) as unknown as { taskId: string }[];
    const extraIds = [...new Set(extras.map((row) => row.taskId))];
    const [count] = await Task.update(
      { needsReassignment: true },
      {
        where: {
          tenantId,
          status: { [Op.ne]: WorkspaceTaskStatus.COMPLETED },
          [Op.or]: [{ assigneeEmployeeId: employeeId }, ...(extraIds.length ? [{ id: { [Op.in]: extraIds } }] : [])],
        },
      },
    );
    return count;
  }

  /** Members cannot change a task once its project is complete. Managers still can. */
  private async assertMemberCanWrite(tenantId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.findOne({ where: { id: projectId, tenantId }, attributes: ['status'] });
    if (project?.status === WorkspaceProjectStatus.COMPLETED) {
      workspaceError('This project is complete, so its tasks are read-only.', HttpStatus.FORBIDDEN);
    }
  }

  async create(tenantId: string, dto: CreateWorkspaceTaskDto, actorUserId?: string) {
    const assigneeIds = this.chosenAssignees(dto.assigneeEmployeeIds, dto.assigneeEmployeeId);
    await this.assertAssignees(tenantId, assigneeIds, dto.projectId);
    const project = await this.assertProject(tenantId, dto.projectId);
    const dueDateException = this.dueExceptionFlag(project, dto.dueDate, dto.dueDateException === true);
    const requiresReview = dto.requiresReview === true;
    const requested = dto.status ?? WorkspaceTaskStatus.PENDING;
    const resolved = await this.nextStatus(tenantId, { requiresReview, reviewStatus: null }, requested);

    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const task = await Task.create({
      tenantId,
      title: dto.title.trim(),
      description: dto.description?.trim() || null,
      projectId: dto.projectId ?? null,
      assigneeEmployeeId: assigneeIds[0],
      dueDate: dto.dueDate,
      dueDateException,
      requiresReview,
      reviewStatus: resolved.reviewStatus,
      priority: dto.priority ?? WorkspaceTaskPriority.NORMAL,
      status: resolved.status,
      completedAt: resolved.completedAt,
      createdByUserId: actorUserId ?? null,
    });
    await this.replaceAssignees(tenantId, task.id, assigneeIds[0], assigneeIds, actorUserId, dto.projectId ?? null);

    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', task.id, 'CREATE', {
      title: { from: null, to: task.title },
      assigneeEmployeeId: { from: null, to: assigneeIds[0] },
      dueDate: { from: null, to: task.dueDate },
    });
    await this.notifyAssignees(tenantId, task, assigneeIds, project?.name ?? null);
    if (resolved.submittedForReview) await this.notifyReview(tenantId, task, project);
    return this.getOne(tenantId, task.id);
  }

  private async notifyReview(tenantId: string, task: any, project: { name?: string; leadEmployeeId?: string | null } | null) {
    if (!project?.leadEmployeeId) return;
    await this.notifyPeople(
      tenantId,
      [project.leadEmployeeId],
      `Task waiting for review: ${task.title}`,
      `This task is ready for your review${project.name ? ` on ${project.name}` : ''}.`,
    );
  }

  async update(tenantId: string, taskId: string, dto: UpdateWorkspaceTaskDto) {
    const task: any = await this.findScoped(tenantId, taskId);
    const project = dto.projectId !== undefined ? await this.assertProject(tenantId, dto.projectId) : null;
    const datesTouched = dto.dueDate !== undefined || dto.projectId !== undefined || dto.dueDateException !== undefined;
    let dueDateException: boolean | undefined;
    if (datesTouched) {
      const dueDate = dto.dueDate ?? task.dueDate;
      const projectId = dto.projectId !== undefined ? dto.projectId : task.projectId;
      const projectForDates = projectId ? (project ?? (await this.assertProject(tenantId, projectId))) : null;
      dueDateException = this.dueExceptionFlag(projectForDates, dueDate, dto.dueDateException ?? task.dueDateException === true);
    }
    const assigneeIds = dto.assigneeEmployeeIds?.length
      ? this.chosenAssignees(dto.assigneeEmployeeIds, undefined)
      : dto.assigneeEmployeeId
        ? [dto.assigneeEmployeeId]
        : undefined;
    const requiresReview = dto.requiresReview === undefined ? task.requiresReview === true : dto.requiresReview === true;
    const resolved = dto.status ? await this.nextStatus(tenantId, { requiresReview, reviewStatus: task.reviewStatus }, dto.status) : null;

    const next: Record<string, unknown> = {
      title: dto.title?.trim(),
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      projectId: dto.projectId === undefined ? undefined : dto.projectId,
      assigneeEmployeeId: assigneeIds?.[0],
      dueDate: dto.dueDate,
      dueDateException,
      requiresReview: dto.requiresReview === undefined ? undefined : requiresReview,
      priority: dto.priority,
      status: resolved?.status,
      completedAt: resolved ? resolved.completedAt : undefined,
      reviewStatus: resolved ? resolved.reviewStatus : undefined,
      deadlineReminderSent: dto.dueDate !== undefined && dto.dueDate !== task.dueDate ? false : undefined,
      overdueReminderSent: dto.dueDate !== undefined && dto.dueDate !== task.dueDate ? false : undefined,
      reviewReminderSent: resolved && resolved.reviewStatus !== 'PENDING' ? false : undefined,
    };
    const changes = diffFields(task.get({ plain: true }), next);
    delete changes.deadlineReminderSent;
    delete changes.overdueReminderSent;
    delete changes.reviewReminderSent;
    const team = assigneeIds
      ? await this.replaceAssignees(
          tenantId,
          taskId,
          task.assigneeEmployeeId,
          assigneeIds,
          undefined,
          dto.projectId !== undefined ? dto.projectId : task.projectId,
        )
      : { added: [] as string[], ids: [task.assigneeEmployeeId] };
    if (!Object.keys(changes).length && !team.added.length) {
      const [row] = await this.present(tenantId, [task]);
      return row;
    }

    if (Object.keys(changes).length) {
      await task.update(Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)));
      await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', task.id, 'UPDATE', changes);
    }
    if (team.added.length) {
      const projectName = project?.name ?? task.project?.name ?? null;
      await this.notifyAssignees(tenantId, { ...task.get({ plain: true }), ...next, priority: next.priority ?? task.priority }, team.added, projectName);
    } else if (changes.dueDate || changes.priority) {
      const what = [changes.dueDate && `now due ${formatDay(String(next.dueDate ?? task.dueDate))}`, changes.priority && `priority ${String(next.priority ?? task.priority).toLowerCase()}`]
        .filter(Boolean)
        .join(', ');
      if (await this.assignmentNoticesOn(tenantId)) {
        await this.notifyPeople(tenantId, team.ids, `Task updated: ${task.title}`, `This task is ${what}.`);
      }
    }
    if (resolved?.submittedForReview) {
      const reviewProject = project ?? (task.projectId ? await this.assertProject(tenantId, task.projectId) : null);
      await this.notifyReview(tenantId, task, reviewProject);
    } else if (resolved?.status === WorkspaceTaskStatus.COMPLETED && task.status !== WorkspaceTaskStatus.COMPLETED) {
      await this.notifyLeadOfCompletion(tenantId, task, await this.actorRecord(tenantId));
    }
    return this.getOne(tenantId, taskId);
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
   * What a person has in Projects & Tasks: tasks they are on (as the main
   * assignee or an extra one) and projects they own. Deleting an employee
   * would otherwise fail on a database rule, or leave a project without an owner.
   */
  async workHistoryOf(tenantId: string, employeeIds: string[]): Promise<{ tasks: number; projectsOwned: number }> {
    if (!employeeIds.length) return { tasks: 0, projectsOwned: 0 };
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const extra = await this.taskIdsForEmployees(tenantId, employeeIds);
    const [tasks, projectsOwned] = await Promise.all([
      Task.count({
        where: {
          tenantId,
          [Op.or]: [{ assigneeEmployeeId: { [Op.in]: employeeIds } }, ...(extra.length ? [{ id: { [Op.in]: extra } }] : [])],
        },
      }),
      Project.count({ where: { tenantId, leadEmployeeId: { [Op.in]: employeeIds } } }),
    ]);
    return { tasks, projectsOwned };
  }

  /** The owners and team members of every project the caller owns. */
  private async peopleOnOwnedProjects(tenantId: string): Promise<string[]> {
    const me = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
    if (!me) return [];
    const owned = await ledProjectIds(this.modelProvider, tenantId, me);
    if (!owned.length) return [];
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const [members, leads] = await Promise.all([
      Member.findAll({ where: { tenantId, projectId: { [Op.in]: owned } }, attributes: ['employeeId'], raw: true }) as unknown as Promise<{ employeeId: string }[]>,
      Project.findAll({ where: { tenantId, id: { [Op.in]: owned } }, attributes: ['leadEmployeeId'], raw: true }) as unknown as Promise<{ leadEmployeeId: string | null }[]>,
    ]);
    return [...new Set([...members.map((row) => row.employeeId), ...leads.map((row) => row.leadEmployeeId).filter(Boolean) as string[]])];
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
    // People on projects the caller owns are theirs to assign work to, wherever they sit.
    const onOwnedProjects = visible ? await this.peopleOnOwnedProjects(tenantId) : [];
    const reachable = visible ? [...new Set([...visible, ...onOwnedProjects])] : null;
    const rows = await Employee.findAll({
      where: {
        tenantId,
        status: { [Op.in]: ASSIGNABLE_STATUSES },
        ...(reachable ? { id: { [Op.in]: reachable } } : {}),
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
    const extra = await this.taskIdsForEmployees(tenantId, [me.id]);
    const rows = await Task.findAll({
      where: {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
        [Op.or]: [{ assigneeEmployeeId: me.id }, ...(extra.length ? [{ id: { [Op.in]: extra } }] : [])],
      },
      include: await this.include(tenantId),
      order: [[literal(STATUS_RANK), 'ASC'], ['dueDate', 'ASC']],
      limit: 200,
    });
    const today = todayIso();
    const assigners = await this.assignerNames(tenantId, rows);
    const presented = await this.present(tenantId, rows, today);
    const data = presented.map((row, index) => ({
      ...row,
      assignedBy: rows[index].createdByUserId ? (assigners.get(rows[index].createdByUserId) ?? 'Management') : null,
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
        blocked: data.filter((t) => t.status === WorkspaceTaskStatus.BLOCKED).length,
        completed: data.filter((t) => t.status === WorkspaceTaskStatus.COMPLETED).length,
        overdue: data.filter((t) => t.overdue).length,
      },
      reviewEnabled: await this.reviewEnabled(tenantId),
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

  /** The caller's employee row, or a stand-in name when this login has none. */
  private async actorRecord(tenantId: string) {
    const actorId = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
    if (!actorId) return { id: null, firstName: 'Someone', lastName: '' };
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    return (
      (await Employee.findOne({ where: { id: actorId, tenantId }, attributes: ['id', 'firstName', 'lastName'] })) ?? {
        id: actorId,
        firstName: 'Someone',
        lastName: '',
      }
    );
  }

  /** An assignee moves their own task along; nothing else about it is theirs to change. */
  async updateMyStatus(tenantId: string, userId: string, email: string | undefined, taskId: string, status: WorkspaceTaskStatus) {
    const me = await findSelfEmployee(this.modelProvider, tenantId, userId, email);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const extra = await this.taskIdsForEmployees(tenantId, [me.id]);
    const task = await Task.findOne({
      where: {
        id: taskId,
        tenantId,
        [Op.or]: [{ assigneeEmployeeId: me.id }, ...(extra.includes(taskId) ? [{ id: taskId }] : [])],
      },
    });
    if (!task) workspaceError('Task not found.', HttpStatus.NOT_FOUND);
    await this.assertMemberCanWrite(tenantId, task.projectId);
    const resolved = await this.nextStatus(tenantId, task!, status);
    if (task!.status !== resolved.status || task!.reviewStatus !== resolved.reviewStatus || task!.completedAt !== resolved.completedAt) {
      const from = task!.status;
      await task!.update({ status: resolved.status, completedAt: resolved.completedAt, reviewStatus: resolved.reviewStatus });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', taskId, 'UPDATE', {
        status: { from, to: resolved.status },
        ...(resolved.submittedForReview ? { reviewStatus: { from: task!.reviewStatus ?? null, to: 'PENDING' } } : {}),
      });
      if (resolved.submittedForReview) {
        const project = task!.projectId ? await this.assertProject(tenantId, task!.projectId) : null;
        await this.notifyReview(tenantId, task, project);
      } else if (resolved.status === WorkspaceTaskStatus.COMPLETED) {
        await this.notifyLeadOfCompletion(tenantId, task, me);
      }
    }
    return this.getOne(tenantId, taskId);
  }

  async getSettings(tenantId: string) {
    const prefs = await workspaceNoticePrefs(this.modelProvider, tenantId);
    return {
      taskReviewEnabled: await this.reviewEnabled(tenantId),
      deadlineRemindersEnabled: prefs.deadlineReminders,
      overdueRemindersEnabled: prefs.overdueReminders,
      reviewRemindersEnabled: prefs.reviewReminders,
      projectStatusNotificationsEnabled: prefs.projectStatusChanges,
      assignmentNotificationsEnabled: prefs.assignmentNotices,
    };
  }

  async updateSettings(
    tenantId: string,
    dto: {
      taskReviewEnabled?: boolean;
      deadlineRemindersEnabled?: boolean;
      overdueRemindersEnabled?: boolean;
      reviewRemindersEnabled?: boolean;
      projectStatusNotificationsEnabled?: boolean;
      assignmentNotificationsEnabled?: boolean;
    },
  ) {
    const Setting = await this.modelProvider.getWorkspaceSettingModel(tenantId);
    const existing = await Setting.findOne({ where: { tenantId } });
    const patch = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
    if (existing) await existing.update(patch);
    else await Setting.create({ tenantId, taskReviewEnabled: false, ...patch });
    return this.getSettings(tenantId);
  }

  /**
   * One pass of deadline, overdue, and still-waiting-for-review notices.
   * Each task is told once. A due-date change or a finished review clears
   * that stamp. Tasks on a completed or cancelled project are skipped.
   * Returns how many notices were sent.
   */
  async sendReminders(tenantId: string, today = todayIso()): Promise<number> {
    const prefs = await workspaceNoticePrefs(this.modelProvider, tenantId);
    if (!prefs.deadlineReminders && !prefs.overdueReminders && !prefs.reviewReminders) return 0;
    const tomorrow = addDays(today, 1);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = (await Task.findAll({
      where: {
        tenantId,
        status: { [Op.ne]: WorkspaceTaskStatus.COMPLETED },
        [Op.or]: [
          { dueDate: tomorrow, deadlineReminderSent: { [Op.not]: true } },
          { dueDate: { [Op.lt]: today }, overdueReminderSent: { [Op.not]: true } },
          { reviewStatus: 'PENDING', reviewReminderSent: { [Op.not]: true } },
        ],
      },
      include: [{ model: Project, as: 'project', attributes: ['id', 'name', 'status', 'leadEmployeeId'], required: false }],
    })) as any[];
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const taskIds = rows.map((row) => row.id);
    const extras = taskIds.length
      ? ((await Assignee.findAll({
          where: { tenantId, taskId: { [Op.in]: taskIds } },
          attributes: ['taskId', 'employeeId'],
          raw: true,
        })) as unknown as { taskId: string; employeeId: string }[])
      : [];
    const extraByTask = new Map<string, string[]>();
    for (const row of extras) {
      const list = extraByTask.get(row.taskId) ?? [];
      list.push(row.employeeId);
      extraByTask.set(row.taskId, list);
    }
    let sent = 0;
    for (const task of rows) {
      const projectStatus = task.project?.status as string | undefined;
      if (projectStatus === WorkspaceProjectStatus.COMPLETED || projectStatus === WorkspaceProjectStatus.CANCELLED) continue;
      const people = [...new Set([task.assigneeEmployeeId, ...(extraByTask.get(task.id) ?? [])].filter(Boolean))];
      const updatedDay = calendarDay(task.updatedAt) ?? today;
      if (prefs.deadlineReminders && task.dueDate === tomorrow && task.deadlineReminderSent !== true) {
        await this.notifyPeople(tenantId, people, `Due tomorrow: ${task.title}`, `This task is due on ${formatDay(task.dueDate)}.`);
        await task.update({ deadlineReminderSent: true });
        sent += 1;
      }
      if (prefs.overdueReminders && task.dueDate && task.dueDate < today && task.overdueReminderSent !== true) {
        const lead = task.project?.leadEmployeeId as string | undefined;
        await this.notifyPeople(
          tenantId,
          [...new Set([...people, ...(lead ? [lead] : [])])],
          `Overdue: ${task.title}`,
          `This task was due on ${formatDay(task.dueDate)} and is still open.`,
        );
        await task.update({ overdueReminderSent: true });
        sent += 1;
      }
      if (
        prefs.reviewReminders &&
        task.reviewStatus === 'PENDING' &&
        task.reviewReminderSent !== true &&
        updatedDay < today &&
        task.project?.leadEmployeeId
      ) {
        await this.notifyPeople(
          tenantId,
          [task.project.leadEmployeeId],
          `Still waiting for review: ${task.title}`,
          `This task is still waiting for your review${task.project.name ? ` on ${task.project.name}` : ''}.`,
        );
        await task.update({ reviewReminderSent: true });
        sent += 1;
      }
    }
    return sent;
  }

  /** The project owner accepts or sends back a task that is waiting for review. */
  async decideReview(tenantId: string, taskId: string, decision: 'APPROVE' | 'RETURN', canManage: boolean) {
    const task: any = await this.findScoped(tenantId, taskId);
    if (task.reviewStatus !== 'PENDING') workspaceError('This task is not waiting for review.', HttpStatus.BAD_REQUEST);
    const actor = await this.actorRecord(tenantId);
    const extra = actor.id ? await this.taskIdsForEmployees(tenantId, [actor.id]) : [];
    if (actor.id && (actor.id === task.assigneeEmployeeId || extra.includes(taskId))) {
      workspaceError("You can't review a task assigned to you.", HttpStatus.FORBIDDEN);
    }
    const project = task.projectId
      ? await (await this.modelProvider.getWorkspaceProjectModel(tenantId)).findOne({
          where: { id: task.projectId, tenantId },
          attributes: ['name', 'leadEmployeeId'],
        })
      : null;
    const isLead = Boolean(actor.id && project?.leadEmployeeId === actor.id);
    if (!canManage && !isLead) workspaceError('Only the project owner can review this task.', HttpStatus.FORBIDDEN);

    const approved = decision === 'APPROVE';
    await task.update({
      status: approved ? WorkspaceTaskStatus.COMPLETED : WorkspaceTaskStatus.IN_PROGRESS,
      completedAt: approved ? new Date() : null,
      reviewStatus: approved ? 'APPROVED' : 'RETURNED',
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', taskId, 'UPDATE', {
      reviewStatus: { from: 'PENDING', to: approved ? 'APPROVED' : 'RETURNED' },
      status: { from: task.status, to: approved ? WorkspaceTaskStatus.COMPLETED : WorkspaceTaskStatus.IN_PROGRESS },
    });
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const rows = (await Assignee.findAll({ where: { tenantId, taskId }, attributes: ['employeeId'], raw: true })) as unknown as { employeeId: string }[];
    const recipients = [...new Set([task.assigneeEmployeeId, ...rows.map((row) => row.employeeId)])];
    await this.notifyPeople(
      tenantId,
      recipients,
      approved ? `Task approved: ${task.title}` : `Task returned: ${task.title}`,
      approved ? 'A reviewer accepted this task.' : 'A reviewer sent this task back.',
    );
    if (approved) await this.notifyLeadOfCompletion(tenantId, task, actor);
    return this.getOne(tenantId, taskId);
  }

  // ==========================================
  // Comments, checklist, attachments
  // Completing a task does not delete any of these.
  // ==========================================

  private async taskForActivity(tenantId: string, taskId: string, scope: 'mine' | 'manage', userId?: string, email?: string) {
    if (scope === 'manage') return this.findScoped(tenantId, taskId);
    const person = await this.personByLogin(tenantId, userId, email);
    if (!person) workspaceError('Your employee profile was not found.', HttpStatus.NOT_FOUND);
    const extra = await this.taskIdsForEmployees(tenantId, [person.id]);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const task = await Task.findOne({
      where: {
        id: taskId,
        tenantId,
        [Op.or]: [{ assigneeEmployeeId: person.id }, ...(extra.includes(taskId) ? [{ id: taskId }] : [])],
      },
    });
    if (!task) workspaceError('Task not found.', HttpStatus.NOT_FOUND);
    await this.assertMemberCanWrite(tenantId, task.projectId);
    return task!;
  }

  private async personByLogin(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    if (userId) {
      const byUser = await Employee.findOne({ where: { tenantId, userId } });
      if (byUser) return byUser;
    }
    if (!email) return null;
    return Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email } } });
  }

  async addComment(tenantId: string, taskId: string, body: string, userId: string, email: string | undefined, scope: 'mine' | 'manage') {
    const text = body.trim();
    if (!text) workspaceError('Write a comment first.', HttpStatus.BAD_REQUEST);
    await this.taskForActivity(tenantId, taskId, scope, userId, email);
    const Comment = await this.modelProvider.getWorkspaceTaskCommentModel(tenantId);
    const count = await Comment.count({ where: { tenantId, taskId } });
    if (count >= 100) workspaceError('This task already has 100 comments.', HttpStatus.BAD_REQUEST);
    const person = await this.personByLogin(tenantId, userId, email);
    await Comment.create({
      tenantId,
      taskId,
      body: text.slice(0, 2000),
      authorUserId: userId,
      authorEmployeeId: person?.id ?? null,
      authorName: person ? fullName(person) : 'Someone',
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', taskId, 'UPDATE', { comment: { from: null, to: 'added' } });
    return this.getOne(tenantId, taskId);
  }

  async deleteComment(tenantId: string, taskId: string, commentId: string, userId: string, canModerate: boolean, scope: 'mine' | 'manage') {
    await this.taskForActivity(tenantId, taskId, scope, userId);
    const Comment = await this.modelProvider.getWorkspaceTaskCommentModel(tenantId);
    const comment = await Comment.findOne({ where: { id: commentId, taskId, tenantId } });
    if (!comment) workspaceError('Comment not found.', HttpStatus.NOT_FOUND);
    if (comment.authorUserId !== userId && !canModerate) workspaceError('You can only delete your own comment.', HttpStatus.FORBIDDEN);
    await comment.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_tasks', taskId, 'UPDATE', { comment: { from: 'present', to: 'removed' } });
    return this.getOne(tenantId, taskId);
  }

  async addChecklistItem(tenantId: string, taskId: string, label: string) {
    const text = label.trim();
    if (!text) workspaceError('Write the checklist line first.', HttpStatus.BAD_REQUEST);
    await this.findScoped(tenantId, taskId);
    const Item = await this.modelProvider.getWorkspaceTaskChecklistItemModel(tenantId);
    const count = await Item.count({ where: { tenantId, taskId } });
    if (count >= 30) workspaceError('A checklist can have 30 lines.', HttpStatus.BAD_REQUEST);
    const last = (await Item.findOne({ where: { tenantId, taskId }, order: [['position', 'DESC']], attributes: ['position'] })) as { position?: number } | null;
    await Item.create({ tenantId, taskId, label: text.slice(0, 200), done: false, position: (last?.position ?? 0) + 1 });
    return this.getOne(tenantId, taskId);
  }

  async updateChecklistItem(
    tenantId: string,
    taskId: string,
    itemId: string,
    patch: { label?: string; done?: boolean },
    scope: 'mine' | 'manage',
    userId?: string,
    email?: string,
  ) {
    await this.taskForActivity(tenantId, taskId, scope, userId, email);
    const Item = await this.modelProvider.getWorkspaceTaskChecklistItemModel(tenantId);
    const item = await Item.findOne({ where: { id: itemId, taskId, tenantId } });
    if (!item) workspaceError('Checklist line not found.', HttpStatus.NOT_FOUND);
    const next: Record<string, unknown> = {};
    if (scope === 'manage' && patch.label !== undefined) {
      const text = patch.label.trim();
      if (!text) workspaceError('Write the checklist line first.', HttpStatus.BAD_REQUEST);
      next.label = text.slice(0, 200);
    }
    if (patch.done !== undefined) next.done = patch.done;
    if (Object.keys(next).length) await item.update(next);
    return this.getOne(tenantId, taskId);
  }

  async deleteChecklistItem(tenantId: string, taskId: string, itemId: string) {
    await this.findScoped(tenantId, taskId);
    const Item = await this.modelProvider.getWorkspaceTaskChecklistItemModel(tenantId);
    const removed = await Item.destroy({ where: { id: itemId, taskId, tenantId } });
    if (!removed) workspaceError('Checklist line not found.', HttpStatus.NOT_FOUND);
    return this.getOne(tenantId, taskId);
  }

  async addAttachment(
    tenantId: string,
    taskId: string,
    file: { fileId: string; fileName: string; mimeType?: string | null; sizeBytes?: number | null },
    userId: string,
    email: string | undefined,
    scope: 'mine' | 'manage',
  ) {
    await this.taskForActivity(tenantId, taskId, scope, userId, email);
    const Attachment = await this.modelProvider.getWorkspaceTaskAttachmentModel(tenantId);
    const count = await Attachment.count({ where: { tenantId, taskId } });
    if (count >= 10) workspaceError('A task can have 10 attachments.', HttpStatus.BAD_REQUEST);
    const existing = await Attachment.findOne({ where: { tenantId, taskId, fileId: file.fileId } });
    if (!existing) {
      await Attachment.create({
        tenantId,
        taskId,
        fileId: file.fileId,
        fileName: file.fileName.slice(0, 255),
        mimeType: file.mimeType ?? null,
        sizeBytes: file.sizeBytes ?? null,
        uploadedByUserId: userId,
      });
    }
    return this.getOne(tenantId, taskId);
  }

  async deleteAttachment(tenantId: string, taskId: string, attachmentId: string, userId: string, canModerate: boolean, scope: 'mine' | 'manage') {
    await this.taskForActivity(tenantId, taskId, scope, userId);
    const Attachment = await this.modelProvider.getWorkspaceTaskAttachmentModel(tenantId);
    const row = await Attachment.findOne({ where: { id: attachmentId, taskId, tenantId } });
    if (!row) workspaceError('Attachment not found.', HttpStatus.NOT_FOUND);
    if (row.uploadedByUserId !== userId && !canModerate) workspaceError('You can only remove a file you uploaded.', HttpStatus.FORBIDDEN);
    const fileId = row.fileId as string;
    await row.destroy();
    return { task: await this.getOne(tenantId, taskId), fileId };
  }

  /** Confirms the caller may open the file, then returns the stored file id for the gateway to stream. */
  async attachmentFile(tenantId: string, taskId: string, attachmentId: string, userId: string, email: string | undefined, scope: 'mine' | 'manage') {
    await this.taskForActivity(tenantId, taskId, scope, userId, email);
    const Attachment = await this.modelProvider.getWorkspaceTaskAttachmentModel(tenantId);
    const row = await Attachment.findOne({ where: { id: attachmentId, taskId, tenantId } });
    if (!row) workspaceError('Attachment not found.', HttpStatus.NOT_FOUND);
    return { fileId: row.fileId as string, fileName: row.fileName as string, mimeType: (row.mimeType as string | null) ?? null };
  }
}
