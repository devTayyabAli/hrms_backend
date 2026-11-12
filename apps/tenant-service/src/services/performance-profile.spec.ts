import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { runAsRpcActor } from '@app/tenant-context';
import { PerformanceDevelopmentService } from './performance-development.service';
import { PerformancePipService } from './performance-pip.service';
import { PerformanceProfileService } from './performance-profile.service';
import { table } from './testing/fake-table';

/**
 * The Employee Performance Profile: what each kind of reader gets, and what
 * the dashboard counts.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['performance.manage'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', reportingManagerId: null, ...over });
const status = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error: any) {
    return error?.getStatus?.() ?? error?.status ?? 500;
  }
  return 200;
};

describe('Employee Performance Profile', () => {
  let models: Record<string, any>;
  let provider: any;
  let scope: { scope: jest.Mock; actorEmployeeId: jest.Mock; assertCanSee: jest.Mock; employeeWhere: jest.Mock };
  let profile: PerformanceProfileService;
  let pips: PerformancePipService;
  let boss: any;
  let sara: any;
  let omar: any;

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Bob', lastName: 'Boss', userId: 'u-boss', email: 'boss@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Sara', lastName: 'Khan', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Other', userId: 'u-omar', email: 'omar@x.com' }),
      ]),
      Department: table([{ tenantId: TENANT, name: 'Engineering' }]),
      Designation: table(),
      Review: table(),
      Goal: table(),
      Kpi: table(),
      Plan: table(),
      Item: table(),
      Ack: table(),
      Notification: table(),
      Audit: table(),
    };
    [boss, sara, omar] = models.Employee.rows;
    sara.reportingManagerId = boss.id;
    provider = {
      getEmployeeModel: async () => models.Employee,
      getDepartmentModel: async () => models.Department,
      getDesignationModel: async () => models.Designation,
      getPerformanceReviewModel: async () => models.Review,
      getPerformanceGoalModel: async () => models.Goal,
      getReviewKpiModel: async () => models.Kpi,
      getImprovementPlanModel: async () => models.Plan,
      getDevelopmentItemModel: async () => models.Item,
      getPerformanceAcknowledgementModel: async () => models.Ack,
      getEmployeeNotificationModel: async () => models.Notification,
      getEntityAuditLogModel: async () => models.Audit,
    };
    scope = { scope: jest.fn(() => 'ORGANIZATION'), actorEmployeeId: jest.fn(async () => null), assertCanSee: jest.fn(async () => undefined), employeeWhere: jest.fn(async () => ({})) };
    pips = new PerformancePipService(provider, scope as any, undefined);
    const development = new PerformanceDevelopmentService(provider, scope as any);
    profile = new PerformanceProfileService(provider, scope as any, undefined, pips, development);
  });

  const review = (over: Record<string, unknown>) => {
    const row = { id: `rev-${models.Review.rows.length + 1}`, tenantId: TENANT, employeeId: sara.id, cycle: 'H1 2026', status: 'COMPLETED', rating: '4.00', reviewDate: '2026-06-30', publishedAt: null, closedAt: null, reviewerId: boss.id, employeeSnapshot: { departmentName: 'Engineering', designationTitle: 'Engineer', reportingManagerName: 'Bob Boss' }, ...over };
    models.Review.rows.push(row);
    return row;
  };

  it('gives HR everything: results, drafts, KPIs of the open review, plans and what is pending', async () => {
    review({ id: 'done', publishedAt: new Date() });
    review({ id: 'unpublished', cycle: 'H2 2025', rating: '3.00', reviewDate: '2025-12-31' });
    const open = review({ id: 'open', cycle: 'H2 2026', status: 'IN_PROGRESS', rating: null, reviewDate: null });
    models.Kpi.rows.push({ id: 'k1', tenantId: TENANT, reviewId: open.id, title: 'Delivery', weight: 100, sortOrder: 0, publishedAt: null });
    models.Goal.rows.push({ id: 'g1', tenantId: TENANT, employeeId: sara.id, title: 'Ship v2', progress: 20, status: 'IN_PROGRESS', cycleId: 'c1', publishedAt: null });
    await as(HR, () => pips.createFromAdmin(TENANT, { employeeId: sara.id, reason: 'Missed targets for months.', startDate: '2026-11-10', endDate: '2027-01-10', targets: [{ title: 'Hit SLA' }] } as any));

    const result: any = await as(HR, () => profile.forEmployee(TENANT, sara.id));
    expect(result.employee).toMatchObject({ name: 'Sara Khan', department: null, reportingManager: { name: 'Bob Boss' } });
    expect(result.access).toEqual({ organizationWide: true, hiddenReviews: 0, plansShown: 'ALL' });
    expect(result.reviews.map((row: any) => row.id).sort()).toEqual(['done', 'open', 'unpublished']);
    expect(result.reviews.find((row: any) => row.id === 'unpublished').rating).toBe(3);
    expect(result.reviews.find((row: any) => row.id === 'open').rating).toBeNull();
    expect(result.currentReview).toMatchObject({ id: 'open', kpis: [{ title: 'Delivery', published: false }] });
    expect(result.goals[0]).toMatchObject({ title: 'Ship v2', draft: true });
    expect(result.improvementPlans).toHaveLength(1);
    expect(result.summary).toMatchObject({ latestRating: 4, averageRating: 3.5, completedReviews: 2, openGoals: 1, activePip: true, pendingAcknowledgements: 2 });
  });

  it('is not shown to someone outside their scope', async () => {
    scope.assertCanSee.mockRejectedValue(Object.assign(new Error('nope'), { status: HttpStatus.NOT_FOUND }));
    expect(await status(() => as(HR, () => profile.forEmployee(TENANT, omar.id)))).toBe(HttpStatus.NOT_FOUND);
  });

  it('shows a manager the plans they proposed and not the others, as the profile\'s access says', async () => {
    await as(HR, () => pips.createFromAdmin(TENANT, { employeeId: sara.id, reason: 'Missed targets for months.', startDate: '2026-11-10', endDate: '2027-01-10', targets: [{ title: 'Hit SLA' }] } as any));
    scope.scope.mockReturnValue('TEAM');
    scope.actorEmployeeId.mockResolvedValue(boss.id);
    const manager = { roles: ['Manager'], isSuperAdmin: false, userId: 'u-boss', email: 'boss@x.com', permissions: ['performance.view'] };
    const result: any = await as(manager, () => profile.forEmployee(TENANT, sara.id));
    expect(result.access.organizationWide).toBe(false);
    expect(result.access.plansShown).toBe('PROPOSED_BY_YOU');
    expect(result.improvementPlans).toHaveLength(0);
    expect(result.summary.activePip).toBe(false);
  });

  it('gives the employee only what has been shared with them', async () => {
    review({ id: 'done', publishedAt: new Date() });
    review({ id: 'unpublished', cycle: 'H2 2025', rating: '2.00' });
    const open = review({ id: 'open', cycle: 'H2 2026', status: 'IN_PROGRESS', rating: null });
    models.Kpi.rows.push({ id: 'k1', tenantId: TENANT, reviewId: open.id, title: 'Delivery', weight: 50, sortOrder: 0, publishedAt: new Date() });
    models.Kpi.rows.push({ id: 'k2', tenantId: TENANT, reviewId: open.id, title: 'Draft KPI', weight: 50, sortOrder: 1, publishedAt: null });
    models.Goal.rows.push({ id: 'g1', tenantId: TENANT, employeeId: sara.id, title: 'Draft goal', progress: 0, status: 'NOT_STARTED', cycleId: 'c1', publishedAt: null });
    models.Goal.rows.push({ id: 'g2', tenantId: TENANT, employeeId: sara.id, title: 'Own goal', progress: 0, status: 'NOT_STARTED', cycleId: null, publishedAt: null });
    // A plan that is only proposed, and one that is running.
    await pips.proposeAsManager(TENANT, 'u-boss', 'boss@x.com', { employeeId: sara.id, reason: 'Proposed, not approved.', startDate: '2026-11-10', endDate: '2027-01-10', targets: [{ title: 'Hit SLA' }] } as any);

    const result: any = await profile.mine(TENANT, 'u-sara', 'sara@x.com');
    expect(result.reviews.map((row: any) => row.id).sort()).toEqual(['done', 'open']);
    expect(result.reviews.find((row: any) => row.id === 'done').rating).toBe(4);
    expect(result.reviews.find((row: any) => row.id === 'open').rating).toBeNull();
    expect(result.currentReview.kpis.map((kpi: any) => kpi.title)).toEqual(['Delivery']);
    expect(result.goals.map((goal: any) => goal.title)).toEqual(['Own goal']);
    expect(result.goals.every((goal: any) => goal.draft === false)).toBe(true);
    expect(result.improvementPlans).toHaveLength(0);
    expect(result.summary).toMatchObject({ latestRating: 4, activePip: false, pendingAcknowledgements: 1 });
    expect(result.reviews[0]).not.toHaveProperty('closedReason', 'EMPLOYEE_EXITED');
  });

  it('counts what needs attention, and a narrower reader counts only their own proposals', async () => {
    await as(HR, () => pips.createFromAdmin(TENANT, { employeeId: omar.id, reason: 'Missed targets for months.', startDate: '2026-11-10', endDate: '2026-11-12', targets: [{ title: 'Hit SLA' }] } as any));
    await pips.proposeAsManager(TENANT, 'u-boss', 'boss@x.com', { employeeId: sara.id, reason: 'Proposed, not approved.', startDate: '2026-11-10', endDate: '2027-01-10', targets: [{ title: 'Hit SLA' }] } as any);
    review({ id: 'p1', publishedAt: new Date() });
    review({ id: 'p2', publishedAt: new Date(), employeeId: omar.id });
    models.Ack.rows.push({ tenantId: TENANT, employeeId: sara.id, kind: 'REVIEW', recordId: 'p1', agreement: 'DISAGREE', acknowledgedAt: new Date() });
    models.Item.rows.push({ tenantId: TENANT, employeeId: sara.id, type: 'RECOMMENDATION', status: 'OPEN' });

    const all: any = await as(HR, () => profile.attention(TENANT));
    expect(all).toMatchObject({ pipsAwaitingApproval: 1, activePips: 1, pipsEndingSoon: 1, reviewsAwaitingAcknowledgement: 1, reviewDisagreements: 1, recommendationsAwaitingEmployee: 1 });

    scope.scope.mockReturnValue('TEAM');
    scope.actorEmployeeId.mockResolvedValue(boss.id);
    const manager = { roles: ['Manager'], isSuperAdmin: false, userId: 'u-boss', email: 'boss@x.com', permissions: ['performance.view'] };
    const mine: any = await as(manager, () => profile.attention(TENANT));
    expect(mine).toMatchObject({ pipsAwaitingApproval: 1, activePips: 0 });
  });

  describe('the change history', () => {
    const at = (value: string) => new Date(value);
    const audit = (rows: any[]) => models.Audit.findAll.mockImplementationOnce(async () => rows);

    it('tells staff what changed in the goals, KPIs and evaluations they may open, in words, newest first', async () => {
      review({ id: 'done', publishedAt: new Date() });
      review({ id: 'open', cycle: 'H2 2026', status: 'IN_PROGRESS', rating: null, reviewDate: null });
      models.Kpi.rows.push({ id: 'k-live', tenantId: TENANT, reviewId: 'open', title: 'Quality', weight: 40, sortOrder: 0 });
      models.Goal.rows.push({ id: 'g1', tenantId: TENANT, employeeId: sara.id, title: 'Ship v2', progress: 20, status: 'IN_PROGRESS', cycleId: null, publishedAt: null });
      audit([
        { createdAt: at('2026-11-03'), tableName: 'performance_reviews', recordId: 'open', action: 'UPDATE', changes: { event: { from: null, to: 'MANAGER_CHANGE_DETECTED' }, reviewerId: { from: boss.id, to: omar.id } } },
        { createdAt: at('2026-11-02'), tableName: 'performance_reviews', recordId: 'done', action: 'UPDATE', changes: { published: { from: false, to: true }, actor: { from: null, to: 'hr@x.com' } } },
        { createdAt: at('2026-11-02T08:00:00Z'), tableName: 'performance_goals', recordId: 'g1', action: 'UPDATE', changes: { progress: { from: 0, to: 20 }, status: { from: 'NOT_STARTED', to: 'IN_PROGRESS' } } },
        { createdAt: at('2026-11-01'), tableName: 'review_kpis', recordId: 'k-gone', action: 'DELETE', changes: { reviewId: { from: null, to: 'open' }, title: { from: 'Delivery', to: null } } },
        { createdAt: at('2026-10-30'), tableName: 'review_kpis', recordId: 'k-live', action: 'UPDATE', changes: { reviewId: { from: null, to: 'open' }, score: { from: null, to: 4 } } },
        // A review this reader may not open: nothing of it is shown.
        { createdAt: at('2026-11-04'), tableName: 'performance_goals', recordId: 'g-other', action: 'CREATE', changes: { reviewId: { from: null, to: 'someone-elses-review' }, title: { from: null, to: 'Secret goal' } } },
        { createdAt: at('2026-11-04'), tableName: 'performance_reviews', recordId: 'someone-elses-review', action: 'UPDATE', changes: { rating: { from: 2, to: 1 } } },
      ]);

      const result: any = await as(HR, () => profile.forEmployee(TENANT, sara.id));

      const query = models.Audit.findAll.mock.calls.at(-1)[0];
      expect(query.where.tableName[Op.in]).toEqual(['review_kpis', 'performance_goals', 'performance_reviews']);
      expect(query.where[Op.or][0].recordId[Op.in]).toEqual(expect.arrayContaining(['done', 'open', 'k-live', 'g1']));
      expect(result.history.map((entry: any) => entry.title)).toEqual([
        'Reporting manager changed while the review was open',
        'Goal progress updated',
        'Result published',
        'KPI removed',
        'KPI scored',
      ]);
      expect(result.history[0]).toMatchObject({ about: 'REVIEW', subject: 'H2 2026', event: 'MANAGER_CHANGE_DETECTED', changes: [{ field: 'reviewerId', label: 'Reviewer', from: 'Bob Boss', to: 'Omar Other' }] });
      expect(result.history[2]).toMatchObject({ by: 'hr@x.com', changes: [{ field: 'published', from: false, to: true }] });
      expect(result.history[3]).toMatchObject({ about: 'KPI', subject: 'Delivery', action: 'DELETE' });
      expect(JSON.stringify(result.history)).not.toContain('Secret goal');
    });

    it('shows the employee only what was shared with them, never why or by whom, and nothing before a goal was published to them', async () => {
      review({ id: 'done', publishedAt: new Date() });
      review({ id: 'unpublished', cycle: 'H2 2025', rating: '2.00' });
      models.Goal.rows.push({ id: 'g-own', tenantId: TENANT, employeeId: sara.id, title: 'Own goal', progress: 10, status: 'IN_PROGRESS', cycleId: null, publishedAt: null });
      models.Goal.rows.push({ id: 'g-set', tenantId: TENANT, employeeId: sara.id, title: 'Set by manager', progress: 0, status: 'NOT_STARTED', cycleId: 'c1', publishedAt: at('2026-11-01') });
      models.Goal.rows.push({ id: 'g-draft', tenantId: TENANT, employeeId: sara.id, title: 'Draft goal', progress: 0, status: 'NOT_STARTED', cycleId: 'c1', publishedAt: null });
      audit([
        { createdAt: at('2026-11-02'), tableName: 'performance_reviews', recordId: 'done', action: 'UPDATE', changes: { published: { from: false, to: true }, rating: { from: 3, to: 4 }, reviewerComments: { from: null, to: 'Needs work' }, actor: { from: null, to: 'hr@x.com' } } },
        { createdAt: at('2026-10-20'), tableName: 'performance_reviews', recordId: 'done', action: 'UPDATE', changes: { rating: { from: null, to: 3 }, event: { from: null, to: 'TRANSFER_DETECTED' } } },
        { createdAt: at('2026-10-15'), tableName: 'performance_reviews', recordId: 'unpublished', action: 'UPDATE', changes: { published: { from: false, to: true } } },
        { createdAt: at('2026-11-03'), tableName: 'performance_goals', recordId: 'g-own', action: 'UPDATE', changes: { progress: { from: 0, to: 10 }, actor: { from: null, to: 'sara@x.com' } } },
        { createdAt: at('2026-10-25'), tableName: 'performance_goals', recordId: 'g-set', action: 'CREATE', changes: { title: { from: null, to: 'Set by manager' } } },
        { createdAt: at('2026-11-04'), tableName: 'performance_goals', recordId: 'g-set', action: 'UPDATE', changes: { progress: { from: 0, to: 30 }, weight: { from: 20, to: 40 } } },
        { createdAt: at('2026-11-04'), tableName: 'performance_goals', recordId: 'g-draft', action: 'UPDATE', changes: { title: { from: 'a', to: 'b' } } },
        { createdAt: at('2026-11-04'), tableName: 'review_kpis', recordId: 'k1', action: 'UPDATE', changes: { reviewId: { from: null, to: 'done' }, score: { from: null, to: 5 } } },
      ]);

      const result: any = await profile.mine(TENANT, 'u-sara', 'sara@x.com');

      const query = models.Audit.findAll.mock.calls.at(-1)[0];
      expect(query.where.tableName[Op.in]).toEqual(['performance_goals', 'performance_reviews']);
      expect(query.where[Op.or]).toHaveLength(1);
      expect(result.history.map((entry: any) => [entry.about, entry.title, entry.changes.map((change: any) => change.field)])).toEqual([
        ['GOAL', 'Goal progress updated', ['progress']],
        ['GOAL', 'Goal progress updated', ['progress']],
        ['REVIEW', 'Result published', ['published']],
      ]);
      expect(result.history.every((entry: any) => entry.by === null && entry.event === null)).toBe(true);
      const text = JSON.stringify(result.history);
      for (const secret of ['Needs work', 'hr@x.com', 'sara@x.com', 'TRANSFER_DETECTED', 'Draft goal', 'weight']) expect(text).not.toContain(secret);
    });

    it('is empty when there is nothing to show, without asking the audit log', async () => {
      const result: any = await as(HR, () => profile.forEmployee(TENANT, omar.id));
      expect(result.history).toEqual([]);
      expect(models.Audit.findAll).not.toHaveBeenCalled();
    });
  });
});
