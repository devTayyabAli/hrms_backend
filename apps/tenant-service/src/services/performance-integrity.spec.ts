import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { DataScope, PerformanceReviewStatus } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformanceSelfService } from './performance-self.service';
import { EmployeeService } from './employee.service';
import { table } from './testing/fake-table';

/**
 * Performance records as history: what a review keeps about the person at the
 * time, one review per person per cycle, nothing new for someone who left,
 * confidential reviews that do not pass to whoever manages the person next,
 * and no deleting an employee out from under their reviews.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', reportingManagerId: null, ...over });
const MANAGER = { roles: [], isSuperAdmin: false, userId: 'u-x', email: 'x@x.com', permissions: ['performance.manage'] };
const PLAIN = { roles: [], isSuperAdmin: false, userId: 'u-y', email: 'y@x.com', permissions: ['performance.view'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);

describe('Performance history and integrity', () => {
  let models: Record<string, any>;
  let provider: any;
  let dashboard: PerformanceDashboardService;
  let self: PerformanceSelfService;
  let ayesha: any;
  let sara: any;
  let omar: any;
  let hina: any;
  let eng: any;
  let sales: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com', employmentType: 'PERMANENT' }),
        person({ employeeCode: 'E2', firstName: 'Sara', lastName: 'Manager', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Lead', userId: 'u-omar', email: 'omar@x.com' }),
        person({ employeeCode: 'E4', firstName: 'Hina', lastName: 'Gone', userId: 'u-hina', email: 'hina@x.com', status: 'RESIGNED' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Engineering' }, { tenantId: TENANT, name: 'Sales' }]),
      Designation: table([{ tenantId: TENANT, title: 'Developer' }]),
      Review: table(),
      Goal: table(),
      Notification: table(),
      Audit: table(),
    };
    [ayesha, sara, omar, hina] = models.Employee.rows;
    [eng, sales] = models.Department.rows;
    ayesha.departmentId = eng.id;
    ayesha.designationId = models.Designation.rows[0].id;
    ayesha.reportingManagerId = sara.id;
    provider = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => models.Designation,
      getPerformanceReviewModel: async () => models.Review,
      getPerformanceGoalModel: async () => models.Goal,
      getEmployeeNotificationModel: async () => models.Notification,
      getEntityAuditLogModel: async () => models.Audit,
    };
    dashboard = new PerformanceDashboardService(provider);
    self = new PerformanceSelfService(provider);
  });

  const create = (over: Record<string, unknown> = {}, employee = ayesha) => dashboard.createReview(TENANT, { employeeId: employee.id, cycle: 'H2 2026', ...over } as any) as Promise<any>;
  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to).filter(Boolean);

  describe('what a review keeps about the person', () => {
    it('records their department, designation, manager and reviewer when it is made', async () => {
      const review = await create();

      expect(review.snapshot).toMatchObject({
        employee: { id: ayesha.id, name: 'Ayesha Khan', employeeCode: 'E1' },
        departmentId: eng.id,
        departmentName: 'Engineering',
        designationTitle: 'Developer',
        employmentType: 'PERMANENT',
        reportingManagerId: sara.id,
        reportingManagerName: 'Sara Manager',
        reviewerId: sara.id,
        reviewerName: 'Sara Manager',
      });
    });

    it('keeps saying so after a transfer and a change of manager, and is taken again when it is completed, then frozen', async () => {
      const review = await create();

      ayesha.departmentId = sales.id;
      ayesha.reportingManagerId = omar.id;
      const completed: any = await dashboard.updateReview(TENANT, review.id, { status: PerformanceReviewStatus.COMPLETED, rating: 4 } as any);
      expect(completed.snapshot).toMatchObject({ departmentName: 'Sales', reportingManagerName: 'Omar Lead' });

      ayesha.departmentId = eng.id;
      ayesha.reportingManagerId = sara.id;
      expect((await dashboard.getReview(TENANT, review.id)).snapshot).toMatchObject({ departmentName: 'Sales', reportingManagerName: 'Omar Lead' });
    });

    it('is taken when the reviewer completes it from their own screen', async () => {
      const review = await create();
      await self.submitEvaluation({ tenantId: TENANT, userId: 'u-sara' }, review.id, { communication: 4, complete: true } as any);
      expect(models.Review.rows[0].employeeSnapshot).toMatchObject({ reviewerName: 'Sara Manager', departmentName: 'Engineering' });
    });

    it('never stops a review being made when a name cannot be read', async () => {
      models.Department.findOne = jest.fn().mockRejectedValue(new Error('no table'));
      expect((await create()).snapshot).toMatchObject({ departmentId: eng.id, departmentName: null });
    });
  });

  describe('one review per person per cycle', () => {
    it('refuses the same cycle again, ignoring case and spaces, and lets another person or cycle through', async () => {
      await create();
      await expect(create({ cycle: '  h2 2026 ' })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(create({ cycle: 'H1 2026' })).resolves.toBeDefined();
      await expect(create({}, sara)).resolves.toBeDefined();
      expect(models.Review.rows).toHaveLength(3);
    });

    it('refuses renaming a review into a cycle the person already has', async () => {
      await create();
      const other = await create({ cycle: 'H1 2026' });
      await expect(dashboard.updateReview(TENANT, other.id, { cycle: 'h2 2026' } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(dashboard.updateReview(TENANT, other.id, { cycle: 'H1 2026' } as any)).resolves.toBeDefined();
    });
  });

  describe('someone who no longer works here', () => {
    it('is not given a new review or goal, unless someone who manages performance authorizes it', async () => {
      await expect(create({}, hina)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(dashboard.createGoal(TENANT, { employeeId: hina.id, title: 'x' } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

      await expect(as(PLAIN, () => create({ authorizeInactive: true }, hina))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(models.Review.rows).toHaveLength(0);

      await expect(as(MANAGER, () => create({ authorizeInactive: true }, hina))).resolves.toBeDefined();
      await expect(as(MANAGER, () => dashboard.createGoal(TENANT, { employeeId: hina.id, title: 'Handover', authorizeInactive: true } as any))).resolves.toBeDefined();
    });
  });

  describe('a finalized review', () => {
    it('cannot be changed by the employee, whose self-assessment closes with it', async () => {
      const review = await create({ status: PerformanceReviewStatus.COMPLETED, rating: 4 });
      await expect(self.submitSelfAssessment({ tenantId: TENANT, userId: 'u-ayesha' }, review.id, { comments: 'I disagree' } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(models.Review.rows[0].selfAssessment).toBeUndefined();
    });
  });

  describe('confidential reviews and a new manager', () => {
    const scoped = (me: string | null, scope = DataScope.TEAM) =>
      new PerformanceDashboardService(provider, {
        scope: () => scope,
        employeeWhere: async (_t: string, field = 'employeeId') => ({ [field]: { [Op.in]: [ayesha.id] } }),
        canSee: async () => true,
        actorEmployeeId: async () => me,
      } as any);
    const whereOf = async (service: PerformanceDashboardService) => {
      let captured: any;
      models.Review.findAll.mockImplementationOnce(async (query: any) => {
        captured = query.where;
        return [];
      });
      await service.getReviews(TENANT);
      return captured;
    };

    it('shows a scoped reader open reviews, and completed ones only when they were the reviewer or manager then', async () => {
      const where = await whereOf(scoped(omar.id));

      expect(where.employeeId).toEqual({ [Op.in]: [ayesha.id] });
      const visible = where[Op.and][0][Op.or] as any[];
      expect(visible).toHaveLength(5);
      expect(visible[0]).toEqual({ status: { [Op.ne]: 'COMPLETED' }, closedAt: null });
      expect(visible[1]).toEqual({ employeeSnapshot: null });
      expect(visible[2]).toEqual({ reviewerId: omar.id });
      expect(visible[4]).toEqual({ accessGrantedTo: { [Op.contains]: [omar.id] } });
    });

    it('adds the departments a head headed when the review was made', async () => {
      eng.managerId = omar.id;
      const visible = (await whereOf(scoped(omar.id, DataScope.DEPARTMENT)))[Op.and][0][Op.or] as any[];
      expect(visible).toHaveLength(6);
    });

    it('does not narrow organization-wide readers, nor a reader with no employee record', async () => {
      expect((await whereOf(scoped(omar.id, DataScope.ORGANIZATION)))[Op.and]).toBeUndefined();
      expect((await whereOf(scoped(null)))[Op.and]).toBeUndefined();
    });

    it('narrows the single review, its publishing and its deletion the same way', async () => {
      const service = scoped(omar.id);
      const seen: any[] = [];
      models.Review.findOne.mockImplementation(async (query: any) => {
        seen.push(query.where);
        return null;
      });
      await expect(service.getReview(TENANT, GHOST)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(service.publishReview(TENANT, GHOST)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(seen).toHaveLength(2);
      expect(seen.every((where) => Array.isArray(where[Op.and]))).toBe(true);
    });

    it('lets HR give particular people access, records it, and can take it away', async () => {
      const review = await create();
      const granted: any = await dashboard.setReviewAccess(TENANT, review.id, { employeeIds: [omar.id, omar.id, ayesha.id] } as any, 'hr@x.com');

      expect(granted.accessGrantedTo).toEqual([omar.id]);
      expect(events()).toContain('REVIEW_ACCESS_CHANGED');
      expect((await dashboard.setReviewAccess(TENANT, review.id, { employeeIds: [] } as any)).accessGrantedTo).toEqual([]);
      await expect(dashboard.setReviewAccess(TENANT, review.id, { employeeIds: [GHOST] } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });
  });

  describe('changes to the employee that move a review', () => {
    it('are in the audit history when the manager changes or the reviewer leaves', async () => {
      await create();
      ayesha.reportingManagerId = omar.id;
      await dashboard.followManagerChange(TENANT, ayesha.id);
      expect(events()).toContain('REVIEWER_FOLLOWED_MANAGER_CHANGE');
      expect(models.Audit.rows.at(-1).changes.reviewerId).toEqual({ from: sara.id, to: omar.id });

      omar.status = 'RESIGNED';
      ayesha.reportingManagerId = sara.id;
      await dashboard.releaseReviewer(TENANT, omar.id);
      expect(events()).toContain('REVIEWER_LEFT_REASSIGNED');
    });
  });

  describe('deleting an employee who has performance records', () => {
    const arrange = (reviews: number, goals: number) => {
      const found = { id: ayesha.id, userId: null, email: 'ayesha@x.com' };
      const delProvider: any = {
        getEmployeeModel: async () => ({ findAll: async () => [found], destroy: jest.fn(), findOne: async () => found }),
        getPayrollRecordModel: async () => ({ count: async () => 0 }),
        getPerformanceReviewModel: async () => ({ count: async () => reviews, destroy: jest.fn() }),
        getPerformanceGoalModel: async () => ({ count: async () => goals, destroy: jest.fn() }),
        getDepartmentModel: async () => ({}),
        getDesignationModel: async () => ({}),
      };
      const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
      const assetClearance: any = { assertHoldsNoAssets: jest.fn() };
      return { service: new EmployeeService(delProvider, {} as any, invitations, assetClearance), delProvider };
    };

    it('refuses with the reason, and keeps what was written', async () => {
      const { service } = arrange(3, 2);
      await expect(service.bulkRemove(TENANT, [ayesha.id])).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        message: expect.stringMatching(/3 performance reviews and 2 goals.*Resigned/s),
      });
    });

    it('refuses for goals alone', async () => {
      await expect(arrange(0, 1).service.bulkRemove(TENANT, [ayesha.id])).rejects.toMatchObject({ message: expect.stringContaining('1 goal in Performance') });
    });
  });
});
