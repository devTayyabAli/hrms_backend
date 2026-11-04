import { HttpStatus } from '@nestjs/common';
import { PerformanceReviewStatus } from '@app/common';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformanceSelfService } from './performance-self.service';
import { table } from './testing/fake-table';

/**
 * Who completes a performance review: the employee's reporting manager by
 * default, HR's choice when they pick one, following a change of manager while
 * the review is open, and a reviewer's own place to score what they review.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', reportingManagerId: null, ...over });

describe('Performance review reviewers', () => {
  let models: Record<string, any>;
  let dashboard: PerformanceDashboardService;
  let self: PerformanceSelfService;
  let ayesha: any;
  let sara: any;
  let omar: any;
  let hina: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Sara', lastName: 'Manager', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Lead', userId: 'u-omar', email: 'omar@x.com' }),
        person({ employeeCode: 'E4', firstName: 'Hina', lastName: 'Gone', userId: 'u-hina', email: 'hina@x.com', status: 'RESIGNED' }),
      ]),
      Review: table(),
      Notification: table(),
      Audit: table(),
    };
    [ayesha, sara, omar, hina] = models.Employee.rows;
    ayesha.reportingManagerId = sara.id;
    const provider: any = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => table(),
      getDesignationModel: async () => table(),
      getPerformanceReviewModel: async () => models.Review,
      getEmployeeNotificationModel: async () => models.Notification,
      getEntityAuditLogModel: async () => models.Audit,
    };
    dashboard = new PerformanceDashboardService(provider);
    self = new PerformanceSelfService(provider);
  });

  const create = (over: Record<string, unknown> = {}) => dashboard.createReview(TENANT, { employeeId: ayesha.id, cycle: 'H2 2026', ...over } as any) as Promise<any>;
  const notes = () => models.Notification.rows.map((n: any) => [n.employeeId, n.title]);

  describe('assigning', () => {
    it('is the reporting manager unless HR picks someone, and the manager is told', async () => {
      const review = await create();

      expect(review).toMatchObject({ reviewer: { id: sara.id, name: 'Sara Manager' }, reviewerSetBy: 'REPORTING_MANAGER' });
      expect(notes()).toEqual([[ayesha.id, 'Self-assessment requested: H2 2026'], [sara.id, 'Review to complete: Ayesha Khan']]);
    });

    it('is the person HR picks, who is then pinned', async () => {
      const review = await create({ reviewerId: omar.id });
      expect(review).toMatchObject({ reviewer: { name: 'Omar Lead' }, reviewerSetBy: 'HR' });
    });

    it('is nobody (HR) when the employee has no manager', async () => {
      ayesha.reportingManagerId = null;
      expect((await create()).reviewer).toBeNull();
    });

    it('cannot be the employee themself, or someone who has left, or unknown', async () => {
      await expect(create({ reviewerId: ayesha.id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(create({ reviewerId: hina.id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(create({ reviewerId: GHOST })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(models.Review.rows).toHaveLength(0);
    });

    it('can be changed, and null goes back to the manager', async () => {
      const review = await create();
      models.Notification.rows.length = 0;

      const changed = await dashboard.updateReview(TENANT, review.id, { reviewerId: omar.id } as any);
      expect(changed).toMatchObject({ reviewer: { name: 'Omar Lead' }, reviewerSetBy: 'HR' });
      expect(notes()).toEqual([[omar.id, 'Review to complete: Ayesha Khan']]);

      const back = await dashboard.updateReview(TENANT, review.id, { reviewerId: null } as any);
      expect(back).toMatchObject({ reviewer: { name: 'Sara Manager' }, reviewerSetBy: 'REPORTING_MANAGER' });
    });

    it('is not changed under an employee once the review is published', async () => {
      const review = await create({ status: PerformanceReviewStatus.COMPLETED, rating: 4 });
      await dashboard.publishReview(TENANT, review.id);
      await expect(dashboard.updateReview(TENANT, review.id, { reviewerId: omar.id } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });
  });

  describe('following the reporting line', () => {
    it('moves an open review to the new manager, and tells them', async () => {
      await create();
      ayesha.reportingManagerId = omar.id;
      models.Notification.rows.length = 0;

      expect(await dashboard.followManagerChange(TENANT, ayesha.id)).toBe(1);

      expect(models.Review.rows[0].reviewerId).toBe(omar.id);
      expect(notes()).toEqual([[omar.id, 'Review to complete: Ayesha Khan']]);
    });

    it('leaves a review HR pinned, a completed one, and one that already has the right reviewer', async () => {
      await create({ reviewerId: omar.id });
      await create({ cycle: 'H1', status: PerformanceReviewStatus.COMPLETED, rating: 4 });
      await create({ cycle: 'Q3' });
      ayesha.reportingManagerId = sara.id;

      expect(await dashboard.followManagerChange(TENANT, ayesha.id)).toBe(0);
      expect(models.Review.rows.map((r: any) => r.reviewerId)).toEqual([omar.id, sara.id, sara.id]);
    });

    it('hands a leaver\'s open reviews to the employee\'s manager, or HR', async () => {
      await create({ reviewerId: omar.id });
      models.Notification.rows.length = 0;

      expect(await dashboard.releaseReviewer(TENANT, omar.id)).toBe(1);
      expect(models.Review.rows[0]).toMatchObject({ reviewerId: sara.id, reviewerPinned: false });

      expect(await dashboard.releaseReviewer(TENANT, sara.id)).toBe(1);
      expect(models.Review.rows[0].reviewerId).toBeNull();
    });
  });

  describe('completing the reviews I am given', () => {
    const mine = (user = 'u-sara') => ({ tenantId: TENANT, userId: user });

    it('lists only the reviews I review, those to complete first', async () => {
      await create();
      await create({ cycle: 'H1', status: PerformanceReviewStatus.COMPLETED, rating: 4 });
      await create({ cycle: 'Other', reviewerId: omar.id });

      const result: any = await self.getReviewing(mine());

      expect(result.summary).toEqual({ total: 2, toComplete: 1, completed: 1, closed: 0 });
      expect(result.data.map((r: any) => r.cycle)).toEqual(['H2 2026', 'H1']);
      expect(result.data[0]).toMatchObject({ employee: { name: 'Ayesha Khan' }, canEvaluate: true });
    });

    it('shows the employee\'s self-assessment, and nothing of reviews that are not mine', async () => {
      const review = await create();
      models.Review.rows[0].selfAssessment = { comments: 'Shipped the migration' };
      expect(await self.getReviewingOne(mine(), review.id)).toMatchObject({ selfAssessment: { comments: 'Shipped the migration' } });
      await expect(self.getReviewingOne(mine('u-omar'), review.id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('saves scores as in progress, and works out the rating', async () => {
      const review = await create();

      const saved: any = await self.submitEvaluation(mine(), review.id, { professionalism: 4, teamwork: 5, reviewerComments: ' Strong quarter ' } as any);

      expect(saved).toMatchObject({ status: 'IN_PROGRESS', rating: 4.5, reviewerComments: 'Strong quarter' });
    });

    it('completes it with a date and a record, and needs a score to do so', async () => {
      const review = await create();
      await expect(self.submitEvaluation(mine(), review.id, { complete: true } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });

      const done: any = await self.submitEvaluation(mine(), review.id, { communication: 3, complete: true } as any);

      expect(done.status).toBe('COMPLETED');
      expect(done.reviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(models.Audit.rows.map((row: any) => row.changes?.event?.to)).toContain('REVIEW_COMPLETED_BY_REVIEWER');
    });

    it('is not changed once published, and not by someone else', async () => {
      const review = await create();
      await self.submitEvaluation(mine(), review.id, { communication: 3, complete: true } as any);
      await dashboard.publishReview(TENANT, review.id);

      await expect(self.submitEvaluation(mine(), review.id, { communication: 5 } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(self.submitEvaluation(mine('u-omar'), review.id, { communication: 5 } as any)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('changes nothing when nothing was sent', async () => {
      const review = await create();
      expect(await self.submitEvaluation(mine(), review.id, {} as any)).toMatchObject({ status: 'PENDING' });
      expect(models.Audit.rows).toHaveLength(0);
    });
  });
});
