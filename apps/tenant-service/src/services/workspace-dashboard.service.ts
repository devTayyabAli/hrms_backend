import { Injectable, Optional } from '@nestjs/common';
import { Op, Sequelize, literal } from 'sequelize';
import { DataScope, WorkspaceProjectStatus, WorkspaceTaskStatus } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { addDays, findSelfEmployee, involvedProjectIds, seesConfidentialProjects, todayIso } from './workspace-shared';

const LIST_LIMIT = 8;

export interface WorkspaceDashboardProject {
  id: string;
  name: string;
  status: string;
  progress: number;
  openTasks: number;
  overdue: number;
}

export interface WorkspaceDashboardTask {
  id: string;
  title: string;
  projectName: string | null;
  dueDate: string | null;
  completedAt: string | null;
  overdue: boolean;
}

export interface WorkspaceDashboardPerson {
  id: string;
  name: string;
  open: number;
  overdue: number;
}

export interface WorkspaceDashboardDepartment {
  id: string;
  name: string;
  activeProjects: number;
  completedProjects: number;
  openTasks: number;
  completedTasks: number;
  overdue: number;
}

/**
 * One payload for every audience. Lists the caller does not need are empty,
 * so the screen can switch on `kind` without a second request.
 */
export interface WorkspaceDashboard {
  kind: 'employee' | 'manager' | 'department' | 'organization';
  projects: WorkspaceDashboardProject[];
  openTasks: number;
  pending: number;
  inProgress: number;
  blocked: number;
  completed: number;
  overdue: number;
  dueSoon: number;
  needsReassignment: number;
  deadlines: WorkspaceDashboardTask[];
  recentlyCompleted: WorkspaceDashboardTask[];
  workload: WorkspaceDashboardPerson[];
  departments: WorkspaceDashboardDepartment[];
  /** Distinct people who have a task, and who still have one open. */
  participation: { peopleWithTasks: number; peopleWithOpenTasks: number };
  /** Department view: projects that are not completed or cancelled, and those that are completed. */
  activeProjects: number;
  completedProjects: number;
}

interface SlimTask {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  completedAt: Date | string | null;
  projectId: string | null;
  assigneeEmployeeId: string | null;
  needsReassignment: boolean | null;
  project?: { name?: string | null } | null;
}

const empty = (kind: WorkspaceDashboard['kind']): WorkspaceDashboard => ({
  kind,
  projects: [],
  openTasks: 0,
  pending: 0,
  inProgress: 0,
  blocked: 0,
  completed: 0,
  overdue: 0,
  dueSoon: 0,
  needsReassignment: 0,
  deadlines: [],
  recentlyCompleted: [],
  workload: [],
  departments: [],
  participation: { peopleWithTasks: 0, peopleWithOpenTasks: 0 },
  activeProjects: 0,
  completedProjects: 0,
});

const progressOf = (total: number, completed: number, status: string) =>
  total ? Math.round((completed / total) * 100) : status === WorkspaceProjectStatus.COMPLETED ? 100 : 0;

const dayOf = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return String(value).slice(0, 10);
};

/**
 * Workspace home for the signed-in person.
 * Organization-wide callers see participation and departments.
 * A department head sees that department. A team lead sees the projects
 * they own and their team's tasks. Everyone else sees their own work.
 */
@Injectable()
export class WorkspaceDashboardService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  /** The caller's own projects, deadlines, overdue work and recent completions. */
  async getMine(tenantId: string, userId: string, email?: string): Promise<WorkspaceDashboard> {
    const employee = await findSelfEmployee(this.modelProvider, tenantId, userId, email);
    return this.forPeople(tenantId, 'employee', [employee.id], employee.id);
  }

  /** Manager, department head, or the whole organization — from the caller's data scope. */
  async getForCaller(tenantId: string): Promise<WorkspaceDashboard> {
    const scope = this.dataScope?.scope() ?? DataScope.ORGANIZATION;
    if (scope === DataScope.ORGANIZATION) return this.organization(tenantId);
    const ids = (await this.dataScope?.visibleEmployeeIds(tenantId)) ?? [];
    // A branch is read like a department: a group of people under one head.
    if (scope === DataScope.DEPARTMENT || scope === DataScope.BRANCH) return this.department(tenantId, ids);
    if (scope === DataScope.TEAM) {
      const me = await this.dataScope?.actorEmployeeId(tenantId);
      return this.forPeople(tenantId, 'manager', ids, me);
    }
    return this.forPeople(tenantId, 'employee', ids, ids[0] ?? null);
  }

  private async forPeople(
    tenantId: string,
    kind: 'employee' | 'manager',
    employeeIds: string[],
    leadId: string | null | undefined,
  ): Promise<WorkspaceDashboard> {
    const board = empty(kind);
    if (!employeeIds.length && !leadId) return board;
    const today = todayIso();
    const soon = addDays(today, 7);
    const loaded = await this.tasksFor(tenantId, employeeIds);
    const tasks = kind === 'manager' ? await this.withoutHidden(tenantId, loaded) : loaded;
    this.fillTaskCounts(board, tasks, today, soon);
    if (kind === 'employee') {
      board.deadlines = tasks
        .filter((task) => task.status !== WorkspaceTaskStatus.COMPLETED)
        .sort((a, b) => String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')))
        .slice(0, 5)
        .map((task) => this.taskCard(task, today));
      board.recentlyCompleted = tasks
        .filter((task) => task.status === WorkspaceTaskStatus.COMPLETED)
        .sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')))
        .slice(0, 5)
        .map((task) => this.taskCard(task, today));
      board.projects = await this.projectsForEmployee(tenantId, employeeIds[0], tasks);
    } else {
      board.projects = await this.projectsLedBy(tenantId, leadId ?? null);
    }
    return board;
  }

  private async department(tenantId: string, employeeIds: string[]): Promise<WorkspaceDashboard> {
    const board = empty('department');
    if (!employeeIds.length) return board;
    const today = todayIso();
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const people = (await Employee.findAll({
      where: { tenantId, id: { [Op.in]: employeeIds } },
      attributes: ['id', 'firstName', 'lastName', 'departmentId'],
      include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
    })) as any[];
    const departmentIds = [...new Set(people.map((person) => person.departmentId).filter(Boolean))] as string[];
    const tasks = await this.withoutHidden(tenantId, await this.tasksFor(tenantId, employeeIds));
    this.fillTaskCounts(board, tasks, today, addDays(today, 7));

    const byPerson = new Map<string, { open: number; overdue: number }>();
    const extras = await this.extraAssignees(tenantId, tasks.map((task) => task.id));
    for (const id of employeeIds) byPerson.set(id, { open: 0, overdue: 0 });
    for (const task of tasks) {
      if (task.status === WorkspaceTaskStatus.COMPLETED) continue;
      const owners = new Set([task.assigneeEmployeeId, ...(extras.get(task.id) ?? [])].filter(Boolean) as string[]);
      for (const id of owners) {
        if (!byPerson.has(id)) continue;
        const row = byPerson.get(id)!;
        row.open += 1;
        if (task.dueDate && task.dueDate < today) row.overdue += 1;
      }
    }
    board.workload = people
      .map((person) => ({
        id: person.id as string,
        name: [person.firstName, person.lastName].filter(Boolean).join(' ') || 'Unnamed',
        open: byPerson.get(person.id)?.open ?? 0,
        overdue: byPerson.get(person.id)?.overdue ?? 0,
      }))
      .filter((person) => person.open > 0)
      .sort((a, b) => b.open - a.open || b.overdue - a.overdue || a.name.localeCompare(b.name))
      .slice(0, LIST_LIMIT);

    const projects = await this.keepVisible(tenantId, await this.projectsIn(tenantId, employeeIds, departmentIds));
    board.activeProjects = projects.filter(
      (project) => project.status !== WorkspaceProjectStatus.COMPLETED && project.status !== WorkspaceProjectStatus.CANCELLED,
    ).length;
    board.completedProjects = projects.filter((project) => project.status === WorkspaceProjectStatus.COMPLETED).length;
    const active = projects.filter(
      (project) => project.status !== WorkspaceProjectStatus.COMPLETED && project.status !== WorkspaceProjectStatus.CANCELLED,
    );
    board.projects = await this.withProgress(tenantId, active.slice(0, LIST_LIMIT));
    return board;
  }

  private async organization(tenantId: string): Promise<WorkspaceDashboard> {
    const board = empty('organization');
    const today = todayIso();
    const hidden = await this.concealedIds(tenantId);
    const taskWhere = (extra: Record<string, unknown> = {}) => ({
      tenantId,
      ...extra,
      ...(hidden.length ? { [Op.or]: [{ projectId: null }, { projectId: { [Op.notIn]: hidden } }] } : {}),
    });
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const grouped = (await Task.findAll({
      where: taskWhere(),
      attributes: [
        'status',
        [Sequelize.fn('COUNT', Sequelize.col('WorkspaceTask.id')), 'count'],
        [
          Sequelize.fn(
            'SUM',
            literal(`CASE WHEN "WorkspaceTask"."status" <> 'COMPLETED' AND "WorkspaceTask"."dueDate" < '${today}' THEN 1 ELSE 0 END`),
          ),
          'overdue',
        ],
        [
          Sequelize.fn(
            'SUM',
            literal(`CASE WHEN "WorkspaceTask"."needsReassignment" = true AND "WorkspaceTask"."status" <> 'COMPLETED' THEN 1 ELSE 0 END`),
          ),
          'reassign',
        ],
      ],
      group: ['WorkspaceTask.status'],
      raw: true,
    })) as unknown as { status: string; count: string; overdue: string; reassign: string }[];
    const countOf = (status: string) => Number(grouped.find((row) => row.status === status)?.count ?? 0);
    board.pending = countOf(WorkspaceTaskStatus.PENDING);
    board.inProgress = countOf(WorkspaceTaskStatus.IN_PROGRESS);
    board.blocked = countOf(WorkspaceTaskStatus.BLOCKED);
    board.completed = countOf(WorkspaceTaskStatus.COMPLETED);
    board.openTasks = board.pending + board.inProgress + board.blocked;
    board.overdue = grouped.reduce((sum, row) => sum + Number(row.overdue ?? 0), 0);
    board.needsReassignment = grouped.reduce((sum, row) => sum + Number(row.reassign ?? 0), 0);

    const people = (await Task.findAll({
      where: taskWhere(),
      attributes: ['assigneeEmployeeId'],
      group: ['assigneeEmployeeId'],
      raw: true,
    })) as unknown as { assigneeEmployeeId: string | null }[];
    const openPeople = (await Task.findAll({
      where: taskWhere({ status: { [Op.ne]: WorkspaceTaskStatus.COMPLETED } }),
      attributes: ['assigneeEmployeeId'],
      group: ['assigneeEmployeeId'],
      raw: true,
    })) as unknown as { assigneeEmployeeId: string | null }[];
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const extras = (await Assignee.findAll({
      where: { tenantId },
      attributes: ['employeeId'],
      group: ['employeeId'],
      raw: true,
    })) as unknown as { employeeId: string }[];
    const withTasks = new Set(
      [...people.map((row) => row.assigneeEmployeeId), ...extras.map((row) => row.employeeId)].filter(Boolean) as string[],
    );
    const withOpen = new Set(openPeople.map((row) => row.assigneeEmployeeId).filter(Boolean) as string[]);
    board.participation = { peopleWithTasks: withTasks.size, peopleWithOpenTasks: withOpen.size };

    const byPerson = (await Task.findAll({
      where: taskWhere(),
      attributes: [
        'assigneeEmployeeId',
        'status',
        [Sequelize.fn('COUNT', Sequelize.col('WorkspaceTask.id')), 'count'],
        [
          Sequelize.fn(
            'SUM',
            literal(`CASE WHEN "WorkspaceTask"."status" <> 'COMPLETED' AND "WorkspaceTask"."dueDate" < '${today}' THEN 1 ELSE 0 END`),
          ),
          'overdue',
        ],
      ],
      group: ['assigneeEmployeeId', 'WorkspaceTask.status'],
      raw: true,
    })) as unknown as { assigneeEmployeeId: string | null; status: string; count: string; overdue: string }[];

    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const projects = (await Project.findAll({
      where: hidden.length
        ? { tenantId, [Op.or]: [{ confidential: { [Op.not]: true } }, { confidential: null }] }
        : { tenantId },
      attributes: ['departmentId', 'status'],
      raw: true,
    })) as unknown as { departmentId: string | null; status: string }[];
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const departments = (await Department.findAll({
      attributes: ['id', 'name'],
      raw: true,
    })) as unknown as { id: string; name: string }[];
    const assigneeIds = [...new Set(byPerson.map((row) => row.assigneeEmployeeId).filter(Boolean))] as string[];
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employees = assigneeIds.length
      ? ((await Employee.findAll({
          where: { tenantId, id: { [Op.in]: assigneeIds } },
          attributes: ['id', 'departmentId'],
          raw: true,
        })) as unknown as { id: string; departmentId: string | null }[])
      : [];
    const departmentOf = new Map(employees.map((row) => [row.id, row.departmentId]));
    const nameOf = new Map(departments.map((row) => [row.id, row.name]));
    const rollup = new Map<string, WorkspaceDashboardDepartment>();
    const bucket = (id: string | null) => {
      const key = id || 'none';
      let row = rollup.get(key);
      if (!row) {
        row = {
          id: id || '',
          name: (id && nameOf.get(id)) || 'No department',
          activeProjects: 0,
          completedProjects: 0,
          openTasks: 0,
          completedTasks: 0,
          overdue: 0,
        };
        rollup.set(key, row);
      }
      return row;
    };
    for (const project of projects) {
      const row = bucket(project.departmentId);
      if (project.status === WorkspaceProjectStatus.COMPLETED) row.completedProjects += 1;
      else if (project.status !== WorkspaceProjectStatus.CANCELLED) row.activeProjects += 1;
    }
    for (const row of byPerson) {
      if (!row.assigneeEmployeeId) continue;
      const bucketRow = bucket(departmentOf.get(row.assigneeEmployeeId) ?? null);
      const count = Number(row.count ?? 0);
      if (row.status === WorkspaceTaskStatus.COMPLETED) bucketRow.completedTasks += count;
      else bucketRow.openTasks += count;
      bucketRow.overdue += Number(row.overdue ?? 0);
    }
    board.departments = [...rollup.values()]
      .filter((row) => row.activeProjects || row.completedProjects || row.openTasks || row.completedTasks)
      .sort((a, b) => b.openTasks - a.openTasks || a.name.localeCompare(b.name))
      .slice(0, 12);
    board.activeProjects = projects.filter(
      (project) => project.status !== WorkspaceProjectStatus.COMPLETED && project.status !== WorkspaceProjectStatus.CANCELLED,
    ).length;
    board.completedProjects = projects.filter((project) => project.status === WorkspaceProjectStatus.COMPLETED).length;
    return board;
  }

  private fillTaskCounts(board: WorkspaceDashboard, tasks: SlimTask[], today: string, soon: string) {
    for (const task of tasks) {
      if (task.status === WorkspaceTaskStatus.COMPLETED) {
        board.completed += 1;
        continue;
      }
      board.openTasks += 1;
      if (task.status === WorkspaceTaskStatus.PENDING) board.pending += 1;
      else if (task.status === WorkspaceTaskStatus.IN_PROGRESS) board.inProgress += 1;
      else if (task.status === WorkspaceTaskStatus.BLOCKED) board.blocked += 1;
      if (task.dueDate && task.dueDate < today) board.overdue += 1;
      else if (task.dueDate && task.dueDate <= soon) board.dueSoon += 1;
      if (task.needsReassignment === true) board.needsReassignment += 1;
    }
  }

  private taskCard(task: SlimTask, today: string): WorkspaceDashboardTask {
    return {
      id: task.id,
      title: task.title,
      projectName: task.project?.name ?? null,
      dueDate: task.dueDate,
      completedAt: dayOf(task.completedAt),
      overdue: Boolean(task.dueDate && task.dueDate < today && task.status !== WorkspaceTaskStatus.COMPLETED),
    };
  }

  private async tasksFor(tenantId: string, employeeIds: string[]): Promise<SlimTask[]> {
    if (!employeeIds.length) return [];
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const extras = (await Assignee.findAll({
      where: { tenantId, employeeId: { [Op.in]: employeeIds } },
      attributes: ['taskId'],
      raw: true,
    })) as unknown as { taskId: string }[];
    const extraIds = [...new Set(extras.map((row) => row.taskId))];
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    return (await Task.findAll({
      where: {
        tenantId,
        [Op.or]: [{ assigneeEmployeeId: { [Op.in]: employeeIds } }, ...(extraIds.length ? [{ id: { [Op.in]: extraIds } }] : [])],
      },
      attributes: ['id', 'title', 'status', 'dueDate', 'completedAt', 'projectId', 'assigneeEmployeeId', 'needsReassignment'],
      include: [{ model: Project, as: 'project', attributes: ['id', 'name'], required: false }],
    })) as unknown as SlimTask[];
  }

  private async extraAssignees(tenantId: string, taskIds: string[]) {
    const map = new Map<string, string[]>();
    if (!taskIds.length) return map;
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const rows = (await Assignee.findAll({
      where: { tenantId, taskId: { [Op.in]: taskIds } },
      attributes: ['taskId', 'employeeId'],
      raw: true,
    })) as unknown as { taskId: string; employeeId: string }[];
    for (const row of rows) {
      const list = map.get(row.taskId) ?? [];
      list.push(row.employeeId);
      map.set(row.taskId, list);
    }
    return map;
  }

  private async projectsForEmployee(tenantId: string, employeeId: string | undefined, tasks: SlimTask[]) {
    if (!employeeId) return [];
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);
    const memberships = (await Member.findAll({
      where: { tenantId, employeeId },
      attributes: ['projectId'],
      raw: true,
    })) as unknown as { projectId: string }[];
    const ids = [...new Set([...memberships.map((row) => row.projectId), ...tasks.map((task) => task.projectId).filter(Boolean)])] as string[];
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = (await Project.findAll({
      where: {
        tenantId,
        status: { [Op.notIn]: [WorkspaceProjectStatus.CANCELLED, WorkspaceProjectStatus.COMPLETED] },
        [Op.or]: [{ leadEmployeeId: employeeId }, ...(ids.length ? [{ id: { [Op.in]: ids } }] : [])],
      },
      attributes: ['id', 'name', 'status'],
    })) as any[];
    const withProgress = await this.withProgress(tenantId, rows);
    return withProgress.sort((a, b) => b.overdue - a.overdue || b.openTasks - a.openTasks || a.name.localeCompare(b.name)).slice(0, LIST_LIMIT);
  }

  private async projectsLedBy(tenantId: string, leadId: string | null) {
    if (!leadId) return [];
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = (await Project.findAll({
      where: {
        tenantId,
        leadEmployeeId: leadId,
        status: { [Op.notIn]: [WorkspaceProjectStatus.CANCELLED] },
      },
      attributes: ['id', 'name', 'status'],
    })) as any[];
    const withProgress = await this.withProgress(tenantId, rows);
    return withProgress.sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name)).slice(0, LIST_LIMIT);
  }

  private async projectsIn(tenantId: string, employeeIds: string[], departmentIds: string[]) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    return (await Project.findAll({
      where: {
        tenantId,
        [Op.or]: [
          ...(employeeIds.length ? [{ leadEmployeeId: { [Op.in]: employeeIds } }] : []),
          ...(departmentIds.length ? [{ departmentId: { [Op.in]: departmentIds } }] : []),
        ],
      },
      attributes: ['id', 'name', 'status', 'departmentId', 'confidential'],
    })) as any[];
  }

  private async withProgress(tenantId: string, projects: { id: string; name: string; status: string }[]): Promise<WorkspaceDashboardProject[]> {
    if (!projects.length) return [];
    const today = todayIso();
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const rows = (await Task.findAll({
      where: { tenantId, projectId: { [Op.in]: projects.map((project) => project.id) } },
      attributes: [
        'projectId',
        'status',
        [Sequelize.fn('COUNT', Sequelize.col('WorkspaceTask.id')), 'count'],
        [
          Sequelize.fn(
            'SUM',
            literal(`CASE WHEN "WorkspaceTask"."status" <> 'COMPLETED' AND "WorkspaceTask"."dueDate" < '${today}' THEN 1 ELSE 0 END`),
          ),
          'overdue',
        ],
      ],
      group: ['projectId', 'WorkspaceTask.status'],
      raw: true,
    })) as unknown as { projectId: string; status: string; count: string; overdue: string }[];
    return projects.map((project) => {
      const mine = rows.filter((row) => row.projectId === project.id);
      const total = mine.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
      const completed = mine.filter((row) => row.status === WorkspaceTaskStatus.COMPLETED).reduce((sum, row) => sum + Number(row.count ?? 0), 0);
      return {
        id: project.id,
        name: project.name,
        status: project.status,
        progress: progressOf(total, completed, project.status),
        openTasks: total - completed,
        overdue: mine.reduce((sum, row) => sum + Number(row.overdue ?? 0), 0),
      };
    });
  }

  /** Confidential project ids the caller is not allowed to see. Empty when they may see them all. */
  private async concealedIds(tenantId: string): Promise<string[]> {
    if (seesConfidentialProjects()) return [];
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = (await Project.findAll({
      where: { tenantId, confidential: true },
      attributes: ['id'],
      raw: true,
    })) as unknown as { id: string }[];
    return rows.map((row) => row.id);
  }

  private async withoutHidden(tenantId: string, tasks: SlimTask[]): Promise<SlimTask[]> {
    const hidden = new Set(await this.concealedIds(tenantId));
    if (!hidden.size) return tasks;
    const me = await this.dataScope?.actorEmployeeId(tenantId);
    const mine = new Set(me ? await involvedProjectIds(this.modelProvider, tenantId, me) : []);
    return tasks.filter((task) => !task.projectId || !hidden.has(task.projectId) || mine.has(task.projectId));
  }

  private async keepVisible<T extends { id: string; confidential?: boolean | null }>(tenantId: string, projects: T[]): Promise<T[]> {
    if (seesConfidentialProjects()) return projects;
    const me = await this.dataScope?.actorEmployeeId(tenantId);
    const mine = new Set(me ? await involvedProjectIds(this.modelProvider, tenantId, me) : []);
    return projects.filter((project) => project.confidential !== true || mine.has(project.id));
  }
}
