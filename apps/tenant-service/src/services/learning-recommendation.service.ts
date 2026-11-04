import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, UniqueConstraintError } from 'sequelize';
import {
  ApproveTrainingRecommendationDto,
  CreateTrainingRecommendationDto,
  DismissTrainingRecommendationDto,
  EmployeeStatus,
  GetTrainingRecommendationsQueryDto,
  LearningActorDto,
  TenantErrorCode,
  TenantException,
  TrainingCourseStatus,
  TrainingRecommendationStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { LearningAssignmentService } from './learning-assignment.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { fullName } from './workspace-shared';
import { OPEN_ASSIGNMENT_STATUSES } from './learning-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

/**
 * Suggesting a course for someone, usually after a performance review, and
 * HR's answer. A suggestion changes nothing by itself: assigning it makes an
 * ordinary assignment (with the usual due date rules and notification);
 * dismissing it just closes it. Only people the caller can reach are visible.
 */
@Injectable()
export class LearningRecommendationService {
  private readonly logger = new Logger(LearningRecommendationService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly assignments: LearningAssignmentService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, 'employeeId') : {};
  }

  private async includes(tenantId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    return [{ model: Employee, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl'], required: false }];
  }

  private toRow(row: any) {
    return {
      id: row.id as string,
      status: row.status as string,
      employee: row.employee
        ? { employeeId: row.employee.id, name: fullName(row.employee), employeeCode: row.employee.employeeCode ?? null, avatarUrl: row.employee.avatarUrl ?? null }
        : { employeeId: row.employeeId, name: null, employeeCode: null, avatarUrl: null },
      courseId: row.courseId as string,
      courseTitle: row.courseTitle as string,
      reviewId: (row.reviewId ?? null) as string | null,
      reviewCycle: (row.reviewCycle ?? null) as string | null,
      reason: row.reason as string,
      recommendedBy: (row.recommendedByEmail ?? null) as string | null,
      recommendedAt: row.createdAt as Date,
      decidedBy: (row.decidedByEmail ?? null) as string | null,
      decidedAt: (row.decidedAt ?? null) as Date | null,
      dismissReason: (row.dismissReason ?? null) as string | null,
      assignmentId: (row.assignmentId ?? null) as string | null,
    };
  }

  private async findScoped(tenantId: string, recommendationId: string) {
    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    const row: any = await Recommendation.findOne({
      where: { [Op.and]: [{ id: recommendationId, tenantId }, await this.scopeWhere(tenantId)] },
      include: await this.includes(tenantId),
    });
    if (!row) this.fail(HttpStatus.NOT_FOUND, `Recommendation '${recommendationId}' not found in this organization.`);
    return row;
  }

  /** Suggests a published course for someone the caller can reach. */
  async recommend(actor: LearningActorDto, dto: CreateTrainingRecommendationDto) {
    const { tenantId } = actor;
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, dto.employeeId, 'Employee');

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { tenantId, id: dto.employeeId }, attributes: ['id', 'status'] });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, `Employee '${dto.employeeId}' not found in this organization.`);
    if (!EMPLOYED.includes(employee.status)) this.fail(HttpStatus.CONFLICT, 'This person no longer works here.');

    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const course: any = await Course.findOne({ where: { id: dto.courseId, tenantId } });
    if (!course) this.fail(HttpStatus.NOT_FOUND, `Course '${dto.courseId}' not found in this organization.`);
    if (course.status !== TrainingCourseStatus.PUBLISHED) this.fail(HttpStatus.CONFLICT, 'Only a published course can be recommended.');

    let reviewCycle: string | null = null;
    if (dto.reviewId) {
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      const review: any = await Review.findOne({ where: { id: dto.reviewId, tenantId }, attributes: ['id', 'employeeId', 'cycle'] });
      if (!review || review.employeeId !== dto.employeeId) {
        this.fail(HttpStatus.BAD_REQUEST, 'That performance review is not this employee\'s.');
      }
      reviewCycle = review.cycle;
    }

    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const open = await Assignment.count({ where: { tenantId, courseId: course.id, employeeId: dto.employeeId, status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES } } });
    if (open) this.fail(HttpStatus.CONFLICT, 'This person already has this course.');

    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    let created: any;
    try {
      created = await Recommendation.create({
        tenantId,
        employeeId: dto.employeeId,
        courseId: course.id,
        courseTitle: course.title,
        reviewId: dto.reviewId ?? null,
        reviewCycle,
        reason: dto.reason,
        status: TrainingRecommendationStatus.PENDING,
        recommendedByUserId: actor.userId ?? null,
        recommendedByEmail: actor.email ?? null,
      } as any);
    } catch (error) {
      if (error instanceof UniqueConstraintError) this.fail(HttpStatus.CONFLICT, 'This course has already been recommended for this person and is waiting for a decision.');
      throw error;
    }
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_recommendations', created.id, 'CREATE', {
      course: { from: null, to: course.title },
      employeeId: { from: null, to: dto.employeeId },
      reason: { from: null, to: dto.reason },
    });
    return this.toRow(await this.findScoped(tenantId, created.id));
  }

  /** Recommendations for the people the caller can reach, pending first by default. */
  async getRecommendations(tenantId: string, query: GetTrainingRecommendationsQueryDto = {}) {
    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;

    const base: Record<string, unknown> = { tenantId, ...(await this.scopeWhere(tenantId)) };
    if (query.employeeId) base.employeeId = query.employeeId;
    if (query.courseId) base.courseId = query.courseId;
    const status = query.status ?? 'PENDING';
    const where = status === 'ALL' ? base : { ...base, status };

    const countOf = (value: string) => Recommendation.count({ where: { ...base, status: value } as any });
    const [{ rows, count }, pending, assigned, dismissed] = await Promise.all([
      Recommendation.findAndCountAll({
        where: where as any,
        include: await this.includes(tenantId),
        order: [['createdAt', 'DESC'], ['id', 'ASC']],
        limit,
        offset: (page - 1) * limit,
        distinct: true,
      }),
      countOf(TrainingRecommendationStatus.PENDING),
      countOf(TrainingRecommendationStatus.ASSIGNED),
      countOf(TrainingRecommendationStatus.DISMISSED),
    ]);
    return {
      data: (rows as any[]).map((row) => this.toRow(row)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      summary: { pending, assigned, dismissed },
    };
  }

  /** Assigns the course: an ordinary assignment, with the usual due date rules and the person's notification. */
  async approve(actor: LearningActorDto, recommendationId: string, dto: ApproveTrainingRecommendationDto) {
    const { tenantId } = actor;
    const row = await this.findScoped(tenantId, recommendationId);
    if (row.status !== TrainingRecommendationStatus.PENDING) this.fail(HttpStatus.CONFLICT, 'This recommendation has already been decided.');

    const result = await this.assignments.assign(actor, {
      courseId: row.courseId,
      employeeIds: [row.employeeId],
      dueDate: dto.dueDate ?? undefined,
      dueInDays: dto.dueInDays,
      mandatory: dto.mandatory,
    } as any);
    if (!result.created) {
      this.fail(HttpStatus.CONFLICT, 'This person already has this course, or no longer works here. Dismiss the recommendation instead.');
    }

    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const assignment: any = await Assignment.findOne({ where: { tenantId, batchId: result.batchId, employeeId: row.employeeId }, attributes: ['id'] });
    await row.update({
      status: TrainingRecommendationStatus.ASSIGNED,
      decidedByUserId: actor.userId ?? null,
      decidedByEmail: actor.email ?? null,
      decidedAt: new Date(),
      assignmentId: assignment?.id ?? null,
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_recommendations', recommendationId, 'UPDATE', {
      status: { from: TrainingRecommendationStatus.PENDING, to: TrainingRecommendationStatus.ASSIGNED },
    });
    return this.toRow(row);
  }

  /** Closes the suggestion without assigning anything. */
  async dismiss(actor: LearningActorDto, recommendationId: string, dto: DismissTrainingRecommendationDto) {
    const { tenantId } = actor;
    const row = await this.findScoped(tenantId, recommendationId);
    if (row.status !== TrainingRecommendationStatus.PENDING) this.fail(HttpStatus.CONFLICT, 'This recommendation has already been decided.');

    await row.update({
      status: TrainingRecommendationStatus.DISMISSED,
      decidedByUserId: actor.userId ?? null,
      decidedByEmail: actor.email ?? null,
      decidedAt: new Date(),
      dismissReason: dto.reason ?? null,
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_recommendations', recommendationId, 'UPDATE', {
      status: { from: TrainingRecommendationStatus.PENDING, to: TrainingRecommendationStatus.DISMISSED },
    });
    return this.toRow(row);
  }

  /** Someone left: what was waiting for a decision about them is dismissed. */
  async dismissOpenForExit(tenantId: string, employeeId: string): Promise<number> {
    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    const [count] = await Recommendation.update(
      { status: TrainingRecommendationStatus.DISMISSED, decidedAt: new Date(), dismissReason: 'Employee left the organization' } as any,
      { where: { tenantId, employeeId, status: TrainingRecommendationStatus.PENDING } },
    );
    return count;
  }
}
