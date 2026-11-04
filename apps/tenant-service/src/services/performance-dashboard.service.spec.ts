import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { runAsRpcActor } from '@app/tenant-context';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformanceReviewStatus } from '../models/performance-review.model';
import { PerformanceGoalStatus } from '../models/performance-goal.model';
import { todayIso } from './workspace-shared';

/**
 * Covers the derived values the Performance screen depends on — the rating
 * averaged from the five metric bars, the review date stamped when a review
 * is completed, and the goal status inferred from progress — plus tenant
 * scoping and the delete response shape.
 */
describe('PerformanceDashboardService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
  const REVIEW = '33333333-3333-4333-8333-333333333333';
  const GOAL = '44444444-4444-4444-8444-444444444444';
  const TODAY = new Date().toISOString().slice(0, 10);

  let reviewModel: any;
  let goalModel: any;
  let employeeModel: any;
  let notices: any[];
  let auditModel: { create: jest.Mock };
  let service: PerformanceDashboardService;

  const review = (over: Record<string, any> = {}) => ({
    id: REVIEW,
    tenantId: TENANT,
    employeeId: EMPLOYEE,
    cycle: 'H1 2026',
    status: PerformanceReviewStatus.PENDING,
    rating: null,
    professionalism: null,
    communication: null,
    qualityOfWork: null,
    teamwork: null,
    leadership: null,
    reviewDate: null,
    employee: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  const goal = (over: Record<string, any> = {}) => ({
    id: GOAL,
    tenantId: TENANT,
    employeeId: EMPLOYEE,
    title: 'Ship the portal',
    category: null,
    progress: 0,
    status: PerformanceGoalStatus.NOT_STARTED,
    dueDate: null,
    employee: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  beforeEach(() => {
    reviewModel = {
      findOne: jest.fn().mockResolvedValue(review()),
      findAll: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: REVIEW }),
      destroy: jest.fn().mockResolvedValue(1),
    };
    goalModel = {
      findOne: jest.fn().mockResolvedValue(goal()),
      findAll: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: GOAL }),
      destroy: jest.fn().mockResolvedValue(1),
    };
    employeeModel = {
      findOne: jest.fn().mockResolvedValue({ id: EMPLOYEE, status: 'ACTIVE' }),
      findAll: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };

    notices = [];
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    const modelProvider = {
      getEmployeeNotificationModel: jest.fn().mockResolvedValue({ create: jest.fn(async (row: any) => notices.push(row)) }),
      getEntityAuditLogModel: jest.fn().mockResolvedValue(auditModel),
      getPerformanceReviewModel: jest.fn().mockResolvedValue(reviewModel),
      getPerformanceGoalModel: jest.fn().mockResolvedValue(goalModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
      getDesignationModel: jest.fn().mockResolvedValue({}),
    };

    service = new PerformanceDashboardService(modelProvider as any);
  });

  describe('createReview', () => {
    const dto = (over: Record<string, any> = {}) =>
      ({ employeeId: EMPLOYEE, cycle: ' H1 2026 ', ...over }) as any;

    it('refuses an employee from another organization', async () => {
      employeeModel.findOne.mockResolvedValue(null);

      await expect(service.createReview(TENANT, dto())).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
      expect(reviewModel.create).not.toHaveBeenCalled();
    });

    it('averages the five metric bars into the rating', async () => {
      await service.createReview(
        TENANT,
        dto({ professionalism: 5, communication: 4, qualityOfWork: 4, teamwork: 3, leadership: 4 }),
      );

      expect(reviewModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ rating: 4, cycle: 'H1 2026' }),
      );
    });

    it('averages only the metrics that were scored', async () => {
      await service.createReview(TENANT, dto({ professionalism: 5, teamwork: 4 }));

      expect(reviewModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ rating: 4.5 }),
      );
    });

    it('prefers an explicit rating over the metric average', async () => {
      await service.createReview(TENANT, dto({ professionalism: 1, rating: 5 }));

      expect(reviewModel.create).toHaveBeenCalledWith(expect.objectContaining({ rating: 5 }));
    });

    it('leaves the rating unset when no metric was scored', async () => {
      await service.createReview(TENANT, dto());

      expect(reviewModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ rating: null, status: PerformanceReviewStatus.PENDING }),
      );
    });

    it('dates a review that is created already completed', async () => {
      await service.createReview(TENANT, dto({ status: PerformanceReviewStatus.COMPLETED }));

      expect(reviewModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ reviewDate: TODAY }),
      );
    });

    it('leaves a pending review undated', async () => {
      await service.createReview(TENANT, dto());

      expect(reviewModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ reviewDate: null }),
      );
    });
  });

  describe('updateReview', () => {
    it('re-averages using the metrics already stored', async () => {
      const row = review({
        professionalism: '4',
        communication: '4',
        qualityOfWork: '4',
        teamwork: '4',
        leadership: '4',
      });
      reviewModel.findOne.mockResolvedValue(row);

      await service.updateReview(TENANT, REVIEW, { leadership: 5 } as any);

      // four stored 4s plus the new 5
      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ leadership: 5, rating: 4.2 }),
      );
    });

    it('dates a review the moment it is completed', async () => {
      const row = review();
      reviewModel.findOne.mockResolvedValue(row);

      await service.updateReview(TENANT, REVIEW, {
        status: PerformanceReviewStatus.COMPLETED,
      } as any);

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PerformanceReviewStatus.COMPLETED,
          reviewDate: TODAY,
        }),
      );
    });

    it('keeps a review date that was already set', async () => {
      const row = review({
        status: PerformanceReviewStatus.COMPLETED,
        reviewDate: '2026-01-15',
      });
      reviewModel.findOne.mockResolvedValue(row);

      await service.updateReview(TENANT, REVIEW, { cycle: 'H2 2026' } as any);

      expect(row.update).toHaveBeenCalledWith({ cycle: 'H2 2026' });
    });

    it('does not reach another tenant review', async () => {
      reviewModel.findOne.mockResolvedValue(null);

      await expect(
        service.updateReview(TENANT, REVIEW, { cycle: 'H2' } as any),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(reviewModel.findOne).toHaveBeenCalledWith({
        where: { id: REVIEW, tenantId: TENANT },
      });
    });
  });

  describe('publishing a review to the employee', () => {
    it('publishes a completed review, records who, tells the employee, and audits it', async () => {
      const completed = review({ status: PerformanceReviewStatus.COMPLETED });
      reviewModel.findOne.mockResolvedValue(completed);

      await service.publishReview(TENANT, REVIEW, 'hr@example.com');

      const patch = completed.update.mock.calls[0][0];
      expect(patch.publishedAt).toBeInstanceOf(Date);
      expect(patch.publishedByEmail).toBe('hr@example.com');
      expect(notices).toEqual([expect.objectContaining({ employeeId: EMPLOYEE, kind: 'PERFORMANCE', title: 'Your H1 2026 review is ready' })]);
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({ tableName: 'performance_reviews', changes: { published: { from: false, to: true } } });
    });

    it('refuses a review that is not completed', async () => {
      reviewModel.findOne.mockResolvedValue(review({ status: PerformanceReviewStatus.IN_PROGRESS }));
      await expect(service.publishReview(TENANT, REVIEW)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(notices).toHaveLength(0);
    });

    it('does nothing the second time, and tells the employee only once', async () => {
      const published = review({ status: PerformanceReviewStatus.COMPLETED, publishedAt: new Date() });
      reviewModel.findOne.mockResolvedValue(published);
      await service.publishReview(TENANT, REVIEW);
      expect(published.update).not.toHaveBeenCalled();
      expect(notices).toHaveLength(0);
    });

    it('takes it back with unpublish', async () => {
      const published = review({ status: PerformanceReviewStatus.COMPLETED, publishedAt: new Date(), publishedByEmail: 'hr@example.com' });
      reviewModel.findOne.mockResolvedValue(published);
      await service.unpublishReview(TENANT, REVIEW);
      expect(published.update).toHaveBeenCalledWith({ publishedAt: null, publishedByEmail: null });
    });

    it('will not change a review the employee has been shown', async () => {
      const published = review({ status: PerformanceReviewStatus.COMPLETED, publishedAt: new Date() });
      reviewModel.findOne.mockResolvedValue(published);
      await expect(service.updateReview(TENANT, REVIEW, { communication: 1 } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT, message: expect.stringContaining('Unpublish') });
      expect(published.update).not.toHaveBeenCalled();
    });

    it('keeps the reviewer\'s comments, and clears them with an empty string', async () => {
      const open = review();
      reviewModel.findOne.mockResolvedValue(open);
      await service.updateReview(TENANT, REVIEW, { reviewerComments: ' Strong quarter ' } as any);
      expect(open.update.mock.calls[0][0]).toMatchObject({ reviewerComments: 'Strong quarter' });
      await service.updateReview(TENANT, REVIEW, { reviewerComments: '' } as any);
      expect(open.update.mock.calls[1][0]).toMatchObject({ reviewerComments: null });
    });

    it('shows the reviewer whether it is published and what the employee wrote', async () => {
      reviewModel.findOne.mockResolvedValue(review({ selfAssessment: { scores: { teamwork: 4 }, comments: 'Good', submittedAt: 'x' }, reviewerComments: 'Nice' }));
      expect(await service.getReview(TENANT, REVIEW)).toMatchObject({
        published: false,
        reviewerComments: 'Nice',
        selfAssessment: { scores: { teamwork: 4 }, comments: 'Good' },
      });
    });
  });

  describe('what the employee is told', () => {
    it('asks for a self-assessment when an open review is created, and not for a completed one', async () => {
      reviewModel.findOne.mockResolvedValue(review());
      await service.createReview(TENANT, { employeeId: EMPLOYEE, cycle: 'H2 2026' } as any);
      expect(notices).toEqual([expect.objectContaining({ employeeId: EMPLOYEE, kind: 'PERFORMANCE', title: 'Self-assessment requested: H2 2026' })]);

      notices.length = 0;
      await service.createReview(TENANT, { employeeId: EMPLOYEE, cycle: 'H1 2026', status: PerformanceReviewStatus.COMPLETED } as any);
      expect(notices).toHaveLength(0);
    });

    it('tells the employee about a new goal', async () => {
      goalModel.findOne.mockResolvedValue(goal());
      await service.createGoal(TENANT, { employeeId: EMPLOYEE, title: 'Ship the portal', dueDate: '2026-12-31' } as any);
      expect(notices).toEqual([expect.objectContaining({ employeeId: EMPLOYEE, title: 'New goal: Ship the portal' })]);
      expect(notices[0].body).toContain('2026-12-31');
    });
  });

  describe('goals', () => {
    it('infers the status from progress on create', async () => {
      await service.createGoal(TENANT, {
        employeeId: EMPLOYEE,
        title: 'Ship the portal',
        progress: 100,
      } as any);

      expect(goalModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 100, status: PerformanceGoalStatus.COMPLETED }),
      );
    });

    it('starts a goal with no progress as not started', async () => {
      await service.createGoal(TENANT, {
        employeeId: EMPLOYEE,
        title: 'Ship the portal',
      } as any);

      expect(goalModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 0, status: PerformanceGoalStatus.NOT_STARTED }),
      );
    });

    it('moves a goal to in progress when progress is edited', async () => {
      const row = goal();
      goalModel.findOne.mockResolvedValue(row);

      await service.updateGoal(TENANT, GOAL, { progress: 40 } as any);

      expect(row.update).toHaveBeenCalledWith({
        progress: 40,
        status: PerformanceGoalStatus.IN_PROGRESS,
      });
    });

    it('lets an explicit status win over the inferred one', async () => {
      const row = goal();
      goalModel.findOne.mockResolvedValue(row);

      await service.updateGoal(TENANT, GOAL, {
        progress: 40,
        status: PerformanceGoalStatus.COMPLETED,
      } as any);

      expect(row.update).toHaveBeenCalledWith({
        progress: 40,
        status: PerformanceGoalStatus.COMPLETED,
      });
    });
  });

  describe('goal KPI cards', () => {
    /**
     * Overdue is derived, not stored — a stored flag would need a nightly job
     * and would be wrong for the hours in between.
     */
    it('counts overdue as past due and not completed', async () => {
      await service.getOverview(TENANT);

      const overdueCall = goalModel.count.mock.calls.find(
        (call: any[]) => call[0]?.where?.dueDate !== undefined,
      );
      expect(overdueCall).toBeDefined();
      expect(overdueCall[0].where.status).toBeDefined();
    });

    it('returns in-progress and overdue alongside the totals', async () => {
      goalModel.count
        .mockResolvedValueOnce(18) // total
        .mockResolvedValueOnce(14) // completed
        .mockResolvedValueOnce(3) // in progress
        .mockResolvedValueOnce(7); // overdue

      const overview = await service.getOverview(TENANT);

      expect(overview).toMatchObject({
        totalGoals: 18,
        completedGoals: 14,
        goalsInProgress: 3,
        goalsOverdue: 7,
      });
    });

    it('never reports a negative not-started count', async () => {
      goalModel.count
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(0);

      const overview = await service.getOverview(TENANT);

      expect(overview.goalsNotStarted).toBe(0);
    });
  });

  describe('trend', () => {
    it('plots goals achieved beside the rating series', async () => {
      const month = new Date().toISOString().slice(0, 7);
      reviewModel.findAll.mockResolvedValue([]);
      goalModel.findAll.mockResolvedValue([
        { dueDate: `${month}-05` },
        { dueDate: `${month}-19` },
      ]);

      const trend = await service.getTrend(TENANT, { months: 3 } as any);
      const current = trend.points.find((point) => point.period === month);

      expect(current?.goalsAchieved).toBe(2);
      expect(trend.points.every((p) => typeof p.averageRating === 'number')).toBe(true);
    });

    it('leaves a month with no completed goals at zero', async () => {
      goalModel.findAll.mockResolvedValue([]);

      const trend = await service.getTrend(TENANT, { months: 3 } as any);

      expect(trend.points.every((point) => point.goalsAchieved === 0)).toBe(true);
    });
  });

  describe('by department', () => {
    it('scores each department against the 5-point scale', async () => {
      employeeModel.findAll.mockResolvedValue([]);
      reviewModel.findAll.mockResolvedValue([
        { rating: '4', employee: { id: 'e1', departmentId: 'd1' } },
        { rating: '5', employee: { id: 'e2', departmentId: 'd1' } },
        { rating: '3', employee: { id: 'e3', departmentId: 'd2' } },
      ]);
      const departmentModel = {
        findAll: jest.fn().mockResolvedValue([
          { id: 'd1', name: 'Engineering' },
          { id: 'd2', name: 'Design' },
        ]),
      };
      (service as any).modelProvider.getDepartmentModel = jest
        .fn()
        .mockResolvedValue(departmentModel);

      const result = await service.getByDepartment(TENANT);

      expect(result.rows[0]).toMatchObject({
        department: 'Engineering',
        averageRating: 4.5,
        score: 90,
        reviewCount: 2,
      });
      expect(result.rows[1]).toMatchObject({ department: 'Design', score: 60 });
    });

    it('reports a department with no completed reviews as unscored, not zero-rated', async () => {
      reviewModel.findAll.mockResolvedValue([]);
      const departmentModel = {
        findAll: jest.fn().mockResolvedValue([{ id: 'd1', name: 'Finance' }]),
      };
      (service as any).modelProvider.getDepartmentModel = jest
        .fn()
        .mockResolvedValue(departmentModel);

      const result = await service.getByDepartment(TENANT);

      expect(result.unscored).toBe(1);
      expect(result.rows[0].reviewCount).toBe(0);
    });
  });

  describe('deletes', () => {
    /**
     * A handler that resolves to undefined completes the RPC observable
     * without emitting, which the gateway turns into an EmptyError even
     * though the row is gone. Both deletes must answer with a body.
     */
    it('answers a review delete with a body', async () => {
      await expect(service.deleteReview(TENANT, REVIEW)).resolves.toEqual({
        deleted: true,
        id: REVIEW,
      });
      expect(reviewModel.destroy).toHaveBeenCalledWith({
        where: { id: REVIEW, tenantId: TENANT },
      });
    });

    it('answers a goal delete with a body', async () => {
      await expect(service.deleteGoal(TENANT, GOAL)).resolves.toEqual({
        deleted: true,
        id: GOAL,
      });
    });

    it('reports a review that is not in this organization', async () => {
      reviewModel.destroy.mockResolvedValue(0);

      await expect(service.deleteReview(TENANT, REVIEW)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('reports a goal that is not in this organization', async () => {
      goalModel.destroy.mockResolvedValue(0);

      await expect(service.deleteGoal(TENANT, GOAL)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  /**
   * A Department Head or Team Lead holds `performance.*` for their own people
   * only. The same `DataScopeService` the employee, attendance and leave lists
   * use narrows every read and write here; an organization-wide caller is
   * untouched (`employeeWhere` answers `{}`).
   */
  describe('data scope', () => {
    const OUTSIDER = '55555555-5555-4555-8555-555555555555';
    let dataScope: any;

    beforeEach(() => {
      dataScope = {
        scope: jest.fn().mockReturnValue('TEAM'),
        actorEmployeeId: jest.fn().mockResolvedValue(null),
        employeeWhere: jest.fn().mockImplementation(async (_tenant: string, field = 'employeeId') => ({
          [field]: { [Op.in]: [EMPLOYEE] },
        })),
        canSee: jest.fn().mockImplementation(async (_tenant: string, id: string) => id === EMPLOYEE),
      };
      service = new PerformanceDashboardService((service as any).modelProvider, dataScope);
    });

    it('limits the review list and KPI counts to visible employees', async () => {
      await service.getReviews(TENANT);
      expect(reviewModel.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT, employeeId: { [Op.in]: [EMPLOYEE] } } }),
      );

      await service.getOverview(TENANT);
      expect(employeeModel.count).toHaveBeenCalledWith({ where: { tenantId: TENANT, id: { [Op.in]: [EMPLOYEE] } } });
      expect(goalModel.count).toHaveBeenCalledWith({ where: { tenantId: TENANT, employeeId: { [Op.in]: [EMPLOYEE] } } });
    });

    it('refuses a review for someone outside the scope, as not found', async () => {
      employeeModel.findOne.mockResolvedValue({ id: OUTSIDER });

      await expect(
        service.createReview(TENANT, { employeeId: OUTSIDER, cycle: 'H1' } as any),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(reviewModel.create).not.toHaveBeenCalled();
    });

    it('cannot delete a goal outside the scope', async () => {
      goalModel.destroy.mockResolvedValue(0);
      await expect(service.deleteGoal(TENANT, GOAL)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(goalModel.destroy).toHaveBeenCalledWith({
        where: { id: GOAL, tenantId: TENANT, employeeId: { [Op.in]: [EMPLOYEE] } },
      });
    });

    it('shows a scoped caller only the departments their people sit in', async () => {
      reviewModel.findAll.mockResolvedValue([{ rating: '4', employee: { id: EMPLOYEE, departmentId: 'd1' } }]);
      (service as any).modelProvider.getDepartmentModel = jest.fn().mockResolvedValue({
        findAll: jest.fn().mockResolvedValue([
          { id: 'd1', name: 'Engineering' },
          { id: 'd2', name: 'Design' },
        ]),
      });

      const result = await service.getByDepartment(TENANT);

      expect(result.rows.map((row) => row.department)).toEqual(['Engineering']);
      expect(result.unscored).toBe(0);
    });

    it('leaves an organization-wide caller untouched', async () => {
      dataScope.scope.mockReturnValue('ORGANIZATION');
      dataScope.employeeWhere.mockResolvedValue({});

      await service.getReviews(TENANT);
      expect(reviewModel.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT } }));
    });
  });

  describe('work evidence for a review', () => {
    const OPEN_PROJECT = '55555555-5555-4555-8555-555555555555';
    const SECRET_PROJECT = '66666666-6666-4666-8666-666666666666';
    const REVIEWER = 'reviewer-1';
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const isoDaysAgo = (days: number) => daysAgo(days).toISOString().slice(0, 10);

    const open = { id: OPEN_PROJECT, name: 'Portal', status: 'ACTIVE', confidential: false, leadEmployeeId: 'lead-1' };
    const secret = { id: SECRET_PROJECT, name: 'Secret Launch', status: 'ACTIVE', confidential: true, leadEmployeeId: 'someone-else' };

    const task = (over: Record<string, any>) => ({
      id: 't',
      title: 'Task',
      status: 'COMPLETED',
      dueDate: null,
      completedAt: daysAgo(10),
      projectId: OPEN_PROJECT,
      project: open,
      ...over,
    });

    /** The work-tracking models behind the evidence, with the reader's own involvement configurable. */
    const arrange = (
      work: {
        tasks?: any[];
        comments?: any[];
        led?: any[];
        employeeProjectIds?: string[];
        readerProjectIds?: string[];
        reader?: string | null;
      } = {},
    ) => {
      const { tasks = [], comments = [], led = [], employeeProjectIds = [], readerProjectIds = [], reader = REVIEWER } = work;
      reviewModel.findOne.mockResolvedValue(review());
      employeeModel.findOne.mockResolvedValue({ id: EMPLOYEE, reportingManagerId: 'mgr-1' });
      const projectModel = {
        findAll: jest.fn(async ({ where }: any) => {
          if (where.confidential === true) return [{ id: SECRET_PROJECT }];
          if (where.leadEmployeeId === EMPLOYEE) return led;
          if (where.id) return [open, secret].filter((project) => where.id[Op.in].includes(project.id));
          return [];
        }),
      };
      const taskModel = {
        // The reader's own tasks (used to work out which projects they are on) have none here.
        findAll: jest.fn(async ({ where }: any) => (where.assigneeEmployeeId ? [] : tasks)),
      };
      const memberModel = {
        findAll: jest.fn(async ({ where }: any) =>
          (where.employeeId === EMPLOYEE ? employeeProjectIds : readerProjectIds).map((projectId) => ({ projectId })),
        ),
      };
      const provider = (service as any).modelProvider;
      provider.getWorkspaceTaskModel = jest.fn().mockResolvedValue(taskModel);
      provider.getWorkspaceTaskAssigneeModel = jest.fn().mockResolvedValue({ findAll: jest.fn().mockResolvedValue([]) });
      provider.getWorkspaceProjectModel = jest.fn().mockResolvedValue(projectModel);
      provider.getWorkspaceProjectMemberModel = jest.fn().mockResolvedValue(memberModel);
      provider.getWorkspaceTaskCommentModel = jest.fn().mockResolvedValue({ findAll: jest.fn().mockResolvedValue(comments) });
      (service as any).dataScope = {
        scope: () => 'ORGANIZATION',
        employeeWhere: async () => ({}),
        canSee: async () => true,
        actorEmployeeId: jest.fn().mockResolvedValue(reader),
      };
    };

    const comment = (over: Record<string, any>) => ({
      id: 'c',
      taskId: 't1',
      body: 'Well done',
      authorEmployeeId: 'mgr-1',
      authorName: 'Manager',
      createdAt: daysAgo(5),
      ...over,
    });

    const restricted = <T>(work: () => Promise<T>) =>
      runAsRpcActor({ permissions: ['performance.view'], isFullAccess: false } as any, work);

    it('shows projects, finished work, overdue work and manager feedback, and never writes a rating', async () => {
      const row = review();
      arrange({
        led: [{ id: OPEN_PROJECT, name: 'Portal', status: 'ACTIVE', confidential: false }],
        tasks: [
          task({ id: 't1', title: 'Done' }),
          task({ id: 't2', title: 'Late', status: 'PENDING', dueDate: isoDaysAgo(20), completedAt: null }),
        ],
        comments: [
          comment({ id: 'c1', body: 'Please close this' }),
          comment({ id: 'c2', body: 'Looks good', authorEmployeeId: 'lead-1', authorName: 'Owner' }),
          comment({ id: 'c3', body: 'Thanks', authorEmployeeId: EMPLOYEE, authorName: 'Sara' }),
          comment({ id: 'c4', body: 'I can help', authorEmployeeId: 'other', authorName: 'Colleague' }),
        ],
      });
      reviewModel.findOne.mockResolvedValue(row);

      const evidence = await service.getReviewEvidence(TENANT, REVIEW);

      expect(evidence.projects).toEqual([expect.objectContaining({ id: OPEN_PROJECT, name: 'Portal', part: 'owner', concealed: false })]);
      expect(evidence.completedTasks.map((line) => line.title)).toEqual(['Done']);
      expect(evidence.overdueTasks.map((line) => line.title)).toEqual(['Late']);
      expect(evidence.managerFeedback.map((note) => note.authorName)).toEqual(['Manager', 'Owner']);
      expect(evidence).not.toHaveProperty('rating');
      expect(reviewModel.create).not.toHaveBeenCalled();
      expect(row.update).not.toHaveBeenCalled();
    });

    it('covers the last twelve months unless told otherwise', async () => {
      arrange({
        tasks: [
          task({ id: 't1', title: 'Recent', completedAt: daysAgo(30) }),
          task({ id: 't2', title: 'Two years ago', completedAt: daysAgo(730) }),
          task({ id: 't3', title: 'Overdue long ago', status: 'PENDING', dueDate: isoDaysAgo(900), completedAt: null }),
          task({ id: 't4', title: 'Overdue lately', status: 'PENDING', dueDate: isoDaysAgo(3), completedAt: null }),
        ],
      });

      const evidence = await service.getReviewEvidence(TENANT, REVIEW);

      expect(evidence.period.to).toBe(todayIso());
      expect(evidence.period.from).toBe(new Date(Date.parse(`${evidence.period.to}T00:00:00.000Z`) - 365 * 86_400_000).toISOString().slice(0, 10));
      expect(evidence.completedTasks.map((line) => line.title)).toEqual(['Recent']);
      expect(evidence.overdueTasks.map((line) => line.title)).toEqual(['Overdue lately']);
      expect(evidence.counts).toMatchObject({ completedTasks: 1, overdueTasks: 1 });
    });

    it('uses the period asked for', async () => {
      arrange({
        tasks: [
          task({ id: 't1', title: 'Recent', completedAt: daysAgo(30) }),
          task({ id: 't2', title: 'Two years ago', completedAt: daysAgo(730) }),
        ],
        comments: [comment({ id: 'old', createdAt: daysAgo(725) }), comment({ id: 'new', createdAt: daysAgo(5) })],
      });

      const evidence = await service.getReviewEvidence(TENANT, REVIEW, { from: isoDaysAgo(800), to: isoDaysAgo(600) });

      expect(evidence.period).toEqual({ from: isoDaysAgo(800), to: isoDaysAgo(600) });
      expect(evidence.completedTasks.map((line) => line.title)).toEqual(['Two years ago']);
      expect(evidence.managerFeedback.map((note) => note.id)).toEqual(['old']);
    });

    it('refuses a period that ends before it starts', async () => {
      arrange();

      await expect(service.getReviewEvidence(TENANT, REVIEW, { from: '2026-06-30', to: '2026-01-01' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
      expect(reviewModel.findOne).not.toHaveBeenCalled();
    });

    it('404s for a review outside the caller\'s scope or organization', async () => {
      arrange();
      reviewModel.findOne.mockResolvedValue(null);

      await expect(service.getReviewEvidence(TENANT, REVIEW)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('leaves out cancelled projects and caps each list at eight while counting them all', async () => {
      arrange({
        tasks: Array.from({ length: 10 }, (_, index) => task({ id: `t${index}`, title: `Done ${index}`, completedAt: daysAgo(index + 1) })),
        led: [{ id: 'cancelled', name: 'Dropped', status: 'CANCELLED', confidential: false }],
      });

      const evidence = await service.getReviewEvidence(TENANT, REVIEW);

      expect(evidence.projects.map((project) => project.name)).toEqual(['Portal']);
      expect(evidence.completedTasks).toHaveLength(8);
      expect(evidence.completedTasks[0].title).toBe('Done 0');
      expect(evidence.counts.completedTasks).toBe(10);
    });

    describe('confidential projects', () => {
      const confidentialWork = () => ({
        employeeProjectIds: [SECRET_PROJECT],
        tasks: [
          task({ id: 't1', title: 'Open work' }),
          task({ id: 't2', title: 'Launch plan', projectId: SECRET_PROJECT, project: secret }),
          task({ id: 't3', title: 'Late launch task', status: 'PENDING', dueDate: isoDaysAgo(4), completedAt: null, projectId: SECRET_PROJECT, project: secret }),
        ],
        comments: [
          comment({ id: 'c1', taskId: 't1', body: 'Fine work' }),
          comment({ id: 'c2', taskId: 't2', body: 'The launch date is the 14th' }),
        ],
      });

      it('counts the work but hides what it was from a reader who may not see the project', async () => {
        arrange(confidentialWork());

        const evidence = await restricted(() => service.getReviewEvidence(TENANT, REVIEW));

        expect(evidence.projects.map((project) => [project.name, project.concealed])).toEqual([
          ['Confidential project', true],
          ['Portal', false],
        ]);
        expect(evidence.completedTasks.map((line) => [line.title, line.projectName, line.concealed])).toEqual(
          expect.arrayContaining([
            ['Confidential task', 'Confidential project', true],
            ['Open work', 'Portal', false],
          ]),
        );
        expect(evidence.overdueTasks).toEqual([expect.objectContaining({ title: 'Confidential task', projectName: 'Confidential project', concealed: true })]);
        expect(evidence.counts).toMatchObject({ projects: 2, completedTasks: 2, overdueTasks: 1 });
        // What was said about the hidden project is not passed on, or counted.
        expect(evidence.managerFeedback.map((note) => note.body)).toEqual(['Fine work']);
        expect(evidence.counts.managerFeedback).toBe(1);
        expect(JSON.stringify(evidence)).not.toContain('Secret Launch');
        expect(JSON.stringify(evidence)).not.toContain('Launch plan');
        expect(JSON.stringify(evidence)).not.toContain('14th');
      });

      it('shows everything to a reader with the Confidential permission, or full access', async () => {
        arrange(confidentialWork());

        const granted = await runAsRpcActor({ permissions: ['projects.confidential'], isFullAccess: false } as any, () =>
          service.getReviewEvidence(TENANT, REVIEW),
        );
        const full = await runAsRpcActor({ permissions: [], isFullAccess: true } as any, () => service.getReviewEvidence(TENANT, REVIEW));

        for (const evidence of [granted, full]) {
          expect(evidence.projects.map((project) => project.name)).toContain('Secret Launch');
          expect(evidence.completedTasks.map((line) => line.title)).toContain('Launch plan');
          expect(evidence.managerFeedback.map((note) => note.body)).toContain('The launch date is the 14th');
          expect(evidence.projects.every((project) => project.concealed === false)).toBe(true);
        }
      });

      it('shows a confidential project to a reader who is on it', async () => {
        arrange({ ...confidentialWork(), readerProjectIds: [SECRET_PROJECT] });

        const evidence = await restricted(() => service.getReviewEvidence(TENANT, REVIEW));

        expect(evidence.projects.map((project) => project.name)).toContain('Secret Launch');
        expect(evidence.completedTasks.map((line) => line.title)).toContain('Launch plan');
        expect(evidence.managerFeedback.map((note) => note.body)).toContain('The launch date is the 14th');
      });

      it('hides it from a reader who has no employee record and no permission', async () => {
        arrange({ ...confidentialWork(), reader: null });

        const evidence = await restricted(() => service.getReviewEvidence(TENANT, REVIEW));

        expect(evidence.projects.map((project) => project.name)).not.toContain('Secret Launch');
      });
    });
  });
});
