import { HttpStatus } from '@nestjs/common';
import { runAsRpcActor } from '@app/tenant-context';
import { PerformanceAcknowledgementService } from './performance-acknowledgement.service';
import { PerformanceDevelopmentService } from './performance-development.service';
import { PerformancePipService } from './performance-pip.service';
import { table } from './testing/fake-table';

/**
 * Improvement plans (proposed by a manager, approved by HR, confidential until
 * then), development goals and recommendations, and the employee's
 * acknowledgements.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const HR = { roles: ['HR'], isSuperAdmin: false, userId: 'u-hr', email: 'hr@x.com', permissions: ['performance.manage'] };
const MANAGER = { roles: ['Manager'], isSuperAdmin: false, userId: 'u-boss', email: 'boss@x.com', permissions: ['performance.edit'] };
const as = <T>(actor: any, work: () => Promise<T>) => runAsRpcActor(actor, work);
const person = (over: Record<string, unknown>) => ({ tenantId: TENANT, status: 'ACTIVE', reportingManagerId: null, ...over });
const target = (title: string) => ({ title });
const plan = (employeeId: string, over: Record<string, unknown> = {}) => ({
  employeeId,
  reason: 'Missed targets for three months in a row.',
  startDate: '2026-11-10',
  endDate: '2027-01-10',
  targets: [target('Close 90% of tickets in SLA')],
  ...over,
});
const status = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error: any) {
    return error?.getStatus?.() ?? error?.status ?? 500;
  }
  return 200;
};

describe('Improvement plans, development and acknowledgements', () => {
  let models: Record<string, any>;
  let provider: any;
  let pips: PerformancePipService;
  let development: PerformanceDevelopmentService;
  let acks: PerformanceAcknowledgementService;
  let holders: { tellPermission: jest.Mock };
  let boss: any;
  let sara: any;
  let omar: any;
  let scope: { scope: jest.Mock; actorEmployeeId: jest.Mock; assertCanSee: jest.Mock; employeeWhere: jest.Mock };

  beforeEach(() => {
    models = {
      Employee: table([
        person({ employeeCode: 'E1', firstName: 'Bob', lastName: 'Boss', userId: 'u-boss', email: 'boss@x.com' }),
        person({ employeeCode: 'E2', firstName: 'Sara', lastName: 'Khan', userId: 'u-sara', email: 'sara@x.com' }),
        person({ employeeCode: 'E3', firstName: 'Omar', lastName: 'Other', userId: 'u-omar', email: 'omar@x.com' }),
      ]),
      Review: table(),
      Plan: table(),
      Item: table(),
      Ack: table(),
      Course: table([{ tenantId: TENANT, title: 'System design' }]),
      Notification: table(),
      Audit: table(),
    };
    [boss, sara, omar] = models.Employee.rows;
    sara.reportingManagerId = boss.id;
    provider = {
      getEmployeeModel: async () => models.Employee,
      getPerformanceReviewModel: async () => models.Review,
      getImprovementPlanModel: async () => models.Plan,
      getDevelopmentItemModel: async () => models.Item,
      getPerformanceAcknowledgementModel: async () => models.Ack,
      getTrainingCourseModel: async () => models.Course,
      getEmployeeNotificationModel: async () => models.Notification,
      getEntityAuditLogModel: async () => models.Audit,
    };
    holders = { tellPermission: jest.fn() };
    scope = { scope: jest.fn(() => 'ORGANIZATION'), actorEmployeeId: jest.fn(async () => null), assertCanSee: jest.fn(async () => undefined), employeeWhere: jest.fn(async () => ({})) };
    pips = new PerformancePipService(provider, scope as any, holders as any);
    development = new PerformanceDevelopmentService(provider, scope as any);
    acks = new PerformanceAcknowledgementService(provider, scope as any, holders as any);
  });

  const notified = (employee: any) => models.Notification.rows.filter((row: any) => row.employeeId === employee.id);
  const asBoss = () => ({ tenantId: TENANT, userId: 'u-boss', email: 'boss@x.com' });
  const asSara = () => ({ tenantId: TENANT, userId: 'u-sara', email: 'sara@x.com' });
  const proposed = async () => (await pips.proposeAsManager(TENANT, 'u-boss', 'boss@x.com', plan(sara.id) as any)) as any;

  describe('proposing and approving a plan', () => {
    it('is active at once when HR starts it, and the employee is told', async () => {
      const created: any = await as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any));
      expect(created.status).toBe('ACTIVE');
      expect(created.targets[0]).toMatchObject({ title: 'Close 90% of tickets in SLA', status: 'OPEN' });
      expect(notified(sara)).toHaveLength(1);
      const mine: any = await pips.myPlans(TENANT, 'u-sara', 'sara@x.com');
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0].canAcknowledge).toBe(true);
    });

    it('waits for HR when a manager proposes it, and the employee sees nothing yet', async () => {
      const created = await proposed();
      expect(created.status).toBe('PROPOSED');
      expect(holders.tellPermission).toHaveBeenCalledWith(TENANT, 'performance.manage', expect.any(Array), expect.stringContaining('Sara'), expect.any(String));
      expect(notified(sara)).toHaveLength(0);
      expect(((await pips.myPlans(TENANT, 'u-sara', 'sara@x.com')) as any).data).toHaveLength(0);
    });

    it('is proposed only for someone who reports to the manager', async () => {
      expect(await status(() => pips.proposeAsManager(TENANT, 'u-boss', 'boss@x.com', plan(omar.id) as any))).toBe(HttpStatus.FORBIDDEN);
      models.Review.rows.push({ id: 'r1', tenantId: TENANT, employeeId: omar.id, reviewerId: boss.id });
      expect(await status(() => pips.proposeAsManager(TENANT, 'u-boss', 'boss@x.com', plan(omar.id) as any))).toBe(200);
    });

    it('starts when HR approves, and the proposer hears; the employee is told', async () => {
      const created = await proposed();
      const approved: any = await as(HR, () => pips.approve(TENANT, created.id, 'hr@x.com'));
      expect(approved.status).toBe('ACTIVE');
      expect(approved.approvedBy).toBe('hr@x.com');
      expect(notified(sara)).toHaveLength(1);
      expect(notified(boss)).toHaveLength(1);
    });

    it('is not approved by whoever proposed it', async () => {
      const created = await proposed();
      scope.actorEmployeeId.mockResolvedValue(boss.id);
      const hrWhoProposed = { ...HR, isFullAccess: false };
      expect(await status(() => as(hrWhoProposed, () => pips.approve(TENANT, created.id)))).toBe(HttpStatus.FORBIDDEN);
    });

    it('can be rejected with a reason, and stays on record; the employee never sees it', async () => {
      const created = await proposed();
      const rejected: any = await as(HR, () => pips.reject(TENANT, created.id, { reason: 'Not enough evidence yet' } as any));
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejectionReason).toBe('Not enough evidence yet');
      expect(((await pips.myPlans(TENANT, 'u-sara', 'sara@x.com')) as any).data).toHaveLength(0);
      expect(models.Plan.rows).toHaveLength(1);
      // A rejected plan frees the person for a new one.
      expect(await status(() => as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any)))).toBe(200);
    });

    it('is changed by its proposer only while it waits', async () => {
      const created = await proposed();
      const edited: any = await pips.updateAsProposer(TENANT, 'u-boss', 'boss@x.com', created.id, { reason: 'A clearer reason for the plan.' } as any);
      expect(edited.reason).toBe('A clearer reason for the plan.');
      await as(HR, () => pips.approve(TENANT, created.id));
      expect(await status(() => pips.updateAsProposer(TENANT, 'u-boss', 'boss@x.com', created.id, { reason: 'Changing it after approval.' } as any))).toBe(HttpStatus.FORBIDDEN);
    });
  });

  describe('the rules of a plan', () => {
    it('lasts at most 180 days, ends after it starts, and has a person who still works here', async () => {
      expect(await status(() => as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id, { endDate: '2027-06-30' }) as any)))).toBe(HttpStatus.BAD_REQUEST);
      expect(await status(() => as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id, { endDate: '2026-11-10' }) as any)))).toBe(HttpStatus.BAD_REQUEST);
      sara.status = 'RESIGNED';
      expect(await status(() => as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any)))).toBe(HttpStatus.CONFLICT);
    });

    it('is one at a time for a person', async () => {
      await as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any));
      expect(await status(() => as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any)))).toBe(HttpStatus.CONFLICT);
    });

    it('takes check-ins only while it runs', async () => {
      const created = await proposed();
      expect(await status(() => pips.checkInAsProposer(TENANT, 'u-boss', 'boss@x.com', created.id, { note: 'Good start', progress: 'ON_TRACK' } as any))).toBe(HttpStatus.CONFLICT);
      await as(HR, () => pips.approve(TENANT, created.id));
      const after: any = await pips.checkInAsProposer(TENANT, 'u-boss', 'boss@x.com', created.id, { note: 'Good start', progress: 'ON_TRACK', date: '2026-11-20' } as any);
      expect(after.checkIns).toHaveLength(1);
      expect(after.checkIns[0]).toMatchObject({ progress: 'ON_TRACK', date: '2026-11-20' });
    });

    it('is extended only with a reason, never shortened, and the extension is recorded', async () => {
      const created: any = await as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any));
      expect(await status(() => as(HR, () => pips.update(TENANT, created.id, { endDate: '2027-02-01' } as any)))).toBe(HttpStatus.BAD_REQUEST);
      expect(await status(() => as(HR, () => pips.update(TENANT, created.id, { endDate: '2026-12-20', extensionReason: 'Shorter' } as any)))).toBe(HttpStatus.BAD_REQUEST);
      const extended: any = await as(HR, () => pips.update(TENANT, created.id, { endDate: '2027-02-01', extensionReason: 'Was on leave for two weeks' } as any));
      expect(extended.endDate).toBe('2027-02-01');
      expect(extended.extensions).toHaveLength(1);
      expect(extended.extensions[0]).toMatchObject({ from: '2027-01-10', to: '2027-02-01', reason: 'Was on leave for two weeks' });
    });

    it('lets HR mark targets as the plan goes, keeping the others', async () => {
      const created: any = await as(HR, () =>
        pips.createFromAdmin(TENANT, plan(sara.id, { targets: [target('First thing'), target('Second thing')] }) as any),
      );
      const [first, second] = created.targets;
      const updated: any = await as(HR, () => pips.update(TENANT, created.id, { targets: [{ id: first.id, title: 'First thing', status: 'MET' }, { id: second.id, title: 'Second thing' }] } as any));
      expect(updated.targets.map((t: any) => t.status)).toEqual(['MET', 'OPEN']);
      expect(await status(() => as(HR, () => pips.update(TENANT, created.id, { targets: [{ id: '55555555-5555-4555-8555-555555555555', title: 'Not ours' }] } as any)))).toBe(HttpStatus.BAD_REQUEST);
    });

    it('ends with an outcome by HR only, and then cannot change', async () => {
      const created: any = await as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any));
      const closed: any = await as(HR, () => pips.close(TENANT, created.id, { outcome: 'SUCCESSFUL', note: 'All met' } as any));
      expect(closed).toMatchObject({ status: 'CLOSED', outcome: 'SUCCESSFUL', outcomeNote: 'All met' });
      expect(await status(() => as(HR, () => pips.close(TENANT, created.id, { outcome: 'CANCELLED' } as any)))).toBe(HttpStatus.CONFLICT);
      expect(await status(() => as(HR, () => pips.update(TENANT, created.id, { endDate: '2027-03-01', extensionReason: 'Late' } as any)))).toBe(HttpStatus.CONFLICT);
    });

    it('is cancelled and kept when the employee leaves', async () => {
      await as(HR, () => pips.createFromAdmin(TENANT, plan(sara.id) as any));
      expect(await pips.onEmployeeLeft(TENANT, sara.id)).toBe(1);
      expect(models.Plan.rows[0]).toMatchObject({ status: 'CLOSED', outcome: 'CANCELLED' });
      expect(await pips.onEmployeeLeft(TENANT, sara.id)).toBe(0);
    });

    it('is confidential: a narrower reader sees only what they proposed', async () => {
      await as(HR, () => pips.createFromAdmin(TENANT, plan(omar.id) as any));
      const mine = await proposed();
      scope.scope.mockReturnValue('TEAM');
      scope.actorEmployeeId.mockResolvedValue(boss.id);
      const seen: any = await as(MANAGER, () => pips.list(TENANT, {}));
      expect(seen.data.map((row: any) => row.id)).toEqual([mine.id]);
      expect(await status(() => as(MANAGER, () => pips.get(TENANT, models.Plan.rows[0].id)))).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('acknowledgements', () => {
    const publishedReview = () => {
      const row = { id: 'rev-1', tenantId: TENANT, employeeId: sara.id, cycle: 'H1', publishedAt: new Date(), reviewerId: boss.id };
      models.Review.rows.push(row);
      return row;
    };

    it('records agreement on a published review, once, without changing the rating', async () => {
      const review: any = publishedReview();
      review.rating = '4.00';
      const first: any = await acks.acknowledgeReview(TENANT, 'u-sara', 'sara@x.com', review.id, { agreement: 'AGREE', comment: 'Fair' } as any);
      expect(first).toMatchObject({ agreement: 'AGREE', comment: 'Fair', alreadyAcknowledged: false });
      const again: any = await acks.acknowledgeReview(TENANT, 'u-sara', 'sara@x.com', review.id, { agreement: 'DISAGREE', comment: 'Changed my mind' } as any);
      expect(again).toMatchObject({ agreement: 'AGREE', alreadyAcknowledged: true });
      expect(models.Ack.rows).toHaveLength(1);
      expect(review.rating).toBe('4.00');
    });

    it('is refused for a review not published yet, or someone else\'s', async () => {
      models.Review.rows.push({ id: 'rev-2', tenantId: TENANT, employeeId: sara.id, cycle: 'H1', publishedAt: null });
      expect(await status(() => acks.acknowledgeReview(TENANT, 'u-sara', 'sara@x.com', 'rev-2', {} as any))).toBe(HttpStatus.CONFLICT);
      const review = publishedReview();
      expect(await status(() => acks.acknowledgeReview(TENANT, 'u-omar', 'omar@x.com', review.id, {} as any))).toBe(HttpStatus.NOT_FOUND);
    });

    it('needs a comment to disagree, and tells HR and the manager when someone does', async () => {
      const review = publishedReview();
      expect(await status(() => acks.acknowledgeReview(TENANT, 'u-sara', 'sara@x.com', review.id, { agreement: 'DISAGREE' } as any))).toBe(HttpStatus.BAD_REQUEST);
      await acks.acknowledgeReview(TENANT, 'u-sara', 'sara@x.com', review.id, { agreement: 'DISAGREE', comment: 'The rating ignores Q2' } as any);
      expect(holders.tellPermission).toHaveBeenCalledWith(TENANT, 'performance.manage', [sara.id], expect.stringContaining('disagrees'), expect.stringContaining('The rating ignores Q2'));
      expect(notified(boss)).toHaveLength(1);
    });

    it('is for a plan once it is approved, and HR sees what is still pending', async () => {
      const created = await proposed();
      expect(await status(() => acks.acknowledgePip(TENANT, 'u-sara', 'sara@x.com', created.id, {} as any))).toBe(HttpStatus.NOT_FOUND);
      await as(HR, () => pips.approve(TENANT, created.id));
      const review = publishedReview();
      const pending: any = await as(HR, () => acks.list(TENANT, {}));
      expect(pending.data.map((row: any) => row.kind).sort()).toEqual(['PIP', 'REVIEW']);
      await acks.acknowledgePip(TENANT, 'u-sara', 'sara@x.com', created.id, { agreement: 'NOTED' } as any);
      await acks.acknowledgeReview(TENANT, 'u-sara', 'sara@x.com', review.id, { agreement: 'DISAGREE', comment: 'No' } as any);
      expect(((await as(HR, () => acks.list(TENANT, {}))) as any).total).toBe(0);
      const disagreed: any = await as(HR, () => acks.list(TENANT, { status: 'DISAGREED' }));
      expect(disagreed.data.map((row: any) => row.recordId)).toEqual([review.id]);
      const plans: any = await pips.myPlans(TENANT, 'u-sara', 'sara@x.com');
      expect(plans.data[0].acknowledgement).toMatchObject({ agreement: 'NOTED' });
      expect(plans.data[0].canAcknowledge).toBe(false);
    });
  });

  describe('development', () => {
    it('is set by a manager for their own people only, and the employee is told', async () => {
      const item: any = await development.createForTeamMember(TENANT, 'u-boss', 'boss@x.com', sara.id, { title: 'Learn system design', type: 'GOAL', courseId: models.Course.rows[0].id } as any);
      expect(item).toMatchObject({ type: 'GOAL', status: 'OPEN', source: 'MANAGER', course: { title: 'System design' } });
      expect(notified(sara)).toHaveLength(1);
      expect(await status(() => development.createForTeamMember(TENANT, 'u-boss', 'boss@x.com', omar.id, { title: 'Something else' } as any))).toBe(HttpStatus.FORBIDDEN);
      expect(await status(() => development.createForTeamMember(TENANT, 'u-boss', 'boss@x.com', sara.id, { title: 'A course', courseId: '66666666-6666-4666-8666-666666666666' } as any))).toBe(HttpStatus.BAD_REQUEST);
    });

    it('lets the employee add their own and move progress, which finishes it at 100', async () => {
      const mine: any = await development.myCreate(TENANT, 'u-sara', 'sara@x.com', { title: 'Public speaking' } as any);
      expect(mine.source).toBe('SELF');
      const started: any = await development.myUpdate(TENANT, 'u-sara', 'sara@x.com', mine.id, { progress: 40 } as any);
      expect(started).toMatchObject({ status: 'IN_PROGRESS', progress: 40 });
      const done: any = await development.myUpdate(TENANT, 'u-sara', 'sara@x.com', mine.id, { progress: 100 } as any);
      expect(done).toMatchObject({ status: 'DONE', progress: 100 });
      expect(done.completedAt).toBeTruthy();
      expect(await status(() => development.myUpdate(TENANT, 'u-sara', 'sara@x.com', mine.id, { progress: 10 } as any))).toBe(HttpStatus.CONFLICT);
    });

    it('lets the employee change only the progress of what a manager set', async () => {
      const set: any = await development.createForTeamMember(TENANT, 'u-boss', 'boss@x.com', sara.id, { title: 'Mentoring' } as any);
      expect(await status(() => development.myUpdate(TENANT, 'u-sara', 'sara@x.com', set.id, { title: 'My own title' } as any))).toBe(HttpStatus.FORBIDDEN);
      expect(await status(() => development.myUpdate(TENANT, 'u-sara', 'sara@x.com', set.id, { progress: 20 } as any))).toBe(200);
    });

    it('turns an accepted recommendation into a goal, and keeps a dismissed one', async () => {
      const a: any = await development.createForTeamMember(TENANT, 'u-boss', 'boss@x.com', sara.id, { title: 'Take the SQL course', type: 'RECOMMENDATION' } as any);
      const b: any = await development.createForTeamMember(TENANT, 'u-boss', 'boss@x.com', sara.id, { title: 'Read the handbook', type: 'RECOMMENDATION' } as any);
      expect(a.awaitingEmployee).toBe(true);
      expect(await status(() => development.myUpdate(TENANT, 'u-sara', 'sara@x.com', a.id, { progress: 10 } as any))).toBe(HttpStatus.CONFLICT);
      const accepted: any = await development.myAccept(TENANT, 'u-sara', 'sara@x.com', b.id);
      expect(accepted).toMatchObject({ type: 'GOAL', awaitingEmployee: false });
      const dismissed: any = await development.myDismiss(TENANT, 'u-sara', 'sara@x.com', a.id);
      expect(dismissed.status).toBe('DISMISSED');
      expect(models.Item.rows).toHaveLength(2);
      expect(await status(() => development.myAccept(TENANT, 'u-sara', 'sara@x.com', b.id))).toBe(HttpStatus.CONFLICT);
    });

    it('is seen by the employee from the start, and HR drops (keeps) what it set', async () => {
      const set: any = await as(HR, () => development.create(TENANT, { employeeId: sara.id, title: 'Leadership basics' } as any));
      expect(set.source).toBe('HR');
      const mine: any = await development.myList(TENANT, 'u-sara', 'sara@x.com', {});
      expect(mine.data).toHaveLength(1);
      const dropped: any = await as(HR, () => development.remove(TENANT, set.id));
      expect(dropped.status).toBe('DROPPED');
      expect(models.Item.rows).toHaveLength(1);
      expect(((await development.myList(TENANT, 'u-sara', 'sara@x.com', {})) as any).open).toBe(0);
    });

    it('needs to know whose items an admin wants', async () => {
      expect(await status(() => as(HR, () => development.list(TENANT, {} as any)))).toBe(HttpStatus.BAD_REQUEST);
    });
  });
});
