import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  CreateDevelopmentItemDto,
  CreateMyDevelopmentItemDto,
  DevelopmentStatus,
  DevelopmentType,
  EmployeeNotificationKind,
  EmployeeStatus,
  GetDevelopmentQueryDto,
  TenantErrorCode,
  TenantException,
  UpdateDevelopmentItemDto,
  grantsPermission,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { writePayrollAudit as writeAudit } from './payroll-access';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const TABLE = 'development_items';
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const FINISHED = [DevelopmentStatus.DONE, DevelopmentStatus.DROPPED, DevelopmentStatus.DISMISSED];

/**
 * Development goals and recommendations. Supportive, not disciplinary: the
 * employee sees theirs from the start, may add their own, moves their progress
 * along, and accepts (becoming a goal) or dismisses what is recommended to them.
 * A manager adds for their team, HR for anyone. A recommendation may point at a
 * course in Learning. Nothing is deleted by the employee: a goal they drop stays.
 */
@Injectable()
export class PerformanceDevelopmentService {
  private readonly logger = new Logger(PerformanceDevelopmentService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private holdsManage(): boolean {
    const rpc = currentRpcActor();
    return !rpc || rpc.isFullAccess === true || grantsPermission(rpc.permissions ?? [], 'performance.manage');
  }

  private async notify(tenantId: string, employeeId: string, title: string, body: string) {
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.PERFORMANCE, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`A development notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName'] }) : null;
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  private audit(tenantId: string, id: string, action: 'CREATE' | 'UPDATE' | 'DELETE', changes: Record<string, { from: unknown; to: unknown }>) {
    return writeAudit(this.modelProvider, this.logger, tenantId, TABLE, id, action, changes);
  }

  private async courseTitle(tenantId: string, courseId?: string | null): Promise<string | null> {
    if (!courseId) return null;
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const course: any = await Course.findOne({ where: { id: courseId, tenantId }, attributes: ['id', 'title'] });
    if (!course) this.fail(HttpStatus.BAD_REQUEST, 'That course is not in this organization\'s Learning.');
    return course.title as string;
  }

  private row(item: any) {
    return {
      id: item.id as string,
      employeeId: item.employeeId as string,
      reviewId: (item.reviewId ?? null) as string | null,
      type: item.type as string,
      title: item.title as string,
      description: (item.description ?? null) as string | null,
      skill: (item.skill ?? null) as string | null,
      course: item.courseId ? { id: item.courseId as string, title: (item.courseTitle ?? null) as string | null } : null,
      targetDate: day(item.targetDate),
      status: item.status as string,
      progress: Number(item.progress ?? 0),
      source: item.source as string,
      createdBy: (item.createdByEmail ?? null) as string | null,
      note: (item.note ?? null) as string | null,
      completedAt: item.completedAt ?? null,
      awaitingEmployee: item.type === DevelopmentType.RECOMMENDATION && item.status === DevelopmentStatus.OPEN,
    };
  }

  private async findForEmployee(tenantId: string, employeeId: string, query: GetDevelopmentQueryDto = {}) {
    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const rows = (await Item.findAll({ where: { tenantId, employeeId, ...(query.status ? { status: query.status } : {}) } as any, order: [['createdAt', 'DESC']], limit: 200 })) as any[];
    const open = rows.filter((row) => !FINISHED.includes(row.status));
    return { data: rows.map((row) => this.row(row)), total: rows.length, open: open.length };
  }

  // ==========================================
  // Admin and manager
  // ==========================================

  /** Someone's items, for anyone allowed to see that person. */
  async list(tenantId: string, query: GetDevelopmentQueryDto) {
    if (!query.employeeId) this.fail(HttpStatus.BAD_REQUEST, 'Say whose development items you want (employeeId).');
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, query.employeeId, 'Employee');
    return this.findForEmployee(tenantId, query.employeeId, query);
  }

  /** A manager's view of one of their own people (reports, or someone whose review they complete). */
  private async assertManages(tenantId: string, managerId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const subject: any = await Employee.findOne({ where: { id: employeeId, tenantId }, attributes: ['id', 'reportingManagerId'] });
    let ok = Boolean(subject && subject.reportingManagerId === managerId);
    if (subject && !ok) {
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      ok = (await Review.count({ where: { tenantId, employeeId, reviewerId: managerId } })) > 0;
    }
    if (!ok) this.fail(HttpStatus.FORBIDDEN, 'This person is not in your team.');
  }

  async forTeamMember(tenantId: string, userId: string, email: string | undefined, employeeId: string) {
    const me = await this.me(tenantId, userId, email);
    await this.assertManages(tenantId, me.id, employeeId);
    return this.findForEmployee(tenantId, employeeId);
  }

  async createForTeamMember(tenantId: string, userId: string, email: string | undefined, employeeId: string, dto: Omit<CreateDevelopmentItemDto, 'employeeId'>) {
    const me = await this.me(tenantId, userId, email);
    await this.assertManages(tenantId, me.id, employeeId);
    return this.create(tenantId, { ...dto, employeeId }, { manager: true, email: email ?? null });
  }

  async create(tenantId: string, dto: CreateDevelopmentItemDto, as?: { manager: boolean; email: string | null }) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: dto.employeeId, tenantId }, attributes: ['id', 'status'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'Employee not found.');
    if (!EMPLOYED.includes(employee.status)) this.fail(HttpStatus.CONFLICT, 'This person no longer works here.');
    if (!as && this.dataScope) await this.dataScope.assertCanSee(tenantId, employee.id, 'Employee');
    if (dto.reviewId) {
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      if (!(await Review.count({ where: { id: dto.reviewId, tenantId, employeeId: employee.id } }))) this.fail(HttpStatus.BAD_REQUEST, 'That review is not one of this person\'s.');
    }
    const courseTitle = await this.courseTitle(tenantId, dto.courseId);
    const rpc = currentRpcActor();
    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const created: any = await Item.create({
      tenantId,
      employeeId: employee.id,
      reviewId: dto.reviewId ?? null,
      type: dto.type ?? DevelopmentType.GOAL,
      title: dto.title.trim(),
      description: dto.description ?? null,
      skill: dto.skill ?? null,
      courseId: dto.courseId ?? null,
      courseTitle,
      targetDate: dto.targetDate ? day(dto.targetDate) : null,
      status: DevelopmentStatus.OPEN,
      progress: 0,
      source: as ? 'MANAGER' : this.holdsManage() ? 'HR' : 'MANAGER',
      createdByEmail: as ? as.email : (rpc?.email ?? null),
    } as any);
    await this.audit(tenantId, created.id, 'CREATE', { title: { from: null, to: created.title }, type: { from: null, to: created.type }, employeeId: { from: null, to: employee.id } });
    const recommended = created.type === DevelopmentType.RECOMMENDATION;
    await this.notify(tenantId, employee.id, recommended ? 'A development recommendation for you' : 'A development goal was added for you', `${created.title}. Open My Performance to see it${recommended ? ' and accept or dismiss it' : ''}.`);
    return this.row(created);
  }

  async update(tenantId: string, id: string, dto: UpdateDevelopmentItemDto) {
    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const item: any = await Item.findOne({ where: { id, tenantId } });
    if (!item) this.fail(HttpStatus.NOT_FOUND, 'Development item not found.');
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, item.employeeId, 'Development item');
    return this.row(await this.apply(tenantId, item, dto, true));
  }

  async remove(tenantId: string, id: string) {
    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const item: any = await Item.findOne({ where: { id, tenantId } });
    if (!item) this.fail(HttpStatus.NOT_FOUND, 'Development item not found.');
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, item.employeeId, 'Development item');
    if (item.source === 'SELF') this.fail(HttpStatus.FORBIDDEN, 'The employee created this one; they can drop it themselves.');
    await item.update({ status: DevelopmentStatus.DROPPED });
    await this.audit(tenantId, id, 'UPDATE', { status: { from: item.status, to: DevelopmentStatus.DROPPED } });
    return { id, status: DevelopmentStatus.DROPPED };
  }

  private async apply(tenantId: string, item: any, dto: UpdateDevelopmentItemDto, manager: boolean) {
    if (FINISHED.includes(item.status) && !manager) this.fail(HttpStatus.CONFLICT, `This item is ${String(item.status).toLowerCase()}.`);
    const patch: Record<string, unknown> = {};
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const set = (key: string, next: unknown) => {
      if ((item[key] ?? null) !== (next ?? null)) {
        patch[key] = next;
        diff[key] = { from: item[key] ?? null, to: next ?? null };
      }
    };
    if (dto.title !== undefined || dto.description !== undefined) {
      if (!manager && item.source !== 'SELF') this.fail(HttpStatus.FORBIDDEN, 'You can change only the progress and status of something your manager or HR set.');
      if (dto.title !== undefined) set('title', dto.title.trim());
      if (dto.description !== undefined) set('description', dto.description);
    }
    if (dto.targetDate !== undefined) {
      if (!manager && item.source !== 'SELF') this.fail(HttpStatus.FORBIDDEN, 'You can change only the progress and status of something your manager or HR set.');
      set('targetDate', dto.targetDate ? day(dto.targetDate) : null);
    }
    if (item.type === DevelopmentType.RECOMMENDATION && item.status === DevelopmentStatus.OPEN && (dto.progress !== undefined || dto.status !== undefined)) {
      this.fail(HttpStatus.CONFLICT, 'Accept the recommendation first, or dismiss it.');
    }
    if (dto.note !== undefined) set('note', dto.note);
    if (dto.status !== undefined) {
      if (dto.status === DevelopmentStatus.DISMISSED) this.fail(HttpStatus.BAD_REQUEST, 'Dismiss a recommendation with the dismiss action.');
      if (item.type === DevelopmentType.RECOMMENDATION && item.status === DevelopmentStatus.OPEN) this.fail(HttpStatus.CONFLICT, 'Accept the recommendation first, or dismiss it.');
      set('status', dto.status);
      if (dto.status === DevelopmentStatus.DONE) {
        set('progress', 100);
        patch.completedAt = new Date();
      } else if (item.status === DevelopmentStatus.DONE) {
        patch.completedAt = null;
      }
    }
    if (dto.progress !== undefined && patch.progress === undefined) {
      set('progress', dto.progress);
      if (dto.status === undefined && FINISHED.includes(item.status) === false) {
        if (dto.progress >= 100) {
          set('status', DevelopmentStatus.DONE);
          patch.completedAt = new Date();
        } else if (dto.progress > 0 && item.status === DevelopmentStatus.OPEN) {
          set('status', DevelopmentStatus.IN_PROGRESS);
        }
      }
    }
    if (!Object.keys(patch).length) return item;
    await item.update(patch);
    await this.audit(tenantId, item.id, 'UPDATE', diff);
    return item;
  }

  // ==========================================
  // The employee
  // ==========================================

  async myList(tenantId: string, userId: string, email: string | undefined, query: GetDevelopmentQueryDto) {
    const me = await this.me(tenantId, userId, email);
    return this.findForEmployee(tenantId, me.id, query);
  }

  async myCreate(tenantId: string, userId: string, email: string | undefined, dto: CreateMyDevelopmentItemDto) {
    const me = await this.me(tenantId, userId, email);
    const courseTitle = await this.courseTitle(tenantId, dto.courseId);
    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const created: any = await Item.create({
      tenantId,
      employeeId: me.id,
      type: DevelopmentType.GOAL,
      title: dto.title.trim(),
      description: dto.description ?? null,
      skill: dto.skill ?? null,
      courseId: dto.courseId ?? null,
      courseTitle,
      targetDate: dto.targetDate ? day(dto.targetDate) : null,
      status: DevelopmentStatus.OPEN,
      progress: 0,
      source: 'SELF',
      createdByEmail: email ?? null,
    } as any);
    await this.audit(tenantId, created.id, 'CREATE', { title: { from: null, to: created.title }, source: { from: null, to: 'SELF' } });
    return this.row(created);
  }

  private async mine(tenantId: string, userId: string, email: string | undefined, id: string) {
    const me = await this.me(tenantId, userId, email);
    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const item: any = await Item.findOne({ where: { id, tenantId, employeeId: me.id } });
    if (!item) this.fail(HttpStatus.NOT_FOUND, 'Development item not found.');
    return item;
  }

  async myUpdate(tenantId: string, userId: string, email: string | undefined, id: string, dto: UpdateDevelopmentItemDto) {
    const item = await this.mine(tenantId, userId, email, id);
    return this.row(await this.apply(tenantId, item, dto, false));
  }

  /** The employee takes up a recommendation: it becomes one of their goals. */
  async myAccept(tenantId: string, userId: string, email: string | undefined, id: string) {
    const item = await this.mine(tenantId, userId, email, id);
    if (item.type !== DevelopmentType.RECOMMENDATION || item.status !== DevelopmentStatus.OPEN) this.fail(HttpStatus.CONFLICT, 'Only an open recommendation can be accepted.');
    await item.update({ type: DevelopmentType.GOAL, status: DevelopmentStatus.OPEN });
    await this.audit(tenantId, id, 'UPDATE', { type: { from: DevelopmentType.RECOMMENDATION, to: DevelopmentType.GOAL } });
    return this.row(item);
  }

  async myDismiss(tenantId: string, userId: string, email: string | undefined, id: string) {
    const item = await this.mine(tenantId, userId, email, id);
    if (item.type !== DevelopmentType.RECOMMENDATION || item.status !== DevelopmentStatus.OPEN) this.fail(HttpStatus.CONFLICT, 'Only an open recommendation can be dismissed.');
    await item.update({ status: DevelopmentStatus.DISMISSED });
    await this.audit(tenantId, id, 'UPDATE', { status: { from: DevelopmentStatus.OPEN, to: DevelopmentStatus.DISMISSED } });
    return this.row(item);
  }

  /** What the Employee Performance Profile shows: counts and the open items. */
  async summaryFor(tenantId: string, employeeId: string) {
    const Item = await this.modelProvider.getDevelopmentItemModel(tenantId);
    const rows = (await Item.findAll({ where: { tenantId, employeeId } as any, limit: 200 })) as any[];
    const open = rows.filter((row) => !FINISHED.includes(row.status));
    return { open: open.length, done: rows.filter((row) => row.status === DevelopmentStatus.DONE).length, items: open.map((row) => this.row(row)) };
  }
}
