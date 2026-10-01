import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, literal } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  CreateOnboardingTaskDto,
  UpdateOnboardingTaskDto,
  SetOnboardingTaskStatusDto,
  GetOnboardingTasksQueryDto,
  GetUpcomingOnboardingTasksQueryDto,
  OnboardingTaskCategory,
  OnboardingTaskStatus,
  OnboardingTaskStatusFilter,
  OnboardingTaskSortableField,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

/** Flattened row for the checklist and the Upcoming Tasks panel. */
export interface OnboardingTaskRow {
  id: string;
  title: string;
  description: string | null;
  category: OnboardingTaskCategory;
  status: OnboardingTaskStatus;
  completed: boolean;
  dueDate: string | null;
  /** True when a still-pending task's due date has passed. */
  overdue: boolean;
  newHire: {
    id: string;
    name: string;
    position: string;
    joiningDate: string;
  } | null;
  assignedTo: { id: string; name: string } | null;
  sortOrder: number;
  completedAt: Date | null;
  completedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The per-hire onboarding checklist and the Upcoming Tasks panel.
 *
 * Completion is set through {@link setStatus} rather than the generic update
 * path, because ticking a checkbox has to keep three things in step: the
 * status, the `completedAt` stamp and the attribution. Exposing `status` on
 * the update DTO would let a caller set it without the stamp, and the panel
 * would then show a completed task with no completion time.
 */
@Injectable()
export class OnboardingTaskService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  // ==========================================
  // Helpers
  // ==========================================

  private notFound(taskId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Onboarding task '${taskId}' not found in this organization.`,
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

  private toRow(record: any): OnboardingTaskRow {
    const newHire = record.newHire;
    const assignedTo = record.assignedTo;
    const dueDate = record.dueDate ? this.toDateOnly(record.dueDate) : null;
    const status: OnboardingTaskStatus = record.status;

    return {
      id: record.id,
      title: record.title,
      description: record.description ?? null,
      category: record.category,
      status,
      // Mirrored as a boolean because the checklist renders a checkbox; the
      // enum stays the stored truth.
      completed: status === OnboardingTaskStatus.COMPLETED,
      dueDate,
      overdue:
        status === OnboardingTaskStatus.PENDING &&
        dueDate !== null &&
        dueDate < this.today(),
      newHire: newHire
        ? {
            id: newHire.id,
            name:
              [newHire.firstName, newHire.lastName].filter(Boolean).join(' ') ||
              newHire.email,
            position: newHire.position,
            joiningDate: this.toDateOnly(newHire.joiningDate),
          }
        : null,
      assignedTo: assignedTo
        ? {
            id: assignedTo.id,
            name: [assignedTo.firstName, assignedTo.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : null,
      sortOrder: Number(record.sortOrder),
      completedAt: record.completedAt ?? null,
      completedByUserId: record.completedByUserId ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async buildInclude(tenantId: string) {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    return [
      {
        model: NewHireModel,
        as: 'newHire',
        attributes: [
          'id',
          'firstName',
          'lastName',
          'email',
          'position',
          'joiningDate',
        ],
        required: false,
      },
      {
        model: EmployeeModel,
        as: 'assignedTo',
        attributes: ['id', 'firstName', 'lastName'],
        required: false,
      },
    ];
  }

  private buildWhere(tenantId: string, query: GetOnboardingTasksQueryDto): any {
    const where: any = { tenantId };

    if (query.newHireId) where.newHireId = query.newHireId;
    if (query.category) where.category = query.category;
    if (query.status && query.status !== OnboardingTaskStatusFilter.ALL) {
      where.status = query.status;
    }

    if (query.search?.trim()) {
      const term = this.quote(`%${query.search.trim()}%`);
      where[Op.and] = [
        literal(
          `("OnboardingTask"."title" ILIKE ${term}` +
            ` OR "OnboardingTask"."description" ILIKE ${term})`,
        ),
      ];
    }

    return where;
  }

  private buildOrder(
    sortBy: OnboardingTaskSortableField = 'dueDate',
    sortOrder: 'ASC' | 'DESC' = 'ASC',
  ): any[] {
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    if (sortBy === 'dueDate') {
      // Undated items sort last either way rather than bubbling to the top of
      // an ascending list, where they would push the actually-urgent work
      // off the panel.
      return [
        [literal(`"OnboardingTask"."dueDate" ${dir} NULLS LAST`)],
        ['sortOrder', 'ASC'],
        ['title', 'ASC'],
      ];
    }
    return [
      [sortBy, dir],
      ['sortOrder', 'ASC'],
      ['title', 'ASC'],
    ];
  }

  private async loadNewHire(tenantId: string, newHireId: string) {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);
    const record = await NewHireModel.findOne({
      where: { id: newHireId, tenantId },
      attributes: ['id', 'joiningDate'],
    });
    if (!record) {
      this.badRequest(
        `New hire '${newHireId}' does not exist in this organization.`,
      );
    }
    return record;
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(tenantId: string, query: GetOnboardingTasksQueryDto) {
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    const { rows, count } = await OnboardingTaskModel.findAndCountAll({
      where: this.buildWhere(tenantId, query),
      include: await this.buildInclude(tenantId),
      order: this.buildOrder(query.sortBy, query.sortOrder),
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

  async getOne(tenantId: string, taskId: string): Promise<OnboardingTaskRow> {
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);
    const record = await OnboardingTaskModel.findOne({
      where: { id: taskId, tenantId },
      include: await this.buildInclude(tenantId),
    });
    if (!record) this.notFound(taskId);
    return this.toRow(record);
  }

  /**
   * The Upcoming Tasks panel: open checklist items, soonest first.
   *
   * Overdue tasks are always included regardless of the forward window — a
   * task that slipped last week is more urgent than one due next month, and
   * dropping it out of the panel is how it stays forgotten. Undated tasks are
   * excluded: with nothing to sort them by they would crowd out dated work.
   */
  async getUpcoming(
    tenantId: string,
    query: GetUpcomingOnboardingTasksQueryDto,
  ): Promise<OnboardingTaskRow[]> {
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);

    const withinDays =
      query.withinDays && query.withinDays > 0 ? query.withinDays : 30;
    const until = new Date(Date.now() + withinDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const where: any = {
      tenantId,
      status: OnboardingTaskStatus.PENDING,
      dueDate: { [Op.ne]: null, [Op.lte]: until },
    };
    if (query.newHireId) where.newHireId = query.newHireId;

    const rows = await OnboardingTaskModel.findAll({
      where,
      include: await this.buildInclude(tenantId),
      order: [
        ['dueDate', 'ASC'],
        ['sortOrder', 'ASC'],
      ],
      limit: query.limit && query.limit > 0 ? query.limit : 5,
      subQuery: false,
    });

    return (rows as any[]).map((row) => this.toRow(row));
  }

  // ==========================================
  // Writes
  // ==========================================

  async create(
    tenantId: string,
    dto: CreateOnboardingTaskDto,
  ): Promise<OnboardingTaskRow> {
    await this.loadNewHire(tenantId, dto.newHireId);

    if (dto.assignedToEmployeeId) {
      const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
      const exists = await EmployeeModel.findOne({
        where: { id: dto.assignedToEmployeeId, tenantId },
        attributes: ['id'],
      });
      if (!exists) {
        this.badRequest(
          `Assignee '${dto.assignedToEmployeeId}' does not exist in this organization.`,
        );
      }
    }

    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);

    const created: any = await OnboardingTaskModel.create({
      tenantId,
      newHireId: dto.newHireId,
      title: dto.title,
      category: dto.category ?? OnboardingTaskCategory.OTHER,
      status: OnboardingTaskStatus.PENDING,
      dueDate: dto.dueDate ? this.toDateOnly(dto.dueDate) : null,
      assignedToEmployeeId: dto.assignedToEmployeeId ?? null,
      sortOrder: dto.sortOrder ?? 0,
      description: dto.description ?? null,
    });

    return this.getOne(tenantId, created.id);
  }

  async update(
    tenantId: string,
    taskId: string,
    dto: UpdateOnboardingTaskDto,
  ): Promise<OnboardingTaskRow> {
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);

    const record: any = await OnboardingTaskModel.findOne({
      where: { id: taskId, tenantId },
    });
    if (!record) this.notFound(taskId);

    if (dto.assignedToEmployeeId) {
      const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
      const exists = await EmployeeModel.findOne({
        where: { id: dto.assignedToEmployeeId, tenantId },
        attributes: ['id'],
      });
      if (!exists) {
        this.badRequest(
          `Assignee '${dto.assignedToEmployeeId}' does not exist in this organization.`,
        );
      }
    }

    await record.update({
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.dueDate !== undefined
        ? { dueDate: dto.dueDate ? this.toDateOnly(dto.dueDate) : null }
        : {}),
      ...(dto.assignedToEmployeeId !== undefined
        ? { assignedToEmployeeId: dto.assignedToEmployeeId }
        : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
    });

    return this.getOne(tenantId, taskId);
  }

  /**
   * Tick or untick a checklist item.
   *
   * Reopening clears `completedAt` and the attribution rather than leaving
   * them behind: a pending task carrying a completion timestamp is a
   * contradiction, and the Upcoming Tasks panel would render it as both open
   * and finished. This is also what every derived onboarding status recomputes
   * from, so the hire's Status column follows automatically.
   */
  async setStatus(
    tenantId: string,
    taskId: string,
    dto: SetOnboardingTaskStatusDto,
    actorUserId?: string,
  ): Promise<OnboardingTaskRow> {
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);

    const record: any = await OnboardingTaskModel.findOne({
      where: { id: taskId, tenantId },
    });
    if (!record) this.notFound(taskId);

    await record.update(
      dto.completed
        ? {
            status: OnboardingTaskStatus.COMPLETED,
            completedAt: new Date(),
            completedByUserId: actorUserId ?? null,
          }
        : {
            status: OnboardingTaskStatus.PENDING,
            completedAt: null,
            completedByUserId: null,
          },
    );

    return this.getOne(tenantId, taskId);
  }

  async remove(tenantId: string, taskId: string): Promise<void> {
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);
    const record: any = await OnboardingTaskModel.findOne({
      where: { id: taskId, tenantId },
    });
    if (!record) this.notFound(taskId);
    await record.destroy();
  }
}
