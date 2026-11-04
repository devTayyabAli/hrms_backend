import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { PerformanceReviewStatus } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { KpiTemplateService } from './kpi-template.service';
import { PerformanceCycleService } from './performance-cycle.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformancePlanService } from './performance-plan.service';
import { PerformanceSelfService } from './performance-self.service';
import { weightedKpiScore } from './performance-kpi';
import { table } from './testing/fake-table';

/**
 * KPI templates, the plan of a review (KPIs and goals) that the reviewer sets
 * and publishes, what the employee sees, KPI scores in the evaluation, and the
 * history of every change.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['performance.manage'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', joiningDate: '2024-01-01', employmentType: 'PERMANENT', reportingManagerId: null, departmentId: null, designationId: null, ...over });
const item = (title: string, weight: number, over: Record<string, unknown> = {}) => ({ title, weight, ...over });

describe('Performance plans: KPIs and goals', () => {
  let models: Record<string, any>;
  let provider: any;
  let templates: KpiTemplateService;
  let dashboard: PerformanceDashboardService;
  let plan: PerformancePlanService;
  let self: PerformanceSelfService;
  let cycles: PerformanceCycleService;
  let sara: any;
  let ayesha: any;
  let omar: any;
  let eng: any;
  let backend: any;
  let sales: any;
  let dev: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Sara', lastName: 'Manager', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Sales', userId: 'u-omar', email: 'omar@x.com' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Engineering' }, { tenantId: TENANT, name: 'Backend' }, { tenantId: TENANT, name: 'Sales' }]),
      Designation: table([{ tenantId: TENANT, title: 'Developer' }]),
      Review: table(),
      Goal: table(),
      Kpi: table(),
      Template: table(),
      Cycle: table(),
      Notification: table(),
      Audit: table(),
    };
    [sara, ayesha, omar] = models.Employee.rows;
    [eng, backend, sales] = models.Department.rows;
    dev = models.Designation.rows[0];
    backend.parentDepartmentId = eng.id;
    ayesha.departmentId = backend.id;
    ayesha.designationId = dev.id;
    ayesha.reportingManagerId = sara.id;
    omar.departmentId = sales.id;
    omar.reportingManagerId = sara.id;
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
    templates = new KpiTemplateService(provider);
    dashboard = new PerformanceDashboardService(provider, undefined, templates);
    plan = new PerformancePlanService(provider, dashboard);
    self = new PerformanceSelfService(provider);
    cycles = new PerformanceCycleService(provider, dashboard);
  });

  const template = (over: Record<string, unknown> = {}) =>
    as(HR, () => templates.create(TENANT, { name: 'Engineering KPIs', departmentIds: [eng.id], items: [item('Code quality', 60, { target: '95%', measurement: 'PERCENT' }), item('Delivery', 40)], ...over } as any)) as Promise<any>;
  const enrol = async (over: Record<string, unknown> = {}) => {
    const cycle: any = await as(HR, () => cycles.create(TENANT, { name: 'H2 2026', startDate: '2026-07-01', endDate: '2026-12-31', eligibility: { minTenureDays: 0 }, ...over } as any));
    await as(HR, () => cycles.launch(TENANT, cycle.id));
    return cycle;
  };
  const reviewOf = (employee: any) => models.Review.rows.find((r: any) => r.employeeId === employee.id);
  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to).filter(Boolean);

  describe('templates', () => {
    it('are made with weights that add up to 100, a name nobody else has, and real departments', async () => {
      const made = await template();
      expect(made).toMatchObject({ name: 'Engineering KPIs', isActive: true, departmentIds: [eng.id] });
      expect(made.items.map((i: any) => [i.title, i.weight, i.measurement])).toEqual([['Code quality', 60, 'PERCENT'], ['Delivery', 40, 'NUMBER']]);
      expect(made.items.every((i: any) => typeof i.id === 'string')).toBe(true);

      await expect(template({ items: [item('A', 60), item('B', 30)] })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(template({ name: ' engineering kpis ', items: [item('A', 100)] })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(template({ name: 'Other', departmentIds: [GHOST], items: [item('A', 100)] })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('are changed and removed without touching plans already made', async () => {
      const made = await template();
      expect((await as(HR, () => templates.update(TENANT, made.id, { items: [item('Only one', 100)], isActive: false } as any))).items).toHaveLength(1);
      await expect(as(HR, () => templates.update(TENANT, made.id, { items: [item('A', 50)] } as any))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(await templates.remove(TENANT, made.id)).toEqual({ deleted: true, id: made.id });
      await expect(templates.get(TENANT, made.id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('fit the most specific one: a designation beats a department beats any', async () => {
      await template({ name: 'Anyone', departmentIds: [], items: [item('Generic', 100)] });
      await template({ name: 'Engineering', departmentIds: [eng.id], items: [item('Dept', 100)] });
      const byDesignation = await template({ name: 'Developers', departmentIds: [], designationIds: [dev.id], items: [item('Role', 100)] });

      expect((await templates.match(TENANT, ayesha.id)).template.id).toBe(byDesignation.id);
      expect((await templates.match(TENANT, omar.id)).template.name).toBe('Anyone');
    });

    it('include the departments under the one named, and skip a switched-off template', async () => {
      const made = await template({ items: [item('Dept', 100)] });
      expect((await templates.match(TENANT, ayesha.id)).template.id).toBe(made.id);
      await as(HR, () => templates.update(TENANT, made.id, { isActive: false } as any));
      expect((await templates.match(TENANT, ayesha.id)).template).toBeNull();
      await expect(templates.match(TENANT, GHOST)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('enrolment', () => {
    it('gives the person the template as their own copy, and asks the reviewer to set goals', async () => {
      await template();
      await enrol();

      const review = reviewOf(ayesha);
      const kpis = models.Kpi.rows.filter((k: any) => k.reviewId === review.id);
      expect(kpis.map((k: any) => [k.title, k.weight, k.source, k.cycleId])).toEqual([['Code quality', 60, 'TEMPLATE', review.cycleId], ['Delivery', 40, 'TEMPLATE', review.cycleId]]);
      expect(models.Notification.rows.some((n: any) => n.employeeId === sara.id && n.title === 'Set goals for Ayesha Khan' && n.body.includes('2 KPIs'))).toBe(true);
      // Sales has no template: still asked to set goals, with no KPIs.
      expect(models.Kpi.rows.filter((k: any) => k.reviewId === reviewOf(omar).id)).toHaveLength(0);
    });

    it('does not rewrite a plan when the template changes afterwards', async () => {
      const made = await template();
      await enrol();
      await as(HR, () => templates.update(TENANT, made.id, { items: [item('Something else', 100)] } as any));
      expect(models.Kpi.rows.filter((k: any) => k.reviewId === reviewOf(ayesha).id).map((k: any) => k.title)).toEqual(['Code quality', 'Delivery']);
    });
  });

  describe('setting the plan', () => {
    let review: any;
    const reviewer = (userId = 'u-sara') => ({ tenantId: TENANT, userId });
    const save = (dto: any, userId = 'u-sara') => plan.reviewerSave(TENANT, userId, undefined, review.id, dto) as Promise<any>;

    beforeEach(async () => {
      await template();
      await enrol();
      review = reviewOf(ayesha);
    });

    it('is the reviewer\'s to see and change, and nobody else\'s', async () => {
      expect((await plan.reviewerPlan(TENANT, 'u-sara', undefined, review.id)).kpis).toHaveLength(2);
      await expect(plan.reviewerPlan(TENANT, 'u-omar', undefined, review.id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(save({ kpis: [] }, 'u-omar')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('adjusts a KPI, adds one and a goal, and records each change with the review', async () => {
      const view = await plan.reviewerPlan(TENANT, 'u-sara', undefined, review.id);
      const [quality, delivery] = view.kpis;

      const saved = await save({
        kpis: [{ id: quality.id, title: 'Code quality', weight: 50, target: '98%' }, { id: delivery.id, title: 'Delivery', weight: 30 }, { title: 'Mentoring', weight: 20 }],
        goals: [{ title: 'Migrate billing', dueDate: '2026-11-30' }],
      });

      expect(saved.kpis.map((k: any) => [k.title, k.weight, k.source])).toEqual([['Code quality', 50, 'TEMPLATE'], ['Delivery', 30, 'TEMPLATE'], ['Mentoring', 20, 'MANUAL']]);
      expect(saved.kpis[0].target).toBe('98%');
      expect(saved.goals).toEqual([expect.objectContaining({ title: 'Migrate billing', dueDate: '2026-11-30', progress: 0, status: 'NOT_STARTED' })]);
      expect(saved).toMatchObject({ planStatus: 'DRAFT', weightTotal: 100, canEdit: true, goalsSupported: true });
      const audited = models.Audit.rows.filter((row: any) => row.changes?.reviewId?.to === review.id);
      expect(audited.map((row: any) => [row.tableName, row.action]).sort()).toEqual([['performance_goals', 'CREATE'], ['review_kpis', 'CREATE'], ['review_kpis', 'UPDATE'], ['review_kpis', 'UPDATE']].sort());
      expect(audited.find((row: any) => row.changes.target)?.changes.target).toEqual({ from: '95%', to: '98%' });
    });

    it('keeps the lists it is not sent, and refuses weights over 100 or a KPI from elsewhere', async () => {
      const before = (await plan.reviewerPlan(TENANT, 'u-sara', undefined, review.id)).kpis;
      expect((await save({ goals: [{ title: 'Only a goal' }] })).kpis).toHaveLength(before.length);
      await expect(save({ kpis: [item('A', 70), item('B', 40)] })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(save({ kpis: [{ id: GHOST, title: 'x', weight: 10 }] })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('removes a KPI or goal that is untouched, and refuses one that was scored or has progress', async () => {
      const view = await plan.reviewerPlan(TENANT, 'u-sara', undefined, review.id);
      expect((await save({ kpis: [{ id: view.kpis[0].id, title: 'Code quality', weight: 60 }] })).kpis).toHaveLength(1);
      expect(events()).not.toContain('x');

      const kept = (await save({ goals: [{ title: 'Goal one' }] })).goals[0];
      models.Goal.rows[0].progress = 30;
      await expect(save({ goals: [] })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      models.Goal.rows[0].progress = 0;
      expect((await save({ goals: [] })).goals).toEqual([]);
      expect(kept.title).toBe('Goal one');

      models.Kpi.rows[0].score = '4.0';
      await expect(save({ kpis: [] })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('takes no goals for a review that is not in a cycle', async () => {
      const manual: any = await dashboard.createReview(TENANT, { employeeId: omar.id, cycle: 'Ad hoc' } as any);
      await expect(plan.reviewerSave(TENANT, 'u-sara', undefined, manual.id, { goals: [{ title: 'x' }] } as any)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect((await plan.reviewerSave(TENANT, 'u-sara', undefined, manual.id, { kpis: [item('Only KPI', 100)] } as any) as any).goalsSupported).toBe(false);
    });

    it('is locked once the review is completed', async () => {
      await self.submitEvaluation(reviewer(), review.id, { communication: 4, complete: true } as any);
      await expect(save({ goals: [{ title: 'Late' }] })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(plan.reviewerPublish(TENANT, 'u-sara', undefined, review.id)).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });
  });

  describe('publishing', () => {
    let review: any;
    beforeEach(async () => {
      await template();
      await enrol();
      review = reviewOf(ayesha);
    });
    const myGoals = () => self.getGoals({ tenantId: TENANT, userId: 'u-ayesha' }) as Promise<any>;

    it('shows nothing to the employee while it is a draft', async () => {
      await plan.reviewerSave(TENANT, 'u-sara', undefined, review.id, { goals: [{ title: 'Migrate billing' }] } as any);
      expect((await plan.myPlans(TENANT, 'u-ayesha')).data).toEqual([]);
      models.Goal.findAll.mockImplementationOnce(async ({ where }: any) => {
        expect(where[Op.or]).toEqual([{ cycleId: null }, { publishedAt: { [Op.ne]: null } }]);
        return [];
      });
      expect((await myGoals()).data).toEqual([]);
    });

    it('needs something to show, and KPI weights that add up to 100', async () => {
      await plan.reviewerSave(TENANT, 'u-sara', undefined, review.id, { kpis: [item('Half', 50)] } as any);
      await expect(plan.reviewerPublish(TENANT, 'u-sara', undefined, review.id)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await plan.reviewerSave(TENANT, 'u-sara', undefined, review.id, { kpis: [] } as any);
      await expect(plan.reviewerPublish(TENANT, 'u-sara', undefined, review.id)).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('shows the employee their KPIs and goals, tells them, and records it', async () => {
      await plan.reviewerSave(TENANT, 'u-sara', undefined, review.id, { goals: [{ title: 'Migrate billing', dueDate: '2026-11-30' }] } as any);
      models.Notification.rows.length = 0;

      const published: any = await plan.reviewerPublish(TENANT, 'u-sara', 'sara@x.com', review.id);

      expect(published.planStatus).toBe('PUBLISHED');
      expect(reviewOf(ayesha)).toMatchObject({ planPublishedByEmail: 'sara@x.com' });
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[ayesha.id, 'Your H2 2026 goals are set']]);
      expect(events()).toContain('PLAN_PUBLISHED');

      const mine: any = await plan.myPlans(TENANT, 'u-ayesha');
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0].kpis.map((k: any) => k.title)).toEqual(['Code quality', 'Delivery']);
      expect(mine.data[0].kpis[0]).not.toHaveProperty('score');
      expect(mine.data[0].goals.map((g: any) => g.title)).toEqual(['Migrate billing']);
      expect((await myGoals()).data.map((g: any) => g.title)).toEqual(['Migrate billing']);
    });

    it('tells the employee when their reviewer changes a plan they can already see, and can be taken back by HR', async () => {
      await plan.reviewerPublish(TENANT, 'u-sara', undefined, review.id);
      models.Notification.rows.length = 0;
      await plan.reviewerSave(TENANT, 'u-sara', undefined, review.id, { goals: [{ title: 'Added later' }] } as any);
      expect(models.Notification.rows.map((n: any) => n.title)).toEqual(['Your H2 2026 goals were updated']);
      expect((await plan.myPlans(TENANT, 'u-ayesha')).data[0].goals.map((g: any) => g.title)).toEqual(['Added later']);

      const taken: any = await as(HR, () => plan.adminUnpublish(TENANT, review.id));
      expect(taken.planStatus).toBe('DRAFT');
      expect((await plan.myPlans(TENANT, 'u-ayesha')).data).toEqual([]);
      expect(events()).toContain('PLAN_UNPUBLISHED');
    });

    it('lets HR see, set and publish a plan from the admin side', async () => {
      expect((await as(HR, () => plan.adminPlan(TENANT, review.id))).kpis).toHaveLength(2);
      await as(HR, () => plan.adminSave(TENANT, review.id, { goals: [{ title: 'By HR' }] } as any));
      expect((await as(HR, () => plan.adminPublish(TENANT, review.id, 'hr@x.com'))).planStatus).toBe('PUBLISHED');
      await expect(as(HR, () => plan.adminPlan(TENANT, GHOST))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('shows the results only once the review itself is published to the employee', async () => {
      await plan.reviewerPublish(TENANT, 'u-sara', undefined, review.id);
      const kpiId = models.Kpi.rows.find((k: any) => k.reviewId === review.id).id;
      await self.submitEvaluation({ tenantId: TENANT, userId: 'u-sara' }, review.id, { kpiScores: [{ kpiId, score: 4, actual: '97%', comment: 'Strong' }], complete: true } as any);

      expect((await plan.myPlans(TENANT, 'u-ayesha')).data[0].kpis[0]).not.toHaveProperty('actual');
      await dashboard.publishReview(TENANT, review.id);
      expect((await plan.myPlans(TENANT, 'u-ayesha')).data[0].kpis[0]).toMatchObject({ actual: '97%', score: 4, comment: 'Strong' });
    });
  });

  describe('scoring the KPIs in the evaluation', () => {
    let review: any;
    const evaluate = (dto: any) => self.submitEvaluation({ tenantId: TENANT, userId: 'u-sara' }, review.id, dto) as Promise<any>;
    beforeEach(async () => {
      await template();
      await enrol();
      review = reviewOf(ayesha);
    });
    const kpi = (index: number) => models.Kpi.rows.filter((k: any) => k.reviewId === review.id)[index];

    it('weighs the scored KPIs into a KPI score, and that is the rating when there are no competency scores', async () => {
      const saved = await evaluate({ kpiScores: [{ kpiId: kpi(0).id, score: 5 }, { kpiId: kpi(1).id, score: 2, actual: '60%' }] });

      expect(saved).toMatchObject({ status: 'IN_PROGRESS', kpiScore: 3.8, rating: 3.8 });
      expect(kpi(1)).toMatchObject({ score: 2, actual: '60%' });
      expect(models.Audit.rows.filter((row: any) => row.tableName === 'review_kpis' && row.changes.score)).toHaveLength(2);
    });

    it('keeps the rating from the competencies when they are scored, with the KPI score beside it', async () => {
      const saved = await evaluate({ professionalism: 4, kpiScores: [{ kpiId: kpi(0).id, score: 5 }] });
      expect(saved).toMatchObject({ rating: 4, kpiScore: 5 });
    });

    it('completes on a KPI score alone, and refuses a KPI from another review', async () => {
      await expect(evaluate({ complete: true })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(evaluate({ kpiScores: [{ kpiId: GHOST, score: 3 }] })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(await evaluate({ kpiScores: [{ kpiId: kpi(0).id, score: 4 }], complete: true })).toMatchObject({ status: 'COMPLETED', kpiScore: 4 });
    });

    it('averages only what has a score, by weight', () => {
      expect(weightedKpiScore([{ weight: 60, score: 5 }, { weight: 40, score: null }])).toBe(5);
      expect(weightedKpiScore([{ weight: 60, score: '4.0' }, { weight: 40, score: 2 }])).toBe(3.2);
      expect(weightedKpiScore([{ weight: 50, score: null }])).toBeNull();
    });
  });

  describe('history', () => {
    it('lists what changed in a review\'s plan, newest first, with who did it', async () => {
      await template();
      await enrol();
      const review = reviewOf(ayesha);
      models.Audit.findAll.mockImplementationOnce(async (query: any) => {
        expect(query.where.tableName[Op.in]).toEqual(['review_kpis', 'performance_goals', 'performance_reviews']);
        expect(query.where[Op.or][0].recordId[Op.in]).toContain(review.id);
        return [
          { createdAt: new Date('2026-11-02'), tableName: 'review_kpis', action: 'UPDATE', changes: { reviewId: { from: null, to: review.id }, weight: { from: 60, to: 50 }, actor: { from: null, to: 'sara@x.com' } } },
          { createdAt: new Date('2026-11-01'), tableName: 'performance_goals', action: 'CREATE', changes: { reviewId: { from: null, to: review.id }, title: { from: null, to: 'Migrate billing' } } },
        ];
      });

      const history: any = await as(HR, () => plan.history(TENANT, review.id));

      expect(history.review).toEqual({ id: review.id, cycle: 'H2 2026' });
      expect(history.data).toEqual([
        { at: new Date('2026-11-02'), about: 'KPI', action: 'UPDATE', by: 'sara@x.com', changes: { weight: { from: 60, to: 50 } } },
        { at: new Date('2026-11-01'), about: 'GOAL', action: 'CREATE', by: null, changes: { title: { from: null, to: 'Migrate billing' } } },
      ]);
      await expect(as(HR, () => plan.history(TENANT, GHOST))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('is written when the employee moves their goal\'s progress', async () => {
      await enrol();
      const review = reviewOf(ayesha);
      await plan.reviewerSave(TENANT, 'u-sara', undefined, review.id, { goals: [{ title: 'Migrate billing' }] } as any);
      await plan.reviewerPublish(TENANT, 'u-sara', undefined, review.id);

      await self.updateGoalProgress({ tenantId: TENANT, userId: 'u-ayesha' }, models.Goal.rows[0].id, 40);

      expect(models.Audit.rows.at(-1)).toMatchObject({ tableName: 'performance_goals', changes: expect.objectContaining({ reviewId: { from: null, to: review.id }, progress: { from: 0, to: 40 } }) });
    });
  });

  it('keeps a completed review\'s status when a plan is read', async () => {
    await enrol();
    const review = reviewOf(ayesha);
    await self.submitEvaluation({ tenantId: TENANT, userId: 'u-sara' }, review.id, { communication: 3, complete: true } as any);
    expect(((await as(HR, () => plan.adminPlan(TENANT, review.id))) as any).review.status).toBe(PerformanceReviewStatus.COMPLETED);
    expect(((await as(HR, () => plan.adminPlan(TENANT, review.id))) as any).canEdit).toBe(false);
  });
});
