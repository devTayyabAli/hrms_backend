import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { EmployeeNotificationKind, LeaveRequestStatus } from '@app/common';
import { runAsRpcActor } from '@app/tenant-context';
import { LeaveRequestService } from './leave-request.service';

/**
 * Covers the parts of the Leave Management screen that are expensive to get
 * wrong: tenant scoping on every lookup, the overlap rule that stops one
 * employee being booked off twice, the day arithmetic behind the Duration
 * column, and the lifecycle guards on edit and decide.
 */
describe('LeaveRequestService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
  const REQUEST = '33333333-3333-4333-8333-333333333333';
  const EMPLOYEE = '44444444-4444-4444-8444-444444444444';
  const POLICY = '55555555-5555-4555-8555-555555555555';

  let leaveRequestModel: any;
  let employeeModel: any;
  let leavePolicyModel: any;
  let departmentModel: any;
  let notificationModel: any;
  let service: LeaveRequestService;

  beforeEach(() => {
    leaveRequestModel = {
      findOne: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      sum: jest.fn().mockResolvedValue(null),
      destroy: jest.fn().mockResolvedValue(1),
    };
    employeeModel = { findOne: jest.fn().mockResolvedValue({ id: EMPLOYEE }) };
    leavePolicyModel = {
      findOne: jest.fn().mockResolvedValue({ id: POLICY, isActive: true }),
    };
    departmentModel = {};
    notificationModel = { create: jest.fn().mockResolvedValue({ id: 'n1' }) };

    const modelProvider = {
      getLeaveRequestModel: jest.fn().mockResolvedValue(leaveRequestModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getLeavePolicyModel: jest.fn().mockResolvedValue(leavePolicyModel),
      getDepartmentModel: jest.fn().mockResolvedValue(departmentModel),
      getEmployeeNotificationModel: jest.fn().mockResolvedValue(notificationModel),
    };

    service = new LeaveRequestService(modelProvider as any);
  });

  const dto = (over: Record<string, any> = {}) => ({
    employeeId: EMPLOYEE,
    leavePolicyId: POLICY,
    fromDate: '2026-09-18',
    toDate: '2026-09-21',
    ...over,
  });

  /** A persisted row as Sequelize hands it back, with a spyable update(). */
  const record = (over: Record<string, any> = {}) => ({
    id: REQUEST,
    tenantId: TENANT,
    employeeId: EMPLOYEE,
    leavePolicyId: POLICY,
    fromDate: '2026-09-18',
    toDate: '2026-09-21',
    totalDays: '4',
    reason: null,
    status: LeaveRequestStatus.PENDING,
    update: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  // ==========================================
  // Tenant isolation
  // ==========================================

  describe('tenant scoping', () => {
    it('scopes a single-request lookup by tenant', async () => {
      leaveRequestModel.findOne.mockResolvedValue(null);

      await expect(service.getOne(TENANT, REQUEST)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });

      expect(leaveRequestModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: REQUEST, tenantId: TENANT } }),
      );
    });

    it.each([
      ['update', () => service.update(TENANT, REQUEST, {})],
      [
        'decide',
        () =>
          service.decide(TENANT, REQUEST, {
            status: LeaveRequestStatus.APPROVED,
          }),
      ],
      ['cancel', () => service.cancel(TENANT, REQUEST)],
    ])(
      'reports another tenant request as not found on %s',
      async (_name, call) => {
        // findOne with the tenant predicate returns nothing for a foreign row.
        leaveRequestModel.findOne.mockResolvedValue(null);

        await expect(call()).rejects.toMatchObject({
          status: HttpStatus.NOT_FOUND,
        });
        expect(leaveRequestModel.findOne).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ tenantId: TENANT }),
          }),
        );
      },
    );

    it('scopes deletion by tenant so a foreign id deletes nothing', async () => {
      leaveRequestModel.destroy.mockResolvedValue(0);

      await expect(service.remove(TENANT, REQUEST)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
      expect(leaveRequestModel.destroy).toHaveBeenCalledWith({
        where: { id: REQUEST, tenantId: TENANT },
      });
    });

    it('never lets a caller filter into another tenant rows', async () => {
      await service.getAll(TENANT, { employeeId: EMPLOYEE });

      const { where } = leaveRequestModel.findAndCountAll.mock.calls[0][0];
      expect(where.tenantId).toBe(TENANT);
      expect(where.tenantId).not.toBe(OTHER_TENANT);
    });
  });

  // ==========================================
  // Search term handling
  // ==========================================

  describe('search', () => {
    it('escapes a quote in the search term so it cannot break out of the literal', async () => {
      await service.getAll(TENANT, { search: "O'Brien" });

      const { where } = leaveRequestModel.findAndCountAll.mock.calls[0][0];
      const sql = where[Op.and][0].val as string;

      expect(sql).toContain("O''Brien");
      // The doubled quote is the whole defense: an odd number of quotes would
      // mean the term had closed the string literal and the rest is SQL.
      expect((sql.match(/'/g) ?? []).length % 2).toBe(0);
    });

    it('neutralises a classic injection payload', async () => {
      await service.getAll(TENANT, {
        search: "x'; DROP TABLE leave_requests; --",
      });

      const { where } = leaveRequestModel.findAndCountAll.mock.calls[0][0];
      const sql = where[Op.and][0].val as string;

      expect(sql).not.toContain("x'; DROP");
      expect(sql).toContain("x''; DROP TABLE leave_requests; --");
    });
  });

  // ==========================================
  // Duration arithmetic
  // ==========================================

  describe('duration', () => {
    it('counts an inclusive calendar span', async () => {
      leaveRequestModel.create.mockResolvedValue({ id: REQUEST });
      // create() probes for an overlap first (none here), then re-reads the
      // row it just wrote.
      leaveRequestModel.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(record());

      await service.create(TENANT, dto());

      // 18th to 21st inclusive is four days, not three.
      expect(leaveRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalDays: 4 }),
      );
    });

    it('counts a single-day request as one day', async () => {
      leaveRequestModel.create.mockResolvedValue({ id: REQUEST });
      // create() probes for an overlap first (none here), then re-reads the
      // row it just wrote.
      leaveRequestModel.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(record());

      await service.create(
        TENANT,
        dto({ fromDate: '2026-09-18', toDate: '2026-09-18' }),
      );

      expect(leaveRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalDays: 1 }),
      );
    });

    it('keeps an explicit half day', async () => {
      leaveRequestModel.create.mockResolvedValue({ id: REQUEST });
      // create() probes for an overlap first (none here), then re-reads the
      // row it just wrote.
      leaveRequestModel.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(record());

      await service.create(
        TENANT,
        dto({
          fromDate: '2026-09-18',
          toDate: '2026-09-18',
          totalDays: 0.5,
        }),
      );

      expect(leaveRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalDays: 0.5 }),
      );
    });

    it('refuses a deduction larger than the period it describes', async () => {
      await expect(
        service.create(TENANT, dto({ totalDays: 10 }) as any),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });

      expect(leaveRequestModel.create).not.toHaveBeenCalled();
    });

    it('refuses an end date before the start date', async () => {
      await expect(
        service.create(
          TENANT,
          dto({ fromDate: '2026-09-21', toDate: '2026-09-18' }) as any,
        ),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });

      expect(leaveRequestModel.create).not.toHaveBeenCalled();
    });

    it('refuses an unparseable date rather than storing NaN days', async () => {
      await expect(
        service.create(TENANT, dto({ toDate: 'not-a-date' }) as any),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });

      expect(leaveRequestModel.create).not.toHaveBeenCalled();
    });

    it('spans a month boundary correctly', async () => {
      leaveRequestModel.create.mockResolvedValue({ id: REQUEST });
      // create() probes for an overlap first (none here), then re-reads the
      // row it just wrote.
      leaveRequestModel.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(record());

      await service.create(
        TENANT,
        dto({ fromDate: '2026-01-30', toDate: '2026-02-02' }),
      );

      expect(leaveRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalDays: 4 }),
      );
    });
  });

  // ==========================================
  // Overlap rule
  // ==========================================

  describe('overlap', () => {
    it('refuses a request overlapping one the employee already holds', async () => {
      leaveRequestModel.findOne.mockResolvedValue({
        id: 'other',
        fromDate: '2026-09-20',
        toDate: '2026-09-25',
        status: LeaveRequestStatus.APPROVED,
      });

      await expect(service.create(TENANT, dto() as any)).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });

      expect(leaveRequestModel.create).not.toHaveBeenCalled();
    });

    it('only treats pending and approved requests as blocking', async () => {
      leaveRequestModel.findOne.mockResolvedValue(null);
      leaveRequestModel.create.mockResolvedValue({ id: REQUEST });

      await service.create(TENANT, dto() as any).catch(() => undefined);

      const overlapCall = leaveRequestModel.findOne.mock.calls[0][0];
      expect(overlapCall.where.status[Op.in]).toEqual([
        LeaveRequestStatus.PENDING,
        LeaveRequestStatus.APPROVED,
      ]);
      // A rejected or cancelled request releases its dates.
      expect(overlapCall.where.status[Op.in]).not.toContain(
        LeaveRequestStatus.REJECTED,
      );
      expect(overlapCall.where.status[Op.in]).not.toContain(
        LeaveRequestStatus.CANCELLED,
      );
    });

    it('scopes the overlap check to one employee in one tenant', async () => {
      leaveRequestModel.findOne.mockResolvedValue(null);
      leaveRequestModel.create.mockResolvedValue({ id: REQUEST });

      await service.create(TENANT, dto() as any).catch(() => undefined);

      const { where } = leaveRequestModel.findOne.mock.calls[0][0];
      expect(where.tenantId).toBe(TENANT);
      expect(where.employeeId).toBe(EMPLOYEE);
    });

    it('ignores the row being edited when re-checking overlap', async () => {
      leaveRequestModel.findOne
        .mockResolvedValueOnce(record()) // the row being edited
        .mockResolvedValueOnce(null) // overlap probe
        .mockResolvedValueOnce(record()); // getOne re-read

      await service
        .update(TENANT, REQUEST, { toDate: '2026-09-23' })
        .catch(() => undefined);

      const probe = leaveRequestModel.findOne.mock.calls[1][0];
      expect(probe.where.id).toEqual({ [Op.ne]: REQUEST });
    });
  });

  // ==========================================
  // Lifecycle guards
  // ==========================================

  describe('lifecycle', () => {
    it('refuses to edit an already-approved request', async () => {
      leaveRequestModel.findOne.mockResolvedValue(
        record({ status: LeaveRequestStatus.APPROVED }),
      );

      await expect(
        service.update(TENANT, REQUEST, { toDate: '2026-09-30' }),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('refuses to decide a request that was already decided', async () => {
      leaveRequestModel.findOne.mockResolvedValue(
        record({ status: LeaveRequestStatus.REJECTED }),
      );

      await expect(
        service.decide(TENANT, REQUEST, {
          status: LeaveRequestStatus.APPROVED,
        }),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('records who decided and when', async () => {
      const row = record();
      leaveRequestModel.findOne.mockResolvedValue(row);
      const admin = '66666666-6666-4666-8666-666666666666';

      await service.decide(
        TENANT,
        REQUEST,
        { status: LeaveRequestStatus.APPROVED, decisionNote: 'Covered' },
        admin,
      );

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LeaveRequestStatus.APPROVED,
          decisionNote: 'Covered',
          decidedByUserId: admin,
          decidedAt: expect.any(Date),
        }),
      );
    });

    it('drops an approval notice into the employee inbox', async () => {
      leaveRequestModel.findOne.mockResolvedValue(record());

      await service.decide(TENANT, REQUEST, {
        status: LeaveRequestStatus.APPROVED,
      });

      expect(notificationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          employeeId: EMPLOYEE,
          kind: EmployeeNotificationKind.LEAVE,
          title: 'Leave Approved',
          readAt: null,
        }),
      );
    });

    it('titles the notice for a rejection', async () => {
      leaveRequestModel.findOne.mockResolvedValue(record());

      await service.decide(TENANT, REQUEST, {
        status: LeaveRequestStatus.REJECTED,
      });

      expect(notificationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Leave Rejected' }),
      );
    });

    /**
     * The decision is already committed when the inbox row is written, so a
     * notification failure must not surface as a failed approval.
     */
    it('still returns the decision when the notification cannot be stored', async () => {
      leaveRequestModel.findOne.mockResolvedValue(record());
      notificationModel.create.mockRejectedValue(new Error('relation does not exist'));

      await expect(
        service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.APPROVED }),
      ).resolves.toBeDefined();
    });

    it('refuses to cancel a rejected request', async () => {
      leaveRequestModel.findOne.mockResolvedValue(
        record({ status: LeaveRequestStatus.REJECTED }),
      );

      await expect(service.cancel(TENANT, REQUEST)).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('treats cancelling an already-cancelled request as a no-op', async () => {
      const row = record({ status: LeaveRequestStatus.CANCELLED });
      leaveRequestModel.findOne.mockResolvedValue(row);

      await service.cancel(TENANT, REQUEST);

      expect(row.update).not.toHaveBeenCalled();
    });

    it('re-derives the duration when an edit moves the dates', async () => {
      const row = record();
      // update() reads the row, probes for an overlap, then re-reads.
      leaveRequestModel.findOne
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(row);

      await service.update(TENANT, REQUEST, { toDate: '2026-09-19' });

      // 18th to 19th is two days: the stored four must not survive.
      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ totalDays: 2 }),
      );
    });
  });

  // ==========================================
  // Leave type validation
  // ==========================================

  describe('leave type', () => {
    it('refuses a leave type from outside the organization', async () => {
      leavePolicyModel.findOne.mockResolvedValue(null);

      await expect(service.create(TENANT, dto() as any)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });

      expect(leavePolicyModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: POLICY, tenantId: TENANT },
        }),
      );
    });

    it('refuses an inactive leave type', async () => {
      leavePolicyModel.findOne.mockResolvedValue({
        id: POLICY,
        isActive: false,
      });

      await expect(service.create(TENANT, dto() as any)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('refuses an employee from outside the organization', async () => {
      employeeModel.findOne.mockResolvedValue(null);

      await expect(service.create(TENANT, dto() as any)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });

      expect(employeeModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EMPLOYEE, tenantId: TENANT },
        }),
      );
    });
  });

  // ==========================================
  // KPI cards
  // ==========================================

  describe('stats', () => {
    const tally = (rows: Array<{ status: string; count: number }>) => rows;

    it('tallies the four cards and totals them', async () => {
      leaveRequestModel.findAll
        .mockResolvedValueOnce(
          tally([
            { status: LeaveRequestStatus.APPROVED, count: 190 },
            { status: LeaveRequestStatus.PENDING, count: 35 },
            { status: LeaveRequestStatus.REJECTED, count: 20 },
            { status: LeaveRequestStatus.CANCELLED, count: 3 },
          ]),
        )
        .mockResolvedValue([]);
      leaveRequestModel.sum.mockResolvedValue('412.5');

      const stats = await service.getStats(TENANT);

      expect(stats).toMatchObject({
        totalRequests: 248,
        approved: 190,
        pending: 35,
        rejected: 20,
        cancelled: 3,
        approvedDays: 412.5,
      });
    });

    it('returns zeroes rather than nulls for an organization with no requests', async () => {
      leaveRequestModel.findAll.mockResolvedValue([]);
      leaveRequestModel.sum.mockResolvedValue(null);

      const stats = await service.getStats(TENANT);

      expect(stats.totalRequests).toBe(0);
      expect(stats.approvedDays).toBe(0);
      expect(stats.growth).toEqual({
        totalRequests: 0,
        approved: 0,
        pending: 0,
        rejected: 0,
      });
    });

    it('reports growth from an empty previous month as +100%, not a division by zero', async () => {
      leaveRequestModel.findAll
        .mockResolvedValueOnce([]) // overall tally
        .mockResolvedValueOnce([]) // decided this month
        .mockResolvedValueOnce(
          tally([{ status: LeaveRequestStatus.APPROVED, count: 5 }]),
        ) // this month
        .mockResolvedValueOnce([]); // previous month

      const stats = await service.getStats(TENANT);

      expect(stats.growth.approved).toBe(100);
      expect(Number.isFinite(stats.growth.approved)).toBe(true);
    });

    it('costs four queries however many cards the screen grows', async () => {
      leaveRequestModel.findAll.mockResolvedValue([]);

      await service.getStats(TENANT);

      // One tally for the cards themselves, one for this month's decisions,
      // and one per month compared — not one per card.
      expect(leaveRequestModel.findAll).toHaveBeenCalledTimes(4);
    });

    /**
     * The "Approved (Month)" and "Rejected (Month)" cards count decisions
     * taken this month, so a request filed in July and approved in August
     * belongs to August.
     */
    it('counts this month by when the decision was taken, not when it was filed', async () => {
      leaveRequestModel.findAll
        .mockResolvedValueOnce([]) // overall tally
        .mockResolvedValueOnce(
          tally([
            { status: LeaveRequestStatus.APPROVED, count: 34 },
            { status: LeaveRequestStatus.REJECTED, count: 5 },
          ]),
        )
        .mockResolvedValue([]);

      const stats = await service.getStats(TENANT);

      expect(stats.approvedThisMonth).toBe(34);
      expect(stats.rejectedThisMonth).toBe(5);

      const decidedQuery = leaveRequestModel.findAll.mock.calls[1][0];
      expect(decidedQuery.where).toHaveProperty('decidedAt');
      expect(decidedQuery.where.tenantId).toBe(TENANT);
    });

    it('reports no decisions this month as zero, not undefined', async () => {
      leaveRequestModel.findAll.mockResolvedValue([]);

      const stats = await service.getStats(TENANT);

      expect(stats.approvedThisMonth).toBe(0);
      expect(stats.rejectedThisMonth).toBe(0);
    });
  });
});

describe('leave approval route', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const REQUEST = '33333333-3333-4333-8333-333333333333';
  const EMPLOYEE = '44444444-4444-4444-8444-444444444444';
  const LEAD = '77777777-7777-4777-8777-777777777777';
  const MANAGER = '88888888-8888-4888-8888-888888888888';

  const people: Record<string, any> = {
    [EMPLOYEE]: {
      id: EMPLOYEE,
      firstName: 'Naveed',
      lastName: 'Ahmad',
      reportingManagerId: LEAD,
      designationId: null,
    },
    [LEAD]: {
      id: LEAD,
      firstName: 'Tayyaba',
      lastName: 'Sabir',
      reportingManagerId: MANAGER,
      designationId: 'des-lead',
    },
    [MANAGER]: {
      id: MANAGER,
      firstName: 'Ali',
      lastName: 'Khan',
      reportingManagerId: null,
      designationId: 'des-mgr',
    },
  };

  let stored: any;
  let notices: any[];
  let service: LeaveRequestService;
  let actorId: string | null;
  let orgWide: boolean;
  let hrPeople: { sourceId: string; email: string }[];
  let hrEmployees: { id: string }[];
  let policyStages: any[] | null;
  let departmentHead: string | null;

  beforeEach(() => {
    stored = null;
    notices = [];
    actorId = null;
    orgWide = true;
    hrPeople = [];
    hrEmployees = [];
    policyStages = null;
    departmentHead = null;
    const leaveRequestModel = {
      findOne: jest.fn(async () => stored),
      create: jest.fn(async (row: any) => {
        stored = { ...row, id: REQUEST, update: jest.fn(async (patch: any) => Object.assign(stored, patch)) };
        return stored;
      }),
      count: jest.fn().mockResolvedValue(0),
      findAll: jest.fn(async () => (stored ? [stored] : [])),
    };
    const modelProvider = {
      getLeaveRequestModel: jest.fn().mockResolvedValue(leaveRequestModel),
      getEmployeeModel: jest.fn().mockResolvedValue({
        findOne: jest.fn(async ({ where }: any) => people[where.id] ?? null),
        findAll: jest.fn(async () => hrEmployees),
      }),
      getLeavePolicyModel: jest.fn().mockResolvedValue({
        findOne: jest.fn().mockResolvedValue({ id: 'policy', name: 'Annual Leave', isActive: true, isPaid: true }),
      }),
      getDepartmentModel: jest.fn().mockResolvedValue({ findOne: jest.fn(async () => ({ managerId: departmentHead })) }),
      getApprovalPolicyModel: jest.fn().mockResolvedValue({ findOne: jest.fn(async () => (policyStages ? { stages: policyStages } : null)) }),
      getDesignationModel: jest.fn().mockResolvedValue({
        findAll: jest.fn().mockResolvedValue([
          { id: 'des-lead', title: 'Team Lead' },
          { id: 'des-mgr', title: 'Engineering Manager' },
        ]),
      }),
      getEmployeeNotificationModel: jest.fn().mockResolvedValue({
        create: jest.fn(async (row: any) => {
          notices.push(row);
          return row;
        }),
      }),
    };
    service = new LeaveRequestService(
      modelProvider as any,
      {
        actorEmployeeId: async () => actorId,
        scope: () => (orgWide ? 'ORGANIZATION' : 'TEAM'),
        employeeWhere: async () => ({}),
      } as any,
      { findAll: jest.fn(async () => hrPeople) } as any,
    );
  });

  describe('with a route the organization configured', () => {
    const DIRECTOR = '99999999-9999-4999-8999-999999999999';
    const HEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const submit = () =>
      service.create(TENANT, { employeeId: EMPLOYEE, leavePolicyId: 'policy', fromDate: '2026-09-18', toDate: '2026-09-18' } as any);
    const approve = () => service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.APPROVED } as any);

    beforeEach(() => {
      people[MANAGER].reportingManagerId = DIRECTOR;
      people[DIRECTOR] = { id: DIRECTOR, firstName: 'Dina', lastName: 'Shah', reportingManagerId: null, designationId: null };
      people[HEAD] = { id: HEAD, firstName: 'Hira', lastName: 'Noor', reportingManagerId: null, designationId: null };
      orgWide = false;
    });

    afterEach(() => {
      people[MANAGER].reportingManagerId = null;
      delete people[DIRECTOR];
      delete people[HEAD];
    });

    it('goes through three stages, and only the last one grants the leave', async () => {
      policyStages = [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }];
      await submit();
      expect(stored.approval.workflow.map((step: any) => step.step)).toEqual(['SUBMITTED', 'FIRST_REVIEW', 'SECOND_REVIEW', 'THIRD_REVIEW']);

      actorId = LEAD;
      expect((await approve()).status).toBe(LeaveRequestStatus.PENDING);
      expect(stored.approval).toMatchObject({ currentApproverId: MANAGER, finalStep: false });

      actorId = MANAGER;
      expect((await approve()).status).toBe(LeaveRequestStatus.PENDING);
      expect(stored.approval).toMatchObject({ currentApproverId: DIRECTOR, finalStep: true });

      actorId = DIRECTOR;
      const done = await approve();
      expect(done.status).toBe(LeaveRequestStatus.APPROVED);
      expect(done.approval?.statusText).toBe('Approved by Dina Shah (Manager).');
    });

    it('lets only the stage it is at decide, not a later approver', async () => {
      policyStages = [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }];
      await submit();
      actorId = DIRECTOR;
      await expect(approve()).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('rejection at any stage ends it', async () => {
      policyStages = [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }];
      await submit();
      actorId = LEAD;
      await approve();
      actorId = MANAGER;
      const row = await service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.REJECTED } as any);
      expect(row.status).toBe(LeaveRequestStatus.REJECTED);
      expect(row.approval?.statusText).toContain('Rejected by Ali Khan');
    });

    it('sends the request to the head of the department', async () => {
      policyStages = [{ kind: 'DEPARTMENT_HEAD' }];
      people[EMPLOYEE].departmentId = 'dept';
      departmentHead = HEAD;
      try {
        await submit();
        expect(stored.approval).toMatchObject({ currentApproverId: HEAD, currentApproverTitle: 'Department head', finalStep: true });
        actorId = HEAD;
        expect((await approve()).status).toBe(LeaveRequestStatus.APPROVED);
      } finally {
        delete people[EMPLOYEE].departmentId;
      }
    });

    it('sends the request to a named approver', async () => {
      policyStages = [{ kind: 'EMPLOYEE', employeeId: DIRECTOR }];
      await submit();
      expect(stored.approval).toMatchObject({ currentApproverId: DIRECTOR, finalStep: true });
    });

    it('lets anyone holding the permission decide a permission stage, and nobody else', async () => {
      policyStages = [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'PERMISSION', permission: 'payroll.approve' }];
      await submit();
      actorId = LEAD;
      await approve();
      expect(stored.approval).toMatchObject({ stage: 'WITH_HR', currentApproverId: null, currentPermission: 'payroll.approve', finalStep: true });

      actorId = 'someone-in-finance';
      await expect(
        runAsRpcActor({ permissions: ['payroll.view'], isFullAccess: false } as any, () => approve()),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

      const row = await runAsRpcActor({ permissions: ['payroll.approve'], isFullAccess: false } as any, () => approve());
      expect(row.status).toBe(LeaveRequestStatus.APPROVED);
    });

    it('shows a permission holder the request is waiting for them', async () => {
      policyStages = [{ kind: 'PERMISSION', permission: 'payroll.approve' }];
      await submit();
      const [holder, other] = await Promise.all([
        runAsRpcActor({ permissions: ['payroll.approve'], isFullAccess: false } as any, () => service.getOne(TENANT, REQUEST)),
        runAsRpcActor({ permissions: ['payroll.view'], isFullAccess: false } as any, () => service.getOne(TENANT, REQUEST)),
      ]);
      expect(holder.canDecide).toBe(true);
      expect(other.canDecide).toBe(false);
    });

    it('keeps the route a request was given when the policy changes afterwards', async () => {
      await submit();
      policyStages = [{ kind: 'HR' }];
      actorId = LEAD;
      await approve();
      // Still the manager's route: the lead approved, and it moved to the manager.
      expect(stored.approval).toMatchObject({ currentApproverId: MANAGER });
    });

    it('rebuilds a request nobody has approved from the current policy when the line changes', async () => {
      await submit();
      policyStages = [{ kind: 'REPORTING_MANAGER', level: 1 }, { kind: 'REPORTING_MANAGER', level: 2 }, { kind: 'REPORTING_MANAGER', level: 3 }];
      expect(await service.rerouteAfterReportingChange(TENANT, EMPLOYEE)).toBe(1);
      expect(stored.approval.stages.map((s: any) => s.approverId)).toEqual([LEAD, MANAGER, DIRECTOR]);
    });
  });

  describe('when the reporting line changes', () => {
    const submit = () =>
      service.create(TENANT, { employeeId: EMPLOYEE, leavePolicyId: 'policy', fromDate: '2026-09-18', toDate: '2026-09-18' } as any);
    const original = { lead: people[EMPLOYEE].reportingManagerId, managerOfLead: people[LEAD].reportingManagerId };

    afterEach(() => {
      people[EMPLOYEE].reportingManagerId = original.lead;
      people[LEAD].reportingManagerId = original.managerOfLead;
    });

    it('sends a request nobody has approved yet to the new manager, keeping when it was submitted', async () => {
      await submit();
      const submittedAt = stored.approval.workflow[0].at;
      notices.length = 0;
      people[EMPLOYEE].reportingManagerId = MANAGER;

      expect(await service.rerouteAfterReportingChange(TENANT, EMPLOYEE)).toBe(1);

      expect(stored.approval).toMatchObject({ stage: 'WITH_APPROVER', currentApproverId: MANAGER, finalStep: false });
      expect(stored.approval.workflow[0]).toMatchObject({ step: 'SUBMITTED', at: submittedAt });
      expect(notices.map((n) => [n.employeeId, n.title])).toEqual([
        [EMPLOYEE, 'Leave update'],
        [MANAGER, 'Leave request waiting'],
      ]);
    });

    it('does nothing when the route is still the same', async () => {
      await submit();
      notices.length = 0;
      expect(await service.rerouteAfterReportingChange(TENANT, EMPLOYEE)).toBe(0);
      expect(stored.update).not.toHaveBeenCalled();
      expect(notices).toHaveLength(0);
    });

    it('follows the second approver when the manager\'s own manager changes', async () => {
      await submit();
      people[LEAD].reportingManagerId = null;

      // The request is the employee's; the change is to the lead's line, so the lead's reports are checked.
      const reports = [{ id: EMPLOYEE }];
      const employeeModel: any = await (service as any).modelProvider.getEmployeeModel();
      employeeModel.findAll.mockResolvedValueOnce(reports);
      expect(await service.rerouteAfterReportingChange(TENANT, LEAD)).toBe(1);
      expect(stored.approval).toMatchObject({ currentApproverId: LEAD, nextApproverId: null });
    });

    it('sends a request whose first approval is done to HR when its approver left the route', async () => {
      await submit();
      stored.approval = {
        ...stored.approval,
        stage: 'WITH_APPROVER',
        currentApproverId: MANAGER,
        currentApproverName: 'Ali Khan',
        finalStep: true,
        nextApproverId: null,
        stageIndex: 1,
        workflow: stored.approval.workflow.map((step: any, index: number) => (index === 1 ? { ...step, status: 'COMPLETED' } : index === 2 ? { ...step, status: 'PENDING' } : step)),
      };
      people[EMPLOYEE].reportingManagerId = LEAD;
      people[LEAD].reportingManagerId = null;

      expect(await service.rerouteAfterReportingChange(TENANT, EMPLOYEE)).toBe(1);

      expect(stored.approval).toMatchObject({ stage: 'WITH_HR', currentApproverId: null });
      expect(stored.approval.workflow[1].status).toBe('COMPLETED');
    });

    it('leaves a request alone when its approver is still on the route', async () => {
      await submit();
      stored.approval = {
        ...stored.approval,
        currentApproverId: MANAGER,
        finalStep: true,
        nextApproverId: null,
        stageIndex: 1,
        workflow: stored.approval.workflow.map((step: any, index: number) => (index === 1 ? { ...step, status: 'COMPLETED' } : step)),
      };
      expect(await service.rerouteAfterReportingChange(TENANT, EMPLOYEE)).toBe(0);
    });

    it('hands what was waiting on someone who left to the next approver, or to HR', async () => {
      await submit();
      expect(await service.releaseWaitingOn(TENANT, LEAD)).toBe(1);
      expect(stored.approval).toMatchObject({ stage: 'WITH_APPROVER', currentApproverId: MANAGER, finalStep: true, nextApproverId: null });
      expect(stored.approval.statusText).toContain('no longer with the organization');

      expect(await service.releaseWaitingOn(TENANT, MANAGER)).toBe(1);
      expect(stored.approval).toMatchObject({ stage: 'WITH_HR', currentApproverId: null });
    });

    it('ignores requests waiting on somebody else', async () => {
      await submit();
      expect(await service.releaseWaitingOn(TENANT, MANAGER)).toBe(0);
    });
  });

  it('sends a new request to the reporting manager and tells the employee where it is', async () => {
    const row = await service.create(TENANT, {
      employeeId: EMPLOYEE,
      leavePolicyId: 'policy',
      fromDate: '2026-09-18',
      toDate: '2026-09-18',
    });

    expect(row.approval).toMatchObject({
      stage: 'WITH_APPROVER',
      currentApproverId: LEAD,
      currentApproverTitle: 'Team Lead',
      nextApproverId: MANAGER,
      statusText: 'With Tayyaba Sabir (Team Lead). Not approved yet.',
    });
    expect(row.status).toBe(LeaveRequestStatus.PENDING);
    expect(notices.map((n) => n.employeeId).sort()).toEqual([EMPLOYEE, LEAD].sort());
    expect(notices.find((n) => n.employeeId === LEAD).title).toBe('Leave request waiting');
  });

  it('moves the request to the manager when the team lead approves, without granting the leave', async () => {
    await service.create(TENANT, {
      employeeId: EMPLOYEE,
      leavePolicyId: 'policy',
      fromDate: '2026-09-18',
      toDate: '2026-09-18',
    });
    notices.length = 0;
    actorId = LEAD;

    const row = await service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.APPROVED });

    expect(row.status).toBe(LeaveRequestStatus.PENDING);
    expect(row.approval?.statusText).toBe(
      'Tayyaba Sabir (Team Lead) approved your leave. It is now with Ali Khan (Engineering Manager).',
    );
    expect(row.approval?.currentApproverId).toBe(MANAGER);
    expect(notices.find((n) => n.employeeId === EMPLOYEE).body).toContain('now with Ali Khan');
    expect(notices.find((n) => n.employeeId === MANAGER).title).toBe('Leave request waiting');
  });

  it('refuses anyone except the person the request is waiting on', async () => {
    await service.create(TENANT, {
      employeeId: EMPLOYEE,
      leavePolicyId: 'policy',
      fromDate: '2026-09-18',
      toDate: '2026-09-18',
    });
    actorId = MANAGER;
    orgWide = false;

    await expect(service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.APPROVED })).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    });
  });

  it('grants the leave only when the second approver approves', async () => {
    await service.create(TENANT, {
      employeeId: EMPLOYEE,
      leavePolicyId: 'policy',
      fromDate: '2026-09-18',
      toDate: '2026-09-18',
    });
    actorId = LEAD;
    await service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.APPROVED });
    actorId = MANAGER;

    const row = await service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.APPROVED });

    expect(row.status).toBe(LeaveRequestStatus.APPROVED);
    expect(row.approval?.statusText).toBe('Approved by Ali Khan (Engineering Manager).');
  });

  it('notifies every HR employee when the request moves to HR', async () => {
    people[LEAD].reportingManagerId = null;
    hrPeople.push({ sourceId: 'user-hr', email: 'hr@x.com' });
    hrEmployees.push({ id: 'hr-employee' });

    await service.create(TENANT, {
      employeeId: EMPLOYEE,
      leavePolicyId: 'policy',
      fromDate: '2026-09-18',
      toDate: '2026-09-18',
    });
    notices.length = 0;
    actorId = LEAD;

    const row = await service.decide(TENANT, REQUEST, { status: LeaveRequestStatus.APPROVED });

    expect(row.status).toBe(LeaveRequestStatus.PENDING);
    expect(row.approval?.stage).toBe('WITH_HR');
    expect(notices.find((n) => n.employeeId === 'hr-employee')).toMatchObject({
      title: 'Leave request waiting',
      body: expect.stringContaining('waiting for HR approval'),
    });
    expect(notices.find((n) => n.employeeId === EMPLOYEE).body).toContain('now with HR');
  });
});
