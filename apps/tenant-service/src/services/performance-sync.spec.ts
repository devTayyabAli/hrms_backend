import { HttpStatus } from '@nestjs/common';
import { EmployeeStatus } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { EmployeeService } from './employee.service';
import { KpiTemplateService } from './kpi-template.service';
import { PerformanceCycleService } from './performance-cycle.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformancePlanService } from './performance-plan.service';
import { PerformanceSelfService } from './performance-self.service';
import { PerformanceSyncService } from './performance-sync.service';
import { table } from './testing/fake-table';

/**
 * Employee Management changes a person while a review of theirs is open: the
 * review keeps its reviewer and criteria and HR decides; someone who leaves has
 * their open reviews closed, not deleted; and a cycle that no longer fits them
 * flags it. Reviews already completed are not touched.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['performance.manage'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', joiningDate: '2024-01-01', employmentType: 'PERMANENT', reportingManagerId: null, departmentId: null, designationId: null, ...over });
const kpi = (title: string, weight: number) => ({ title, weight });

describe('Performance reviews and changes in Employee Management', () => {
  let models: Record<string, any>;
  let provider: any;
  let templates: KpiTemplateService;
  let dashboard: PerformanceDashboardService;
  let sync: PerformanceSyncService;
  let cycles: PerformanceCycleService;
  let plan: PerformancePlanService;
  let self: PerformanceSelfService;
  let holders: { tellPermission: jest.Mock };
  let sara: any;
  let ayesha: any;
  let nadia: any;
  let eng: any;
  let sales: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Sara', lastName: 'Manager', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Nadia', lastName: 'New', userId: 'u-nadia', email: 'nadia@x.com' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Engineering' }, { tenantId: TENANT, name: 'Sales' }]),
      Designation: table(),
      Review: table(),
      Goal: table(),
      Kpi: table(),
      Template: table(),
      Cycle: table(),
      Notification: table(),
      Audit: table(),
    };
    [sara, ayesha, nadia] = models.Employee.rows;
    [eng, sales] = models.Department.rows;
    sara.departmentId = eng.id;
    ayesha.departmentId = eng.id;
    ayesha.reportingManagerId = sara.id;
    nadia.departmentId = sales.id;
    nadia.reportingManagerId = sara.id;
    provider = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => models.Designation,
      getPerformanceReviewModel: async () => models.Review,
      getPerformanceGoalModel: async () => models.Goal,
      getReviewKpiModel: async () => models.Kpi,
      getKpiTemplateModel: async () => models.Template,
      getPerformanceCycleModel: async () => models.Cycle,
      getEmployeeNotificationModel: async () => models.Notification,
      getEntityAuditLogModel: async () => models.Audit,
    };
    holders = { tellPermission: jest.fn() };
    templates = new KpiTemplateService(provider);
    dashboard = new PerformanceDashboardService(provider, undefined, templates);
    sync = new PerformanceSyncService(provider, dashboard, templates, holders as any);
    cycles = new PerformanceCycleService(provider, dashboard, undefined, sync);
    plan = new PerformancePlanService(provider, dashboard);
    self = new PerformanceSelfService(provider);
  });

  const makeTemplate = (name: string, departmentIds: string[], items = [kpi('Dept KPI', 100)]) => as(HR, () => templates.create(TENANT, { name, departmentIds, items } as any)) as Promise<any>;
  const startCycle = async (over: Record<string, unknown> = {}) => {
    const cycle: any = await as(HR, () => cycles.create(TENANT, { name: 'H2 2026', startDate: '2026-07-01', endDate: '2026-12-31', eligibility: { minTenureDays: 0 }, ...over } as any));
    await as(HR, () => cycles.launch(TENANT, cycle.id));
    return cycle;
  };
  const reviewOf = (employee: any) => models.Review.rows.find((r: any) => r.employeeId === employee.id);
  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to).filter(Boolean);
  const transfer = async (employee: any, to: any) => {
    const before = { departmentId: employee.departmentId, designationId: employee.designationId };
    employee.departmentId = to.id;
    return sync.onAssignmentChange(TENANT, employee.id, before, { departmentId: to.id, designationId: employee.designationId });
  };

  describe('a transfer', () => {
    beforeEach(async () => {
      await makeTemplate('Engineering', [eng.id], [kpi('Eng KPI', 100)]);
      await makeTemplate('Sales', [sales.id], [kpi('Sales KPI', 100)]);
      await startCycle();
    });

    it('flags the open review for HR, keeping its reviewer and KPIs, and tells HR and the reviewer', async () => {
      const review = reviewOf(ayesha);
      models.Notification.rows.length = 0;

      expect(await transfer(ayesha, sales)).toBe(1);

      expect(review.pendingChange).toMatchObject({ type: 'TRANSFER', from: { departmentName: 'Engineering' }, to: { departmentName: 'Sales' }, options: ['KEEP', 'REASSIGN', 'RESTART', 'REMOVE'] });
      expect(review.reviewerId).toBe(sara.id);
      expect(models.Kpi.rows.filter((k: any) => k.reviewId === review.id).map((k: any) => k.title)).toEqual(['Eng KPI']);
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[sara.id, 'Decision needed on Ayesha Khan\'s review']]);
      expect(holders.tellPermission).toHaveBeenCalledWith(TENANT, 'performance.manage', [ayesha.id], expect.stringContaining('Transfer decision needed'), expect.any(String));
      expect(events()).toContain('TRANSFER_DETECTED');
    });

    it('keeps what the review was set up for through a second move', async () => {
      const review = reviewOf(ayesha);
      await transfer(ayesha, sales);
      await transfer(ayesha, eng);
      expect(review.pendingChange.from.departmentName).toBe('Engineering');
      expect(review.pendingChange.to.departmentName).toBe('Engineering');
    });

    it('leaves a completed, published, closed or manager-only change alone', async () => {
      const review = reviewOf(ayesha);
      review.status = 'COMPLETED';
      expect(await transfer(ayesha, sales)).toBe(0);
      review.status = 'PENDING';
      review.publishedAt = new Date();
      expect(await transfer(ayesha, eng)).toBe(0);
      review.publishedAt = null;
      review.closedAt = new Date();
      expect(await transfer(ayesha, sales)).toBe(0);
      review.closedAt = null;
      expect(await sync.onAssignmentChange(TENANT, ayesha.id, { departmentId: eng.id }, { departmentId: eng.id })).toBe(0);
      expect(review.pendingChange ?? null).toBeNull();
    });

    it('lists what is waiting, oldest first, and nothing once it is decided', async () => {
      await transfer(ayesha, sales);
      const waiting: any = await as(HR, () => sync.pending(TENANT));
      expect(waiting.total).toBe(1);
      expect(waiting.data[0]).toMatchObject({ reviewId: reviewOf(ayesha).id, employee: { name: 'Ayesha Khan' }, reviewer: { name: 'Sara Manager' }, type: 'TRANSFER' });

      await as(HR, () => sync.decide(TENANT, reviewOf(ayesha).id, { decision: 'KEEP' } as any));
      expect((await as(HR, () => sync.pending(TENANT))).total).toBe(0);
    });

    describe('and HR\'s decision', () => {
      const decide = (decision: string, extra: Record<string, unknown> = {}) => as(HR, () => sync.decide(TENANT, reviewOf(ayesha).id, { decision, ...extra } as any)) as Promise<any>;

      beforeEach(() => transfer(ayesha, sales));

      it('KEEP clears the flag and changes nothing else, with the note recorded', async () => {
        await decide('KEEP', { note: 'Finishing the cycle in Engineering' });
        expect(reviewOf(ayesha).pendingChange).toBeNull();
        expect(reviewOf(ayesha).reviewerId).toBe(sara.id);
        expect(models.Audit.rows.at(-1).changes).toMatchObject({ event: { to: 'CHANGE_DECISION_KEEP' }, note: { to: 'Finishing the cycle in Engineering' } });
      });

      it('REASSIGN gives it to the new manager by default, or to someone named, and tells them', async () => {
        const omar = models.Employee.create({ tenantId: TENANT, status: 'ACTIVE', firstName: 'Omar', lastName: 'Sales', userId: 'u-omar', email: 'omar@x.com' });
        ayesha.reportingManagerId = (await omar).id;
        models.Notification.rows.length = 0;

        await decide('REASSIGN');
        expect(reviewOf(ayesha)).toMatchObject({ reviewerId: (await omar).id, reviewerPinned: false, pendingChange: null });
        expect(models.Notification.rows.map((n: any) => n.employeeId)).toEqual([(await omar).id]);
      });

      it('REASSIGN refuses the person themself or someone who has left', async () => {
        await expect(decide('REASSIGN', { reviewerId: ayesha.id })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
        await expect(decide('REASSIGN', { reviewerId: GHOST })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
        expect(reviewOf(ayesha).pendingChange).not.toBeNull();
      });

      it('RESTART puts the new department\'s KPIs in, takes the plan back to a draft, refreshes the snapshot and tells both', async () => {
        await plan.reviewerSave(TENANT, 'u-sara', undefined, reviewOf(ayesha).id, { goals: [{ title: 'Old goal' }] } as any);
        await plan.reviewerPublish(TENANT, 'u-sara', undefined, reviewOf(ayesha).id);
        models.Notification.rows.length = 0;

        await decide('RESTART');

        const review = reviewOf(ayesha);
        expect(models.Kpi.rows.filter((k: any) => k.reviewId === review.id).map((k: any) => k.title)).toEqual(['Sales KPI']);
        expect(review).toMatchObject({ planPublishedAt: null, pendingChange: null });
        expect(review.employeeSnapshot.departmentName).toBe('Sales');
        expect(models.Goal.rows.every((g: any) => g.publishedAt === null)).toBe(true);
        expect(models.Notification.rows.map((n: any) => n.title)).toEqual(['Set goals again for Ayesha Khan', 'Your H2 2026 goals are being reset']);
        expect(models.Audit.rows.some((row: any) => row.tableName === 'review_kpis' && row.action === 'DELETE')).toBe(true);
      });

      it('RESTART is refused once a KPI has been scored', async () => {
        models.Kpi.rows.find((k: any) => k.reviewId === reviewOf(ayesha).id).score = '4.0';
        await expect(decide('RESTART')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
        expect(reviewOf(ayesha).pendingChange).not.toBeNull();
      });

      it('REMOVE closes the review for good reason, and keeps it', async () => {
        await decide('REMOVE');
        expect(reviewOf(ayesha)).toMatchObject({ closedReason: 'REMOVED_FROM_CYCLE', pendingChange: null });
        expect(reviewOf(ayesha).closedAt).toBeInstanceOf(Date);
        expect(models.Review.rows).toContain(reviewOf(ayesha));
      });

      it('is only for a review that is waiting, not already finished, and with a choice that fits', async () => {
        await decide('KEEP');
        await expect(decide('KEEP')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
        await expect(as(HR, () => sync.decide(TENANT, GHOST, { decision: 'KEEP' } as any))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      });
    });
  });

  describe('someone who leaves', () => {
    beforeEach(async () => {
      await startCycle();
    });

    it('has their open reviews closed and kept, and the reviewer told; completed ones are untouched', async () => {
      const done = await dashboard.createReview(TENANT, { employeeId: ayesha.id, cycle: 'H1 2026', status: 'COMPLETED', rating: 4 } as any);
      models.Notification.rows.length = 0;

      expect(await sync.closeForExit(TENANT, ayesha.id)).toBe(1);

      expect(reviewOf(ayesha)).toMatchObject({ closedReason: 'EMPLOYEE_EXITED' });
      expect(models.Review.rows.find((r: any) => r.id === done.id).closedAt).toBeUndefined();
      expect(models.Review.rows).toHaveLength(4);
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[sara.id, 'Review closed: employee left']]);
      expect(events()).toContain('REVIEW_CLOSED_EMPLOYEE_EXITED');
    });

    it('cannot be self-assessed, evaluated or planned once closed, and shows as closed to the reviewer', async () => {
      const review = reviewOf(ayesha);
      await sync.closeForExit(TENANT, ayesha.id);

      await expect(self.submitSelfAssessment({ tenantId: TENANT, userId: 'u-ayesha' }, review.id, { comments: 'x' } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(self.submitEvaluation({ tenantId: TENANT, userId: 'u-sara' }, review.id, { communication: 3 } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(plan.reviewerSave(TENANT, 'u-sara', undefined, review.id, { goals: [{ title: 'x' }] } as any)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(plan.reviewerPublish(TENANT, 'u-sara', undefined, review.id)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

      const reviewing: any = await self.getReviewing({ tenantId: TENANT, userId: 'u-sara' });
      expect(reviewing.summary).toMatchObject({ toComplete: 1, closed: 1 });
      expect(reviewing.data.find((r: any) => r.id === review.id)).toMatchObject({ canEvaluate: false, closed: { reason: 'EMPLOYEE_EXITED' } });
    });

    it('does not follow a manager change or a reviewer leaving once closed', async () => {
      await sync.closeForExit(TENANT, ayesha.id);
      ayesha.reportingManagerId = nadia.id;
      expect(await dashboard.followManagerChange(TENANT, ayesha.id)).toBe(0);
      expect(await dashboard.releaseReviewer(TENANT, sara.id)).toBe(1);
      expect(reviewOf(ayesha).reviewerId).toBe(sara.id);
    });

    it('can be reopened by HR only when the person works here again', async () => {
      const review = reviewOf(ayesha);
      await sync.closeForExit(TENANT, ayesha.id);
      ayesha.status = 'RESIGNED';
      await expect(as(HR, () => sync.reopen(TENANT, review.id))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      ayesha.status = 'ACTIVE';
      const reopened: any = await as(HR, () => sync.reopen(TENANT, review.id));
      expect(reopened.closed).toBeNull();
      expect(events()).toContain('REVIEW_REOPENED');
      await expect(as(HR, () => sync.reopen(TENANT, review.id))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('is closed by the employee record when they are marked Resigned, and a failure does not undo the exit', async () => {
      const found: any = { id: ayesha.id, tenantId: TENANT, status: EmployeeStatus.ACTIVE, exitDate: null, email: 'ayesha@x.com', employeeCode: 'E2', userId: null, update: jest.fn(async (patch: any) => Object.assign(found, patch)) };
      const empProvider: any = { getEmployeeModel: async () => ({ findOne: async () => found }) };
      const invitations: any = { setLinkedAccountActive: jest.fn(), deactivateLinkedAccount: jest.fn() };
      const assets: any = { assertCanLeave: jest.fn() };
      const closeForExit = jest.fn().mockResolvedValue(1);
      const service = new EmployeeService(empProvider, {} as any, invitations, assets, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { closeForExit } as any);
      jest.spyOn(service, 'getOne').mockResolvedValue({} as any);

      await service.updateStatus(TENANT, ayesha.id, EmployeeStatus.RESIGNED, '2026-12-31');
      expect(closeForExit).toHaveBeenCalledWith(TENANT, ayesha.id);

      found.status = EmployeeStatus.ACTIVE;
      closeForExit.mockRejectedValue(new Error('down'));
      await expect(service.updateStatus(TENANT, ayesha.id, EmployeeStatus.RESIGNED, '2026-12-31')).resolves.toBeDefined();
    });
  });

  describe('a cycle that stops fitting the person', () => {
    it('flags an open review when a transfer takes them out of the cycle\'s department, and clears it when they return', async () => {
      await startCycle({ eligibility: { minTenureDays: 0, departmentIds: [eng.id] } });
      const review = reviewOf(ayesha);

      ayesha.departmentId = sales.id;
      await cycles.onEmployeeChange(TENANT, ayesha.id);
      expect(review.pendingChange).toMatchObject({ type: 'ELIGIBILITY', eligibilityReason: 'Their department is not part of this cycle.', options: ['KEEP', 'REMOVE'] });
      expect(holders.tellPermission).toHaveBeenCalledWith(TENANT, 'performance.manage', [ayesha.id], expect.stringContaining('Eligibility changed'), expect.any(String));
      expect(events()).toContain('ELIGIBILITY_CHANGED');

      holders.tellPermission.mockClear();
      await cycles.onEmployeeChange(TENANT, ayesha.id);
      expect(holders.tellPermission).not.toHaveBeenCalled();

      ayesha.departmentId = eng.id;
      await cycles.onEmployeeChange(TENANT, ayesha.id);
      expect(review.pendingChange).toBeNull();
      expect(events()).toContain('ELIGIBILITY_RESTORED');
    });

    it('flags a change of contract type when the cycle is for another type, and lets HR remove or keep them', async () => {
      await startCycle({ eligibility: { minTenureDays: 0, employmentTypes: ['PERMANENT'] } });
      ayesha.employmentType = 'CONTRACT';
      await cycles.onEmployeeChange(TENANT, ayesha.id);
      expect(reviewOf(ayesha).pendingChange.eligibilityReason).toContain('CONTRACT');

      await expect(as(HR, () => sync.decide(TENANT, reviewOf(ayesha).id, { decision: 'REASSIGN' } as any))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await as(HR, () => sync.decide(TENANT, reviewOf(ayesha).id, { decision: 'REMOVE' } as any));
      expect(reviewOf(ayesha).closedReason).toBe('REMOVED_FROM_CYCLE');
    });

    it('does not flag a finished review, and counts someone who left as closed rather than as a change', async () => {
      await startCycle({ eligibility: { minTenureDays: 0, departmentIds: [eng.id] } });
      reviewOf(ayesha).status = 'COMPLETED';
      ayesha.departmentId = sales.id;
      await cycles.onEmployeeChange(TENANT, ayesha.id);
      expect(reviewOf(ayesha).pendingChange ?? null).toBeNull();

      reviewOf(sara).status = 'PENDING';
      sara.status = 'RESIGNED';
      await cycles.onEmployeeChange(TENANT, sara.id);
      expect(reviewOf(sara).pendingChange ?? null).toBeNull();
    });
  });

  describe('what a probation confirmation or a hire does', () => {
    it('enrols a person who becomes eligible and records it in the history', async () => {
      await startCycle({ eligibility: { minTenureDays: 0, probation: 'EXCLUDE' } });
      nadia.employmentType = 'PROBATION';
      models.Review.rows.splice(models.Review.rows.findIndex((r: any) => r.employeeId === nadia.id), 1);

      expect(await cycles.onEmployeeChange(TENANT, nadia.id)).toBe(0);
      nadia.employmentType = 'PERMANENT';
      expect(await cycles.onEmployeeChange(TENANT, nadia.id)).toBe(1);
      expect(events()).toContain('REVIEW_ENROLLED_IN_CYCLE');
    });
  });
});
