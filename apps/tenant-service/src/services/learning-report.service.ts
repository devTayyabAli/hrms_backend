import { Injectable, Optional } from '@nestjs/common';
import { Op, literal, fn, col } from 'sequelize';
import { GetLearningReportQueryDto, LearningReportGroup, TrainingCourseStatus } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { OPEN_ASSIGNMENT_STATUSES, addDays } from './learning-shared';
import { todayIso } from './workspace-shared';

/** Cancelled assignments are not results: they were withdrawn, not missed. */
const COUNTED = { status: { [Op.ne]: 'CANCELLED' } };
const percent = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const REPORT_ROWS = 200;
const TOP_COURSES = 5;

/**
 * The numbers behind the Learning dashboard and its reports: how many people
 * have what, how many finished, how many are late. Cancelled assignments are
 * left out. Only the people the caller's data scope reaches are counted.
 */
@Injectable()
export class LearningReportService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, 'employeeId') : {};
  }

  /** The dashboard cards: courses, assignments by state, completion and mandatory compliance, the busiest courses. */
  async getDashboard(tenantId: string) {
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const Recommendation = await this.modelProvider.getTrainingRecommendationModel(tenantId);
    const today = todayIso();
    const monthStart = `${today.slice(0, 7)}-01`;
    const scope = await this.scopeWhere(tenantId);
    const base = { tenantId, ...scope };
    const open = { status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES } };
    const late = { dueDate: { [Op.lt]: today } };
    const count = (where: Record<string, unknown>) => Assignment.count({ where: { ...base, ...where } as any });

    const [published, draft, archived, assigned, completed, notStarted, inProgress, overdue, mandatoryTotal, mandatoryCompleted, mandatoryOverdue, completedThisMonth, pendingRecommendations, topCourses] =
      await Promise.all([
        Course.count({ where: { tenantId, status: TrainingCourseStatus.PUBLISHED } }),
        Course.count({ where: { tenantId, status: TrainingCourseStatus.DRAFT } }),
        Course.count({ where: { tenantId, status: TrainingCourseStatus.ARCHIVED } }),
        count(COUNTED),
        count({ status: 'COMPLETED' }),
        count({ status: 'NOT_STARTED', [Op.and]: [{ [Op.or]: [{ dueDate: null }, { dueDate: { [Op.gte]: today } }] }] }),
        count({ status: 'IN_PROGRESS', [Op.and]: [{ [Op.or]: [{ dueDate: null }, { dueDate: { [Op.gte]: today } }] }] }),
        count({ ...open, ...late }),
        count({ ...COUNTED, mandatory: true }),
        count({ status: 'COMPLETED', mandatory: true }),
        count({ ...open, ...late, mandatory: true }),
        count({ status: 'COMPLETED', completedAt: { [Op.gte]: new Date(`${monthStart}T00:00:00.000Z`) } }),
        Recommendation.count({ where: { ...base, status: 'PENDING' } as any }),
        this.groupReport(tenantId, LearningReportGroup.COURSE, {}, TOP_COURSES),
      ]);

    return {
      courses: { published, draft, archived },
      assignments: { total: assigned, notStarted, inProgress, overdue, completed, completedThisMonth },
      completionRate: percent(completed, assigned),
      mandatory: { total: mandatoryTotal, completed: mandatoryCompleted, overdue: mandatoryOverdue, complianceRate: percent(mandatoryCompleted, mandatoryTotal) },
      pendingRecommendations,
      topCourses,
    };
  }

  /** Results per course, or per department as it was when the course was assigned, most assigned first. */
  async getReport(tenantId: string, group: LearningReportGroup, query: GetLearningReportQueryDto = {}) {
    return { group, rows: await this.groupReport(tenantId, group, query, REPORT_ROWS) };
  }

  private async groupReport(tenantId: string, group: LearningReportGroup, query: GetLearningReportQueryDto, limit: number) {
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const today = todayIso();
    const q = (value: string) => Assignment.sequelize!.escape(value);
    const where: Record<string | symbol, unknown> = { tenantId, ...COUNTED, ...(await this.scopeWhere(tenantId)) };
    const assignedOn: Record<symbol, Date> = {};
    if (query.from) assignedOn[Op.gte] = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) assignedOn[Op.lt] = new Date(`${addDays(query.to, 1)}T00:00:00.000Z`);
    if (query.from || query.to) where.createdAt = assignedOn;
    if (query.departmentId && group === LearningReportGroup.COURSE) where.departmentId = query.departmentId;

    const byCourse = group === LearningReportGroup.COURSE;
    const key = byCourse ? 'courseId' : 'departmentId';
    const rows = (await Assignment.findAll({
      where: where as any,
      attributes: [
        [col(key), 'groupId'],
        [fn('MAX', col(byCourse ? 'courseTitle' : 'departmentName')), 'groupName'],
        [fn('COUNT', literal('*')), 'assigned'],
        [literal(`COUNT(*) FILTER (WHERE "status" = 'COMPLETED')`), 'completed'],
        [literal(`COUNT(*) FILTER (WHERE "status" = 'NOT_STARTED' AND ("dueDate" IS NULL OR "dueDate" >= ${q(today)}))`), 'notStarted'],
        [literal(`COUNT(*) FILTER (WHERE "status" = 'IN_PROGRESS' AND ("dueDate" IS NULL OR "dueDate" >= ${q(today)}))`), 'inProgress'],
        [literal(`COUNT(*) FILTER (WHERE "status" IN ('NOT_STARTED', 'IN_PROGRESS') AND "dueDate" < ${q(today)})`), 'overdue'],
        [literal(`COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "dueDate" IS NOT NULL AND "completedAt"::date > "dueDate")`), 'completedLate'],
        [literal(`AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")) / 86400) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" IS NOT NULL)`), 'avgDays'],
      ],
      group: [key],
      order: [[literal('"assigned"'), 'DESC'], [literal('"groupName"'), 'ASC']],
      limit,
      raw: true,
    })) as unknown as Record<string, any>[];

    return rows.map((row) => {
      const assigned = Number(row.assigned);
      const completed = Number(row.completed);
      return {
        [key]: (row.groupId ?? null) as string | null,
        name: (row.groupName ?? (byCourse ? null : 'No department')) as string | null,
        assigned,
        notStarted: Number(row.notStarted),
        inProgress: Number(row.inProgress),
        completed,
        overdue: Number(row.overdue),
        completedLate: Number(row.completedLate),
        completionRate: percent(completed, assigned),
        avgDaysToComplete: row.avgDays === null || row.avgDays === undefined ? null : Math.round(Number(row.avgDays) * 10) / 10,
      };
    });
  }
}
