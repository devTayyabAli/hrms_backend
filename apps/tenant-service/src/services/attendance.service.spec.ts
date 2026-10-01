import {
  AttendanceStatus,
  EmployeeStatus,
  LeaveRequestStatus,
} from '@app/common';
import { AttendanceService } from './attendance.service';

/**
 * Covers the HR views: period resolution, the register's per-employee
 * figures (expected working days, unmarked days, rates), the per-employee
 * calendar's day classification, and the unmarked follow-up list.
 */
describe('AttendanceService HR views', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  let employeeModel: any;
  let attendanceModel: any;
  let workingHoursModel: any;
  let leaveModel: any;
  let service: AttendanceService;

  const employee = (over: Record<string, any> = {}) => ({
    id: 'e1',
    employeeCode: 'EMP001',
    firstName: 'Ayesha',
    lastName: 'Khan',
    avatarUrl: null,
    status: EmployeeStatus.ACTIVE,
    joiningDate: '2025-01-01',
    exitDate: null,
    department: { id: 'd1', name: 'Engineering' },
    designation: { id: 'g1', title: 'Engineer' },
    ...over,
  });

  beforeEach(() => {
    // Pin "today" so expected working days don't drift with the calendar.
    jest.useFakeTimers({ now: new Date('2026-09-30T12:00:00.000Z') });

    employeeModel = {
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      findOne: jest.fn().mockResolvedValue(null),
    };
    attendanceModel = {
      findAll: jest.fn().mockResolvedValue([]),
      getTableName: jest.fn().mockReturnValue('attendance_records'),
    };
    workingHoursModel = {
      findOne: jest.fn().mockResolvedValue({
        workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
      }),
    };
    leaveModel = { findAll: jest.fn().mockResolvedValue([]) };

    const modelProvider = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getAttendanceRecordModel: jest.fn().mockResolvedValue(attendanceModel),
      getWorkingHoursModel: jest.fn().mockResolvedValue(workingHoursModel),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
      getDesignationModel: jest.fn().mockResolvedValue({}),
      getLeaveRequestModel: jest.fn().mockResolvedValue(leaveModel),
      getLeavePolicyModel: jest.fn().mockResolvedValue({}),
    };
    service = new AttendanceService(modelProvider as any);
  });

  afterEach(() => jest.useRealTimers());

  describe('period resolution', () => {
    it('defaults to the current calendar month', async () => {
      const result = await service.getRegister(TENANT, {});
      expect(result).toMatchObject({
        month: '2026-09',
        from: '2026-09-01',
        to: '2026-09-30',
      });
    });

    it('lets an explicit range win over month', async () => {
      const result = await service.getRegister(TENANT, {
        month: '2026-01',
        from: '2026-09-10',
        to: '2026-09-20',
      });
      expect(result).toMatchObject({
        month: null,
        from: '2026-09-10',
        to: '2026-09-20',
      });
    });

    it('handles February in a non-leap year', async () => {
      const result = await service.getRegister(TENANT, { month: '2026-02' });
      expect(result.to).toBe('2026-02-28');
    });

    it('rejects a reversed range', async () => {
      await expect(
        service.getRegister(TENANT, { from: '2026-09-20', to: '2026-09-10' }),
      ).rejects.toThrow(/must not be later/);
    });

    it('rejects a range longer than a year', async () => {
      await expect(
        service.getRegister(TENANT, { from: '2024-01-01', to: '2026-01-01' }),
      ).rejects.toThrow(/at most 366 days/);
    });
  });

  describe('getRegister', () => {
    it('summarizes each employee against expected working days', async () => {
      employeeModel.findAndCountAll.mockResolvedValue({
        rows: [employee()],
        count: 1,
      });
      // September 2026 has 22 weekdays; all have passed by the pinned today.
      attendanceModel.findAll.mockResolvedValue([
        {
          employeeId: 'e1',
          status: AttendanceStatus.PRESENT,
          count: '15',
          workedMinutes: '7200',
          workedDays: '15',
          workingDayRecords: '15',
        },
        {
          employeeId: 'e1',
          status: AttendanceStatus.LATE,
          count: '3',
          workedMinutes: '1440',
          workedDays: '3',
          workingDayRecords: '3',
        },
        {
          employeeId: 'e1',
          status: AttendanceStatus.ABSENT,
          count: '1',
          workedMinutes: '0',
          workedDays: '0',
          workingDayRecords: '1',
        },
        {
          employeeId: 'e1',
          status: AttendanceStatus.ON_LEAVE,
          count: '1',
          workedMinutes: '0',
          workedDays: '0',
          workingDayRecords: '1',
        },
      ]);

      const result = await service.getRegister(TENANT, { month: '2026-09' });
      const { summary, employee: ref } = result.data[0];

      expect(ref).toMatchObject({
        name: 'Ayesha Khan',
        department: { id: 'd1', name: 'Engineering' },
        designation: { id: 'g1', title: 'Engineer' },
      });
      expect(summary).toMatchObject({
        present: 15,
        late: 3,
        absent: 1,
        onLeave: 1,
        recordedDays: 20,
        expectedWorkingDays: 22,
        unmarkedDays: 2,
        totalWorkedMinutes: 8640,
        totalWorkHours: '144h 00m',
        avgWorkedMinutesPerDay: 480,
        avgWorkHours: '8h 00m',
      });
      // attended 18 / (18 + 1 absent + 2 unmarked)
      expect(summary.attendanceRate).toBe(85.7);
      // (18 - 3 late) / 18
      expect(summary.punctualityRate).toBe(83.3);
      expect(result).toMatchObject({ total: 1, page: 1, totalPages: 1 });
    });

    it('clips expected days to the joining date', async () => {
      employeeModel.findAndCountAll.mockResolvedValue({
        rows: [employee({ joiningDate: '2026-09-28' })],
        count: 1,
      });

      const result = await service.getRegister(TENANT, { month: '2026-09' });

      // Mon 28, Tue 29, Wed 30.
      expect(result.data[0].summary.expectedWorkingDays).toBe(3);
      expect(result.data[0].summary.unmarkedDays).toBe(3);
      expect(result.data[0].summary.attendanceRate).toBe(0);
    });

    it('never expects days after today', async () => {
      employeeModel.findAndCountAll.mockResolvedValue({
        rows: [employee()],
        count: 1,
      });

      const result = await service.getRegister(TENANT, { month: '2026-10' });

      expect(result.data[0].summary.expectedWorkingDays).toBe(0);
    });

    it('skips the attendance query when the page has no employees', async () => {
      await service.getRegister(TENANT, {});
      expect(attendanceModel.findAll).not.toHaveBeenCalled();
    });

    it('falls back to Monday–Friday when no working hours are configured', async () => {
      workingHoursModel.findOne.mockResolvedValue(null);
      const result = await service.getRegister(TENANT, {});
      expect(result.workingDays).toEqual([
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
      ]);
    });
  });

  describe('getRegisterForExport', () => {
    it('reports truncation against the matched count', async () => {
      employeeModel.findAndCountAll.mockResolvedValue({
        rows: [employee()],
        count: 25000,
      });

      const result = await service.getRegisterForExport(TENANT, {});

      expect(result).toMatchObject({ totalMatched: 25000, truncated: true });
      expect(result.rows).toHaveLength(1);
    });
  });

  describe('getEmployeeAttendance', () => {
    it('404s for an employee outside the organization', async () => {
      await expect(
        service.getEmployeeAttendance(TENANT, 'missing', {}),
      ).rejects.toThrow(/not found/);
    });

    it('returns every day of the period, classified', async () => {
      employeeModel.findOne.mockResolvedValue(
        employee({ joiningDate: '2026-09-02' }),
      );
      attendanceModel.findAll.mockResolvedValue([
        {
          id: 'r1',
          date: '2026-09-03',
          status: AttendanceStatus.LATE,
          checkInAt: new Date('2026-09-03T09:40:00.000Z'),
          checkOutAt: new Date('2026-09-03T18:00:00.000Z'),
          workedMinutes: 500,
          source: 'SELF_SERVICE',
          notes: null,
        },
        {
          id: 'r2',
          date: '2026-09-04',
          status: AttendanceStatus.ON_LEAVE,
          workedMinutes: null,
          source: 'MANUAL',
        },
      ]);
      leaveModel.findAll.mockResolvedValue([
        {
          fromDate: '2026-09-04',
          toDate: '2026-09-04',
          leavePolicy: { name: 'Sick Leave' },
        },
      ]);

      const result = await service.getEmployeeAttendance(TENANT, 'e1', {
        month: '2026-09',
      });
      const day = (date: string) => result.days.find((d) => d.date === date);

      expect(result.days).toHaveLength(30);
      expect(day('2026-09-01').dayType).toBe('NOT_EMPLOYED');
      expect(day('2026-09-02').dayType).toBe('UNMARKED');
      expect(day('2026-09-03')).toMatchObject({
        dayType: 'RECORDED',
        status: AttendanceStatus.LATE,
        record: { id: 'r1', workHours: '8h 20m' },
      });
      expect(day('2026-09-04')).toMatchObject({
        status: AttendanceStatus.ON_LEAVE,
        leaveType: 'Sick Leave',
      });
      expect(day('2026-09-05')).toMatchObject({
        weekday: 'SATURDAY',
        isWorkingDay: false,
        dayType: 'WEEKLY_OFF',
      });

      // Weekdays from Sep 2 to Sep 30 = 21; two of them are recorded.
      expect(result.summary).toMatchObject({
        late: 1,
        onLeave: 1,
        expectedWorkingDays: 21,
        unmarkedDays: 19,
      });
      expect(leaveModel.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: LeaveRequestStatus.APPROVED,
          }),
        }),
      );
    });

    it('marks days after today as upcoming', async () => {
      jest.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
      employeeModel.findOne.mockResolvedValue(employee());

      const result = await service.getEmployeeAttendance(TENANT, 'e1', {
        month: '2026-09',
      });

      expect(result.days.find((d) => d.date === '2026-09-16')?.dayType).toBe(
        'UPCOMING',
      );
    });
  });

  describe('getUnmarked', () => {
    it('lists employees with no record via NOT EXISTS for the day', async () => {
      employeeModel.findAndCountAll.mockResolvedValue({
        rows: [employee()],
        count: 1,
      });

      const result = await service.getUnmarked(TENANT, { date: '2026-09-26' });

      expect(result).toMatchObject({
        date: '2026-09-26',
        isWorkingDay: false,
        total: 1,
        data: [{ id: 'e1', name: 'Ayesha Khan' }],
      });

      const { where } = employeeModel.findAndCountAll.mock.calls[0][0];
      const sql = JSON.stringify(
        Object.getOwnPropertySymbols(where).map((symbol) => where[symbol]),
      );
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain("'2026-09-26'");
    });
  });
});
