import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, UniqueConstraintError } from 'sequelize';
import {
  CompleteMyLearningDto,
  GetMyLearningHistoryQueryDto,
  GetMyLearningQueryDto,
  LearningActorDto,
  TenantErrorCode,
  TenantException,
  TrainingAssignmentStatus,
  TrainingAssignmentViewStatus,
  TrainingMaterialKind,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { LearningNotificationService } from './learning-notification.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { todayIso } from './workspace-shared';
import { OPEN_ASSIGNMENT_STATUSES, assignmentCore, finishedLate, progressFor } from './learning-shared';

/** The newest this many of a person's courses are on My Learning; the rest are in their history. */
const MY_LEARNING_LIMIT = 200;
/** What comes first on My Learning: what is late, then what is under way, then what is waiting, then what is done. */
const GROUP_ORDER: Record<string, number> = { OVERDUE: 0, IN_PROGRESS: 1, NOT_STARTED: 2, COMPLETED: 3 };

/**
 * The employee's side of Learning: the courses they have been given, working
 * through them, and finishing them. Every call starts from the employee linked
 * to the signed-in login, found the way the rest of the employee portal finds
 * "me", so there is no way to name someone else's course. A cancelled
 * assignment is not shown: it is no longer theirs to do.
 */
@Injectable()
export class LearningSelfService {
  private readonly logger = new Logger(LearningSelfService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly notifier?: LearningNotificationService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  /** The employee behind this login: by login id, then by email. */
  async me(actor: LearningActorDto) {
    const { tenantId, userId, email } = actor;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName'] }) : null;
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName'] });
    }
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  /** One of my own assignments that has not been cancelled; anyone else's looks like it is not there. */
  private async mine(tenantId: string, employeeId: string, assignmentId: string) {
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const assignment: any = await Assignment.findOne({
      where: { id: assignmentId, tenantId, employeeId, status: { [Op.ne]: TrainingAssignmentStatus.CANCELLED } },
      include: [{ model: Course, as: 'course', attributes: ['id', 'title', 'category', 'description', 'estimatedMinutes', 'requireAllMaterials', 'status'], required: false }],
    });
    if (!assignment) this.fail(HttpStatus.NOT_FOUND, `Course assignment '${assignmentId}' is not one of yours.`);
    return assignment;
  }

  private courseSummary(assignment: any) {
    const course = assignment.course;
    return {
      id: assignment.courseId as string,
      title: (course?.title ?? assignment.courseTitle) as string,
      category: (course?.category ?? null) as string | null,
      description: (course?.description ?? null) as string | null,
      estimatedMinutes: (course?.estimatedMinutes ?? null) as number | null,
    };
  }

  // ==========================================
  // My Learning
  // ==========================================

  /** My courses: what needs doing first, with a count per status. */
  async getMine(actor: LearningActorDto, query: GetMyLearningQueryDto = {}) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const today = todayIso();

    const assignments = (await Assignment.findAll({
      where: { tenantId, employeeId: employee.id, status: { [Op.ne]: TrainingAssignmentStatus.CANCELLED } },
      include: [{ model: Course, as: 'course', attributes: ['id', 'title', 'category', 'description', 'estimatedMinutes'], required: false }],
      order: [['createdAt', 'DESC']],
      limit: MY_LEARNING_LIMIT,
    })) as any[];

    const progress = await progressFor(this.modelProvider, tenantId, assignments);
    const all = assignments.map((assignment) => ({
      ...assignmentCore(assignment, today),
      course: this.courseSummary(assignment),
      progress: progress.get(assignment.id) ?? { opened: 0, total: 0, percent: 0 },
    }));

    const countOf = (status: string) => all.filter((row) => row.status === status).length;
    const summary = {
      total: all.length,
      notStarted: countOf(TrainingAssignmentViewStatus.NOT_STARTED),
      inProgress: countOf(TrainingAssignmentViewStatus.IN_PROGRESS),
      completed: countOf(TrainingAssignmentViewStatus.COMPLETED),
      overdue: countOf(TrainingAssignmentViewStatus.OVERDUE),
    };

    const term = query.search?.trim().toLowerCase();
    const shown = all
      .filter((row) => !query.status || query.status === 'ALL' || (row.status as string) === query.status)
      .filter((row) => !term || row.courseTitle.toLowerCase().includes(term) || (row.course.category ?? '').toLowerCase().includes(term))
      .sort((a, b) => {
        const group = GROUP_ORDER[a.status] - GROUP_ORDER[b.status];
        if (group) return group;
        if (a.status === TrainingAssignmentViewStatus.COMPLETED) return String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? ''));
        // Soonest due first; nothing due last.
        return (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31');
      });

    return { data: shown, summary };
  }

  /** One of my courses: its materials, and which of them I have opened. */
  async getMineOne(actor: LearningActorDto, assignmentId: string) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    return this.detail(tenantId, await this.mine(tenantId, employee.id, assignmentId));
  }

  private async detail(tenantId: string, assignment: any) {
    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
    const Progress = await this.modelProvider.getTrainingProgressModel(tenantId);
    const [materials, opened] = await Promise.all([
      Material.findAll({ where: { tenantId, courseId: assignment.courseId }, order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']] }) as Promise<any[]>,
      Progress.findAll({ where: { tenantId, assignmentId: assignment.id }, attributes: ['materialId', 'openedAt'] }) as Promise<any[]>,
    ]);
    const openedAt = new Map(opened.map((row) => [row.materialId, row.openedAt]));
    const done = materials.filter((material) => openedAt.has(material.id)).length;
    const requireAll = assignment.course?.requireAllMaterials === true;
    const unopenedRequired = materials.filter((material) => material.required !== false && !openedAt.has(material.id)).length;
    const open = OPEN_ASSIGNMENT_STATUSES.includes(assignment.status);

    return {
      ...assignmentCore(assignment, todayIso()),
      course: this.courseSummary(assignment),
      completionNote: assignment.completionNote ?? null,
      progress: { opened: done, total: materials.length, percent: materials.length ? Math.round((done / materials.length) * 100) : 0 },
      // Whether finishing needs every required material opened first, and how many are still to open.
      requiresAllMaterials: requireAll,
      requiredMaterialsLeft: requireAll ? unopenedRequired : 0,
      canComplete: open && (!requireAll || unopenedRequired === 0),
      materials: materials.map((material) => ({
        id: material.id,
        kind: material.kind as TrainingMaterialKind,
        title: material.title,
        url: material.url ?? null,
        fileName: material.fileName ?? null,
        mimeType: material.mimeType ?? null,
        sizeBytes: material.sizeBytes === null || material.sizeBytes === undefined ? null : Number(material.sizeBytes),
        required: material.required !== false,
        opened: openedAt.has(material.id),
        openedAt: openedAt.get(material.id) ?? null,
        downloadPath: material.kind === TrainingMaterialKind.FILE ? `/organization/me/learning/${assignment.id}/materials/${material.id}/download` : null,
      })),
    };
  }

  // ==========================================
  // Working through a course
  // ==========================================

  /** Under way: the first thing a person does with a course moves it off "not started". */
  private async markStarted(assignment: any) {
    if (assignment.status !== TrainingAssignmentStatus.NOT_STARTED) return;
    await assignment.update({ status: TrainingAssignmentStatus.IN_PROGRESS, startedAt: new Date() });
  }

  /** Records that this material was opened (the first time counts), and starts the course. Nothing changes once it is finished. */
  private async recordOpened(tenantId: string, assignment: any, materialId: string) {
    if (!OPEN_ASSIGNMENT_STATUSES.includes(assignment.status)) return;
    const Progress = await this.modelProvider.getTrainingProgressModel(tenantId);
    const existing = await Progress.findOne({ where: { assignmentId: assignment.id, materialId }, attributes: ['id'] });
    if (!existing) {
      try {
        await Progress.create({ tenantId, assignmentId: assignment.id, materialId, openedAt: new Date() } as any);
      } catch (error) {
        // Opened twice at once: the other one counted.
        if (!(error instanceof UniqueConstraintError)) throw error;
      }
    }
    await this.markStarted(assignment);
  }

  private async materialOf(tenantId: string, assignment: any, materialId: string) {
    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
    const material: any = await Material.findOne({ where: { id: materialId, courseId: assignment.courseId, tenantId } });
    if (!material) this.fail(HttpStatus.NOT_FOUND, `Material '${materialId}' is not in this course.`);
    return material;
  }

  /** Begin a course without opening anything yet. */
  async start(actor: LearningActorDto, assignmentId: string) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const assignment = await this.mine(tenantId, employee.id, assignmentId);
    await this.markStarted(assignment);
    return this.detail(tenantId, assignment);
  }

  /** "I opened this": marks the material as seen. */
  async openMaterial(actor: LearningActorDto, assignmentId: string, materialId: string) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const assignment = await this.mine(tenantId, employee.id, assignmentId);
    await this.materialOf(tenantId, assignment, materialId);
    await this.recordOpened(tenantId, assignment, materialId);
    return this.detail(tenantId, assignment);
  }

  /** The stored file behind a file material. Downloading it counts as opening it. */
  async getMaterialFile(actor: LearningActorDto, assignmentId: string, materialId: string) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const assignment = await this.mine(tenantId, employee.id, assignmentId);
    const material = await this.materialOf(tenantId, assignment, materialId);
    if (material.kind !== TrainingMaterialKind.FILE || !material.fileId) {
      this.fail(HttpStatus.BAD_REQUEST, 'This material is a link. Open it at its web address.');
    }
    await this.recordOpened(tenantId, assignment, materialId);
    return { fileId: material.fileId as string, fileName: material.fileName as string, mimeType: (material.mimeType ?? null) as string | null };
  }

  /**
   * Marks the course finished. When the course asks for every required
   * material to be opened first, that is checked. A course that is overdue can
   * still be finished; it is then recorded as finished late.
   */
  async complete(actor: LearningActorDto, assignmentId: string, dto: CompleteMyLearningDto) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const assignment = await this.mine(tenantId, employee.id, assignmentId);
    if (assignment.status === TrainingAssignmentStatus.COMPLETED) this.fail(HttpStatus.CONFLICT, 'You have already completed this course.');

    if (assignment.course?.requireAllMaterials === true) {
      const state = await this.detail(tenantId, assignment);
      if (state.requiredMaterialsLeft > 0) {
        this.fail(
          HttpStatus.CONFLICT,
          `Open every required material first (${state.requiredMaterialsLeft} left), then mark the course as completed.`,
        );
      }
    }

    const previous = assignment.status as string;
    const now = new Date();
    await assignment.update({
      status: TrainingAssignmentStatus.COMPLETED,
      completedAt: now,
      startedAt: assignment.startedAt ?? now,
      completionNote: dto.note ?? null,
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_assignments', assignmentId, 'UPDATE', {
      status: { from: previous, to: TrainingAssignmentStatus.COMPLETED },
      ...(finishedLate(assignment) ? { completedLate: { from: null, to: true } } : {}),
    });
    await this.notifier?.completed(tenantId, {
      employeeId: assignment.employeeId,
      courseTitle: assignment.courseTitle,
      mandatory: assignment.mandatory === true,
      dueDate: assignment.dueDate ?? null,
      completedAt: now,
    });
    return this.detail(tenantId, assignment);
  }

  // ==========================================
  // History
  // ==========================================

  /** Everything I have completed, newest first. */
  async getHistory(actor: LearningActorDto, query: GetMyLearningHistoryQueryDto = {}) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;

    const { rows, count } = await Assignment.findAndCountAll({
      where: { tenantId, employeeId: employee.id, status: TrainingAssignmentStatus.COMPLETED },
      order: [['completedAt', 'DESC'], ['id', 'ASC']],
      limit,
      offset: (page - 1) * limit,
    });
    return {
      data: (rows as any[]).map((assignment) => ({
        id: assignment.id as string,
        courseId: assignment.courseId as string,
        courseTitle: assignment.courseTitle as string,
        mandatory: assignment.mandatory === true,
        dueDate: (assignment.dueDate ?? null) as string | null,
        completedAt: assignment.completedAt as Date,
        completedLate: finishedLate(assignment),
        note: (assignment.completionNote ?? null) as string | null,
      })),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }
}
