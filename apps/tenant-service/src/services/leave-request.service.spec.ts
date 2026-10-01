import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { EmployeeNotificationKind, LeaveRequestStatus } from '@app/common';
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
