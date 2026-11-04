import { Op } from 'sequelize';
import { HttpStatus } from '@nestjs/common';
import { PerformanceSelfService } from './performance-self.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ME = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const REVIEW = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const GOAL = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const actor = { tenantId: TENANT, userId: 'user-1', email: 'me@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const review = (over: Record<string, any> = {}) =>
  row({
    id: REVIEW,
    tenantId: TENANT,
    employeeId: ME,
    cycle: '2026 Q3',
    status: 'IN_PROGRESS',
    rating: '4.20',
    professionalism: '4.00',
    communication: '3.50',
    qualityOfWork: '4.50',
    teamwork: null,
    leadership: null,
    reviewDate: '2026-10-01',
    reviewerComments: 'Strong quarter',
    publishedAt: null,
    selfAssessment: null,
    ...over,
  });

const goal = (over: Record<string, any> = {}) =>
  row({ id: GOAL, tenantId: TENANT, employeeId: ME, title: 'Ship the portal', category: 'Delivery', progress: 20, status: 'IN_PROGRESS', dueDate: '2026-12-31', ...over });

describe('PerformanceSelfService', () => {
  let employeeModel: any;
  let reviewModel: any;
  let goalModel: any;
  let auditModel: { create: jest.Mock };
  let service: PerformanceSelfService;

  beforeEach(() => {
    employeeModel = { findOne: jest.fn().mockResolvedValue({ id: ME, firstName: 'Ayesha', lastName: 'Khan' }) };
    reviewModel = { findOne: jest.fn().mockResolvedValue(review()), findAll: jest.fn().mockResolvedValue([]) };
    goalModel = { findOne: jest.fn().mockResolvedValue(goal()), findAll: jest.fn().mockResolvedValue([]) };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getEmployeeModel: async () => employeeModel,
      getPerformanceReviewModel: async () => reviewModel,
      getPerformanceGoalModel: async () => goalModel,
      getEntityAuditLogModel: async () => auditModel,
    };
    service = new PerformanceSelfService(provider);
  });

  describe('who is asking', () => {
    it('finds the employee by login, then by email, and says so when there is none', async () => {
      await service.getReviews(actor);
      expect(employeeModel.findOne.mock.calls[0][0].where).toEqual({ tenantId: TENANT, userId: 'user-1' });

      employeeModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ME });
      await service.getReviews(actor);
      expect(employeeModel.findOne.mock.calls[2][0].where.email).toBeDefined();

      employeeModel.findOne.mockResolvedValue(null);
      await expect(service.getReviews(actor)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('my reviews', () => {
    it('shows an open review without its result, and lets me assess myself', async () => {
      reviewModel.findAll.mockResolvedValue([review()]);

      const { data, summary } = await service.getReviews(actor);

      expect(reviewModel.findAll.mock.calls[0][0].where).toEqual({ tenantId: TENANT, employeeId: ME });
      expect(data[0]).toMatchObject({ id: REVIEW, published: false, canSelfAssess: true, evaluation: null, selfAssessment: null });
      expect(summary).toEqual({ total: 1, awaitingSelfAssessment: 1, published: 0 });
    });

    it('shows the rating, scores and feedback once it is published, and no more self-assessment', async () => {
      reviewModel.findAll.mockResolvedValue([review({ status: 'COMPLETED', publishedAt: new Date('2026-10-05') })]);

      const { data, summary } = await service.getReviews(actor);

      expect(data[0]).toMatchObject({
        published: true,
        canSelfAssess: false,
        evaluation: { rating: 4.2, reviewerComments: 'Strong quarter', metrics: { professionalism: 4, communication: 3.5, qualityOfWork: 4.5, teamwork: null, leadership: null } },
      });
      expect(summary.published).toBe(1);
    });

    it('does not count a review I have already assessed as waiting', async () => {
      reviewModel.findAll.mockResolvedValue([review({ selfAssessment: { scores: { teamwork: 4 }, comments: null, submittedAt: 'x' } })]);
      expect((await service.getReviews(actor)).summary.awaitingSelfAssessment).toBe(0);
    });

    it('hides a completed review that has not been published', async () => {
      reviewModel.findOne.mockResolvedValue(review({ status: 'COMPLETED' }));
      const result = await service.getReview(actor, REVIEW);
      expect(result).toMatchObject({ published: false, canSelfAssess: false, evaluation: null });
    });

    it('only finds my own review', async () => {
      reviewModel.findOne.mockResolvedValue(null);
      await expect(service.getReview(actor, REVIEW)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(reviewModel.findOne.mock.calls[0][0].where).toEqual({ id: REVIEW, tenantId: TENANT, employeeId: ME });
    });
  });

  describe('my self-assessment', () => {
    it('saves my scores and note, and records it', async () => {
      const open = review();
      reviewModel.findOne.mockResolvedValue(open);

      const result = await service.submitSelfAssessment(actor, REVIEW, { teamwork: 4, leadership: 3.5, comments: 'Led the migration' } as any);

      const saved = open.update.mock.calls[0][0].selfAssessment;
      expect(saved).toMatchObject({ scores: { teamwork: 4, leadership: 3.5 }, comments: 'Led the migration' });
      expect(typeof saved.submittedAt).toBe('string');
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({ tableName: 'performance_reviews', recordId: REVIEW });
      expect(result.selfAssessment).toMatchObject({ comments: 'Led the migration' });
    });

    it('can be changed until the review is completed', async () => {
      const open = review({ selfAssessment: { scores: { teamwork: 2 }, comments: null, submittedAt: 'x' } });
      reviewModel.findOne.mockResolvedValue(open);
      await service.submitSelfAssessment(actor, REVIEW, { teamwork: 5 } as any);
      expect(open.update.mock.calls[0][0].selfAssessment.scores).toEqual({ teamwork: 5 });
    });

    it('needs a score or a comment', async () => {
      await expect(service.submitSelfAssessment(actor, REVIEW, {} as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(service.submitSelfAssessment(actor, REVIEW, { comments: '   ' } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('is closed once the review is completed or published', async () => {
      reviewModel.findOne.mockResolvedValue(review({ status: 'COMPLETED' }));
      await expect(service.submitSelfAssessment(actor, REVIEW, { teamwork: 4 } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      reviewModel.findOne.mockResolvedValue(review({ publishedAt: new Date() }));
      await expect(service.submitSelfAssessment(actor, REVIEW, { teamwork: 4 } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('is only for my own review', async () => {
      reviewModel.findOne.mockResolvedValue(null);
      await expect(service.submitSelfAssessment(actor, REVIEW, { teamwork: 4 } as any)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('my goals', () => {
    it('lists open goals first, soonest due first, with a count per status', async () => {
      goalModel.findAll.mockResolvedValue([
        goal({ id: 'g1', title: 'Done thing', status: 'COMPLETED', progress: 100, dueDate: '2026-01-01' }),
        goal({ id: 'g2', title: 'Later', dueDate: '2026-12-31' }),
        goal({ id: 'g3', title: 'Sooner', status: 'NOT_STARTED', progress: 0, dueDate: '2026-11-15' }),
      ]);

      const { data, summary } = await service.getGoals(actor);

      // Goals set outside a cycle show at once; those of a cycle only once their plan is published.
      const where = goalModel.findAll.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: TENANT, employeeId: ME });
      expect(where[Op.or]).toEqual([{ cycleId: null }, { publishedAt: { [Op.ne]: null } }]);
      expect(data.map((g) => g.id)).toEqual(['g3', 'g2', 'g1']);
      expect(summary).toEqual({ total: 3, notStarted: 1, inProgress: 1, completed: 1 });
    });

    it('moves my progress and the status follows, and records it', async () => {
      const mine = goal();
      goalModel.findOne.mockResolvedValue(mine);

      expect(await service.updateGoalProgress(actor, GOAL, 100)).toMatchObject({ progress: 100, status: 'COMPLETED' });
      expect(mine.update).toHaveBeenCalledWith({ progress: 100, status: 'COMPLETED' });
      expect(auditModel.create.mock.calls[0][0].changes).toMatchObject({ progress: { from: 20, to: 100 } });

      await service.updateGoalProgress(actor, GOAL, 0);
      expect(mine.update).toHaveBeenLastCalledWith({ progress: 0, status: 'NOT_STARTED' });
    });

    it('does not write when nothing changed', async () => {
      const mine = goal({ progress: 20, status: 'IN_PROGRESS' });
      goalModel.findOne.mockResolvedValue(mine);
      await service.updateGoalProgress(actor, GOAL, 20);
      expect(mine.update).not.toHaveBeenCalled();
      expect(auditModel.create).not.toHaveBeenCalled();
    });

    it('is only for my own goal', async () => {
      goalModel.findOne.mockResolvedValue(null);
      await expect(service.updateGoalProgress(actor, GOAL, 50)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(goalModel.findOne.mock.calls[0][0].where).toEqual({ id: GOAL, tenantId: TENANT, employeeId: ME });
    });
  });
});
