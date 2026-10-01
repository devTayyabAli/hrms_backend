import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, fn, col, literal } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  CreateNewHireDto,
  UpdateNewHireDto,
  GetNewHiresQueryDto,
  ExportNewHiresQueryDto,
  GetOnboardingProgressQueryDto,
  NewHireOnboardingStatus,
  NewHireOnboardingStatusFilter,
  NewHireSortableField,
  OnboardingTaskStatus,
  deriveOnboardingStatus,
  EXPORT_MAX_ROWS,
  ExportResult,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { buildDefaultChecklist } from './onboarding-checklist';

/** Flattened row for the New Hires table. */
export interface NewHireRow {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  position: string;
  department: { id: string; name: string } | null;
  designation: { id: string; name: string } | null;
  joiningDate: string;
  reportingManager: { id: string; name: string } | null;
  employeeId: string | null;
  candidateId: string | null;
  notes: string | null;
  /** Derived from the checklist, never stored — see the NewHire model. */
  status: NewHireOnboardingStatus;
  tasks: {
    total: number;
    completed: number;
    pending: number;
    progressPercentage: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface OnboardingStats {
  totalNewHires: number;
  completedOnboarding: number;
  inProgress: number;
  pendingTasks: number;
  growth: {
    totalNewHires: number;
    completedOnboarding: number;
    inProgress: number;
    pendingTasks: number;
  };
}

export interface OnboardingProgress {
  /** Checklist items across every hire in scope. */
  totalTasks: number;
  completedTasks: number;
  inProgressHires: number;
  pendingTasks: number;
  /** Completed share of all checklist items — the donut's centre figure. */
  overallProgressPercentage: number;
  byStatus: {
    status: NewHireOnboardingStatus;
    hires: number;
    percentage: number;
  }[];
  totalHires: number;
}

/**
 * New hires behind the Onboarding screen's table, KPI cards and progress
 * donut.
 *
 * Onboarding status is derived from each hire's checklist on every read (see
 * `deriveOnboardingStatus`), which is why the checklist tallies are attached
 * as correlated subqueries rather than fetched per row: the table needs them
 * for the Status column anyway, and a per-row COUNT would be a query per hire.
 *
 * That derivation is also why the status filter is applied after the database
 * has paged: a column Postgres does not have cannot appear in a WHERE clause.
 * The `total` reported alongside a status-filtered page is therefore the count
 * of hires matching that status, computed from the same tallies — see
 * {@link getAll}.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  // ==========================================
  // Helpers
  // ==========================================

  private notFound(newHireId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `New hire '${newHireId}' not found in this organization.`,
      HttpStatus.NOT_FOUND,
    );
  }

  private badRequest(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }

  private conflict(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.CONFLICT,
    );
  }

  private toDateOnly(value: string | Date): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return value.slice(0, 10);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private percentChange(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  }

  /** Correlated tallies for the derived status and progress bar. */
  private taskCountLiterals(): [any, string][] {
    return [
      [
        literal(
          '(SELECT COUNT(*) FROM "onboarding_tasks" AS "t" WHERE "t"."newHireId" = "NewHire"."id")',
        ),
        'tasksTotal',
      ],
      [
        literal(
          `(SELECT COUNT(*) FROM "onboarding_tasks" AS "t" WHERE "t"."newHireId" = "NewHire"."id" AND "t"."status" = '${OnboardingTaskStatus.COMPLETED}')`,
        ),
        'tasksCompleted',
      ],
    ];
  }

  private toRow(record: any): NewHireRow {
    const department = record.department;
    const designation = record.designation;
    const manager = record.reportingManager;

    const total = Number(record.get?.('tasksTotal') ?? record.tasksTotal ?? 0);
    const completed = Number(
      record.get?.('tasksCompleted') ?? record.tasksCompleted ?? 0,
    );

    return {
      id: record.id,
      name:
        [record.firstName, record.lastName].filter(Boolean).join(' ') ||
        record.email,
      firstName: record.firstName,
      lastName: record.lastName,
      email: record.email,
      phone: record.phone ?? null,
      position: record.position,
      department: department
        ? { id: department.id, name: department.name }
        : null,
      designation: designation
        ? { id: designation.id, name: designation.title }
        : null,
      joiningDate: this.toDateOnly(record.joiningDate),
      reportingManager: manager
        ? {
            id: manager.id,
            name: [manager.firstName, manager.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : null,
      employeeId: record.employeeId ?? null,
      candidateId: record.candidateId ?? null,
      notes: record.notes ?? null,
      status: deriveOnboardingStatus(total, completed),
      tasks: {
        total,
        completed,
        pending: Math.max(0, total - completed),
        progressPercentage:
          total === 0 ? 0 : Math.round((completed / total) * 1000) / 10,
      },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async buildInclude(tenantId: string) {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const DesignationModel =
      await this.modelProvider.getDesignationModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    return [
      {
        model: DepartmentModel,
        as: 'department',
        attributes: ['id', 'name'],
        required: false,
      },
      {
        model: DesignationModel,
        as: 'designation',
        attributes: ['id', 'title'],
        required: false,
      },
      {
        model: EmployeeModel,
        as: 'reportingManager',
        attributes: ['id', 'firstName', 'lastName'],
        required: false,
      },
    ];
  }

  private buildWhere(tenantId: string, query: GetNewHiresQueryDto): any {
    const where: any = { tenantId };

    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.designationId) where.designationId = query.designationId;
    if (query.from)
      where.joiningDate = { [Op.gte]: this.toDateOnly(query.from) };
    if (query.to) {
      where.joiningDate = {
        ...(where.joiningDate ?? {}),
        [Op.lte]: this.toDateOnly(query.to),
      };
    }

    if (query.search?.trim()) {
      const term = this.quote(`%${query.search.trim()}%`);
      where[Op.and] = [
        literal(
          `(concat("NewHire"."firstName", ' ', "NewHire"."lastName") ILIKE ${term}` +
            ` OR "NewHire"."email" ILIKE ${term}` +
            ` OR "NewHire"."position" ILIKE ${term})`,
        ),
      ];
    }

    return where;
  }

  private buildOrder(
    sortBy: NewHireSortableField = 'joiningDate',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): any[] {
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    switch (sortBy) {
      case 'employeeName':
        return [
          [literal(`"NewHire"."firstName" ${dir}`)],
          [literal(`"NewHire"."lastName" ${dir}`)],
        ];
      case 'department':
        return [[literal(`"department"."name" ${dir}`)]];
      default:
        return [[sortBy, dir]];
    }
  }

  private async validateRefs(
    tenantId: string,
    refs: {
      departmentId?: string;
      designationId?: string;
      reportingManagerEmployeeId?: string;
      employeeId?: string;
    },
  ): Promise<void> {
    if (refs.departmentId) {
      const DepartmentModel =
        await this.modelProvider.getDepartmentModel(tenantId);
      const exists = await DepartmentModel.findOne({
        where: { id: refs.departmentId, tenantId },
        attributes: ['id'],
      });
      if (!exists) {
        this.badRequest(
          `Department '${refs.departmentId}' does not exist in this organization.`,
        );
      }
    }
    if (refs.designationId) {
      const DesignationModel =
        await this.modelProvider.getDesignationModel(tenantId);
      const exists = await DesignationModel.findOne({
        where: { id: refs.designationId, tenantId },
        attributes: ['id'],
      });
      if (!exists) {
        this.badRequest(
          `Designation '${refs.designationId}' does not exist in this organization.`,
        );
      }
    }

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    for (const [id, label] of [
      [refs.reportingManagerEmployeeId, 'Reporting manager'],
      [refs.employeeId, 'Employee'],
    ] as [string | undefined, string][]) {
      if (!id) continue;
      const exists = await EmployeeModel.findOne({
        where: { id, tenantId },
        attributes: ['id'],
      });
      if (!exists) {
        this.badRequest(
          `${label} '${id}' does not exist in this organization.`,
        );
      }
    }
  }

  // ==========================================
  // Reads
  // ==========================================

  /**
   * The New Hires table.
   *
   * Without a status filter the database pages the result as usual. With one,
   * the filter targets a derived value, so the matching set has to be
   * resolved before paging — the tallies come back as two lightweight
   * correlated counts per hire (ids only, no joins), the status is computed,
   * and only the requested page is then hydrated with its joins. That keeps
   * the expensive part (three joins per row) proportional to the page rather
   * than to the tenant's whole onboarding history.
   */
  async getAll(tenantId: string, query: GetNewHiresQueryDto) {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;
    const where = this.buildWhere(tenantId, query);
    const order = this.buildOrder(query.sortBy, query.sortOrder);
    const statusFilter = query.status ?? NewHireOnboardingStatusFilter.ALL;

    if (statusFilter === NewHireOnboardingStatusFilter.ALL) {
      const { rows, count } = await NewHireModel.findAndCountAll({
        where,
        include: await this.buildInclude(tenantId),
        attributes: { include: this.taskCountLiterals() as any },
        order,
        limit,
        offset: (page - 1) * limit,
        distinct: true,
        subQuery: false,
      });

      return {
        data: (rows as any[]).map((row) => this.toRow(row)),
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit) || 1,
      };
    }

    // Department sorting needs the joined table, which the id-only pass does
    // not have; fall back to the underlying column for that pass and re-apply
    // the real order once the page is hydrated.
    const idOnlyOrder =
      query.sortBy === 'department' ? [['departmentId', 'ASC']] : order;

    const candidates = (await NewHireModel.findAll({
      where,
      attributes: ['id', ...this.taskCountLiterals()] as any,
      order: idOnlyOrder as any,
      raw: true,
    })) as unknown as {
      id: string;
      tasksTotal: string;
      tasksCompleted: string;
    }[];

    const matchingIds = candidates
      .filter(
        (row) =>
          deriveOnboardingStatus(
            Number(row.tasksTotal),
            Number(row.tasksCompleted),
          ) === (statusFilter as unknown as NewHireOnboardingStatus),
      )
      .map((row) => row.id);

    const total = matchingIds.length;
    const pageIds = matchingIds.slice((page - 1) * limit, page * limit);

    const rows = pageIds.length
      ? await NewHireModel.findAll({
          where: { tenantId, id: { [Op.in]: pageIds } },
          include: await this.buildInclude(tenantId),
          attributes: { include: this.taskCountLiterals() as any },
          order,
          subQuery: false,
        })
      : [];

    return {
      data: (rows as any[]).map((row) => this.toRow(row)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async getOne(tenantId: string, newHireId: string): Promise<NewHireRow> {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);
    const record = await NewHireModel.findOne({
      where: { id: newHireId, tenantId },
      include: await this.buildInclude(tenantId),
      attributes: { include: this.taskCountLiterals() as any },
    });
    if (!record) this.notFound(newHireId);
    return this.toRow(record);
  }

  async export(
    tenantId: string,
    query: ExportNewHiresQueryDto,
  ): Promise<ExportResult<NewHireRow>> {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);

    const where = this.buildWhere(tenantId, query);
    const include = await this.buildInclude(tenantId);

    const rows = await NewHireModel.findAll({
      where,
      include,
      attributes: { include: this.taskCountLiterals() as any },
      order: this.buildOrder(query.sortBy, query.sortOrder),
      limit: EXPORT_MAX_ROWS,
      subQuery: false,
    });

    let mapped = (rows as any[]).map((row) => this.toRow(row));

    // The status filter is derived, so it applies after mapping — same reason
    // as getAll. totalMatched counts the rows that survive it.
    const statusFilter = query.status ?? NewHireOnboardingStatusFilter.ALL;
    if (statusFilter !== NewHireOnboardingStatusFilter.ALL) {
      mapped = mapped.filter(
        (row) =>
          row.status === (statusFilter as unknown as NewHireOnboardingStatus),
      );
    }

    const totalMatched = await NewHireModel.count({
      where,
      include,
      distinct: true,
    });

    return {
      rows: mapped,
      totalMatched:
        statusFilter === NewHireOnboardingStatusFilter.ALL
          ? totalMatched
          : mapped.length,
      truncated:
        statusFilter === NewHireOnboardingStatusFilter.ALL &&
        totalMatched > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  /**
   * The four KPI cards.
   *
   * "Completed Onboarding" and "In Progress" are derived per hire, so they
   * come from one grouped pass over the checklist tallies rather than a query
   * per card. "Pending Tasks" is a direct COUNT of open checklist items,
   * which is what the card on the screen actually reports — open work, not
   * hires with open work.
   */
  async getStats(tenantId: string): Promise<OnboardingStats> {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const tallyStatuses = async (where: any) => {
      const rows = (await NewHireModel.findAll({
        where,
        attributes: ['id', ...this.taskCountLiterals()] as any,
        raw: true,
      })) as unknown as {
        id: string;
        tasksTotal: string;
        tasksCompleted: string;
      }[];

      const counts = {
        total: rows.length,
        completed: 0,
        inProgress: 0,
        pending: 0,
      };
      for (const row of rows) {
        const status = deriveOnboardingStatus(
          Number(row.tasksTotal),
          Number(row.tasksCompleted),
        );
        if (status === NewHireOnboardingStatus.COMPLETED) counts.completed++;
        else if (status === NewHireOnboardingStatus.IN_PROGRESS)
          counts.inProgress++;
        else counts.pending++;
      }
      return counts;
    };

    const [overall, thisMonth, lastMonth, pendingTasks, pendingTasksLastMonth] =
      await Promise.all([
        tallyStatuses({ tenantId }),
        tallyStatuses({
          tenantId,
          createdAt: { [Op.gte]: monthStart, [Op.lt]: now },
        }),
        tallyStatuses({
          tenantId,
          createdAt: { [Op.gte]: prevMonthStart, [Op.lt]: monthStart },
        }),
        OnboardingTaskModel.count({
          where: { tenantId, status: OnboardingTaskStatus.PENDING },
        }),
        OnboardingTaskModel.count({
          where: {
            tenantId,
            status: OnboardingTaskStatus.PENDING,
            createdAt: { [Op.gte]: prevMonthStart, [Op.lt]: monthStart },
          },
        }),
      ]);

    return {
      totalNewHires: overall.total,
      completedOnboarding: overall.completed,
      inProgress: overall.inProgress,
      pendingTasks,
      growth: {
        totalNewHires: this.percentChange(thisMonth.total, lastMonth.total),
        completedOnboarding: this.percentChange(
          thisMonth.completed,
          lastMonth.completed,
        ),
        inProgress: this.percentChange(
          thisMonth.inProgress,
          lastMonth.inProgress,
        ),
        pendingTasks: this.percentChange(pendingTasks, pendingTasksLastMonth),
      },
    };
  }

  /**
   * The Onboarding Progress donut.
   *
   * The centre percentage is completed checklist items over all checklist
   * items, not hires over hires: a hire two tasks from done and one that has
   * not started should not contribute equally, and the task-level figure is
   * the one that moves as work is actually ticked off. The per-status hire
   * counts come back alongside it for the legend.
   */
  async getProgress(
    tenantId: string,
    query: GetOnboardingProgressQueryDto,
  ): Promise<OnboardingProgress> {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);

    const where: any = { tenantId };
    if (query.departmentId) where.departmentId = query.departmentId;

    const rows = (await NewHireModel.findAll({
      where,
      attributes: ['id', ...this.taskCountLiterals()] as any,
      raw: true,
    })) as unknown as {
      id: string;
      tasksTotal: string;
      tasksCompleted: string;
    }[];

    let totalTasks = 0;
    let completedTasks = 0;
    const hiresByStatus = new Map<NewHireOnboardingStatus, number>();

    for (const row of rows) {
      const total = Number(row.tasksTotal);
      const completed = Number(row.tasksCompleted);
      totalTasks += total;
      completedTasks += completed;

      const status = deriveOnboardingStatus(total, completed);
      hiresByStatus.set(status, (hiresByStatus.get(status) ?? 0) + 1);
    }

    const totalHires = rows.length;

    return {
      totalTasks,
      completedTasks,
      inProgressHires:
        hiresByStatus.get(NewHireOnboardingStatus.IN_PROGRESS) ?? 0,
      pendingTasks: Math.max(0, totalTasks - completedTasks),
      overallProgressPercentage:
        totalTasks === 0
          ? 0
          : Math.round((completedTasks / totalTasks) * 1000) / 10,
      byStatus: Object.values(NewHireOnboardingStatus).map((status) => {
        const hires = hiresByStatus.get(status) ?? 0;
        return {
          status,
          hires,
          percentage:
            totalHires === 0 ? 0 : Math.round((hires / totalHires) * 1000) / 10,
        };
      }),
      totalHires,
    };
  }

  // ==========================================
  // Writes
  // ==========================================

  async create(
    tenantId: string,
    dto: CreateNewHireDto,
    actorUserId?: string,
  ): Promise<NewHireRow> {
    await this.validateRefs(tenantId, dto);

    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);
    const email = dto.email.trim().toLowerCase();

    const duplicate = await NewHireModel.findOne({
      where: { tenantId, email },
      attributes: ['id'],
    });
    if (duplicate) {
      this.conflict(
        `${email} already has an onboarding record in this organization.`,
      );
    }

    const joiningDate = this.toDateOnly(dto.joiningDate);

    const created: any = await NewHireModel.create({
      tenantId,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email,
      phone: dto.phone ?? null,
      position: dto.position,
      departmentId: dto.departmentId,
      designationId: dto.designationId ?? null,
      joiningDate,
      reportingManagerEmployeeId: dto.reportingManagerEmployeeId ?? null,
      employeeId: dto.employeeId ?? null,
      candidateId: dto.candidateId ?? null,
      notes: dto.notes ?? null,
      createdByUserId: actorUserId ?? null,
    });

    // Seeded by default: a hire with no checklist derives as PENDING and
    // shows an empty progress bar, which is rarely what an admin adding
    // someone actually wants.
    if (dto.seedDefaultTasks !== false) {
      const OnboardingTaskModel =
        await this.modelProvider.getOnboardingTaskModel(tenantId);
      await OnboardingTaskModel.bulkCreate(
        buildDefaultChecklist(tenantId, created.id, joiningDate) as any[],
      );
    }

    return this.getOne(tenantId, created.id);
  }

  async update(
    tenantId: string,
    newHireId: string,
    dto: UpdateNewHireDto,
  ): Promise<NewHireRow> {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);
    const record: any = await NewHireModel.findOne({
      where: { id: newHireId, tenantId },
    });
    if (!record) this.notFound(newHireId);

    await this.validateRefs(tenantId, dto);

    let email: string | undefined;
    if (dto.email !== undefined) {
      email = dto.email.trim().toLowerCase();
      if (email !== record.email) {
        const duplicate = await NewHireModel.findOne({
          where: { tenantId, email, id: { [Op.ne]: newHireId } },
          attributes: ['id'],
        });
        if (duplicate) {
          this.conflict(
            `${email} already has an onboarding record in this organization.`,
          );
        }
      }
    }

    await record.update({
      ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.position !== undefined ? { position: dto.position } : {}),
      ...(dto.departmentId !== undefined
        ? { departmentId: dto.departmentId }
        : {}),
      ...(dto.designationId !== undefined
        ? { designationId: dto.designationId }
        : {}),
      ...(dto.joiningDate !== undefined
        ? { joiningDate: this.toDateOnly(dto.joiningDate) }
        : {}),
      ...(dto.reportingManagerEmployeeId !== undefined
        ? { reportingManagerEmployeeId: dto.reportingManagerEmployeeId }
        : {}),
      ...(dto.employeeId !== undefined ? { employeeId: dto.employeeId } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    });

    return this.getOne(tenantId, newHireId);
  }

  /**
   * Delete a hire and their checklist. The tasks carry a real FK, so they go
   * first — and a checklist without the person it belongs to is not a record
   * anyone can act on.
   */
  async remove(tenantId: string, newHireId: string): Promise<void> {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);

    const record: any = await NewHireModel.findOne({
      where: { id: newHireId, tenantId },
    });
    if (!record) this.notFound(newHireId);

    await OnboardingTaskModel.destroy({ where: { tenantId, newHireId } });
    await record.destroy();
  }
}
