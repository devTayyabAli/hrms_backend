import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, Sequelize, WhereOptions, literal } from 'sequelize';
import {
  CreateWorkspaceProjectDto,
  EXPORT_MAX_ROWS,
  EmployeeStatus,
  ExportResult,
  GetWorkspaceProjectsQueryDto,
  UpdateWorkspaceProjectDto,
  WorkspaceProjectPriority,
  WorkspaceProjectStatus,
  WorkspaceTaskStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import {
  diffFields,
  employeeInclude,
  employeeSummary,
  fullName,
  involvedProjectIds,
  notifyEmployee,
  seesConfidentialProjects,
  todayIso,
  workspaceError,
  workspaceNoticePrefs,
} from './workspace-shared';

/** Projects are an organization-level list, kept small enough to return whole. */
const MAX_PROJECTS = 500;

/** Someone who still works here. A resigned or inactive employee cannot own or join a project. */
const ASSIGNABLE = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

export interface WorkspaceProjectRow {
  id: string;
  name: string;
  client: string | null;
  description: string | null;
  lead: ReturnType<typeof employeeSummary>;
  /** Team besides the owner. Empty when the owner is the only person on it. */
  members: NonNullable<ReturnType<typeof employeeSummary>>[];
  department: { id: string; name: string } | null;
  status: WorkspaceProjectStatus;
  priority: WorkspaceProjectPriority;
  startDate: string | null;
  /** Expected end. */
  dueDate: string | null;
  location: string | null;
  tags: string[];
  milestone: string | null;
  confidential: boolean;
  /** 0–100: share of the project's tasks that are completed. */
  progress: number;
  totalTasks: number;
  openTasks: number;
  overdueTasks: number;
  createdAt: Date;
}

type TaskTally = { total: number; completed: number; overdue: number };

/**
 * Workspace › Projects. Progress and task counts are computed from the
 * project's tasks on every read rather than stored, so a project card always
 * agrees with the task list behind it.
 *
 * A scoped role (Department Head, Team Lead) reaches a project when its
 * owner is someone they reach, a team member is, or it holds a task assigned
 * to someone they reach. The list, the KPI counts, the picker and a single
 * project all use that same limit.
 */
@Injectable()
export class WorkspaceProjectService {
  private readonly logger = new Logger(WorkspaceProjectService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  /**
   * A `where` fragment limiting projects to the caller's data scope — `{}`
   * for organization-wide callers.
   */
  private async scopeWhere(tenantId: string): Promise<WhereOptions> {
    const visible = this.dataScope ? await this.dataScope.visibleEmployeeIds(tenantId) : null;
    const reach = await this.confidentialWhere(tenantId);
    if (visible === null) return reach ?? {};
    if (!visible.length) return { id: null };
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const [withTasks, withMembers, assigneeRows] = await Promise.all([
      Task.findAll({
        where: { tenantId, assigneeEmployeeId: { [Op.in]: visible }, projectId: { [Op.ne]: null } },
        attributes: [[Sequelize.fn('DISTINCT', Sequelize.col('projectId')), 'projectId']],
        raw: true,
      }) as unknown as Promise<{ projectId: string }[]>,
      Member.findAll({
        where: { tenantId, employeeId: { [Op.in]: visible } },
        attributes: [[Sequelize.fn('DISTINCT', Sequelize.col('projectId')), 'projectId']],
        raw: true,
      }) as unknown as Promise<{ projectId: string }[]>,
      Assignee.findAll({
        where: { tenantId, employeeId: { [Op.in]: visible } },
        attributes: ['taskId'],
        raw: true,
      }) as unknown as Promise<{ taskId: string }[]>,
    ]);
    const extraTaskIds = [...new Set(assigneeRows.map((row) => row.taskId))];
    const extraProjects = extraTaskIds.length
      ? ((await Task.findAll({
          where: { tenantId, id: { [Op.in]: extraTaskIds }, projectId: { [Op.ne]: null } },
          attributes: [[Sequelize.fn('DISTINCT', Sequelize.col('projectId')), 'projectId']],
          raw: true,
        })) as unknown as { projectId: string }[])
      : [];
    const projectIds = [...new Set([...withTasks, ...withMembers, ...extraProjects].map((row) => row.projectId))];
    const dataScope = {
      [Op.or]: [
        { leadEmployeeId: { [Op.in]: visible } },
        ...(projectIds.length ? [{ id: { [Op.in]: projectIds } }] : []),
      ],
    };
    return reach ? { [Op.and]: [dataScope, reach] } : dataScope;
  }

  /**
   * Confidential projects are visible to someone with the grant, and to the
   * owner, a member, or an assignee. Everyone else does not see them.
   * Null and false are ordinary projects.
   */
  private async confidentialWhere(tenantId: string): Promise<WhereOptions | null> {
    if (seesConfidentialProjects()) return null;
    const me = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId) : null;
    const mine = me ? await involvedProjectIds(this.modelProvider, tenantId, me) : [];
    return {
      [Op.or]: [
        { confidential: { [Op.not]: true } },
        { confidential: null },
        ...(mine.length ? [{ id: { [Op.in]: mine } }] : []),
      ],
    };
  }

  /** Used when a task is pointed at a project the caller may not know about. */
  async isVisible(tenantId: string, projectId: string): Promise<boolean> {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const row = await Project.findOne({
      where: { [Op.and]: [{ id: projectId, tenantId }, await this.scopeWhere(tenantId)] },
      attributes: ['id'],
    });
    return Boolean(row);
  }

  private async include(tenantId: string) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    return [
      await employeeInclude(this.modelProvider, tenantId, 'lead'),
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
    ];
  }

  /** One grouped query for every project's task counts. */
  private async taskTallies(tenantId: string, projectIds: string[]): Promise<Map<string, TaskTally>> {
    const tallies = new Map<string, TaskTally>();
    if (!projectIds.length) return tallies;
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const rows = (await Task.findAll({
      where: { tenantId, projectId: { [Op.in]: projectIds } },
      attributes: [
        'projectId',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'total'],
        [Sequelize.fn('SUM', literal(`CASE WHEN "status" = 'COMPLETED' THEN 1 ELSE 0 END`)), 'completed'],
        [
          Sequelize.fn('SUM', literal(`CASE WHEN "status" <> 'COMPLETED' AND "dueDate" < '${todayIso()}' THEN 1 ELSE 0 END`)),
          'overdue',
        ],
      ],
      group: ['projectId'],
      raw: true,
    })) as unknown as { projectId: string; total: string; completed: string; overdue: string }[];
    for (const row of rows) {
      tallies.set(row.projectId, { total: Number(row.total), completed: Number(row.completed), overdue: Number(row.overdue) });
    }
    return tallies;
  }

  private async membersByProject(tenantId: string, projectIds: string[]) {
    const grouped = new Map<string, NonNullable<ReturnType<typeof employeeSummary>>[]>();
    if (!projectIds.length) return grouped;
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const rows = (await Member.findAll({
      where: { tenantId, projectId: { [Op.in]: projectIds } },
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
      const list = grouped.get(row.projectId) ?? [];
      list.push(person);
      grouped.set(row.projectId, list);
    }
    for (const list of grouped.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return grouped;
  }

  private toRow(
    project: any,
    tally: TaskTally | undefined,
    members: NonNullable<ReturnType<typeof employeeSummary>>[] = [],
  ): WorkspaceProjectRow {
    const total = tally?.total ?? 0;
    const completed = tally?.completed ?? 0;
    const progress = total
      ? Math.round((completed / total) * 100)
      : project.status === WorkspaceProjectStatus.COMPLETED
        ? 100
        : 0;
    return {
      id: project.id,
      name: project.name,
      client: project.client ?? null,
      description: project.description ?? null,
      lead: employeeSummary(project.lead),
      members,
      department: project.department ? { id: project.department.id, name: project.department.name } : null,
      status: project.status,
      priority: project.priority ?? WorkspaceProjectPriority.MEDIUM,
      startDate: project.startDate ?? null,
      dueDate: project.dueDate ?? null,
      location: project.location ?? null,
      tags: Array.isArray(project.tags) ? project.tags : [],
      milestone: project.milestone ?? null,
      confidential: project.confidential === true,
      progress,
      totalTasks: total,
      openTasks: total - completed,
      overdueTasks: tally?.overdue ?? 0,
      createdAt: project.createdAt,
    };
  }

  /**
   * The projects one employee is part of: those they own, those they are a
   * team member of, and those holding a task assigned to them.
   */
  async getForEmployee(tenantId: string, employeeId: string, myTaskProjectIds: string[]) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const memberships = (await Member.findAll({
      where: { tenantId, employeeId },
      attributes: ['projectId'],
      raw: true,
    })) as unknown as { projectId: string }[];
    const memberProjectIds = memberships.map((row) => row.projectId);
    const involved = [...new Set([...myTaskProjectIds, ...memberProjectIds])];
    const rows = await Project.findAll({
      where: {
        tenantId,
        [Op.or]: [{ leadEmployeeId: employeeId }, ...(involved.length ? [{ id: { [Op.in]: involved } }] : [])],
      },
      include: await this.include(tenantId),
      order: [['dueDate', 'ASC NULLS LAST'], ['name', 'ASC']],
      limit: 100,
    });
    const ids = rows.map((r) => r.id);
    const [tallies, members] = await Promise.all([this.taskTallies(tenantId, ids), this.membersByProject(tenantId, ids)]);
    return rows.map((r) => ({
      ...this.toRow(r, tallies.get(r.id), members.get(r.id) ?? []),
      isLead: r.leadEmployeeId === employeeId,
      isMember: memberProjectIds.includes(r.id),
    }));
  }

  private where(tenantId: string, query: GetWorkspaceProjectsQueryDto) {
    const and: any[] = [{ tenantId }];
    if (query.status) and.push({ status: query.status });
    const search = query.search?.trim();
    if (search) {
      const like = `%${search}%`;
      and.push({
        [Op.or]: [
          { name: { [Op.iLike]: like } },
          { client: { [Op.iLike]: like } },
          Sequelize.where(Sequelize.fn('concat', Sequelize.col('lead.firstName'), ' ', Sequelize.col('lead.lastName')), {
            [Op.iLike]: like,
          }),
        ],
      });
    }
    return { [Op.and]: and };
  }

  // ==========================================
  // Reads
  // ==========================================

  /** The filtered cards, plus status counts across the caller's projects (the KPI row). */
  async getAll(tenantId: string, query: GetWorkspaceProjectsQueryDto) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const scope = await this.scopeWhere(tenantId);
    const [rows, byStatus] = await Promise.all([
      Project.findAll({
        where: { [Op.and]: [this.where(tenantId, query), scope] },
        include: await this.include(tenantId),
        // Live work first, then the nearest deadline.
        order: [
          [literal(`CASE "WorkspaceProject"."status" WHEN 'AT_RISK' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'PLANNED' THEN 2 WHEN 'ON_HOLD' THEN 3 WHEN 'COMPLETED' THEN 4 ELSE 5 END`), 'ASC'],
          [literal(`"WorkspaceProject"."dueDate" IS NULL`), 'ASC'],
          ['dueDate', 'ASC'],
          ['name', 'ASC'],
        ],
        limit: MAX_PROJECTS,
        subQuery: false,
      }),
      Project.count({ where: { [Op.and]: [{ tenantId }, scope] }, group: ['status'] }) as unknown as Promise<
        { status: string; count: number }[]
      >,
    ]);

    const ids = rows.map((r) => r.id);
    const [tallies, members] = await Promise.all([this.taskTallies(tenantId, ids), this.membersByProject(tenantId, ids)]);
    const count = (status: WorkspaceProjectStatus) => Number(byStatus.find((s) => s.status === status)?.count ?? 0);
    return {
      data: rows.map((r) => this.toRow(r, tallies.get(r.id), members.get(r.id) ?? [])),
      stats: {
        total: byStatus.reduce((sum, s) => sum + Number(s.count), 0),
        active: count(WorkspaceProjectStatus.ACTIVE),
        onHold: count(WorkspaceProjectStatus.ON_HOLD),
        atRisk: count(WorkspaceProjectStatus.AT_RISK),
        completed: count(WorkspaceProjectStatus.COMPLETED),
        planned: count(WorkspaceProjectStatus.PLANNED),
        cancelled: count(WorkspaceProjectStatus.CANCELLED),
      },
    };
  }

  /** The caller's projects, for the task form's project picker. */
  async getOptions(tenantId: string) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = await Project.findAll({
      where: { [Op.and]: [{ tenantId }, await this.scopeWhere(tenantId)] },
      attributes: ['id', 'name', 'status', 'startDate', 'dueDate'],
      order: [['name', 'ASC']],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      startDate: r.startDate ?? null,
      dueDate: r.dueDate ?? null,
    }));
  }

  async getAllForExport(tenantId: string, query: GetWorkspaceProjectsQueryDto): Promise<ExportResult<WorkspaceProjectRow>> {
    const { data } = await this.getAll(tenantId, query);
    const rows = data.slice(0, EXPORT_MAX_ROWS);
    return { rows, totalMatched: data.length, truncated: data.length > rows.length, limit: EXPORT_MAX_ROWS };
  }

  /** The project, if it exists and is inside the caller's scope; otherwise it doesn't exist for them. */
  private async findOwn(tenantId: string, projectId: string) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.findOne({
      where: { [Op.and]: [{ id: projectId, tenantId }, await this.scopeWhere(tenantId)] },
      include: await this.include(tenantId),
    });
    if (!project) workspaceError('Project not found.', HttpStatus.NOT_FOUND);
    return project!;
  }

  private async getOne(tenantId: string, projectId: string) {
    const project = await this.findOwn(tenantId, projectId);
    const [tallies, members] = await Promise.all([
      this.taskTallies(tenantId, [projectId]),
      this.membersByProject(tenantId, [projectId]),
    ]);
    return this.toRow(project, tallies.get(projectId), members.get(projectId) ?? []);
  }

  // ==========================================
  // Writes
  // ==========================================

  /** The lead must exist and be inside the caller's scope; returns their department for the default. */
  private async leadDepartment(tenantId: string, leadEmployeeId: string | null | undefined): Promise<string | null> {
    if (!leadEmployeeId) return null;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const lead = await Employee.findOne({
      where: { id: leadEmployeeId, tenantId },
      attributes: ['id', 'departmentId', 'status', 'firstName', 'lastName'],
    });
    if (!lead) workspaceError('The selected project owner was not found.', HttpStatus.BAD_REQUEST);
    if (!ASSIGNABLE.includes(lead.status)) {
      workspaceError(`${fullName(lead)} no longer works here and can't own a project.`, HttpStatus.BAD_REQUEST);
    }
    if (this.dataScope && !(await this.dataScope.canSee(tenantId, leadEmployeeId))) {
      workspaceError('The selected project owner was not found.', HttpStatus.BAD_REQUEST);
    }
    return lead.departmentId ?? null;
  }

  /** The owner is stored on the project, so they are not also a team row. */
  private chosenMembers(ids: string[] | undefined, ownerId: string): string[] {
    return [...new Set((ids ?? []).filter((id) => id && id !== ownerId))];
  }

  /** Every id must be a current employee the caller is allowed to assign. */
  private async assertMembers(tenantId: string, ids: string[]) {
    if (!ids.length) return;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({
      where: { tenantId, id: { [Op.in]: ids } },
      attributes: ['id', 'status', 'firstName', 'lastName'],
    })) as any[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids) {
      const employee = byId.get(id);
      if (!employee || (this.dataScope && !(await this.dataScope.canSee(tenantId, id)))) {
        workspaceError('A selected team member was not found.', HttpStatus.BAD_REQUEST);
      }
      if (!ASSIGNABLE.includes(employee.status)) {
        workspaceError(`${fullName(employee)} no longer works here and can't join a project.`, HttpStatus.BAD_REQUEST);
      }
    }
  }

  /**
   * Replaces the team when `memberEmployeeIds` is sent. Omit it and the team
   * stays. Returns who was newly added, so only they are notified.
   */
  private async replaceMembers(
    tenantId: string,
    projectId: string,
    ownerId: string,
    memberEmployeeIds: string[] | undefined,
    actorUserId?: string,
  ) {
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    if (memberEmployeeIds === undefined) {
      // The owner is not also a team row. Promoting a member drops that row.
      const dropped = await Member.destroy({ where: { tenantId, projectId, employeeId: ownerId } });
      return { added: [] as string[], removed: dropped ? [ownerId] : [] };
    }
    const wanted = this.chosenMembers(memberEmployeeIds, ownerId);
    const current = (await Member.findAll({
      where: { tenantId, projectId },
      attributes: ['employeeId'],
      raw: true,
    })) as unknown as { employeeId: string }[];
    const currentIds = current.map((row) => row.employeeId);
    const added = wanted.filter((id) => !currentIds.includes(id));
    const removed = currentIds.filter((id) => !wanted.includes(id));
    await this.assertMembers(tenantId, added);
    if (removed.length) await Member.destroy({ where: { tenantId, projectId, employeeId: { [Op.in]: removed } } });
    if (added.length) {
      await Member.bulkCreate(
        added.map((employeeId) => ({ tenantId, projectId, employeeId, addedByUserId: actorUserId ?? null })),
      );
    }
    return { added, removed };
  }

  private async notifyAdded(tenantId: string, projectName: string, employeeIds: string[]) {
    if (!employeeIds.length) return;
    try {
      if (!(await workspaceNoticePrefs(this.modelProvider, tenantId)).assignmentNotices) return;
    } catch {
      // A settings row that cannot be read means the notice is on.
    }
    const self = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
    for (const employeeId of employeeIds) {
      if (self && self === employeeId) continue;
      await notifyEmployee(
        this.modelProvider,
        this.logger,
        tenantId,
        employeeId,
        'Added to a project',
        `You were added to ${projectName}.`,
      );
    }
  }

  /** Start must not fall after the expected end. Either date may be empty. */
  private assertSchedule(startDate?: string | null, dueDate?: string | null) {
    if (startDate && dueDate && startDate > dueDate) {
      workspaceError('The expected end date cannot be earlier than the start date.', HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * Trim, drop blanks, and keep the first spelling of a repeated tag.
   * `undefined` means the caller did not send tags.
   */
  private cleanTags(tags: string[] | null | undefined): string[] | undefined {
    if (tags == null) return tags === null ? [] : undefined;
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of tags) {
      const tag = raw.trim().replace(/\s+/g, ' ');
      if (!tag) continue;
      if (tag.length > 40) workspaceError('A tag can be at most 40 characters.', HttpStatus.BAD_REQUEST);
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(tag);
      if (cleaned.length > 20) workspaceError('A project can have at most 20 tags.', HttpStatus.BAD_REQUEST);
    }
    return cleaned;
  }

  private async assertDepartment(tenantId: string, departmentId: string | null | undefined) {
    if (!departmentId) return;
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    if (!(await Department.findOne({ where: { id: departmentId, tenantId }, attributes: ['id'] }))) {
      workspaceError('The selected department was not found.', HttpStatus.BAD_REQUEST);
    }
  }

  private async assertUniqueName(tenantId: string, name: string, exceptId?: string) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const clash = await Project.findOne({
      where: { tenantId, name: { [Op.iLike]: name }, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
      attributes: ['id'],
    });
    if (clash) workspaceError(`A project named "${name}" already exists.`, HttpStatus.CONFLICT);
  }

  async create(tenantId: string, dto: CreateWorkspaceProjectDto, actorUserId?: string) {
    const name = dto.name.trim();
    await this.assertUniqueName(tenantId, name);
    if (!dto.leadEmployeeId) workspaceError('Choose a project owner.', HttpStatus.BAD_REQUEST);
    const members = this.chosenMembers(dto.memberEmployeeIds, dto.leadEmployeeId);
    await this.assertMembers(tenantId, members);
    const leadDepartmentId = await this.leadDepartment(tenantId, dto.leadEmployeeId);
    await this.assertDepartment(tenantId, dto.departmentId);
    const startDate = dto.startDate ?? null;
    const dueDate = dto.dueDate ?? null;
    this.assertSchedule(startDate, dueDate);
    const tags = this.cleanTags(dto.tags) ?? [];
    if (dto.confidential === true && !seesConfidentialProjects()) {
      workspaceError('Marking a project confidential needs the Confidential permission.', HttpStatus.FORBIDDEN);
    }

    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.create({
      tenantId,
      name,
      client: dto.client?.trim() || null,
      description: dto.description?.trim() || null,
      leadEmployeeId: dto.leadEmployeeId,
      departmentId: dto.departmentId ?? leadDepartmentId,
      status: dto.status ?? WorkspaceProjectStatus.ACTIVE,
      priority: dto.priority ?? WorkspaceProjectPriority.MEDIUM,
      startDate,
      dueDate,
      location: dto.location?.trim() || null,
      tags,
      milestone: dto.milestone?.trim() || null,
      confidential: dto.confidential === true,
      createdByUserId: actorUserId ?? null,
    });
    const team = await this.replaceMembers(tenantId, project.id, dto.leadEmployeeId, members, actorUserId);
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_projects', project.id, 'CREATE', {
      name: { from: null, to: project.name },
      leadEmployeeId: { from: null, to: dto.leadEmployeeId },
      ...(team.added.length ? { members: { from: null, to: team.added } } : {}),
    });
    await this.notifyAdded(tenantId, project.name, team.added);
    return this.getOne(tenantId, project.id);
  }

  /**
   * Incomplete and blocked tasks on a project. Closing shows these first.
   * Closing does not complete or delete them.
   */
  async openWork(tenantId: string, projectId: string) {
    await this.findOwn(tenantId, projectId);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Task.findAll({
      where: { tenantId, projectId, status: { [Op.ne]: WorkspaceTaskStatus.COMPLETED } },
      attributes: ['id', 'title', 'status'],
      include: [{ model: Employee, as: 'assignee', attributes: ['firstName', 'lastName'], required: false }],
    })) as any[];
    const line = (row: any) => ({
      id: row.id as string,
      title: row.title as string,
      status: row.status as string,
      assigneeName: fullName(row.assignee) || null,
    });
    return {
      incomplete: rows.filter((row) => row.status !== WorkspaceTaskStatus.BLOCKED).map(line),
      blocked: rows.filter((row) => row.status === WorkspaceTaskStatus.BLOCKED).map(line),
    };
  }

  async update(tenantId: string, projectId: string, dto: UpdateWorkspaceProjectDto, actorUserId?: string, canReopen = false) {
    const project: any = await this.findOwn(tenantId, projectId);
    const closing = dto.status === WorkspaceProjectStatus.COMPLETED && project.status !== WorkspaceProjectStatus.COMPLETED;
    const reopening =
      project.status === WorkspaceProjectStatus.COMPLETED && dto.status !== undefined && dto.status !== WorkspaceProjectStatus.COMPLETED;
    if (reopening && !canReopen) {
      workspaceError('Reopening a completed project needs the Reopen permission.', HttpStatus.FORBIDDEN);
    }
    if (closing) {
      const open = await this.openWork(tenantId, projectId);
      if ((open.incomplete.length || open.blocked.length) && dto.acknowledgeOpenTasks !== true) {
        workspaceError(
          'This project still has tasks that are not complete. Review the incomplete and blocked tasks, then close it again.',
          HttpStatus.CONFLICT,
        );
      }
    }
    if (!dto.leadEmployeeId && !project.leadEmployeeId) workspaceError('Choose a project owner.', HttpStatus.BAD_REQUEST);
    if (dto.name && dto.name.trim().toLowerCase() !== project.name.toLowerCase()) {
      await this.assertUniqueName(tenantId, dto.name.trim(), projectId);
    }
    const ownerId = dto.leadEmployeeId ?? project.leadEmployeeId;
    let departmentId = dto.departmentId;
    if (dto.leadEmployeeId && dto.leadEmployeeId !== project.leadEmployeeId) {
      const leadDepartmentId = await this.leadDepartment(tenantId, dto.leadEmployeeId);
      // A new owner brings their department, unless one was picked explicitly.
      if (departmentId === undefined) departmentId = leadDepartmentId ?? project.departmentId;
    }
    await this.assertDepartment(tenantId, departmentId);
    const startDate = dto.startDate !== undefined ? dto.startDate : project.startDate;
    const dueDate = dto.dueDate !== undefined ? dto.dueDate : project.dueDate;
    this.assertSchedule(startDate, dueDate);
    const turningOn = dto.confidential === true && project.confidential !== true;
    const turningOff = dto.confidential === false && project.confidential === true;
    if ((turningOn || turningOff) && !seesConfidentialProjects()) {
      workspaceError('Marking a project confidential needs the Confidential permission.', HttpStatus.FORBIDDEN);
    }
    const tags = this.cleanTags(dto.tags);
    const tagsUnchanged = tags === undefined || JSON.stringify(tags) === JSON.stringify(project.tags ?? []);

    const next: Record<string, unknown> = {
      name: dto.name?.trim(),
      client: dto.client === undefined ? undefined : dto.client?.trim() || null,
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      leadEmployeeId: dto.leadEmployeeId,
      departmentId,
      status: dto.status,
      priority: dto.priority,
      startDate: dto.startDate,
      dueDate: dto.dueDate,
      location: dto.location === undefined ? undefined : dto.location?.trim() || null,
      tags: tagsUnchanged ? undefined : tags,
      milestone: dto.milestone === undefined ? undefined : dto.milestone?.trim() || null,
      confidential: dto.confidential,
    };
    const changes = diffFields(project.get({ plain: true }), next);
    if (reopening && dto.status) changes.reopened = { from: WorkspaceProjectStatus.COMPLETED, to: dto.status };
    if (Object.keys(changes).length) {
      await project.update(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
      await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_projects', projectId, 'UPDATE', changes);
    }
    const team = await this.replaceMembers(tenantId, projectId, ownerId, dto.memberEmployeeIds, actorUserId);
    if (team.added.length || team.removed.length) {
      await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_projects', projectId, 'UPDATE', {
        members: { from: team.removed, to: team.added },
      });
      await this.notifyAdded(tenantId, project.name, team.added);
    }
    const name = (dto.name ?? project.name) as string;
    const lead = (dto.leadEmployeeId ?? project.leadEmployeeId) as string | null;
    if (closing) await this.notifyCompleted(tenantId, name, lead, projectId);
    else if (changes.status && dto.status) {
      const prefs = await workspaceNoticePrefs(this.modelProvider, tenantId);
      if (prefs.projectStatusChanges) await this.notifyStatusChanged(tenantId, name, lead, projectId, dto.status);
    }
    return this.getOne(tenantId, projectId);
  }

  /** Owner and members hear a status change other than closing. Closing has its own notice. */
  private async notifyStatusChanged(
    tenantId: string,
    projectName: string,
    leadEmployeeId: string | null,
    projectId: string,
    status: WorkspaceProjectStatus,
  ) {
    const labels: Record<string, string> = {
      PLANNED: 'Planned',
      ACTIVE: 'Active',
      ON_HOLD: 'On hold',
      AT_RISK: 'At risk',
      COMPLETED: 'Completed',
      CANCELLED: 'Cancelled',
    };
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const rows = (await Member.findAll({
      where: { tenantId, projectId },
      attributes: ['employeeId'],
      raw: true,
    })) as unknown as { employeeId: string }[];
    const recipients = [...new Set([leadEmployeeId, ...rows.map((row) => row.employeeId)].filter((id): id is string => Boolean(id)))];
    const self = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
    for (const employeeId of recipients) {
      if (self && self === employeeId) continue;
      await notifyEmployee(
        this.modelProvider,
        this.logger,
        tenantId,
        employeeId,
        `Project update: ${projectName}`,
        `${projectName} is now ${labels[status] ?? status}.`,
      );
    }
  }

  /** The owner and team members hear that the project was closed. The actor is skipped. */
  private async notifyCompleted(tenantId: string, projectName: string, leadEmployeeId: string | null, projectId: string) {
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const rows = (await Member.findAll({
      where: { tenantId, projectId },
      attributes: ['employeeId'],
      raw: true,
    })) as unknown as { employeeId: string }[];
    const recipients = [...new Set([leadEmployeeId, ...rows.map((row) => row.employeeId)].filter((id): id is string => Boolean(id)))];
    const self = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
    for (const employeeId of recipients) {
      if (self && self === employeeId) continue;
      await notifyEmployee(
        this.modelProvider,
        this.logger,
        tenantId,
        employeeId,
        `Project completed: ${projectName}`,
        `${projectName} is complete. Open tasks on it were left as they are.`,
      );
    }
  }

  /** The project's tasks are kept, without a project. Team rows go with the project. */
  async remove(tenantId: string, projectId: string) {
    const project = await this.findOwn(tenantId, projectId);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const [unlinked] = await Task.update({ projectId: null }, { where: { tenantId, projectId } });
    await Member.destroy({ where: { tenantId, projectId } });
    await project.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_projects', projectId, 'DELETE', {
      name: { from: project.name, to: null },
      unlinkedTasks: { from: unlinked, to: 0 },
    });
    return { success: true, unlinkedTasks: unlinked };
  }
}
