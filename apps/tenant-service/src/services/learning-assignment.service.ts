import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, UniqueConstraintError, literal } from 'sequelize';
import {
  AssignTrainingDto,
  CancelTrainingAssignmentDto,
  EXPORT_MAX_ROWS,
  EmployeeStatus,
  ExportResult,
  GetTrainingAssignmentsQueryDto,
  LearningActorDto,
  TRAINING_ASSIGN_MAX_PEOPLE,
  TenantErrorCode,
  TenantException,
  TrainingAssignmentSource,
  TrainingAssignmentStatus,
  TrainingCourseStatus,
  UpdateTrainingAssignmentDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields, todayIso } from './workspace-shared';
import { OPEN_ASSIGNMENT_STATUSES, addDays, assignmentCore, progressFor } from './learning-shared';
import { LearningNotificationService } from './learning-notification.service';

/** A mandatory onboarding course with no default gets this long. */
const ONBOARDING_MANDATORY_DAYS = 30;

/** "Due soon" on the bell: due within this many days. */
const DUE_SOON_DAYS = 3;

/** Who can be given a course: people still employed. */
const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const ESCAPE = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
const fullName = (employee: any) => [employee?.firstName, employee?.lastName].filter(Boolean).join(' ');

/**
 * Giving courses to people, and following how they get on.
 *
 * An assignment goes to employees by name, or to everyone currently in a
 * department or holding a designation. That is worked out once, when it is
 * made: someone who joins the department later is not added. Only people the
 * caller's data scope reaches are assigned; the rest are counted and skipped.
 * Whoever already has the course open is skipped too.
 */
@Injectable()
export class LearningAssignmentService {
  private readonly logger = new Logger(LearningAssignmentService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly notifier?: LearningNotificationService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, 'employeeId') : {};
  }

  // ==========================================
  // Assigning
  // ==========================================

  /** The due date this assignment gets: the one given, N days from today, the course's default, or none. */
  private resolveDueDate(dto: AssignTrainingDto, course: any, today: string): string | null {
    if (dto.dueDate && dto.dueInDays) this.fail(HttpStatus.BAD_REQUEST, 'Give a due date or a number of days, not both.');
    if (dto.dueDate) {
      if (dto.dueDate < today) this.fail(HttpStatus.BAD_REQUEST, 'The due date cannot be in the past.');
      return dto.dueDate;
    }
    const days = dto.dueInDays ?? course.defaultDueDays;
    return days ? addDays(today, days) : null;
  }

  /** The department and designation an assignment records as they are today. */
  private async employeeIncludes(tenantId: string) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    return [
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
    ];
  }

  /** Everyone the targets name, with why they were reached: by name beats by department beats by designation. */
  private async expandTargets(tenantId: string, dto: AssignTrainingDto) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const include = await this.employeeIncludes(tenantId);
    const attributes = ['id', 'firstName', 'lastName', 'status', 'departmentId', 'designationId', 'reportingManagerId'];
    const reached = new Map<string, { employee: any; source: TrainingAssignmentSource }>();
    const add = (rows: any[], source: TrainingAssignmentSource) => {
      for (const employee of rows) if (!reached.has(employee.id)) reached.set(employee.id, { employee, source });
    };

    if (dto.employeeIds?.length) {
      const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: dto.employeeIds } }, attributes, include })) as any[];
      if (rows.length !== dto.employeeIds.length) this.fail(HttpStatus.BAD_REQUEST, 'A selected employee was not found in this organization.');
      add(rows, TrainingAssignmentSource.DIRECT);
    }
    if (dto.departmentIds?.length) {
      const found = await Department.count({ where: { tenantId, id: { [Op.in]: dto.departmentIds } } });
      if (found !== dto.departmentIds.length) this.fail(HttpStatus.BAD_REQUEST, 'A selected department was not found in this organization.');
      add(
        (await Employee.findAll({ where: { tenantId, departmentId: { [Op.in]: dto.departmentIds }, status: { [Op.in]: EMPLOYED } }, attributes, include })) as any[],
        TrainingAssignmentSource.DEPARTMENT,
      );
    }
    if (dto.designationIds?.length) {
      const found = await Designation.count({ where: { tenantId, id: { [Op.in]: dto.designationIds } } });
      if (found !== dto.designationIds.length) this.fail(HttpStatus.BAD_REQUEST, 'A selected designation was not found in this organization.');
      add(
        (await Employee.findAll({ where: { tenantId, designationId: { [Op.in]: dto.designationIds }, status: { [Op.in]: EMPLOYED } }, attributes, include })) as any[],
        TrainingAssignmentSource.DESIGNATION,
      );
    }
    if (reached.size > TRAINING_ASSIGN_MAX_PEOPLE) {
      this.fail(HttpStatus.BAD_REQUEST, `That reaches ${reached.size} people. Narrow it to at most ${TRAINING_ASSIGN_MAX_PEOPLE}.`);
    }
    return reached;
  }

  /**
   * Assigns a published course. Returns how many people got it and how many
   * were skipped, and why: they already have it open, they are outside what the
   * caller can reach, or they no longer work here.
   */
  async assign(actor: LearningActorDto, dto: AssignTrainingDto) {
    const { tenantId } = actor;
    if (!dto.employeeIds?.length && !dto.departmentIds?.length && !dto.designationIds?.length) {
      this.fail(HttpStatus.BAD_REQUEST, 'Choose who to assign the course to: employees, departments or designations.');
    }

    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const course: any = await Course.findOne({ where: { id: dto.courseId, tenantId } });
    if (!course) this.fail(HttpStatus.NOT_FOUND, `Course '${dto.courseId}' not found in this organization.`);
    if (course.status !== TrainingCourseStatus.PUBLISHED) {
      this.fail(HttpStatus.CONFLICT, course.status === TrainingCourseStatus.ARCHIVED ? 'This course is archived. Restore it to assign it.' : 'Publish the course before assigning it.');
    }

    const today = todayIso();
    const mandatory = dto.mandatory ?? course.mandatoryByDefault === true;
    const dueDate = this.resolveDueDate(dto, course, today);
    if (mandatory && !dueDate) this.fail(HttpStatus.BAD_REQUEST, 'A mandatory course needs a due date.');

    const reached = await this.expandTargets(tenantId, dto);
    const skipped = { alreadyAssigned: 0, notInScope: 0, inactive: 0 };
    const visible = this.dataScope ? await this.dataScope.visibleEmployeeIds(tenantId) : null;

    let eligible = [...reached.values()];
    eligible = eligible.filter(({ employee }) => {
      if (!EMPLOYED.includes(employee.status)) {
        skipped.inactive++;
        return false;
      }
      if (visible !== null && !visible.includes(employee.id)) {
        skipped.notInScope++;
        return false;
      }
      return true;
    });

    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    if (eligible.length) {
      const open = (await Assignment.findAll({
        where: { tenantId, courseId: course.id, employeeId: { [Op.in]: eligible.map(({ employee }) => employee.id) }, status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES } },
        attributes: ['employeeId'],
        raw: true,
      })) as unknown as { employeeId: string }[];
      const have = new Set(open.map((row) => row.employeeId));
      eligible = eligible.filter(({ employee }) => {
        if (!have.has(employee.id)) return true;
        skipped.alreadyAssigned++;
        return false;
      });
    }

    const batchId = randomUUID();
    if (eligible.length) {
      try {
        await Assignment.sequelize!.transaction(async (transaction) => {
          await Assignment.bulkCreate(
            eligible.map(({ employee, source }) => ({
              tenantId,
              courseId: course.id,
              courseTitle: course.title,
              employeeId: employee.id,
              departmentId: employee.departmentId ?? null,
              departmentName: employee.department?.name ?? null,
              designationTitle: employee.designation?.title ?? null,
              reportingManagerId: employee.reportingManagerId ?? null,
              source,
              batchId,
              mandatory,
              dueDate,
              status: TrainingAssignmentStatus.NOT_STARTED,
              assignedByUserId: actor.userId ?? null,
              assignedByEmail: actor.email ?? null,
            })) as any[],
            { transaction },
          );
        });
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          this.fail(HttpStatus.CONFLICT, 'Someone else has just assigned this course to some of these people. Try again.');
        }
        throw error;
      }
      await writeAudit(this.modelProvider, this.logger, tenantId, 'training_assignments', batchId, 'CREATE', {
        course: { from: null, to: course.title },
        assigned: { from: null, to: eligible.length },
        dueDate: { from: null, to: dueDate },
        mandatory: { from: null, to: mandatory },
      });
      await this.notifier?.assigned(
        tenantId,
        eligible.map(({ employee }) => ({ employeeId: employee.id as string, courseTitle: course.title as string, mandatory, dueDate })),
      );
    }

    return { batchId, courseId: course.id, courseTitle: course.title as string, mandatory, dueDate, created: eligible.length, skipped };
  }

  // ==========================================
  // Reading
  // ==========================================

  private async includes(tenantId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    return [{ model: Employee, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl'], required: false }];
  }

  /** The filters the list and its counts share: who the caller can reach, and what was asked for (but not the status). */
  private async baseWhere(tenantId: string, query: GetTrainingAssignmentsQueryDto) {
    const where: Record<string | symbol, unknown> = { tenantId, ...(await this.scopeWhere(tenantId)) };
    if (query.courseId) where.courseId = query.courseId;
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.mandatory !== undefined) where.mandatory = query.mandatory;
    return where;
  }

  /** One status as a query: overdue is an open assignment past its due date, so "not started" and "in progress" leave those out. */
  private statusWhere(status: string | undefined, today: string): Record<string | symbol, unknown> {
    switch (status) {
      case 'OVERDUE':
        return { status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES }, dueDate: { [Op.lt]: today } };
      case 'NOT_STARTED':
      case 'IN_PROGRESS':
        return { status, [Op.and]: [{ [Op.or]: [{ dueDate: null }, { dueDate: { [Op.gte]: today } }] }] };
      case 'COMPLETED':
      case 'CANCELLED':
        return { status };
      default:
        return {};
    }
  }

  private order(query: GetTrainingAssignmentsQueryDto): any[] {
    const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    switch (query.sortBy) {
      case 'dueDate':
        return [[literal(`"TrainingAssignment"."dueDate" ${direction} NULLS LAST`)], ['createdAt', 'DESC']];
      case 'employeeName':
        return [[literal(`"employee"."firstName" ${direction}`)], [literal(`"employee"."lastName" ${direction}`)], ['createdAt', 'DESC']];
      case 'courseTitle':
        return [['courseTitle', direction], ['createdAt', 'DESC']];
      case 'status':
        return [['status', direction], [literal('"TrainingAssignment"."dueDate" ASC NULLS LAST')]];
      default:
        return [['createdAt', direction], ['id', 'ASC']];
    }
  }

  toRow(assignment: any, today: string, progress?: { opened: number; total: number; percent: number }) {
    return {
      ...assignmentCore(assignment, today),
      employee: assignment.employee
        ? {
            employeeId: assignment.employee.id,
            name: fullName(assignment.employee),
            employeeCode: assignment.employee.employeeCode ?? null,
            avatarUrl: assignment.employee.avatarUrl ?? null,
          }
        : { employeeId: assignment.employeeId, name: null, employeeCode: null, avatarUrl: null },
      // What was true when it was assigned.
      department: assignment.departmentName ?? null,
      designation: assignment.designationTitle ?? null,
      assignedBy: assignment.assignedByEmail ?? null,
      progress: progress ?? { opened: 0, total: 0, percent: 0 },
    };
  }

  /** What the list and the export filter on: who the caller can reach, plus the status and search asked for. */
  private async listWhere(tenantId: string, query: GetTrainingAssignmentsQueryDto, today: string) {
    const base = await this.baseWhere(tenantId, query);
    const and: any[] = [base, this.statusWhere(query.status && query.status !== 'ALL' ? query.status : undefined, today)];
    const term = query.search?.trim();
    if (term) {
      const like = `%${ESCAPE(term)}%`;
      and.push({
        [Op.or]: [
          { courseTitle: { [Op.iLike]: like } },
          { '$employee.firstName$': { [Op.iLike]: like } },
          { '$employee.lastName$': { [Op.iLike]: like } },
          { '$employee.employeeCode$': { [Op.iLike]: like } },
        ],
      });
    }
    return { base, where: { [Op.and]: and } };
  }

  /** Every assignment matching the filters, up to the export cap. */
  async exportAssignments(tenantId: string, query: GetTrainingAssignmentsQueryDto = {}): Promise<ExportResult<ReturnType<LearningAssignmentService['toRow']>>> {
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const today = todayIso();
    const { where } = await this.listWhere(tenantId, query, today);
    const { rows, count } = await Assignment.findAndCountAll({
      where,
      include: await this.includes(tenantId),
      order: this.order(query),
      limit: EXPORT_MAX_ROWS,
      distinct: true,
    });
    return {
      rows: (rows as any[]).map((assignment) => this.toRow(assignment, today)),
      totalMatched: count,
      truncated: count > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  /** Assignments the caller can reach, filtered, searched, sorted and paged, with a count per status. */
  async getAssignments(tenantId: string, query: GetTrainingAssignmentsQueryDto = {}) {
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;
    const today = todayIso();

    const { base, where } = await this.listWhere(tenantId, query, today);

    const include = await this.includes(tenantId);
    const countOf = (status: string) => Assignment.count({ where: { [Op.and]: [base, this.statusWhere(status, today)] } as any });
    const [{ rows, count }, notStarted, inProgress, completed, overdue] = await Promise.all([
      Assignment.findAndCountAll({ where, include, order: this.order(query), limit, offset: (page - 1) * limit, distinct: true }),
      countOf('NOT_STARTED'),
      countOf('IN_PROGRESS'),
      countOf('COMPLETED'),
      countOf('OVERDUE'),
    ]);

    const progress = await progressFor(this.modelProvider, tenantId, rows as any[]);
    return {
      data: (rows as any[]).map((assignment) => this.toRow(assignment, today, progress.get(assignment.id))),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      summary: { notStarted, inProgress, completed, overdue },
    };
  }

  private async findScoped(tenantId: string, assignmentId: string) {
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const assignment: any = await Assignment.findOne({
      where: { [Op.and]: [{ id: assignmentId, tenantId }, await this.scopeWhere(tenantId)] },
      include: await this.includes(tenantId),
    });
    if (!assignment) this.fail(HttpStatus.NOT_FOUND, `Assignment '${assignmentId}' not found in this organization.`);
    return assignment;
  }

  /** One assignment with which materials the person has opened. */
  async getAssignment(tenantId: string, assignmentId: string) {
    const assignment = await this.findScoped(tenantId, assignmentId);
    return this.detail(tenantId, assignment);
  }

  private async detail(tenantId: string, assignment: any) {
    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
    const Progress = await this.modelProvider.getTrainingProgressModel(tenantId);
    const [materials, opened] = await Promise.all([
      Material.findAll({ where: { tenantId, courseId: assignment.courseId }, order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']] }) as Promise<any[]>,
      Progress.findAll({ where: { tenantId, assignmentId: assignment.id }, attributes: ['materialId', 'openedAt'] }) as Promise<any[]>,
    ]);
    const openedAt = new Map(opened.map((row) => [row.materialId, row.openedAt]));
    const today = todayIso();
    const done = materials.filter((material) => openedAt.has(material.id)).length;
    return {
      ...this.toRow(assignment, today, { opened: done, total: materials.length, percent: materials.length ? Math.round((done / materials.length) * 100) : 0 }),
      completionNote: assignment.completionNote ?? null,
      cancelledAt: assignment.cancelledAt ?? null,
      cancelReason: assignment.cancelReason ?? null,
      materials: materials.map((material) => ({
        id: material.id,
        kind: material.kind,
        title: material.title,
        required: material.required !== false,
        opened: openedAt.has(material.id),
        openedAt: openedAt.get(material.id) ?? null,
      })),
    };
  }

  // ==========================================
  // Changing
  // ==========================================

  private assertOpen(assignment: any) {
    if (assignment.status === TrainingAssignmentStatus.COMPLETED) {
      this.fail(HttpStatus.CONFLICT, 'This course is completed. A completed course stays on record and cannot be changed.');
    }
    if (assignment.status === TrainingAssignmentStatus.CANCELLED) this.fail(HttpStatus.CONFLICT, 'This assignment was cancelled.');
  }

  /** Moves the due date, or makes it mandatory or optional. A mandatory assignment always has a due date. */
  async updateAssignment(actor: LearningActorDto, assignmentId: string, dto: UpdateTrainingAssignmentDto) {
    const { tenantId } = actor;
    const assignment = await this.findScoped(tenantId, assignmentId);
    this.assertOpen(assignment);

    const today = todayIso();
    const dueDate = dto.dueDate !== undefined ? dto.dueDate : assignment.dueDate;
    const mandatory = dto.mandatory !== undefined ? dto.mandatory : assignment.mandatory === true;
    if (dto.dueDate && dto.dueDate < today) this.fail(HttpStatus.BAD_REQUEST, 'The due date cannot be in the past.');
    if (mandatory && !dueDate) this.fail(HttpStatus.BAD_REQUEST, 'A mandatory course needs a due date.');

    const changes = diffFields({ dueDate: assignment.dueDate ?? null, mandatory: assignment.mandatory === true }, { dueDate, mandatory });
    if (Object.keys(changes).length) {
      // A new due date means the reminders are due afresh.
      await assignment.update({ dueDate, mandatory, ...('dueDate' in changes ? { remindersSent: [], overdueNoticeSent: false } : {}) });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'training_assignments', assignmentId, 'UPDATE', changes);
      await this.notifier?.changed(
        tenantId,
        { employeeId: assignment.employeeId, courseTitle: assignment.courseTitle, mandatory, dueDate: dueDate ?? null },
        { dueDate: 'dueDate' in changes, mandatory: 'mandatory' in changes },
      );
    }
    return this.detail(tenantId, assignment);
  }

  /** Withdraws a course that has not been finished. What was finished is never undone. */
  async cancelAssignment(actor: LearningActorDto, assignmentId: string, dto: CancelTrainingAssignmentDto) {
    const { tenantId } = actor;
    const assignment = await this.findScoped(tenantId, assignmentId);
    this.assertOpen(assignment);

    const previous = assignment.status as string;
    await assignment.update({ status: TrainingAssignmentStatus.CANCELLED, cancelledAt: new Date(), cancelReason: dto.reason ?? null });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_assignments', assignmentId, 'UPDATE', {
      status: { from: previous, to: TrainingAssignmentStatus.CANCELLED },
    });
    await this.notifier?.cancelled(tenantId, { employeeId: assignment.employeeId, courseTitle: assignment.courseTitle }, dto.reason);
    return this.detail(tenantId, assignment);
  }

  /** The bell for the people who run Learning: what needs attention among the people they can reach. */
  async getAlerts(tenantId: string) {
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const today = todayIso();
    const soon = addDays(today, DUE_SOON_DAYS);
    const base = { tenantId, ...(await this.scopeWhere(tenantId)) };
    const open = { status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES } };
    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    const [overdue, mandatoryOverdue, dueSoon, pendingRecommendations] = await Promise.all([
      Assignment.count({ where: { ...base, ...open, dueDate: { [Op.lt]: today } } as any }),
      Assignment.count({ where: { ...base, ...open, mandatory: true, dueDate: { [Op.lt]: today } } as any }),
      Assignment.count({ where: { ...base, ...open, dueDate: { [Op.gte]: today, [Op.lte]: soon } } as any }),
      Recommendation.count({ where: { ...base, status: 'PENDING' } as any }),
    ]);
    return { overdue, mandatoryOverdue, dueSoon, dueSoonDays: DUE_SOON_DAYS, pendingRecommendations, total: overdue + dueSoon + pendingRecommendations };
  }

  /**
   * A person's whole training record for their profile: what they have now,
   * what they finished, what was withdrawn. Newest first. Only for someone
   * the caller can reach.
   */
  async getForEmployee(tenantId: string, employeeId: string, query: { page?: number; limit?: number } = {}) {
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, employeeId, 'Employee');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const person: any = await Employee.findOne({ where: { tenantId, id: employeeId }, attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl'] });
    if (!person) this.fail(HttpStatus.NOT_FOUND, `Employee '${employeeId}' not found in this organization.`);

    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;
    const today = todayIso();
    const base = { tenantId, employeeId };
    const countOf = (status: string) => Assignment.count({ where: { [Op.and]: [base, this.statusWhere(status, today)] } as any });

    const [{ rows, count }, notStarted, inProgress, completed, overdue, cancelled] = await Promise.all([
      Assignment.findAndCountAll({ where: base, include: await this.includes(tenantId), order: [['createdAt', 'DESC'], ['id', 'ASC']], limit, offset: (page - 1) * limit, distinct: true }),
      countOf('NOT_STARTED'),
      countOf('IN_PROGRESS'),
      countOf('COMPLETED'),
      countOf('OVERDUE'),
      countOf('CANCELLED'),
    ]);
    const progress = await progressFor(this.modelProvider, tenantId, rows as any[]);
    return {
      employee: { employeeId: person.id, name: fullName(person), employeeCode: person.employeeCode ?? null, avatarUrl: person.avatarUrl ?? null },
      data: (rows as any[]).map((assignment) => this.toRow(assignment, today, progress.get(assignment.id))),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      summary: { notStarted, inProgress, completed, overdue, cancelled },
    };
  }

  /**
   * Everything a new joiner is given: each published course marked "assign on
   * join". Due dates count from today; a mandatory course with no default gets
   * 30 days. Best effort and quiet on failure: the employee already exists.
   */
  async autoAssignOnJoin(tenantId: string, employeeId: string): Promise<number> {
    try {
      const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
      const courses: any[] = (await Course.findAll({
        where: { tenantId, status: TrainingCourseStatus.PUBLISHED, autoAssignOnJoin: true },
        order: [['title', 'ASC']],
      })) as any[];
      if (!courses.length) return 0;

      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const employee: any = await Employee.findOne({ where: { tenantId, id: employeeId }, include: await this.employeeIncludes(tenantId) });
      if (!employee || !EMPLOYED.includes(employee.status)) return 0;

      const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
      const have = new Set(
        ((await Assignment.findAll({
          where: { tenantId, employeeId, courseId: { [Op.in]: courses.map((course) => course.id) }, status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES } },
          attributes: ['courseId'],
          raw: true,
        })) as unknown as { courseId: string }[]).map((row) => row.courseId),
      );

      const today = todayIso();
      const batchId = randomUUID();
      const rows = courses
        .filter((course) => !have.has(course.id))
        .map((course) => {
          const mandatory = course.mandatoryByDefault === true;
          const days = course.defaultDueDays ?? (mandatory ? ONBOARDING_MANDATORY_DAYS : null);
          return {
            tenantId,
            courseId: course.id,
            courseTitle: course.title,
            employeeId,
            departmentId: employee.departmentId ?? null,
            departmentName: employee.department?.name ?? null,
            designationTitle: employee.designation?.title ?? null,
            reportingManagerId: employee.reportingManagerId ?? null,
            source: TrainingAssignmentSource.ONBOARDING,
            batchId,
            mandatory,
            dueDate: days ? addDays(today, days) : null,
            status: TrainingAssignmentStatus.NOT_STARTED,
            assignedByUserId: null,
            assignedByEmail: null,
          };
        });
      if (!rows.length) return 0;

      await Assignment.bulkCreate(rows as any[]);
      await writeAudit(this.modelProvider, this.logger, tenantId, 'training_assignments', batchId, 'CREATE', {
        onboarding: { from: null, to: rows.map((row) => row.courseTitle).join(', ') },
        employeeId: { from: null, to: employeeId },
      });
      await this.notifier?.assigned(tenantId, rows.map((row) => ({ employeeId, courseTitle: row.courseTitle, mandatory: row.mandatory, dueDate: row.dueDate })));
      return rows.length;
    } catch (error: any) {
      this.logger.warn(`Onboarding courses were not assigned to ${employeeId}: ${error?.message ?? error}`);
      return 0;
    }
  }

  /**
   * Someone left: whatever they had not finished is withdrawn. What they
   * completed stays on record. No notification, they are gone.
   */
  async cancelOpenForExit(tenantId: string, employeeId: string): Promise<number> {
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    // Suggestions still waiting for a decision about them are closed too.
    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    await Recommendation.update(
      { status: 'DISMISSED', decidedAt: new Date(), dismissReason: 'Employee left the organization' } as any,
      { where: { tenantId, employeeId, status: 'PENDING' } },
    );
    const open: any[] = (await Assignment.findAll({ where: { tenantId, employeeId, status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES } }, attributes: ['id'] })) as any[];
    if (!open.length) return 0;
    await Assignment.update(
      { status: TrainingAssignmentStatus.CANCELLED, cancelledAt: new Date(), cancelReason: 'Employee left the organization' } as any,
      { where: { tenantId, id: { [Op.in]: open.map((row) => row.id) } } },
    );
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_assignments', employeeId, 'UPDATE', {
      openCoursesWithdrawn: { from: open.length, to: 0 },
    });
    return open.length;
  }

  /** How many training records these people have: a person with any cannot be deleted, only made to leave. */
  async countFor(tenantId: string, employeeIds: string[]): Promise<number> {
    if (!employeeIds.length) return 0;
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    const [assigned, recommended] = await Promise.all([
      Assignment.count({ where: { tenantId, employeeId: { [Op.in]: employeeIds } } }),
      Recommendation.count({ where: { tenantId, employeeId: { [Op.in]: employeeIds } } }),
    ]);
    return assigned + recommended;
  }
}
