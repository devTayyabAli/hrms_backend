import { HttpStatus } from '@nestjs/common';
import { HrReportFormat, HrReportRange, HrReportType, LeaveRequestStatus } from '@app/common';
import { HrReportsService } from './hr-reports.service';

/**
 * Covers the parts of the Reports screen that are easy to get subtly wrong:
 * the Date Range presets, the window each report dates its rows on, and the
 * run log behind "Last run: 2h ago".
 */
describe('HrReportsService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';

  let runModel: any;
  let employeeModel: any;
  let attendanceModel: any;
  let leaveModel: any;
  let newHireModel: any;
  let taskModel: any;
  let departmentModel: any;
  let service: HrReportsService;

  beforeEach(() => {
    runModel = {
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'run-1' }),
    };
    employeeModel = { findAll: jest.fn().mockResolvedValue([]) };
    attendanceModel = { findAll: jest.fn().mockResolvedValue([]) };
    leaveModel = { findAll: jest.fn().mockResolvedValue([]) };
    newHireModel = { findAll: jest.fn().mockResolvedValue([]) };
    taskModel = { findAll: jest.fn().mockResolvedValue([]) };
    departmentModel = { findAll: jest.fn().mockResolvedValue([]) };

    const modelProvider = {
      getHrReportRunModel: jest.fn().mockResolvedValue(runModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getAttendanceRecordModel: jest.fn().mockResolvedValue(attendanceModel),
      getLeaveRequestModel: jest.fn().mockResolvedValue(leaveModel),
      getLeavePolicyModel: jest.fn().mockResolvedValue({}),
      getNewHireModel: jest.fn().mockResolvedValue(newHireModel),
      getOnboardingTaskModel: jest.fn().mockResolvedValue(taskModel),
      getDepartmentModel: jest.fn().mockResolvedValue(departmentModel),
      getDesignationModel: jest.fn().mockResolvedValue({}),
    };

    service = new HrReportsService(modelProvider as any);
  });

  describe('getTemplates', () => {
    it('offers the six cards the screen shows', async () => {
      const result = await service.getTemplates(TENANT);

      expect(result.templates.map((row) => row.type)).toEqual([
        HrReportType.EMPLOYEE,
        HrReportType.ATTENDANCE,
        HrReportType.LEAVE,
        HrReportType.ONBOARDING,
        HrReportType.DEPARTMENT_SUMMARY,
        HrReportType.CUSTOM,
      ]);
    });

    it('reads Never for a report that has not been run', async () => {
      const result = await service.getTemplates(TENANT);

      expect(result.templates.every((row) => row.lastRunLabel === 'Never')).toBe(true);
    });

    it('labels the most recent run of each type', async () => {
      runModel.findAll.mockResolvedValue([
        { type: HrReportType.EMPLOYEE, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        { type: HrReportType.EMPLOYEE, createdAt: new Date(Date.now() - 50 * 60 * 60 * 1000) },
        { type: HrReportType.LEAVE, createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      ]);

      const result = await service.getTemplates(TENANT);
      const byType = new Map(result.templates.map((row) => [row.type, row.lastRunLabel]));

      // Rows arrive newest first, so the first of each type is the latest.
      expect(byType.get(HrReportType.EMPLOYEE)).toBe('2h ago');
      expect(byType.get(HrReportType.LEAVE)).toBe('3d ago');
      expect(byType.get(HrReportType.ATTENDANCE)).toBe('Never');
    });
  });

  describe('date ranges', () => {
    const generate = (range: HrReportRange, extra: Record<string, any> = {}) =>
      service.generate(TENANT, { type: HrReportType.EMPLOYEE, range, ...extra } as any, USER);

    it('defaults to the current calendar month', async () => {
      const report = await generate(HrReportRange.THIS_MONTH);
      const now = new Date();

      expect(report.from).toBe(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
      );
      expect(report.rangeLabel).toBe('This Month');
    });

    it('starts the quarter on its first month', async () => {
      const report = await generate(HrReportRange.THIS_QUARTER);
      const month = Number(report.from.slice(5, 7));

      expect([1, 4, 7, 10]).toContain(month);
      expect(report.from.slice(8)).toBe('01');
    });

    it('spans the whole year', async () => {
      const report = await generate(HrReportRange.THIS_YEAR);

      expect(report.from.slice(4)).toBe('-01-01');
      expect(report.to.slice(4)).toBe('-12-31');
    });

    it('covers seven days inclusive, not eight', async () => {
      const report = await generate(HrReportRange.LAST_7_DAYS);
      const days =
        (Date.parse(report.to) - Date.parse(report.from)) / 86400000;

      expect(days).toBe(6);
    });

    it('takes a custom window as given', async () => {
      const report = await generate(HrReportRange.CUSTOM, {
        from: '2026-01-01',
        to: '2026-03-31',
      });

      expect(report.from).toBe('2026-01-01');
      expect(report.to).toBe('2026-03-31');
    });

    it('refuses a custom range that is missing a bound', async () => {
      await expect(generate(HrReportRange.CUSTOM, { from: '2026-01-01' })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('refuses a custom range that runs backwards', async () => {
      await expect(
        generate(HrReportRange.CUSTOM, { from: '2026-03-31', to: '2026-01-01' }),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('does not log a run it refused to build', async () => {
      await generate(HrReportRange.CUSTOM, { from: '2026-03-31', to: '2026-01-01' }).catch(
        () => undefined,
      );

      expect(runModel.create).not.toHaveBeenCalled();
    });
  });

  describe('employee report', () => {
    it('reports tenure and counts who joined inside the window', async () => {
      employeeModel.findAll.mockResolvedValue([
        {
          employeeCode: 'TN-0001',
          firstName: 'Ravi',
          lastName: 'Kumar',
          email: 'ravi@technova.com',
          phone: null,
          status: 'ACTIVE',
          joiningDate: '2020-01-15',
          exitDate: null,
          department: { name: 'Engineering' },
          designation: { title: 'Engineering Manager' },
        },
      ]);

      const report = await service.generate(
        TENANT,
        { type: HrReportType.EMPLOYEE, range: HrReportRange.THIS_MONTH } as any,
        USER,
      );

      expect(report.rows[0]).toMatchObject({
        employeeCode: 'TN-0001',
        name: 'Ravi Kumar',
        department: 'Engineering',
        designation: 'Engineering Manager',
      });
      expect(report.rows[0].tenure).toMatch(/y/);
      expect(report.summary.joinedInRange).toBe(0);
    });
  });

  describe('leave report', () => {
    /**
     * A leave report for August is about who was away in August, so rows are
     * selected by overlap with the window, not by when they were filed.
     */
    it('selects leave that overlaps the window rather than leave filed in it', async () => {
      await service.generate(
        TENANT,
        { type: HrReportType.LEAVE, range: HrReportRange.CUSTOM, from: '2026-08-01', to: '2026-08-31' } as any,
        USER,
      );

      const where = leaveModel.findAll.mock.calls[0][0].where;
      expect(where).toHaveProperty('fromDate');
      expect(where).toHaveProperty('toDate');
      expect(where).not.toHaveProperty('createdAt');
    });

    it('totals approved days and tallies each status', async () => {
      leaveModel.findAll.mockResolvedValue([
        {
          employee: { employeeCode: 'TN-0047', firstName: 'Anjali', lastName: 'Menon', department: { name: 'Design' } },
          leavePolicy: { name: 'Annual Leave' },
          fromDate: '2026-08-26',
          toDate: '2026-08-30',
          totalDays: '5',
          status: LeaveRequestStatus.APPROVED,
          reason: 'Personal travel',
        },
        {
          employee: null,
          leavePolicy: null,
          fromDate: '2026-08-24',
          toDate: '2026-08-25',
          totalDays: '2',
          status: LeaveRequestStatus.PENDING,
          reason: null,
        },
      ]);

      const report = await service.generate(
        TENANT,
        { type: HrReportType.LEAVE, range: HrReportRange.THIS_MONTH } as any,
        USER,
      );

      expect(report.summary).toMatchObject({
        total: 2,
        approvedDays: 5,
        byStatus: { APPROVED: 1, PENDING: 1 },
      });
      expect(report.rows[1].type).toBe('Leave');
    });
  });

  describe('onboarding report', () => {
    it('reports progress per hire and rolls up what is outstanding', async () => {
      newHireModel.findAll.mockResolvedValue([
        {
          id: 'h1',
          firstName: 'Kiran',
          lastName: 'Mehta',
          email: 'kiran@technova.com',
          position: 'Software Engineer',
          joiningDate: '2026-08-15',
          department: { name: 'Engineering' },
        },
      ]);
      taskModel.findAll.mockResolvedValue([
        { newHireId: 'h1', completedAt: new Date() },
        { newHireId: 'h1', completedAt: new Date() },
        { newHireId: 'h1', completedAt: null },
        { newHireId: 'h1', completedAt: null },
      ]);

      const report = await service.generate(
        TENANT,
        { type: HrReportType.ONBOARDING, range: HrReportRange.THIS_YEAR } as any,
        USER,
      );

      expect(report.rows[0]).toMatchObject({
        name: 'Kiran Mehta',
        completedTasks: 2,
        totalTasks: 4,
        pendingTasks: 2,
        progress: 50,
        onboardingComplete: false,
      });
      expect(report.summary).toMatchObject({ total: 1, completed: 0, pendingTasks: 2 });
    });

    it('does not ask for tasks when no hire is in the window', async () => {
      await service.generate(
        TENANT,
        { type: HrReportType.ONBOARDING, range: HrReportRange.THIS_MONTH } as any,
        USER,
      );

      expect(taskModel.findAll).not.toHaveBeenCalled();
    });
  });

  describe('department summary', () => {
    it('rolls headcount, attendance and leave up per department', async () => {
      departmentModel.findAll.mockResolvedValue([{ id: 'd1', name: 'Engineering' }]);
      employeeModel.findAll.mockResolvedValue([
        { id: 'e1', departmentId: 'd1', status: 'ACTIVE' },
        { id: 'e2', departmentId: 'd1', status: 'ACTIVE' },
        { id: 'e3', departmentId: null, status: 'ACTIVE' },
      ]);
      attendanceModel.findAll.mockResolvedValue([
        { employeeId: 'e1', status: 'PRESENT' },
        { employeeId: 'e1', status: 'LATE' },
        { employeeId: 'e2', status: 'ABSENT' },
      ]);
      leaveModel.findAll.mockResolvedValue([
        { employeeId: 'e1', status: LeaveRequestStatus.APPROVED, totalDays: '2' },
        { employeeId: 'e2', status: LeaveRequestStatus.PENDING, totalDays: '1' },
      ]);

      const report = await service.generate(
        TENANT,
        { type: HrReportType.DEPARTMENT_SUMMARY, range: HrReportRange.THIS_MONTH } as any,
        USER,
      );

      expect(report.rows[0]).toMatchObject({
        department: 'Engineering',
        headcount: 2,
        attendanceRecords: 3,
        presentRecords: 2,
        approvedLeaveDays: 2,
        pendingLeaveRequests: 1,
      });
      // Late still counts as turning up.
      expect(report.rows[0].attendanceRate).toBeCloseTo(66.7, 1);
      expect(report.summary.unassigned).toBe(1);
    });
  });

  describe('run log', () => {
    it('records what was generated so the card can say when', async () => {
      await service.generate(
        TENANT,
        { type: HrReportType.EMPLOYEE, range: HrReportRange.THIS_MONTH, format: HrReportFormat.CSV } as any,
        USER,
      );

      expect(runModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          type: HrReportType.EMPLOYEE,
          rangeLabel: 'This Month',
          format: HrReportFormat.CSV,
          generatedByUserId: USER,
        }),
      );
    });

    it('hands the export path its columns alongside the rows', async () => {
      const result = await service.export(
        TENANT,
        { type: HrReportType.EMPLOYEE, range: HrReportRange.THIS_MONTH } as any,
        USER,
      );

      expect(result.columns).toContain('employeeCode');
      expect(result).toHaveProperty('rows');
      expect(result).toHaveProperty('truncated', false);
    });
  });
});
