import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op, Sequelize, literal } from 'sequelize';
import {
  CreateWorkspaceProjectDto,
  EXPORT_MAX_ROWS,
  ExportResult,
  GetWorkspaceProjectsQueryDto,
  UpdateWorkspaceProjectDto,
  WorkspaceProjectStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields, employeeInclude, employeeSummary, todayIso, workspaceError } from './workspace-shared';

/** Projects are an organization-level list, kept small enough to return whole. */
const MAX_PROJECTS = 500;

export interface WorkspaceProjectRow {
  id: string;
  name: string;
  client: string | null;
  description: string | null;
  lead: ReturnType<typeof employeeSummary>;
  department: { id: string; name: string } | null;
  status: WorkspaceProjectStatus;
  dueDate: string | null;
  milestone: string | null;
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
 */
@Injectable()
export class WorkspaceProjectService {
  private readonly logger = new Logger(WorkspaceProjectService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

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

  private toRow(project: any, tally: TaskTally | undefined): WorkspaceProjectRow {
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
      department: project.department ? { id: project.department.id, name: project.department.name } : null,
      status: project.status,
      dueDate: project.dueDate ?? null,
      milestone: project.milestone ?? null,
      progress,
      totalTasks: total,
      openTasks: total - completed,
      overdueTasks: tally?.overdue ?? 0,
      createdAt: project.createdAt,
    };
  }

  /**
   * The projects one employee is part of: those they lead and those holding a
   * task assigned to them. Projects have no member list, so taking part means
   * one of the two.
   */
  async getForEmployee(tenantId: string, employeeId: string, myTaskProjectIds: string[]) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = await Project.findAll({
      where: {
        tenantId,
        [Op.or]: [
          { leadEmployeeId: employeeId },
          ...(myTaskProjectIds.length ? [{ id: { [Op.in]: myTaskProjectIds } }] : []),
        ],
      },
      include: await this.include(tenantId),
      order: [['dueDate', 'ASC NULLS LAST'], ['name', 'ASC']],
      limit: 100,
    });
    const tallies = await this.taskTallies(tenantId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...this.toRow(r, tallies.get(r.id)), isLead: r.leadEmployeeId === employeeId }));
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

  /** The filtered cards, plus status counts for the whole organization (the KPI row). */
  async getAll(tenantId: string, query: GetWorkspaceProjectsQueryDto) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const [rows, byStatus] = await Promise.all([
      Project.findAll({
        where: this.where(tenantId, query),
        include: await this.include(tenantId),
        // Live work first, then the nearest deadline.
        order: [
          [literal(`CASE "WorkspaceProject"."status" WHEN 'AT_RISK' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'ON_HOLD' THEN 2 ELSE 3 END`), 'ASC'],
          [literal(`"WorkspaceProject"."dueDate" IS NULL`), 'ASC'],
          ['dueDate', 'ASC'],
          ['name', 'ASC'],
        ],
        limit: MAX_PROJECTS,
        subQuery: false,
      }),
      Project.count({ where: { tenantId }, group: ['status'] }) as unknown as Promise<{ status: string; count: number }[]>,
    ]);

    const tallies = await this.taskTallies(tenantId, rows.map((r) => r.id));
    const count = (status: WorkspaceProjectStatus) => Number(byStatus.find((s) => s.status === status)?.count ?? 0);
    return {
      data: rows.map((r) => this.toRow(r, tallies.get(r.id))),
      stats: {
        total: byStatus.reduce((sum, s) => sum + Number(s.count), 0),
        active: count(WorkspaceProjectStatus.ACTIVE),
        onHold: count(WorkspaceProjectStatus.ON_HOLD),
        atRisk: count(WorkspaceProjectStatus.AT_RISK),
        completed: count(WorkspaceProjectStatus.COMPLETED),
      },
    };
  }

  /** Every project, for the task form's project picker. */
  async getOptions(tenantId: string) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const rows = await Project.findAll({ where: { tenantId }, attributes: ['id', 'name', 'status'], order: [['name', 'ASC']] });
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status }));
  }

  async getAllForExport(tenantId: string, query: GetWorkspaceProjectsQueryDto): Promise<ExportResult<WorkspaceProjectRow>> {
    const { data } = await this.getAll(tenantId, query);
    const rows = data.slice(0, EXPORT_MAX_ROWS);
    return { rows, totalMatched: data.length, truncated: data.length > rows.length, limit: EXPORT_MAX_ROWS };
  }

  private async findOwn(tenantId: string, projectId: string) {
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.findOne({ where: { id: projectId, tenantId }, include: await this.include(tenantId) });
    if (!project) workspaceError('Project not found.', HttpStatus.NOT_FOUND);
    return project!;
  }

  private async getOne(tenantId: string, projectId: string) {
    const project = await this.findOwn(tenantId, projectId);
    return this.toRow(project, (await this.taskTallies(tenantId, [projectId])).get(projectId));
  }

  // ==========================================
  // Writes
  // ==========================================

  /** The lead must exist; returns their department for the default. */
  private async leadDepartment(tenantId: string, leadEmployeeId: string | null | undefined): Promise<string | null> {
    if (!leadEmployeeId) return null;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const lead = await Employee.findOne({ where: { id: leadEmployeeId, tenantId }, attributes: ['id', 'departmentId'] });
    if (!lead) workspaceError('The selected project lead was not found.', HttpStatus.BAD_REQUEST);
    return lead!.departmentId ?? null;
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
    const leadDepartmentId = await this.leadDepartment(tenantId, dto.leadEmployeeId);
    await this.assertDepartment(tenantId, dto.departmentId);

    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const project = await Project.create({
      tenantId,
      name,
      client: dto.client?.trim() || null,
      description: dto.description?.trim() || null,
      leadEmployeeId: dto.leadEmployeeId ?? null,
      departmentId: dto.departmentId ?? leadDepartmentId,
      status: dto.status ?? WorkspaceProjectStatus.ACTIVE,
      dueDate: dto.dueDate ?? null,
      milestone: dto.milestone?.trim() || null,
      createdByUserId: actorUserId ?? null,
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_projects', project.id, 'CREATE', {
      name: { from: null, to: project.name },
    });
    return this.getOne(tenantId, project.id);
  }

  async update(tenantId: string, projectId: string, dto: UpdateWorkspaceProjectDto) {
    const project: any = await this.findOwn(tenantId, projectId);
    if (dto.name && dto.name.trim().toLowerCase() !== project.name.toLowerCase()) {
      await this.assertUniqueName(tenantId, dto.name.trim(), projectId);
    }
    let departmentId = dto.departmentId;
    if (dto.leadEmployeeId !== undefined && dto.leadEmployeeId !== project.leadEmployeeId) {
      const leadDepartmentId = await this.leadDepartment(tenantId, dto.leadEmployeeId);
      // A new lead brings their department, unless one was picked explicitly.
      if (departmentId === undefined) departmentId = leadDepartmentId ?? project.departmentId;
    }
    await this.assertDepartment(tenantId, departmentId);

    const next: Record<string, unknown> = {
      name: dto.name?.trim(),
      client: dto.client === undefined ? undefined : dto.client?.trim() || null,
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      leadEmployeeId: dto.leadEmployeeId,
      departmentId,
      status: dto.status,
      dueDate: dto.dueDate,
      milestone: dto.milestone === undefined ? undefined : dto.milestone?.trim() || null,
    };
    const changes = diffFields(project.get({ plain: true }), next);
    if (Object.keys(changes).length) {
      await project.update(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
      await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_projects', projectId, 'UPDATE', changes);
    }
    return this.getOne(tenantId, projectId);
  }

  /** The project's tasks are kept, without a project. */
  async remove(tenantId: string, projectId: string) {
    const project = await this.findOwn(tenantId, projectId);
    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const [unlinked] = await Task.update({ projectId: null }, { where: { tenantId, projectId } });
    await project.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'workspace_projects', projectId, 'DELETE', {
      name: { from: project.name, to: null },
      unlinkedTasks: { from: unlinked, to: 0 },
    });
    return { success: true, unlinkedTasks: unlinked };
  }
}
