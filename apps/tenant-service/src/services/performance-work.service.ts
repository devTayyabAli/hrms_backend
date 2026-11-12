import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import { GetWorkSummaryQueryDto, HRMSModuleKey, TenantErrorCode, TenantException, WorkspaceTaskStatus } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { OrganizationModuleAccessService } from './organization-module-access.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { fullName, involvedProjectIds, seesConfidentialProjects, todayIso } from './workspace-shared';

/** Lists are capped; the totals in `summary` are always complete. */
const LIST_CAP = 100;
const FEEDBACK_CAP = 50;
/** The most tasks read for one person in one request. */
const TASK_CAP = 2000;

const NOTE =
  'Supporting evidence for a review, not a rating. Counts of projects, tasks or deadlines are shown as facts because the nature and size of work differ; the reviewer decides what they mean.';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export interface WorkPeriod {
  from: string;
  to: string;
  /** The cycle name, when the period came from a review. */
  label: string | null;
}

type Audience = 'STAFF' | 'EMPLOYEE';

/**
 * What one person did on projects and tasks, for a reviewer to use as supporting
 * evidence: the projects they were on, the tasks they finished and the ones
 * still overdue, and what a reviewer said about their work.
 *
 * It only reads. Nothing here is scored, ranked or turned into a rating, and no
 * count feeds one: the performance review stays a person's judgement.
 *
 * Who sees what:
 *  - staff (HR, a manager, a department head) see people inside their data
 *    scope, and never a confidential project they are not on themselves;
 *  - the employee sees their own work, with only the fields below, and no one
 *    else's names beyond the reviewer who gave them feedback.
 * When the organization has the Projects module off there is nothing to show,
 * and the summary says so rather than returning zeros.
 */
@Injectable()
export class PerformanceWorkService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly dashboard?: PerformanceDashboardService,
    @Optional() private readonly modules?: OrganizationModuleAccessService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  // ==========================================
  // Who and when
  // ==========================================

  private async me(tenantId: string, userId?: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId } }) : null;
    if (!employee && email?.trim()) employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  /** The window to look at: a review's cycle, an explicit range, or none (everything on record). */
  private async period(tenantId: string, employeeId: string, query: GetWorkSummaryQueryDto, audience: Audience): Promise<WorkPeriod | null> {
    if (query.reviewId) {
      const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
      const where: any = { tenantId, id: query.reviewId, employeeId };
      // Staff reach only the reviews the review screens would show them; an employee only what was shared with them.
      const scope = audience === 'STAFF' && this.dashboard ? await this.dashboard.reviewScope(tenantId) : {};
      const review: any = await Review.findOne({ where: { [Op.and]: [where, scope] } as any });
      const shared = audience === 'EMPLOYEE' ? Boolean(review?.publishedAt) || (review && review.status !== 'COMPLETED' && !review.closedAt) : true;
      if (!review || !shared) this.fail(HttpStatus.NOT_FOUND, 'Review not found.');
      if (!review.cycleId) this.fail(HttpStatus.BAD_REQUEST, 'This review has no cycle dates. Send `from` and `to` instead.');
      const Cycle = await this.modelProvider.getPerformanceCycleModel(tenantId);
      const cycle: any = await Cycle.findOne({ where: { id: review.cycleId, tenantId }, attributes: ['name', 'startDate', 'endDate'] });
      if (!cycle) this.fail(HttpStatus.BAD_REQUEST, 'This review’s cycle no longer exists. Send `from` and `to` instead.');
      return { from: day(cycle.startDate) as string, to: day(cycle.endDate) as string, label: cycle.name as string };
    }
    if (query.from || query.to) {
      if (!query.from || !query.to) this.fail(HttpStatus.BAD_REQUEST, 'Send both `from` and `to`, or neither.');
      if (!DAY.test(query.from) || !DAY.test(query.to)) this.fail(HttpStatus.BAD_REQUEST, '`from` and `to` must be dates in YYYY-MM-DD format.');
      if (query.from > query.to) this.fail(HttpStatus.BAD_REQUEST, '`from` must be on or before `to`.');
      return { from: query.from, to: query.to, label: null };
    }
    return null;
  }

  // ==========================================
  // The two entry points
  // ==========================================

  async forEmployee(tenantId: string, employeeId: string, query: GetWorkSummaryQueryDto = {}) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({ where: { id: employeeId, tenantId } });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'Employee not found.');
    // Outside the caller's scope the person does not exist for them.
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, employee.id, 'Employee');
    const period = await this.period(tenantId, employee.id, query, 'STAFF');
    return this.summary(tenantId, employee, period, 'STAFF');
  }

  async mine(tenantId: string, userId: string, email: string | undefined, query: GetWorkSummaryQueryDto = {}) {
    const employee = await this.me(tenantId, userId, email);
    const period = await this.period(tenantId, employee.id, query, 'EMPLOYEE');
    return this.summary(tenantId, employee, period, 'EMPLOYEE');
  }

  // ==========================================
  // The summary
  // ==========================================

  private async projectsOn(tenantId: string): Promise<boolean> {
    if (!this.modules) return true;
    try {
      return (await this.modules.isModuleEnabled(tenantId, HRMSModuleKey.PROJECTS)).enabled;
    } catch {
      return true;
    }
  }

  private inPeriod(date: string | null, period: WorkPeriod | null): boolean {
    if (!period) return true;
    return Boolean(date) && (date as string) >= period.from && (date as string) <= period.to;
  }

  private async summary(tenantId: string, employee: any, period: WorkPeriod | null, audience: Audience) {
    const person = { id: employee.id as string, name: fullName(employee), employeeCode: (employee.employeeCode ?? null) as string | null };
    const empty = (available: boolean) => ({
      employee: person,
      available,
      period,
      note: NOTE,
      summary: { projects: 0, projectsOwned: 0, tasksAssigned: 0, completed: 0, completedLate: 0, open: 0, overdue: 0, feedbackNotes: 0 },
      projects: [] as any[],
      completedTasks: [] as any[],
      overdueTasks: [] as any[],
      feedback: [] as any[],
      access: { hiddenTasks: 0 },
    });

    if (!(await this.projectsOn(tenantId))) return empty(false);

    const Task = await this.modelProvider.getWorkspaceTaskModel(tenantId);
    const Assignee = await this.modelProvider.getWorkspaceTaskAssigneeModel(tenantId);
    const Project = await this.modelProvider.getWorkspaceProjectModel(tenantId);
    const Member = await this.modelProvider.getWorkspaceProjectMemberModel(tenantId);

    // Every task they are on, as the main assignee or as one of several.
    const extras = (await Assignee.findAll({ where: { tenantId, employeeId: employee.id }, attributes: ['taskId'], raw: true })) as unknown as { taskId: string }[];
    const extraIds = [...new Set(extras.map((row) => row.taskId))];
    const tasks = (await Task.findAll({
      where: { tenantId, [Op.or]: [{ assigneeEmployeeId: employee.id }, ...(extraIds.length ? [{ id: { [Op.in]: extraIds } }] : [])] } as any,
      attributes: ['id', 'title', 'projectId', 'dueDate', 'priority', 'status', 'completedAt', 'reviewStatus', 'reviewFeedback', 'reviewedAt', 'reviewedByName'],
      order: [['dueDate', 'DESC']],
      limit: TASK_CAP,
    })) as any[];

    const [led, memberships] = await Promise.all([
      Project.findAll({ where: { tenantId, leadEmployeeId: employee.id }, attributes: ['id'], raw: true }) as unknown as Promise<{ id: string }[]>,
      Member.findAll({ where: { tenantId, employeeId: employee.id }, attributes: ['projectId'], raw: true }) as unknown as Promise<{ projectId: string }[]>,
    ]);
    const ledIds = new Set(led.map((row) => row.id));
    const memberIds = new Set(memberships.map((row) => row.projectId));

    // A confidential project is not shown to staff who are not on it. The person's own view needs no filter.
    let hidden = new Set<string>();
    if (audience === 'STAFF' && !seesConfidentialProjects()) {
      const readerId = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId).catch(() => null) : null;
      const mine = readerId ? await involvedProjectIds(this.modelProvider, tenantId, readerId) : [];
      const confidential = (await Project.findAll({ where: { tenantId, confidential: true }, attributes: ['id'], raw: true })) as unknown as { id: string }[];
      hidden = new Set(confidential.map((row) => row.id).filter((id) => !mine.includes(id)));
    }
    const visibleTask = (task: any) => !task.projectId || !hidden.has(task.projectId);
    const hiddenTasks = tasks.filter((task) => !visibleTask(task)).length;
    const shownTasks = tasks.filter(visibleTask);

    const today = todayIso();
    const relevant = (task: any) => !period || this.inPeriod(day(task.dueDate), period) || this.inPeriod(day(task.completedAt), period);
    const inScope = shownTasks.filter(relevant);

    const completed = inScope.filter(
      (task) => task.status === WorkspaceTaskStatus.COMPLETED && (!period || this.inPeriod(day(task.completedAt), period) || (!task.completedAt && this.inPeriod(day(task.dueDate), period))),
    );
    const open = inScope.filter((task) => task.status !== WorkspaceTaskStatus.COMPLETED);
    const overdue = open.filter((task) => day(task.dueDate)! < today && (!period || day(task.dueDate)! <= period.to));
    const late = (task: any) => Boolean(task.completedAt) && (day(task.completedAt) as string) > (day(task.dueDate) as string);

    // Projects: the ones their tasks sit on, and the ones they own or belong to during the period.
    const taskProjectIds = new Set(inScope.map((task) => task.projectId).filter((id): id is string => Boolean(id)));
    const candidateIds = [...new Set([...taskProjectIds, ...ledIds, ...memberIds])].filter((id) => !hidden.has(id));
    const projectRows = candidateIds.length
      ? ((await Project.findAll({ where: { tenantId, id: { [Op.in]: candidateIds } }, attributes: ['id', 'name', 'status', 'startDate', 'dueDate', 'leadEmployeeId'], raw: true })) as any[])
      : [];
    const overlaps = (project: any) =>
      !period || ((!project.startDate || day(project.startDate)! <= period.to) && (!project.dueDate || day(project.dueDate)! >= period.from));
    const projects = projectRows
      .filter((project) => taskProjectIds.has(project.id) || overlaps(project))
      .map((project) => {
        const mine = inScope.filter((task) => task.projectId === project.id);
        return {
          id: project.id as string,
          name: project.name as string,
          status: project.status as string,
          startDate: day(project.startDate),
          dueDate: day(project.dueDate),
          isOwner: ledIds.has(project.id),
          isMember: memberIds.has(project.id),
          tasks: {
            assigned: mine.length,
            completed: mine.filter((task) => task.status === WorkspaceTaskStatus.COMPLETED).length,
            overdue: mine.filter((task) => task.status !== WorkspaceTaskStatus.COMPLETED && day(task.dueDate)! < today).length,
          },
        };
      })
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.name.localeCompare(b.name));

    const nameOfProject = new Map(projectRows.map((project) => [project.id as string, project.name as string]));
    const where = (task: any) => (task.projectId && nameOfProject.has(task.projectId) ? { id: task.projectId as string, name: nameOfProject.get(task.projectId) as string } : null);

    const completedRows = completed
      .slice()
      .sort((a, b) => (day(b.completedAt) ?? '').localeCompare(day(a.completedAt) ?? ''))
      .slice(0, LIST_CAP)
      .map((task) => ({
        id: task.id as string,
        title: task.title as string,
        project: where(task),
        priority: task.priority as string,
        dueDate: day(task.dueDate),
        completedAt: day(task.completedAt),
        late: late(task),
      }));
    const overdueRows = overdue
      .slice()
      .sort((a, b) => (day(a.dueDate) as string).localeCompare(day(b.dueDate) as string))
      .slice(0, LIST_CAP)
      .map((task) => ({
        id: task.id as string,
        title: task.title as string,
        project: where(task),
        priority: task.priority as string,
        status: task.status as string,
        dueDate: day(task.dueDate),
        daysOverdue: daysBetween(day(task.dueDate) as string, today),
      }));

    // What a reviewer said about their work, in the period the decision was made.
    const feedbackTasks = shownTasks.filter((task) => task.reviewFeedback && task.reviewedAt && this.inPeriod(day(task.reviewedAt), period));
    const feedback = feedbackTasks
      .slice()
      .sort((a, b) => (day(b.reviewedAt) as string).localeCompare(day(a.reviewedAt) as string))
      .slice(0, FEEDBACK_CAP)
      .map((task) => ({
        taskId: task.id as string,
        taskTitle: task.title as string,
        project: where(task),
        decision: (task.reviewStatus ?? null) as string | null,
        feedback: task.reviewFeedback as string,
        reviewedBy: (task.reviewedByName ?? null) as string | null,
        reviewedAt: day(task.reviewedAt),
      }));

    return {
      employee: person,
      available: true,
      period,
      note: NOTE,
      summary: {
        projects: projects.length,
        projectsOwned: projects.filter((project) => project.isOwner).length,
        tasksAssigned: inScope.length,
        completed: completed.length,
        completedLate: completed.filter(late).length,
        open: open.length,
        overdue: overdue.length,
        feedbackNotes: feedbackTasks.length,
      },
      projects,
      completedTasks: completedRows,
      overdueTasks: overdueRows,
      feedback,
      // Work on a confidential project the reader is not on: counted, never named.
      access: { hiddenTasks },
    };
  }
}
