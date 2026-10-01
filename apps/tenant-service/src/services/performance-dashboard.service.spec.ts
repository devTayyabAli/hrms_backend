import { HttpStatus } from '@nestjs/common';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformanceReviewStatus } from '../models/performance-review.model';
import { PerformanceGoalStatus } from '../models/performance-goal.model';

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
      findOne: jest.fn().mockResolvedValue({ id: EMPLOYEE }),
      findAll: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };

    const modelProvider = {
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
});
