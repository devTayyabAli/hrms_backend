import { HttpStatus } from '@nestjs/common';
import { runAsRpcActor } from '@app/tenant-context';
import { consolidate, equalShares, scaleWeights } from './performance-consolidation';
import { KpiTemplateService } from './kpi-template.service';
import { PerformanceCycleService } from './performance-cycle.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformanceEvaluatorService } from './performance-evaluator.service';
import { PerformanceSelfService } from './performance-self.service';
import { PerformanceSyncService } from './performance-sync.service';
import { ReviewRolesService } from './review-roles.service';
import { table } from './testing/fake-table';

/**
 * More than one role, more than one reviewer: KPIs for each role that still
 * add up to 100, an evaluator for each additional role's manager, each writing
 * their own evaluation without seeing the others', and the final rating their
 * ratings weighted by each one's share.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['performance.manage'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', joiningDate: '2024-01-01', employmentType: 'PERMANENT', reportingManagerId: null, departmentId: null, designationId: null, ...over });
const kpi = (title: string, weight: number) => ({ title, weight });

describe('consolidating evaluations', () => {
  const empty = { professionalism: null, communication: null, qualityOfWork: null, teamwork: null, leadership: null };

  it('weighs the ratings and each competency by the evaluators\' shares, over those who scored it', () => {
    const result = consolidate([
      { weight: 50, rating: 4, metrics: { ...empty, professionalism: 4, teamwork: 4 } },
      { weight: 50, rating: 2, metrics: { ...empty, professionalism: 2, communication: 2 } },
    ]);
    expect(result.rating).toBe(3);
    expect(result.metrics).toEqual({ professionalism: 3, communication: 2, qualityOfWork: null, teamwork: 4, leadership: null });
  });

  it('is not pulled by someone with no rating, and is nothing when nobody has one', () => {
    expect(consolidate([{ weight: 70, rating: 5, metrics: { ...empty } }, { weight: 30, rating: null, metrics: { ...empty } }]).rating).toBe(5);
    expect(consolidate([{ weight: 100, rating: null, metrics: { ...empty } }]).rating).toBeNull();
    expect(consolidate([{ weight: 60, rating: 4.5, metrics: { ...empty } }, { weight: 40, rating: 3.5, metrics: { ...empty } }]).rating).toBe(4.1);
  });

  it('splits whole percentages that add up exactly', () => {
    expect(scaleWeights([60, 40], 50)).toEqual([30, 20]);
    expect(scaleWeights([1, 1, 1], 100)).toEqual([34, 33, 33]);
    expect(scaleWeights([30, 30, 40], 33).reduce((a, b) => a + b, 0)).toBe(33);
    expect(equalShares(3)).toEqual([34, 33, 33]);
    expect(equalShares(2)).toEqual([50, 50]);
    expect(scaleWeights([], 100)).toEqual([]);
  });
});

describe('Roles, reviewers and the consolidated review', () => {
  let models: Record<string, any>;
  let provider: any;
  let templates: KpiTemplateService;
  let dashboard: PerformanceDashboardService;
  let evaluators: PerformanceEvaluatorService;
  let self: PerformanceSelfService;
  let cycles: PerformanceCycleService;
  let holders: { tellPermission: jest.Mock };
  let sara: any;
  let ayesha: any;
  let omar: any;
  let zoya: any;
  let eng: any;
  let marketing: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Sara', lastName: 'Lead', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Ayesha', lastName: 'Khan', userId: 'u-ayesha', email: 'ayesha@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Marketing', userId: 'u-omar', email: 'omar@x.com' }),
        person({ employeeCode: 'E4', firstName: 'Zoya', lastName: 'Third', userId: 'u-zoya', email: 'zoya@x.com' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Engineering' }, { tenantId: TENANT, name: 'Marketing' }]),
      Designation: table(),
      Review: table(),
      Goal: table(),
      Kpi: table(),
      Template: table(),
      Cycle: table(),
      Evaluator: table(),
      Assignment: table(),
      Notification: table(),
      Audit: table(),
    };
    [sara, ayesha, omar, zoya] = models.Employee.rows;
    [eng, marketing] = models.Department.rows;
    ayesha.departmentId = eng.id;
    ayesha.reportingManagerId = sara.id;
    provider = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => models.Designation,
      getPerformanceReviewModel: async () => models.Review,
      getPerformanceGoalModel: async () => models.Goal,
      getReviewKpiModel: async () => models.Kpi,
      getKpiTemplateModel: async () => models.Template,
      getPerformanceCycleModel: async () => models.Cycle,
      getReviewEvaluatorModel: async () => models.Evaluator,
      getEmployeeAssignmentModel: async () => models.Assignment,
      getEmployeeNotificationModel: async () => models.Notification,
      getEntityAuditLogModel: async () => models.Audit,
    };
    holders = { tellPermission: jest.fn() };
    templates = new KpiTemplateService(provider);
    const roles = new ReviewRolesService(provider, templates);
    dashboard = new PerformanceDashboardService(provider, undefined, templates, roles);
    evaluators = new PerformanceEvaluatorService(provider, dashboard, holders as any);
    self = new PerformanceSelfService(provider, evaluators);
    cycles = new PerformanceCycleService(provider, dashboard);
  });

  const makeTemplates = async () => {
    await as(HR, () => templates.create(TENANT, { name: 'Engineering', departmentIds: [eng.id], items: [kpi('Code quality', 60), kpi('Delivery', 40)] } as any));
    await as(HR, () => templates.create(TENANT, { name: 'Marketing', departmentIds: [marketing.id], items: [kpi('Campaigns', 50), kpi('Leads', 50)] } as any));
  };
  const giveRole = (over: Record<string, unknown> = {}) => models.Assignment.create({ tenantId: TENANT, employeeId: ayesha.id, departmentId: marketing.id, title: 'Brand liaison', reportingManagerId: omar.id, startDate: '2026-01-01', endDate: null, ...over });
  const start = async (over: Record<string, unknown> = {}) => {
    const cycle: any = await as(HR, () => cycles.create(TENANT, { name: 'H2 2026', startDate: '2026-07-01', endDate: '2026-12-31', eligibility: { minTenureDays: 0 }, includeAdditionalRoles: true, ...over } as any));
    await as(HR, () => cycles.launch(TENANT, cycle.id));
    return cycle;
  };
  const reviewOf = (employee: any) => models.Review.rows.find((r: any) => r.employeeId === employee.id);
  const kpisOf = (review: any) => models.Kpi.rows.filter((k: any) => k.reviewId === review.id);
  const as_ = (user: string) => ({ tenantId: TENANT, userId: user });
  const evaluate = (user: string, dto: Record<string, unknown>, review = reviewOf(ayesha)) => self.submitEvaluation(as_(user), review.id, dto as any) as Promise<any>;
  const events = () => models.Audit.rows.map((row: any) => row.changes?.event?.to).filter(Boolean);

  describe('enrolling someone with an additional role', () => {
    beforeEach(async () => {
      await makeTemplates();
    });

    it('gives KPIs for each role that still add up to 100, tagged by role, and the role\'s manager as an evaluator', async () => {
      await giveRole();
      await start();

      const review = reviewOf(ayesha);
      const kpis = kpisOf(review);
      expect(kpis.map((k: any) => [k.title, k.weight, k.roleLabel, k.evaluatorEmployeeId ?? null])).toEqual([
        ['Code quality', 30, 'Primary role', null],
        ['Delivery', 20, 'Primary role', null],
        ['Campaigns', 25, 'Brand liaison', omar.id],
        ['Leads', 25, 'Brand liaison', omar.id],
      ]);
      expect(kpis.reduce((sum: number, k: any) => sum + k.weight, 0)).toBe(100);
      expect(review.multiReviewer).toBe(true);
      expect(models.Evaluator.rows.map((e: any) => [e.employeeId, e.isLead, e.weight, e.roleLabel])).toEqual([[sara.id, true, 50, 'Primary role'], [omar.id, false, 50, 'Brand liaison']]);
      expect(events()).toContain('ROLES_ADDED_TO_PLAN');
    });

    it('does nothing extra when the cycle does not ask for it, or the person has no additional role', async () => {
      await giveRole();
      await start({ includeAdditionalRoles: false, name: 'Plain' });
      expect(kpisOf(reviewOf(ayesha)).map((k: any) => k.roleLabel ?? null)).toEqual([null, null]);
      expect(reviewOf(ayesha).multiReviewer).toBeFalsy();
      expect(models.Evaluator.rows).toHaveLength(0);
    });

    it('adds the role\'s KPIs without an evaluator when the role has no manager, and skips a template the person already has', async () => {
      await giveRole({ reportingManagerId: null });
      await giveRole({ departmentId: eng.id, title: 'Same template' });
      await start();

      const kpis = kpisOf(reviewOf(ayesha));
      expect(kpis.map((k: any) => [k.title, k.weight, k.evaluatorEmployeeId ?? null])).toEqual([['Code quality', 30, null], ['Delivery', 20, null], ['Campaigns', 25, null], ['Leads', 25, null]]);
      expect(models.Evaluator.rows).toHaveLength(0);
      expect(reviewOf(ayesha).multiReviewer).toBeFalsy();
    });

    it('leaves out a role that has ended, and ignores a table it cannot read', async () => {
      await giveRole({ endDate: '2026-02-01' });
      await start({ name: 'One' });
      expect(kpisOf(reviewOf(ayesha))).toHaveLength(2);

      models.Review.rows.length = 0;
      models.Kpi.rows.length = 0;
      provider.getEmployeeAssignmentModel = async () => {
        throw new Error('no table');
      };
      await start({ name: 'Two' });
      expect(kpisOf(reviewOf(ayesha))).toHaveLength(2);
    });
  });

  describe('setting the evaluators by hand', () => {
    let review: any;
    beforeEach(async () => {
      await makeTemplates();
      await start({ includeAdditionalRoles: false });
      review = reviewOf(ayesha);
    });
    const set = (reviewers: any[]) => as(HR, () => evaluators.set(TENANT, review.id, { reviewers } as any)) as Promise<any>;
    const pair = () => [{ employeeId: sara.id, weight: 70, isLead: true, roleLabel: 'Team Lead' }, { employeeId: omar.id, weight: 30, roleLabel: 'Project Manager' }];

    it('makes the review multi-reviewer, with the lead as its reviewer, and tells the others', async () => {
      models.Notification.rows.length = 0;
      const result = await set(pair());

      expect(result.evaluators.map((e: any) => [e.employee.name, e.isLead, e.weight, e.roleLabel, e.status])).toEqual([['Sara Lead', true, 70, 'Team Lead', 'PENDING'], ['Omar Marketing', false, 30, 'Project Manager', 'PENDING']]);
      expect(result.weightTotal).toBe(100);
      expect(review).toMatchObject({ multiReviewer: true, reviewerId: sara.id });
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[sara.id, 'Evaluate Ayesha Khan'], [omar.id, 'Evaluate Ayesha Khan']]);
      expect(events()).toContain('REVIEWERS_SET');
    });

    it('refuses shares that do not add to 100, one reviewer, no or two leads, the person themself, someone who left or repeats', async () => {
      await expect(set([{ employeeId: sara.id, weight: 60, isLead: true }, { employeeId: omar.id, weight: 30 }])).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(set([{ employeeId: sara.id, weight: 100, isLead: true }])).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(set([{ employeeId: sara.id, weight: 50 }, { employeeId: omar.id, weight: 50 }])).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(set([{ employeeId: sara.id, weight: 50, isLead: true }, { employeeId: omar.id, weight: 50, isLead: true }])).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(set([{ employeeId: sara.id, weight: 50, isLead: true }, { employeeId: ayesha.id, weight: 50 }])).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(set([{ employeeId: sara.id, weight: 50, isLead: true }, { employeeId: sara.id, weight: 50 }])).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      zoya.status = 'RESIGNED';
      await expect(set([{ employeeId: sara.id, weight: 50, isLead: true }, { employeeId: zoya.id, weight: 50 }])).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(review.multiReviewer).toBeFalsy();
    });

    it('moves the lead\'s draft into their own evaluation, so it is not taken for the result', async () => {
      await evaluate('u-sara', { professionalism: 4, reviewerComments: 'Good start' });
      expect(review).toMatchObject({ rating: 4, reviewerComments: 'Good start' });

      await set(pair());

      expect(review).toMatchObject({ professionalism: null, rating: null, reviewerComments: null });
      const lead = models.Evaluator.rows.find((e: any) => e.isLead);
      expect(lead).toMatchObject({ professionalism: 4, rating: 4, comments: 'Good start', status: 'IN_PROGRESS' });
    });

    it('can change the shares and the reviewers, but not take off someone who has submitted, and can go back to one', async () => {
      await set(pair());
      await set([{ employeeId: sara.id, weight: 50, isLead: true }, { employeeId: zoya.id, weight: 50 }]);
      expect(models.Evaluator.rows.map((e: any) => e.employeeId).sort()).toEqual([sara.id, zoya.id].sort());

      await evaluate('u-zoya', { teamwork: 3, complete: true });
      await expect(set([{ employeeId: sara.id, weight: 50, isLead: true }, { employeeId: omar.id, weight: 50 }])).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(set([])).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

      models.Evaluator.rows.find((e: any) => e.employeeId === zoya.id).status = 'PENDING';
      await set([]);
      expect(review.multiReviewer).toBe(false);
      expect(models.Evaluator.rows).toHaveLength(0);
    });

    it('is not for a review that is finished', async () => {
      review.status = 'COMPLETED';
      await expect(set(pair())).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(as(HR, () => evaluators.set(TENANT, GHOST, { reviewers: [] } as any))).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('evaluating together', () => {
    let review: any;
    beforeEach(async () => {
      await makeTemplates();
      await giveRole();
      await start();
      review = reviewOf(ayesha);
    });
    const kpiIds = (owner: string | null) => kpisOf(review).filter((k: any) => (k.evaluatorEmployeeId ?? null) === owner).map((k: any) => k.id);

    it('lists a review under each evaluator, and not under someone else', async () => {
      expect((await self.getReviewing(as_('u-omar')) as any).data.map((r: any) => r.id)).toEqual([review.id]);
      expect((await self.getReviewing(as_('u-sara')) as any).data.map((r: any) => r.id)).toEqual([review.id]);
      expect((await self.getReviewing(as_('u-zoya')) as any).data).toEqual([]);
      await expect(self.getReviewingOne(as_('u-zoya'), review.id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      await expect(evaluate('u-zoya', { teamwork: 3 })).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('shows each evaluator only their own evaluation and the KPIs they score, and the lead who has submitted', async () => {
      await evaluate('u-omar', { communication: 2, reviewerComments: 'Private note' });

      const mine: any = await self.getReviewingOne(as_('u-omar'), review.id);
      expect(mine).toMatchObject({ multiReviewer: true, evaluators: null, myEvaluation: { roleLabel: 'Brand liaison', isLead: false, weight: 50, status: 'IN_PROGRESS', comments: 'Private note' } });
      expect(mine.myKpis.map((k: any) => k.title)).toEqual(['Campaigns', 'Leads']);

      const lead: any = await self.getReviewingOne(as_('u-sara'), review.id);
      expect(lead.myKpis.map((k: any) => k.title)).toEqual(['Code quality', 'Delivery']);
      expect(lead.evaluators.map((e: any) => [e.employee.name, e.status])).toEqual([['Sara Lead', 'PENDING'], ['Omar Marketing', 'IN_PROGRESS']]);
      expect(JSON.stringify(lead)).not.toContain('Private note');
      expect(lead.rating).toBeNull();
    });

    it('lets each score only their own KPIs', async () => {
      await expect(evaluate('u-omar', { kpiScores: [{ kpiId: kpiIds(null)[0], score: 4 }] })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await expect(evaluate('u-sara', { kpiScores: [{ kpiId: kpiIds(omar.id)[0], score: 4 }] })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      const saved = await evaluate('u-omar', { kpiScores: [{ kpiId: kpiIds(omar.id)[0], score: 5, actual: '120 leads' }] });
      expect(saved.myEvaluation).toMatchObject({ rating: 5 });
      expect(kpisOf(review).find((k: any) => k.id === kpiIds(omar.id)[0])).toMatchObject({ score: 5, actual: '120 leads' });
    });

    it('completes the review when the last evaluator submits, with the ratings weighed by their shares', async () => {
      await evaluate('u-sara', { professionalism: 4, teamwork: 4, reviewerComments: 'Strong engineer', complete: true });
      expect(review.status).toBe('IN_PROGRESS');
      expect(await self.getReviewing(as_('u-sara')).then((r: any) => r.data[0].status)).toBe('IN_PROGRESS');

      await evaluate('u-omar', { professionalism: 2, communication: 2, reviewerComments: 'Needs focus', complete: true });

      expect(review).toMatchObject({ status: 'COMPLETED', rating: 3, professionalism: 3, communication: 2, teamwork: 4, reviewerComments: 'Strong engineer' });
      expect(review.reviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(review.employeeSnapshot).toMatchObject({ reviewerName: 'Sara Lead' });
      expect(events()).toContain('REVIEW_CONSOLIDATED');
      expect(models.Evaluator.rows.every((e: any) => e.status === 'SUBMITTED' && e.submittedAt)).toBe(true);
    });

    it('refuses a second submission, a submission with nothing in it, and anything once finished', async () => {
      await expect(evaluate('u-omar', { complete: true })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await evaluate('u-omar', { communication: 3, complete: true });
      await expect(evaluate('u-omar', { communication: 5 })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('is completed by HR from the evaluations that are in, weighing only those', async () => {
      await expect(as(HR, () => evaluators.consolidateNow(TENANT, review.id))).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      await evaluate('u-omar', { communication: 2, complete: true });
      expect(review.status).not.toBe('COMPLETED');

      const result: any = await as(HR, () => evaluators.consolidateNow(TENANT, review.id));

      expect(review).toMatchObject({ status: 'COMPLETED', rating: 2 });
      expect(result.evaluators.map((e: any) => [e.employee.name, e.status])).toEqual([['Sara Lead', 'PENDING'], ['Omar Marketing', 'SUBMITTED']]);
      expect(models.Audit.rows.at(-1).changes.notSubmitted.to).toBe(sara.id);
      await expect(as(HR, () => evaluators.consolidateNow(TENANT, review.id))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('is reachable by HR with every evaluator\'s own scores, and not for a review with one reviewer', async () => {
      await evaluate('u-omar', { communication: 2, reviewerComments: 'Needs focus' });
      const all: any = await as(HR, () => evaluators.list(TENANT, review.id));
      expect(all.evaluators.find((e: any) => e.employee.name === 'Omar Marketing')).toMatchObject({ comments: 'Needs focus', metrics: expect.objectContaining({ communication: 2 }) });

      const single = await dashboard.createReview(TENANT, { employeeId: zoya.id, cycle: 'Other' } as any);
      await expect(as(HR, () => evaluators.consolidateNow(TENANT, single.id))).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });
  });

  describe('when an evaluator leaves', () => {
    let review: any;
    beforeEach(async () => {
      await makeTemplates();
      await giveRole();
      await start();
      review = reviewOf(ayesha);
    });

    it('gives an additional evaluator\'s share to the lead, and tells the lead', async () => {
      models.Notification.rows.length = 0;
      expect(await evaluators.onEvaluatorLeft(TENANT, omar.id)).toBe(1);

      expect(models.Evaluator.rows.map((e: any) => [e.employeeId, e.weight])).toEqual([[sara.id, 100]]);
      expect(models.Notification.rows.map((n: any) => [n.employeeId, n.title])).toEqual([[sara.id, 'A reviewer left: Ayesha Khan']]);
      expect(events()).toContain('EVALUATOR_LEFT_SHARE_TO_LEAD');
    });

    it('asks HR to set the reviewers again when the lead leaves, and keeps a submitted evaluation', async () => {
      expect(await evaluators.onEvaluatorLeft(TENANT, sara.id)).toBe(1);
      expect(holders.tellPermission).toHaveBeenCalledWith(TENANT, 'performance.manage', [ayesha.id], 'Lead reviewer left', expect.any(String));
      expect(models.Evaluator.rows).toHaveLength(2);

      await evaluate('u-omar', { communication: 3, complete: true });
      expect(await evaluators.onEvaluatorLeft(TENANT, omar.id)).toBe(0);
      expect(models.Evaluator.rows.find((e: any) => e.employeeId === omar.id).status).toBe('SUBMITTED');
    });

    it('is not flagged by the single-reviewer rules for a review with several', async () => {
      ayesha.reportingManagerId = zoya.id;
      const sync = new PerformanceSyncService(provider, dashboard, undefined as any);
      expect(await sync.onManagerChange(TENANT, ayesha.id)).toBe(0);
      expect(review.reviewerId).toBe(sara.id);
      expect(review.pendingChange ?? null).toBeNull();
    });
  });
});
