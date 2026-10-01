import { AdminDashboardRange, LeaveApprovalUrgency, LeaveRequestStatus } from '@app/common';
import { HrDashboardService, rangeBounds, samplePoints } from './hr-dashboard.service';

/**
 * Covers what this service adds rather than composes: the Urgent badge
 * derived from how soon leave starts, and the checklist matrix that lines
 * per-hire task rows up by title.
 */
describe('HrDashboardService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  const iso = (offsetDays: number) => {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  };

  let leaveModel: any;
  let newHireModel: any;
  let taskModel: any;
  let employees: any;
  let attendance: any;
  let onboarding: any;
  let leaveRequests: any;
  let departments: any;
  let service: HrDashboardService;

  const leave = (over: Record<string, any> = {}) => ({
    id: 'l1',
    fromDate: iso(10),
    toDate: iso(12),
    totalDays: 3,
    status: LeaveRequestStatus.PENDING,
    reason: null,
    leavePolicyId: 'p1',
    leavePolicy: { id: 'p1', name: 'Annual Leave' },
    employee: {
      id: 'e1',
      employeeCode: 'TN-0047',
      firstName: 'Anjali',
      lastName: 'Menon',
      avatarUrl: null,
      department: { id: 'd1', name: 'Design' },
    },
    createdAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    leaveModel = { findAll: jest.fn().mockResolvedValue([]) };
    newHireModel = { findAll: jest.fn().mockResolvedValue([]) };
    taskModel = { findAll: jest.fn().mockResolvedValue([]) };

    const modelProvider = {
      getLeaveRequestModel: jest.fn().mockResolvedValue(leaveModel),
      getLeavePolicyModel: jest.fn().mockResolvedValue({}),
      getEmployeeModel: jest.fn().mockResolvedValue({}),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
      getDesignationModel: jest.fn().mockResolvedValue({}),
      getNewHireModel: jest.fn().mockResolvedValue(newHireModel),
      getOnboardingTaskModel: jest.fn().mockResolvedValue(taskModel),
    };

    employees = {
      getStats: jest.fn().mockResolvedValue({
        totalEmployees: 247,
        active: 231,
        onLeave: 8,
        resigned: 5,
        inactive: 3,
        newThisMonth: 8,
        growth: { totalEmployees: 3.2, active: 1, onLeave: 0, resigned: 0 },
      }),
    };
    attendance = {
      getStats: jest.fn().mockResolvedValue({
        date: '2026-09-23',
        presentToday: 218,
        lateToday: 11,
        absentToday: 13,
        onLeaveToday: 16,
        growth: { presentToday: 1.4, lateToday: 0, absentToday: 0, onLeaveToday: 0 },
      }),
    };
    onboarding = {
      getStats: jest.fn().mockResolvedValue({
        totalNewHires: 11,
        completedOnboarding: 8,
        inProgress: 3,
        pendingTasks: 14,
        growth: { totalNewHires: 10, completedOnboarding: 0, inProgress: 0, pendingTasks: 0 },
      }),
    };
    leaveRequests = {
      getStats: jest.fn().mockResolvedValue({
        pending: 12,
        approved: 190,
        rejected: 20,
        approvedThisMonth: 34,
        rejectedThisMonth: 5,
        growth: { totalRequests: 0, approved: 0, pending: -4.5, rejected: 0 },
      }),
    };
    departments = { getStats: jest.fn().mockResolvedValue({ totalDepartments: 8 }) };

    service = new HrDashboardService(
      modelProvider as any,
      employees as any,
      attendance as any,
      onboarding as any,
      leaveRequests as any,
      departments as any,
    );
  });

  describe('admin dashboard ranges', () => {
    it('resolves each range to calendar bounds', () => {
      const today = '2026-09-29'; // a Tuesday
      expect(rangeBounds(AdminDashboardRange.TODAY, today)).toEqual({ from: today, to: today });
      expect(rangeBounds(AdminDashboardRange.THIS_WEEK, today)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
      expect(rangeBounds(AdminDashboardRange.THIS_MONTH, today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
      expect(rangeBounds(AdminDashboardRange.LAST_MONTH, today)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
      expect(rangeBounds(AdminDashboardRange.THIS_QUARTER, today)).toEqual({ from: '2026-07-01', to: '2026-09-30' });
      expect(rangeBounds(AdminDashboardRange.THIS_YEAR, today)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    });

    it('samples evenly spaced chart points, both ends included', () => {
      expect(samplePoints('2026-09-01', '2026-09-26', 6)).toEqual([
        '2026-09-01',
        '2026-09-06',
        '2026-09-11',
        '2026-09-16',
        '2026-09-21',
        '2026-09-26',
      ]);
      expect(samplePoints('2026-09-01', '2026-09-03', 6)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
      expect(samplePoints('2026-09-01', '2026-09-01', 6)).toEqual(['2026-09-01']);
    });

    it('returns the other cards when one fails', async () => {
      attendance.getOverview = jest.fn().mockRejectedValue(new Error('boom'));
      const overview = await service.getAdminOverview(TENANT, {});
      expect(overview.attendance).toBeNull();
      expect(overview.leave).toMatchObject({ approved: 190, pending: 12, rejected: 20 });
    });
  });

  describe('getInsights', () => {
    it('fills every day of the last week, zero where nothing was recorded', async () => {
      const today = iso(0);
      attendance.getOverview = jest.fn().mockResolvedValue({
        series: [{ period: today, present: 5, late: 2, absent: 1, onLeave: 1, total: 9 }],
      });

      const days = await (service as any).lastSevenDays(TENANT, today);

      expect(days).toHaveLength(7);
      expect(days[6]).toMatchObject({ date: today, present: 5, late: 2, absent: 1, onLeave: 1 });
      expect(days.slice(0, 6).every((day: any) => day.present === 0 && day.late === 0)).toBe(true);
    });

    it('finds work anniversaries in the next 30 days and recent joiners', () => {
      const today = '2026-09-28';
      const person = (employee: any) => ({ id: employee.id, name: employee.firstName });
      const { anniversaries, recentJoiners } = (service as any).peopleMoments(
        [
          { id: 'a', firstName: 'Three years', joiningDate: '2023-10-05' },
          { id: 'b', firstName: 'Too far', joiningDate: '2022-12-01' },
          { id: 'c', firstName: 'New', joiningDate: '2026-09-20' },
          { id: 'd', firstName: 'Today', joiningDate: '2025-09-28' },
        ],
        today,
        person,
      );

      expect(anniversaries.map((row: any) => [row.employee.id, row.years, row.inDays])).toEqual([
        ['d', 1, 0],
        ['a', 3, 7],
      ]);
      expect(recentJoiners.map((row: any) => [row.employee.id, row.daysAgo])).toEqual([['c', 8]]);
    });

    it('keeps the other panels when one query fails', async () => {
      attendance.getOverview = jest.fn().mockRejectedValue(new Error('boom'));
      attendance.getStats.mockResolvedValue({
        presentToday: 4,
        lateToday: 1,
        halfDayToday: 0,
        onLeaveToday: 1,
        absentToday: 0,
        unmarked: 2,
        totalEmployees: 8,
        attendanceRate: 62.5,
        punctualityRate: 80,
      });

      const insights = await service.getInsights(TENANT);

      expect(insights.trend).toEqual([]);
      expect(insights.attendanceToday).toMatchObject({ present: 4, late: 1, notMarked: 2, workforce: 8 });
      expect(insights.pendingReview).toEqual({ documents: 0, requests: 0 });
    });
  });

  describe('getStats', () => {
    it('fills the five KPI cards from the services that own each figure', async () => {
      const stats = await service.getStats(TENANT);

      expect(stats).toMatchObject({
        totalEmployees: 247,
        newJoinersThisMonth: 8,
        presentToday: 218,
        pendingLeave: 12,
        totalDepartments: 8,
      });
    });

    /**
     * OnboardingStats counts completed hires and pending *tasks*; neither is
     * the card. Hires still working through a checklist is.
     */
    it('derives Pending Onboarding as the hires who have not finished', async () => {
      const stats = await service.getStats(TENANT);
      expect(stats.pendingOnboarding).toBe(3);
    });

    it('never reports a negative pending count', async () => {
      onboarding.getStats.mockResolvedValue({
        totalNewHires: 2,
        completedOnboarding: 5,
        inProgress: 0,
        pendingTasks: 0,
        growth: { totalNewHires: 0, completedOnboarding: 0, inProgress: 0, pendingTasks: 0 },
      });

      const stats = await service.getStats(TENANT);
      expect(stats.pendingOnboarding).toBe(0);
    });
  });

  describe('getLeaveApprovals', () => {
    it('flags leave starting within three days as Urgent', async () => {
      leaveModel.findAll.mockResolvedValue([leave({ fromDate: iso(2), toDate: iso(3) })]);

      const result = await service.getLeaveApprovals(TENANT);

      expect(result.rows[0].urgency).toBe(LeaveApprovalUrgency.URGENT);
      expect(result.rows[0].isUrgent).toBe(true);
      expect(result.urgent).toBe(1);
    });

    it('leaves a request further out unflagged', async () => {
      leaveModel.findAll.mockResolvedValue([leave({ fromDate: iso(9), toDate: iso(10) })]);

      const result = await service.getLeaveApprovals(TENANT);

      expect(result.rows[0].urgency).toBe(LeaveApprovalUrgency.NORMAL);
      expect(result.urgent).toBe(0);
    });

    it('calls leave that is already under way Overdue', async () => {
      leaveModel.findAll.mockResolvedValue([leave({ fromDate: iso(-2), toDate: iso(1) })]);

      const result = await service.getLeaveApprovals(TENANT);

      expect(result.rows[0].urgency).toBe(LeaveApprovalUrgency.OVERDUE);
      expect(result.rows[0].isUrgent).toBe(true);
    });

    it('treats leave starting today as Urgent, not Overdue', async () => {
      leaveModel.findAll.mockResolvedValue([leave({ fromDate: iso(0), toDate: iso(0) })]);

      const result = await service.getLeaveApprovals(TENANT);

      expect(result.rows[0].startsInDays).toBe(0);
      expect(result.rows[0].urgency).toBe(LeaveApprovalUrgency.URGENT);
    });

    it('asks only for pending requests, soonest first', async () => {
      await service.getLeaveApprovals(TENANT);

      expect(leaveModel.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT, status: LeaveRequestStatus.PENDING },
          order: [['fromDate', 'ASC']],
        }),
      );
    });

    it('builds the row the panel renders', async () => {
      leaveModel.findAll.mockResolvedValue([
        leave({ fromDate: '2026-08-26', toDate: '2026-08-30', totalDays: 5 }),
      ]);

      const [row] = (await service.getLeaveApprovals(TENANT)).rows;

      expect(row).toMatchObject({
        summary: 'Annual Leave · 5d',
        period: 'Aug 26 – Aug 30',
        durationLabel: '5d',
      });
      expect(row.employee).toMatchObject({ name: 'Anjali Menon' });
      expect(row.employee?.department).toEqual({ id: 'd1', name: 'Design' });
    });

    /**
     * Urgency is derived per row, so the page has to be taken after the
     * filter — otherwise a limit would drop rows that belong on screen.
     */
    it('counts every pending request even when the page is smaller', async () => {
      leaveModel.findAll.mockResolvedValue([
        leave({ id: 'a', fromDate: iso(1) }),
        leave({ id: 'b', fromDate: iso(2) }),
        leave({ id: 'c', fromDate: iso(30) }),
      ]);

      const result = await service.getLeaveApprovals(TENANT, { limit: 1 });

      expect(result.pending).toBe(3);
      expect(result.urgent).toBe(2);
      expect(result.rows).toHaveLength(1);
    });

    it('filters to one urgency without losing the headline counts', async () => {
      leaveModel.findAll.mockResolvedValue([
        leave({ id: 'a', fromDate: iso(1) }),
        leave({ id: 'c', fromDate: iso(30) }),
      ]);

      const result = await service.getLeaveApprovals(TENANT, {
        urgency: LeaveApprovalUrgency.URGENT,
      });

      expect(result.pending).toBe(2);
      expect(result.total).toBe(1);
      expect(result.rows[0].id).toBe('a');
    });
  });

  describe('getOnboardingMatrix', () => {
    const hire = (id: string, first: string) => ({
      id,
      firstName: first,
      lastName: 'Mehta',
      position: 'Software Engineer',
      designation: null,
      department: { id: 'd1', name: 'Engineering' },
      joiningDate: '2026-08-15',
    });

    it('returns nothing to draw when there are no hires', async () => {
      const matrix = await service.getOnboardingMatrix(TENANT);

      expect(matrix).toEqual({ tasks: [], hires: [], cells: [] });
      expect(taskModel.findAll).not.toHaveBeenCalled();
    });

    it('lines the same task up across hires and leaves a gap where one is missing', async () => {
      newHireModel.findAll.mockResolvedValue([hire('h1', 'Kiran'), hire('h2', 'Rohan')]);
      taskModel.findAll.mockResolvedValue([
        { id: 't1', newHireId: 'h1', title: 'Offer Letter Signed', sortOrder: 10, status: 'COMPLETED', completedAt: new Date(), dueDate: null, category: 'DOCUMENTATION' },
        { id: 't2', newHireId: 'h2', title: 'Offer Letter Signed', sortOrder: 10, status: 'COMPLETED', completedAt: new Date(), dueDate: null, category: 'DOCUMENTATION' },
        { id: 't3', newHireId: 'h1', title: 'Bank Details', sortOrder: 20, status: 'PENDING', completedAt: null, dueDate: null, category: 'DOCUMENTATION' },
      ]);

      const matrix = await service.getOnboardingMatrix(TENANT);

      expect(matrix.tasks.map((task) => task.title)).toEqual([
        'Offer Letter Signed',
        'Bank Details',
      ]);

      const bankDetails = matrix.cells.find((cell) => cell.title === 'Bank Details')!;
      expect(bankDetails.byHire).toEqual([
        expect.objectContaining({ hireId: 'h1', taskId: 't3', completed: false }),
        // Rohan has no such task — the cell is blank, not a false tick.
        { hireId: 'h2', taskId: null, status: null, completed: null },
      ]);
    });

    it('counts progress per hire for the card above the matrix', async () => {
      newHireModel.findAll.mockResolvedValue([hire('h1', 'Kiran')]);
      taskModel.findAll.mockResolvedValue([
        { id: 't1', newHireId: 'h1', title: 'A', sortOrder: 10, status: 'COMPLETED', completedAt: new Date(), category: null },
        { id: 't2', newHireId: 'h1', title: 'B', sortOrder: 20, status: 'PENDING', completedAt: null, category: null },
        { id: 't3', newHireId: 'h1', title: 'C', sortOrder: 30, status: 'PENDING', completedAt: null, category: null },
        { id: 't4', newHireId: 'h1', title: 'D', sortOrder: 40, status: 'PENDING', completedAt: null, category: null },
      ]);

      const matrix = await service.getOnboardingMatrix(TENANT);

      expect(matrix.hires[0]).toMatchObject({
        name: 'Kiran Mehta',
        designation: 'Software Engineer',
        progressLabel: '1/4',
        progress: 25,
      });
    });
  });
});
