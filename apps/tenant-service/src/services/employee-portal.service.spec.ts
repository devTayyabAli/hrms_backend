import { HttpStatus } from '@nestjs/common';
import { Op } from 'sequelize';
import { AttendanceSource, EmployeeDocumentCategory, EmployeeDocumentStatus, EmployeeNotificationKind, EmployeeRequestStatus, EmployeeRequestType, LeaveRequestStatus } from '@app/common';
import { EmployeePortalService } from './employee-portal.service';
import { rulesFrom } from './attendance-rules';

describe('EmployeePortalService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';
  const EMPLOYEE = '33333333-3333-4333-8333-333333333333';
  const OTHER = '44444444-4444-4444-8444-444444444444';

  let employeeModel: any;
  let attendanceModel: any;
  let policyModel: any;
  let leaveModel: any;
  let documentModel: any;
  let requestModel: any;
  let notificationModel: any;
  let workingHoursModel: any;
  let leaveRequests: { create: jest.Mock; cancel: jest.Mock; update: jest.Mock };
  let attendanceService: { create: jest.Mock; update: jest.Mock; getRules: jest.Mock; getWorkingDays: jest.Mock };
  let service: EmployeePortalService;

  const employee = (over: Record<string, any> = {}) => ({
    id: EMPLOYEE,
    tenantId: TENANT,
    userId: USER,
    employeeCode: 'EMP001',
    firstName: 'Meera',
    lastName: 'Nair',
    email: 'meera@technova.com',
    phone: null,
    avatarUrl: null,
    status: 'ACTIVE',
    joiningDate: '2023-04-15',
    department: { id: 'd1', name: 'Engineering' },
    designation: { id: 'g1', title: 'Engineer' },
    reportingManager: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  beforeEach(() => {
    employeeModel = { findOne: jest.fn().mockResolvedValue(employee()) };
    attendanceModel = { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) };
    policyModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({
        id: 'p1',
        name: 'Sick Leave',
        annualAllocation: 12,
        isPaid: true,
        isActive: true,
      }),
    };
    leaveModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
    };
    documentModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      destroy: jest.fn().mockResolvedValue(1),
    };
    requestModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
    };
    notificationModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
      update: jest.fn().mockResolvedValue([1]),
    };
    workingHoursModel = { findOne: jest.fn().mockResolvedValue(null) };
    leaveRequests = {
      create: jest.fn(),
      cancel: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const modelProvider = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
      getDesignationModel: jest.fn().mockResolvedValue({}),
      getAttendanceRecordModel: jest.fn().mockResolvedValue(attendanceModel),
      getLeavePolicyModel: jest.fn().mockResolvedValue(policyModel),
      getLeaveRequestModel: jest.fn().mockResolvedValue(leaveModel),
      getEmployeeDocumentModel: jest.fn().mockResolvedValue(documentModel),
      getEmployeeRequestModel: jest.fn().mockResolvedValue(requestModel),
      getEmployeeNotificationModel: jest.fn().mockResolvedValue(notificationModel),
      getWorkingHoursModel: jest.fn().mockResolvedValue(workingHoursModel),
    };

    attendanceService = {
      create: jest.fn().mockResolvedValue({
        id: 'att-1',
        status: 'PRESENT',
        checkInAt: new Date(),
        checkOutAt: null,
        workedMinutes: null,
      }),
      update: jest.fn().mockResolvedValue({
        id: 'att-1',
        status: 'PRESENT',
        checkInAt: new Date(),
        checkOutAt: new Date(),
        workedMinutes: 532,
      }),
      getRules: jest.fn().mockResolvedValue(rulesFrom(null, null)),
      getWorkingDays: jest
        .fn()
        .mockResolvedValue(new Set(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'])),
    };

    service = new EmployeePortalService(
      modelProvider as any,
      leaveRequests as any,
      attendanceService as any,
    );
  });

  it('refuses a login that is not linked to an employee', async () => {
    employeeModel.findOne.mockResolvedValue(null);
    await expect(service.getProfile(TENANT, USER)).rejects.toMatchObject({
      message: expect.stringContaining('No employee profile'),
    });
    expect(employeeModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, userId: USER } }),
    );
  });

  it('links the login by email when the token id is not the employee user id', async () => {
    const row = employee({ userId: 'user-service-id' });
    employeeModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    const profile = await service.getProfile(TENANT, 'auth-credential-id', 'Meera@TechNova.com');
    expect(profile.name).toBe('Meera Nair');
    expect(employeeModel.findOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          email: expect.objectContaining({}),
        }),
      }),
    );
  });

  it('returns the profile tab and only patches phone and photo', async () => {
    const row = employee();
    employeeModel.findOne.mockResolvedValue(row);
    const updated = await service.updateProfile(TENANT, USER, { phone: '+91 90000 00000' });
    expect(row.update).toHaveBeenCalledWith({ phone: '+91 90000 00000' });
    expect(updated.name).toBe('Meera Nair');
    expect(updated.department).toEqual({ id: 'd1', name: 'Engineering' });
  });

  it('summarises the attendance month', async () => {
    attendanceModel.findAll.mockResolvedValue([
      { id: 'a1', date: '2026-09-01', status: 'PRESENT', checkInAt: null, checkOutAt: null, workedMinutes: 480, notes: null },
      { id: 'a2', date: '2026-09-02', status: 'LATE', checkInAt: null, checkOutAt: null, workedMinutes: 400, notes: null },
      { id: 'a3', date: '2026-09-03', status: 'ABSENT', checkInAt: null, checkOutAt: null, workedMinutes: null, notes: null },
      { id: 'a4', date: '2026-09-04', status: 'ON_LEAVE', checkInAt: null, checkOutAt: null, workedMinutes: null, notes: null },
    ]);
    const result = await service.getAttendance(TENANT, USER, { month: '2026-09' });
    expect(result.summary).toMatchObject({
      present: 1,
      late: 1,
      absent: 1,
      onLeave: 1,
      halfDay: 0,
      holiday: 0,
    });
    expect(result.days).toHaveLength(4);
    expect(attendanceModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, employeeId: EMPLOYEE }),
      }),
    );
  });

  it('reports the organization working hours as the daily target', async () => {
    workingHoursModel.findOne.mockResolvedValue({
      name: 'General',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakDurationMinutes: 60,
      workingDays: ['MON', 'TUE'],
    });

    const today = await service.getAttendanceToday(TENANT, USER);

    expect(today.schedule).toMatchObject({
      startTime: '09:00',
      endTime: '18:00',
      breakMinutes: 60,
      targetMinutes: 540,
      targetHoursLabel: '9h 00m',
    });
    expect(workingHoursModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT } }),
    );
  });

  it('has no target when working hours are not configured', async () => {
    const result = await service.getAttendance(TENANT, USER, { month: '2026-09' });
    expect(result.schedule).toBeNull();
  });

  /**
   * The Avg Hours/Day card. Averaging over the month's length instead of the
   * days worked would read as underwork every time someone takes leave.
   */
  it('averages hours over the days worked, not the days in the month', async () => {
    attendanceModel.findAll.mockResolvedValue([
      { id: 'a1', date: '2026-09-01', status: 'PRESENT', workedMinutes: 532, checkInAt: null, checkOutAt: null, notes: null },
      { id: 'a2', date: '2026-09-02', status: 'PRESENT', workedMinutes: 532, checkInAt: null, checkOutAt: null, notes: null },
      { id: 'a3', date: '2026-09-03', status: 'ON_LEAVE', workedMinutes: null, checkInAt: null, checkOutAt: null, notes: null },
    ]);

    const result = await service.getAttendance(TENANT, USER, { month: '2026-09' });

    expect(result.summary.daysWorked).toBe(2);
    expect(result.summary.avgMinutesPerDay).toBe(532);
    expect(result.summary.avgHoursLabel).toBe('8h 52m');
    expect(result.summary.totalHoursLabel).toBe('17h 44m');
  });

  it('reports a month with nothing worked as zero rather than NaN', async () => {
    attendanceModel.findAll.mockResolvedValue([]);

    const result = await service.getAttendance(TENANT, USER, { month: '2026-09' });

    expect(result.summary.avgMinutesPerDay).toBe(0);
    expect(result.summary.avgHoursLabel).toBe('0h 00m');
  });

  it('labels each row the way the table renders it', async () => {
    attendanceModel.findAll.mockResolvedValue([
      { id: 'a1', date: '2026-08-19', status: 'PRESENT', workedMinutes: 532, checkInAt: null, checkOutAt: null, notes: null },
    ]);

    const [row] = (await service.getAttendance(TENANT, USER, { month: '2026-08' })).days;

    expect(row).toMatchObject({
      // 19 Aug 2026 is a Wednesday.
      dayLabel: 'Wed Aug 19',
      workHours: '8h 52m',
      statusLabel: 'Present',
      leaveType: null,
    });
  });

  /** An absent day reads as the leave that caused it, not as "On Leave". */
  it('names the leave type on a day taken off', async () => {
    attendanceModel.findAll.mockResolvedValue([
      { id: 'a1', date: '2026-08-21', status: 'ON_LEAVE', workedMinutes: null, checkInAt: null, checkOutAt: null, notes: null },
      { id: 'a2', date: '2026-08-22', status: 'ON_LEAVE', workedMinutes: null, checkInAt: null, checkOutAt: null, notes: null },
    ]);
    leaveModel.findAll.mockResolvedValue([
      {
        fromDate: '2026-08-21',
        toDate: '2026-08-22',
        status: LeaveRequestStatus.APPROVED,
        leavePolicy: { id: 'p1', name: 'Sick Leave' },
      },
    ]);

    const result = await service.getAttendance(TENANT, USER, { month: '2026-08' });

    expect(result.days.map((day) => day.statusLabel)).toEqual(['Sick Leave', 'Sick Leave']);
    expect(result.days[0].leaveType).toBe('Sick Leave');
  });

  it('falls back to On Leave when no approved leave covers the day', async () => {
    attendanceModel.findAll.mockResolvedValue([
      { id: 'a1', date: '2026-08-21', status: 'ON_LEAVE', workedMinutes: null, checkInAt: null, checkOutAt: null, notes: null },
    ]);
    leaveModel.findAll.mockResolvedValue([]);

    const result = await service.getAttendance(TENANT, USER, { month: '2026-08' });

    expect(result.days[0].statusLabel).toBe('On Leave');
  });

  /** The label is decoration; losing it must not lose the attendance table. */
  it('still returns the month when the leave lookup fails', async () => {
    attendanceModel.findAll.mockResolvedValue([
      { id: 'a1', date: '2026-08-21', status: 'ON_LEAVE', workedMinutes: null, checkInAt: null, checkOutAt: null, notes: null },
    ]);
    leaveModel.findAll.mockRejectedValue(new Error('relation does not exist'));

    const result = await service.getAttendance(TENANT, USER, { month: '2026-08' });

    expect(result.days).toHaveLength(1);
    expect(result.days[0].statusLabel).toBe('On Leave');
  });

  describe('check in / check out', () => {
    const todayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
      new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`).getUTCDay()
    ];
    const everyDayBut = (day: string) =>
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].filter((d) => d !== day);

    it('blocks a punch from outside the allowed networks', async () => {
      attendanceModel.findOne.mockResolvedValue(null);
      attendanceService.getRules.mockResolvedValue(
        rulesFrom(null, { ipRestrictionEnabled: true, allowedIpRanges: ['203.0.113.0/24'] }),
      );

      await expect(service.checkIn(TENANT, USER, undefined, '198.51.100.7')).rejects.toMatchObject({
        message: expect.stringContaining('office network'),
      });
      expect(attendanceService.create).not.toHaveBeenCalled();

      await service.checkIn(TENANT, USER, undefined, '::ffff:203.0.113.42');
      expect(attendanceService.create).toHaveBeenCalled();
    });

    it('lets an approved work-from-home day punch from anywhere', async () => {
      attendanceModel.findOne.mockResolvedValue(null);
      requestModel.findOne.mockResolvedValue({ id: 'wfh-1', fromDate: '2026-01-01', toDate: '2099-12-31' });
      attendanceModel.update = jest.fn().mockResolvedValue([1]);
      attendanceService.getRules.mockResolvedValue(
        rulesFrom(null, { ipRestrictionEnabled: true, allowedIpRanges: ['203.0.113.10'] }),
      );

      await service.checkIn(TENANT, USER, undefined, '198.51.100.7');
      expect(attendanceService.create).toHaveBeenCalled();
    });

    it('refuses weekend check-in when weekend work is not allowed', async () => {
      attendanceModel.findOne.mockResolvedValue(null);
      attendanceService.getRules.mockResolvedValue(
        rulesFrom(
          { startTime: '09:00', workingDays: everyDayBut(todayName) },
          { weekendWorkPolicy: 'NOT_ALLOWED' },
        ),
      );

      await expect(service.checkIn(TENANT, USER)).rejects.toMatchObject({
        message: expect.stringContaining('weekend work'),
      });
    });

    it('notes comp-off eligibility on a weekend punch', async () => {
      attendanceModel.findOne.mockResolvedValue(null);
      attendanceService.getRules.mockResolvedValue(
        rulesFrom(
          { startTime: '09:00', workingDays: everyDayBut(todayName) },
          { weekendWorkPolicy: 'COMP_OFF' },
        ),
      );

      await service.checkIn(TENANT, USER);
      expect(attendanceService.create.mock.calls[0][1]).toMatchObject({
        notes: expect.stringContaining('comp-off'),
      });
    });

    it('creates today as a self-service punch', async () => {
      attendanceModel.findOne.mockResolvedValue(null);

      const result = await service.checkIn(TENANT, USER);

      expect(attendanceService.create).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ employeeId: EMPLOYEE }),
        USER,
        AttendanceSource.SELF_SERVICE,
      );
      expect(result.record.statusLabel).toBe('Present');
    });

    /**
     * The late rule depends on the org's working hours and grace period, so
     * it stays with AttendanceService — the portal must not decide it.
     */
    it('never names a status itself', async () => {
      attendanceModel.findOne.mockResolvedValue(null);

      await service.checkIn(TENANT, USER);

      expect(attendanceService.create.mock.calls[0][1]).not.toHaveProperty('status');
    });

    it('refuses a second check-in on the same day', async () => {
      attendanceModel.findOne.mockResolvedValue({ id: 'att-1', checkInAt: new Date() });

      await expect(service.checkIn(TENANT, USER)).rejects.toMatchObject({
        message: expect.stringContaining('already checked in'),
      });
      expect(attendanceService.create).not.toHaveBeenCalled();
    });

    /** HR may have marked the day absent before the employee punched in. */
    it('updates a day HR already marked rather than colliding with it', async () => {
      attendanceModel.findOne.mockResolvedValue({
        id: 'att-1',
        checkInAt: null,
        checkOutAt: null,
      });

      await service.checkIn(TENANT, USER);

      expect(attendanceService.create).not.toHaveBeenCalled();
      expect(attendanceService.update).toHaveBeenCalledWith(
        TENANT,
        'att-1',
        expect.objectContaining({ checkInAt: expect.any(String) }),
        USER,
      );
    });

    it('records the hours on check-out', async () => {
      attendanceModel.findOne.mockResolvedValue({
        id: 'att-1',
        checkInAt: new Date(),
        checkOutAt: null,
      });

      const result = await service.checkOut(TENANT, USER);

      expect(attendanceService.update).toHaveBeenCalledWith(
        TENANT,
        'att-1',
        expect.objectContaining({ checkOutAt: expect.any(String) }),
        USER,
      );
      expect(result.record.workHours).toBe('8h 52m');
    });

    it('saves the day-end status with the check-out, as written', async () => {
      attendanceModel.findOne.mockResolvedValue({ id: 'att-1', checkInAt: new Date(), checkOutAt: null });
      attendanceModel.update = jest.fn().mockResolvedValue([1]);
      const report = '- Closed the payroll run\n- Reviewed 3 leave requests';

      const result = await service.checkOut(TENANT, USER, undefined, undefined, `  ${report}  `);

      expect(attendanceModel.update).toHaveBeenCalledWith(
        { dayEndStatus: report },
        { where: { id: 'att-1', tenantId: TENANT } },
      );
      expect(result.record.dayEndStatus).toBe(report);
    });

    it('refuses a check-out with no check-in', async () => {
      attendanceModel.findOne.mockResolvedValue(null);

      await expect(service.checkOut(TENANT, USER)).rejects.toMatchObject({
        message: expect.stringContaining('check in before'),
      });
      expect(attendanceService.update).not.toHaveBeenCalled();
    });

    it('refuses a second check-out', async () => {
      attendanceModel.findOne.mockResolvedValue({
        id: 'att-1',
        checkInAt: new Date(),
        checkOutAt: new Date(),
      });

      await expect(service.checkOut(TENANT, USER)).rejects.toMatchObject({
        message: expect.stringContaining('already checked out'),
      });
      expect(attendanceService.update).not.toHaveBeenCalled();
    });

    it('scopes the day lookup to the signed-in employee', async () => {
      attendanceModel.findOne.mockResolvedValue(null);

      await service.checkIn(TENANT, USER);

      expect(attendanceModel.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ tenantId: TENANT, employeeId: EMPLOYEE }),
      });
    });
  });

  it('labels today for the dashboard card', async () => {
    attendanceModel.findOne.mockResolvedValue({
      id: 'a1',
      status: 'PRESENT',
      checkInAt: null,
      checkOutAt: null,
      workedMinutes: 532,
    });

    const today = await service.getAttendanceToday(TENANT, USER);

    expect(today.record).toMatchObject({ statusLabel: 'Present', workHours: '8h 52m' });
  });

  it('builds leave cards from approved days only', async () => {
    policyModel.findAll.mockResolvedValue([
      { id: 'p-annual', name: 'Annual Leave', annualAllocation: 21, isActive: true },
      { id: 'p-sick', name: 'Sick Leave', annualAllocation: 12, isActive: true },
    ]);
    leaveModel.findAll.mockResolvedValue([
      { leavePolicyId: 'p-annual', status: LeaveRequestStatus.APPROVED, totalDays: '6' },
      { leavePolicyId: 'p-sick', status: LeaveRequestStatus.PENDING, totalDays: '2' },
    ]);
    const summary = await service.getLeaveSummary(TENANT, USER);
    expect(summary.fiscalYear).toMatch(/^FY \d{4}-\d{2}$/);
    const annual = summary.balances.find((row) => row.name === 'Annual Leave');
    const sick = summary.balances.find((row) => row.name === 'Sick Leave');
    expect(annual).toMatchObject({ remaining: 15, used: 6, usedLabel: 'Used: 6 / 21' });
    expect(sick).toMatchObject({ remaining: 12, used: 0, pending: 2 });
  });

  it('flags only pending leave as cancellable and ignores another employee', async () => {
    leaveModel.findAndCountAll.mockResolvedValue({
      count: 1,
      rows: [
      {
        id: 'l1',
        leavePolicyId: 'p1',
        leavePolicy: { id: 'p1', name: 'Sick Leave' },
        fromDate: '2026-08-21',
        toDate: '2026-08-22',
        totalDays: 2,
        status: LeaveRequestStatus.PENDING,
        reason: null,
      },
      ],
    });
    const history = await service.getLeaveHistory(TENANT, USER);
    expect(history.rows[0]).toMatchObject({
      type: 'Sick Leave',
      period: 'Aug 21 – Aug 22',
      durationLabel: '2 days',
      canCancel: true,
      canEdit: true,
    });
    expect(history).toMatchObject({ total: 1, page: 1, totalPages: 1 });

    leaveModel.findOne.mockResolvedValue(null);
    await expect(service.cancelLeave(TENANT, USER, OTHER)).rejects.toMatchObject({
      message: expect.stringContaining('not found'),
    });
    expect(leaveRequests.cancel).not.toHaveBeenCalled();
  });

  it('filters documents by category and labels file size', async () => {
    documentModel.findAll.mockResolvedValueOnce([
      {
        id: 'doc1',
        title: 'Offer Letter',
        category: EmployeeDocumentCategory.EMPLOYMENT,
        fileId: 'file-1',
        fileName: 'offer.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 250880,
        status: EmployeeDocumentStatus.VERIFIED,
        createdAt: new Date('2023-04-15'),
      },
    ]);
    // Second findAll: the grouped tab/status counts across all categories.
    documentModel.findAll.mockResolvedValueOnce([
      { category: EmployeeDocumentCategory.EMPLOYMENT, status: EmployeeDocumentStatus.VERIFIED, count: '4' },
      { category: EmployeeDocumentCategory.IDENTITY, status: EmployeeDocumentStatus.PENDING, count: '3' },
    ]);
    const list = await service.getDocuments(TENANT, USER, { category: 'EMPLOYMENT' as any });
    expect(list.total).toBe(7);
    expect(list.counts).toEqual({
      byCategory: { ALL: 7, EMPLOYMENT: 4, IDENTITY: 3, PAYROLL: 0, QUALIFICATION: 0 },
      byStatus: { PENDING: 3, VERIFIED: 4, REJECTED: 0 },
    });
    expect(list.rows[0]).toMatchObject({ canEdit: false, canDelete: false, expiryDate: null });
    expect(list.categories).toEqual(['ALL', 'EMPLOYMENT', 'IDENTITY', 'PAYROLL', 'QUALIFICATION']);
    expect(list.rows[0].sizeLabel).toBe('245 KB');
    expect(documentModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: 'EMPLOYMENT', employeeId: EMPLOYEE }),
      }),
    );
  });

  it('deletes a pending document and hands back its file id', async () => {
    const row = { id: 'doc1', fileId: 'file-1', status: EmployeeDocumentStatus.PENDING, destroy: jest.fn() };
    documentModel.findOne.mockResolvedValue(row);

    const result = await service.deleteDocument(TENANT, USER, 'doc1');

    expect(row.destroy).toHaveBeenCalled();
    expect(result.fileId).toBe('file-1');
    expect(documentModel.findOne).toHaveBeenCalledWith({
      where: { id: 'doc1', tenantId: TENANT, employeeId: EMPLOYEE },
    });
  });

  describe('HR document review', () => {
    const HR = '55555555-5555-4555-8555-555555555555';
    const uploaded = (over: Record<string, any> = {}) => ({
      id: 'doc1',
      employeeId: OTHER,
      title: 'Passport',
      fileId: 'file-1',
      fileName: 'passport.pdf',
      status: EmployeeDocumentStatus.PENDING,
      createdAt: new Date(),
      update: jest.fn().mockImplementation(async function (this: any, patch: any) {
        Object.assign(this, patch);
      }),
      ...over,
    });

    beforeEach(() => {
      // The reviewer has no employee record of their own (e.g. the org admin).
      employeeModel.findOne.mockResolvedValue(null);
    });

    it('verifies a document, records who did it and notifies the employee', async () => {
      const row = uploaded();
      documentModel.findOne.mockResolvedValue(row);

      const result = await service.reviewDocument(TENANT, 'doc1', { status: EmployeeDocumentStatus.VERIFIED }, { userId: HR });

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: EmployeeDocumentStatus.VERIFIED, reviewedByUserId: HR }),
      );
      expect(result.status).toBe(EmployeeDocumentStatus.VERIFIED);
      expect(notificationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: OTHER, title: 'Document Verified' }),
      );
    });

    it('needs a reason to reject, and passes it on to the employee', async () => {
      const row = uploaded();
      documentModel.findOne.mockResolvedValue(row);

      await expect(
        service.reviewDocument(TENANT, 'doc1', { status: EmployeeDocumentStatus.REJECTED, note: '  ' }, { userId: HR }),
      ).rejects.toMatchObject({ message: expect.stringContaining('reason') });
      expect(row.update).not.toHaveBeenCalled();

      await service.reviewDocument(
        TENANT,
        'doc1',
        { status: EmployeeDocumentStatus.REJECTED, note: 'Scan is blurry' },
        { userId: HR },
      );
      expect(row.update).toHaveBeenCalledWith(expect.objectContaining({ reviewNote: 'Scan is blurry' }));
      expect(notificationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Document Rejected', body: expect.stringContaining('Scan is blurry') }),
      );
    });

    it('stops anyone reviewing their own upload', async () => {
      const row = uploaded({ employeeId: EMPLOYEE });
      documentModel.findOne.mockResolvedValue(row);
      employeeModel.findOne.mockResolvedValue({ id: EMPLOYEE });

      await expect(
        service.reviewDocument(TENANT, 'doc1', { status: EmployeeDocumentStatus.VERIFIED }, { userId: USER }),
      ).rejects.toMatchObject({ message: expect.stringContaining('your own document') });
      expect(row.update).not.toHaveBeenCalled();
    });

    it('lists every employee’s uploads and flags the viewer’s own', async () => {
      employeeModel.findOne.mockResolvedValue({ id: EMPLOYEE });
      documentModel.findAndCountAll = jest.fn().mockResolvedValue({
        rows: [
          uploaded({ employeeId: EMPLOYEE, employee: { id: EMPLOYEE, employeeCode: 'EMP001', firstName: 'Meera', lastName: 'Nair' } }),
          uploaded({ id: 'doc2', employee: { id: OTHER, employeeCode: 'EMP002', firstName: 'Ali', lastName: 'Khan' } }),
        ],
        count: 2,
      });

      const result = await service.listAllDocuments(TENANT, { status: EmployeeDocumentStatus.PENDING }, { userId: USER });

      expect(result.total).toBe(2);
      expect(result.data.map((row) => row.isOwnDocument)).toEqual([true, false]);
      expect(result.data[1].employee?.name).toBe('Ali Khan');
      expect(documentModel.findAndCountAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: EmployeeDocumentStatus.PENDING }) }),
      );
    });
  });

  it('refuses to delete a document HR has verified', async () => {
    const row = { id: 'doc1', fileId: 'file-1', status: EmployeeDocumentStatus.VERIFIED, destroy: jest.fn() };
    documentModel.findOne.mockResolvedValue(row);

    await expect(service.deleteDocument(TENANT, USER, 'doc1')).rejects.toMatchObject({
      message: expect.stringContaining('verified'),
    });
    expect(row.destroy).not.toHaveBeenCalled();
  });

  it('returns the four request cards and a pending count beyond the page', async () => {
    requestModel.count.mockResolvedValue(3);
    requestModel.findAll.mockResolvedValue([
      {
        id: 'r1',
        type: EmployeeRequestType.ATTENDANCE_CORRECTION,
        description: 'Aug 20 — missed check-in',
        requestDate: '2026-08-21',
        fromDate: null,
        toDate: null,
        hours: null,
        status: EmployeeRequestStatus.PENDING,
        decisionNote: null,
        createdAt: new Date(),
      },
    ]);
    const result = await service.getRequests(TENANT, USER);
    expect(result.types.map((card) => card.type)).toEqual([
      'ATTENDANCE_CORRECTION',
      'WORK_FROM_HOME',
      'OVERTIME',
      'GENERAL',
    ]);
    expect(result.pending).toBe(3);
    expect(result.rows[0].canCancel).toBe(true);
    expect(result.rows[0].title).toBe('Attendance Correction');
  });

  it('marks one notification read and reports unread', async () => {
    const row = {
      id: 'n1',
      kind: EmployeeNotificationKind.LEAVE,
      title: 'Leave Approved',
      body: 'Your leave request has been approved.',
      readAt: null,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      update: jest.fn().mockImplementation(async function (this: any, patch: any) {
        this.readAt = patch.readAt;
      }),
    };
    notificationModel.findAll.mockResolvedValue([row]);
    notificationModel.count.mockResolvedValue(1);
    notificationModel.findOne.mockResolvedValue(row);

    const feed = await service.getNotifications(TENANT, USER, { limit: 10 });
    expect(feed.unread).toBe(1);
    expect(feed.rows[0].timeAgo).toBe('2h ago');
    expect(feed.rows[0].unread).toBe(true);

    const read = await service.markNotificationRead(TENANT, USER, 'n1');
    expect(read.unread).toBe(false);
  });

  it('applies leave as the signed-in employee and always as pending', async () => {
    leaveRequests.create.mockResolvedValue({
      id: 'l9',
      fromDate: '2026-08-21',
      toDate: '2026-08-22',
      leaveType: { id: 'p1', name: 'Sick Leave' },
    });

    await service.applyLeave(TENANT, USER, {
      leavePolicyId: 'p1',
      fromDate: '2026-08-21',
      toDate: '2026-08-22',
    } as any);

    expect(leaveRequests.create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        employeeId: EMPLOYEE,
        leavePolicyId: 'p1',
        status: LeaveRequestStatus.PENDING,
      }),
      USER,
    );
    expect(notificationModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: EMPLOYEE,
        kind: EmployeeNotificationKind.LEAVE,
        body: expect.stringContaining('Sick Leave'),
      }),
    );
  });

  it('files a request against the signed-in employee and refuses a backwards range', async () => {
    requestModel.create.mockResolvedValue({
      id: 'r9',
      type: EmployeeRequestType.WORK_FROM_HOME,
      description: 'Remote',
      requestDate: '2026-08-21',
      status: EmployeeRequestStatus.PENDING,
      createdAt: new Date(),
    });

    await service.createRequest(TENANT, USER, {
      type: EmployeeRequestType.WORK_FROM_HOME,
      description: '  Remote  ',
      fromDate: '2026-08-21',
      toDate: '2026-08-23',
    } as any);

    expect(requestModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: EMPLOYEE,
        description: 'Remote',
        requestDate: '2026-08-21',
        status: EmployeeRequestStatus.PENDING,
      }),
    );

    await expect(
      service.createRequest(TENANT, USER, {
        type: EmployeeRequestType.OVERTIME,
        description: 'Late',
        fromDate: '2026-08-23',
        toDate: '2026-08-21',
      } as any),
    ).rejects.toMatchObject({ message: expect.stringContaining('on or after') });
  });

  describe('approving a request applies it', () => {
    const HR = '55555555-5555-4555-8555-555555555555';
    const pendingRequest = (over: Record<string, any> = {}) => ({
      id: 'r1',
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      type: EmployeeRequestType.ATTENDANCE_CORRECTION,
      description: 'Missed check-in',
      requestDate: '2026-09-20',
      fromDate: null,
      toDate: null,
      hours: null,
      timeFrom: '09:30',
      timeTo: '18:00',
      status: EmployeeRequestStatus.PENDING,
      createdAt: new Date(),
      update: jest.fn().mockResolvedValue(undefined),
      ...over,
    });

    beforeEach(() => {
      attendanceModel.update = jest.fn().mockResolvedValue([2]);
      // The approver here has no employee record of their own (an org admin).
      employeeModel.findOne.mockResolvedValue(null);
    });

    it('corrects an existing attendance day through AttendanceService', async () => {
      const row = pendingRequest();
      requestModel.findOne.mockResolvedValue(row);
      attendanceModel.findOne.mockResolvedValue({
        id: 'att-9',
        checkInAt: null,
        checkOutAt: null,
        status: 'ABSENT',
        notes: null,
      });

      await service.decideRequest(
        TENANT,
        'r1',
        {
          status: EmployeeRequestStatus.APPROVED,
          checkInAt: '2026-09-20T04:30:00.000Z',
          checkOutAt: '2026-09-20T13:00:00.000Z',
        } as any,
        HR,
      );

      expect(attendanceService.update).toHaveBeenCalledWith(
        TENANT,
        'att-9',
        expect.objectContaining({
          checkInAt: '2026-09-20T04:30:00.000Z',
          checkOutAt: '2026-09-20T13:00:00.000Z',
          notes: expect.stringContaining('Corrected'),
        }),
        HR,
      );
      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: EmployeeRequestStatus.APPROVED,
          resolution: expect.objectContaining({ attendanceRecordId: 'att-1', previous: expect.objectContaining({ status: 'ABSENT' }) }),
        }),
      );
    });

    it('creates the day when there was no attendance at all', async () => {
      requestModel.findOne.mockResolvedValue(pendingRequest());
      attendanceModel.findOne.mockResolvedValue(null);

      await service.decideRequest(
        TENANT,
        'r1',
        { status: EmployeeRequestStatus.APPROVED, checkInAt: '2026-09-20T04:30:00.000Z' } as any,
        HR,
      );

      expect(attendanceService.create).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ employeeId: EMPLOYEE, date: '2026-09-20', checkInAt: '2026-09-20T04:30:00.000Z' }),
        HR,
        AttendanceSource.MANUAL,
      );
    });

    it('will not approve a correction without the corrected times, and changes nothing', async () => {
      const row = pendingRequest();
      requestModel.findOne.mockResolvedValue(row);

      await expect(
        service.decideRequest(TENANT, 'r1', { status: EmployeeRequestStatus.APPROVED } as any, HR),
      ).rejects.toMatchObject({ message: expect.stringContaining('corrected check-in or check-out') });
      expect(row.update).not.toHaveBeenCalled();
      expect(attendanceService.update).not.toHaveBeenCalled();
    });

    it('refuses a check-out before the check-in', async () => {
      requestModel.findOne.mockResolvedValue(pendingRequest());
      attendanceModel.findOne.mockResolvedValue(null);

      await expect(
        service.decideRequest(
          TENANT,
          'r1',
          {
            status: EmployeeRequestStatus.APPROVED,
            checkInAt: '2026-09-20T13:00:00.000Z',
            checkOutAt: '2026-09-20T04:30:00.000Z',
          } as any,
          HR,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('after check-in') });
    });

    it('approves overtime for the hours HR allows and records them on the day', async () => {
      const row = pendingRequest({ type: EmployeeRequestType.OVERTIME, hours: '3.0' });
      const day = { id: 'att-5', update: jest.fn().mockResolvedValue(undefined) };
      requestModel.findOne.mockResolvedValue(row);
      attendanceModel.findOne.mockResolvedValue(day);

      await service.decideRequest(TENANT, 'r1', { status: EmployeeRequestStatus.APPROVED, hours: 2 } as any, HR);

      expect(day.update).toHaveBeenCalledWith({ overtimeMinutes: 120 });
      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({
          hours: 2,
          resolution: expect.objectContaining({ hours: 2, requested: { hours: 3 } }),
        }),
      );
      expect(notificationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('you asked for 3h') }),
      );
    });

    it('marks the approved work-from-home days as remote', async () => {
      const row = pendingRequest({
        type: EmployeeRequestType.WORK_FROM_HOME,
        fromDate: '2026-09-21',
        toDate: '2026-09-25',
      });
      requestModel.findOne.mockResolvedValue(row);

      await service.decideRequest(
        TENANT,
        'r1',
        { status: EmployeeRequestStatus.APPROVED, toDate: '2026-09-23' } as any,
        HR,
      );

      expect(attendanceModel.update).toHaveBeenCalledWith(
        { workLocation: 'REMOTE' },
        { where: expect.objectContaining({ tenantId: TENANT, employeeId: EMPLOYEE }) },
      );
      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ fromDate: '2026-09-21', toDate: '2026-09-23' }),
      );
    });

    it('refuses to let someone decide their own request', async () => {
      const row = pendingRequest();
      requestModel.findOne.mockResolvedValue(row);
      // The approver's login resolves to the same employee who raised it.
      employeeModel.findOne.mockResolvedValue({ id: EMPLOYEE });

      await expect(
        service.decideRequest(
          TENANT,
          'r1',
          { status: EmployeeRequestStatus.APPROVED, checkInAt: '2026-09-20T04:30:00.000Z' } as any,
          USER,
          'meera@technova.com',
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('your own request') });
      expect(row.update).not.toHaveBeenCalled();
      expect(attendanceService.update).not.toHaveBeenCalled();
    });

    it('rejecting changes no attendance', async () => {
      const row = pendingRequest();
      requestModel.findOne.mockResolvedValue(row);

      await service.decideRequest(TENANT, 'r1', { status: EmployeeRequestStatus.REJECTED, note: 'No' } as any, HR);

      expect(attendanceService.update).not.toHaveBeenCalled();
      expect(attendanceService.create).not.toHaveBeenCalled();
      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: EmployeeRequestStatus.REJECTED, decisionNote: 'No' }),
      );
    });

    it('marks a check-in on an approved work-from-home day as remote', async () => {
      // Here the signed-in person is the employee checking in.
      employeeModel.findOne.mockResolvedValue(employee());
      attendanceModel.findOne.mockResolvedValue(null);
      requestModel.findOne.mockResolvedValue({ id: 'wfh-1', fromDate: '2026-01-01', toDate: '2099-12-31' });

      const result = await service.checkIn(TENANT, USER);

      expect(attendanceModel.update).toHaveBeenCalledWith(
        { workLocation: 'REMOTE' },
        { where: { id: 'att-1', tenantId: TENANT } },
      );
      expect(result.record.workLocation).toBe('REMOTE');
    });

    it("tells today's card about an approved work-from-home before check-in", async () => {
      employeeModel.findOne.mockResolvedValue(employee());
      attendanceModel.findOne.mockResolvedValue(null);
      requestModel.findOne.mockResolvedValue({ id: 'wfh-1', fromDate: '2026-09-28', toDate: '2026-09-30' });

      const today = await service.getAttendanceToday(TENANT, USER);

      expect(today.record).toBeNull();
      expect(today.workFromHome).toEqual({ requestId: 'wfh-1', fromDate: '2026-09-28', toDate: '2026-09-30' });
      expect(requestModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: EmployeeRequestType.WORK_FROM_HOME,
            status: EmployeeRequestStatus.APPROVED,
          }),
        }),
      );

      requestModel.findOne.mockResolvedValue(null);
      expect((await service.getAttendanceToday(TENANT, USER)).workFromHome).toBeNull();
    });
  });

  describe("HR's view of every employee's requests", () => {
    it('lists requests with who raised them, filtered by status and type', async () => {
      requestModel.findAndCountAll = jest.fn().mockResolvedValue({
        count: 1,
        rows: [
          {
            id: 'r1',
            employeeId: EMPLOYEE,
            type: EmployeeRequestType.GENERAL,
            description: 'Salary certificate',
            requestDate: '2026-09-28',
            status: EmployeeRequestStatus.PENDING,
            createdAt: new Date(),
            employee: {
              id: EMPLOYEE,
              employeeCode: 'EMP001',
              firstName: 'Meera',
              lastName: 'Nair',
              avatarUrl: null,
              department: { id: 'd1', name: 'Engineering' },
            },
          },
        ],
      });

      const result = await service.listAllRequests(
        TENANT,
        {
          status: EmployeeRequestStatus.PENDING,
          type: EmployeeRequestType.GENERAL,
          page: 1,
          limit: 10,
        },
        { userId: USER, email: 'meera@technova.com' },
      );

      expect(result.total).toBe(1);
      expect(result.data[0]).toMatchObject({
        id: 'r1',
        canCancel: true,
        // The viewer resolves to the same employee, so it's flagged as theirs.
        isOwnRequest: true,
        employee: { name: 'Meera Nair', department: { name: 'Engineering' } },
      });
      expect(requestModel.findAndCountAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT,
            status: EmployeeRequestStatus.PENDING,
            type: EmployeeRequestType.GENERAL,
          }),
        }),
      );
    });

    it('counts requests by status and pending by type', async () => {
      requestModel.findAll = jest
        .fn()
        .mockResolvedValueOnce([
          { status: EmployeeRequestStatus.PENDING, count: '3' },
          { status: EmployeeRequestStatus.APPROVED, count: '2' },
        ])
        .mockResolvedValueOnce([{ type: EmployeeRequestType.OVERTIME, count: '2' }]);
      requestModel.count.mockResolvedValue(4);

      const stats = await service.getRequestStats(TENANT);

      expect(stats).toMatchObject({ pending: 3, approved: 2, rejected: 0, total: 5, thisMonth: 4 });
      expect(stats.pendingByType.find((row) => row.type === EmployeeRequestType.OVERTIME)?.count).toBe(2);
    });
  });

  describe('request fields each type needs', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    it.each([
      [{ type: EmployeeRequestType.ATTENDANCE_CORRECTION }, 'date to correct'],
      [{ type: EmployeeRequestType.ATTENDANCE_CORRECTION, date: tomorrow }, 'today or earlier'],
      [{ type: EmployeeRequestType.WORK_FROM_HOME, fromDate: '2026-08-21' }, 'start and end date'],
      [{ type: EmployeeRequestType.OVERTIME, hours: 2 }, 'date the hours were worked'],
      [{ type: EmployeeRequestType.OVERTIME, date: '2026-08-21' }, 'number of hours'],
    ])('rejects %o', async (fields, message) => {
      await expect(
        service.createRequest(TENANT, USER, { description: 'x', ...fields } as any),
      ).rejects.toMatchObject({ message: expect.stringContaining(message) });
      expect(requestModel.create).not.toHaveBeenCalled();
    });

    it('accepts overtime with a date and hours', async () => {
      requestModel.create.mockResolvedValue({
        id: 'r2',
        type: EmployeeRequestType.OVERTIME,
        description: 'Covering a shift',
        requestDate: '2026-08-21',
        hours: 3,
        status: EmployeeRequestStatus.PENDING,
        createdAt: new Date(),
      });

      await expect(
        service.createRequest(TENANT, USER, {
          type: EmployeeRequestType.OVERTIME,
          description: 'Covering a shift',
          date: '2026-08-21',
          hours: 3,
        } as any),
      ).resolves.toMatchObject({ id: 'r2', hours: 3 });
    });
  });

  /**
   * The row is already committed by the time the inbox is written, so a
   * notification failure must not fail the action that caused it.
   */
  it('still returns the request when the notification cannot be stored', async () => {
    requestModel.create.mockResolvedValue({
      id: 'r9',
      type: EmployeeRequestType.GENERAL,
      description: 'NOC',
      requestDate: '2026-08-21',
      status: EmployeeRequestStatus.PENDING,
      createdAt: new Date(),
    });
    notificationModel.create.mockRejectedValue(new Error('relation does not exist'));

    await expect(
      service.createRequest(TENANT, USER, {
        type: EmployeeRequestType.GENERAL,
        description: 'NOC',
      } as any),
    ).resolves.toMatchObject({ id: 'r9' });
  });

  it('refuses to cancel a request that is no longer pending', async () => {
    requestModel.findOne.mockResolvedValue({
      id: 'r1',
      status: EmployeeRequestStatus.APPROVED,
      update: jest.fn(),
    });

    await expect(service.cancelRequest(TENANT, USER, 'r1')).rejects.toMatchObject({
      message: expect.stringContaining('pending'),
    });
  });

  it('assembles the dashboard from the other tabs', async () => {
    const dashboard = await service.getDashboard(TENANT, USER);
    expect(dashboard.profile.name).toBe('Meera Nair');
    expect(dashboard.attendanceToday.record).toBeNull();
    expect(dashboard.requests.pending).toBe(0);
    expect(dashboard.notifications.recent).toEqual([]);
  });

  describe('My Leave', () => {
    // Fri 25 Sep – Mon 28 Sep 2026: four calendar days, two of them the weekend.
    const FRI = '2026-09-25';
    const MON = '2026-09-28';

    const created = {
      id: 'l9',
      fromDate: FRI,
      toDate: MON,
      leaveType: { id: 'p1', name: 'Sick Leave' },
    };

    beforeEach(() => {
      leaveRequests.create.mockResolvedValue(created);
    });

    it('deducts working days only, not the weekend in between', async () => {
      await service.applyLeave(TENANT, USER, {
        leavePolicyId: 'p1',
        fromDate: FRI,
        toDate: MON,
      } as any);

      expect(leaveRequests.create).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ totalDays: 2, fromDate: FRI, toDate: MON }),
        USER,
      );
    });

    it('previews the cost and balance without saving anything', async () => {
      leaveModel.findAll.mockResolvedValue([
        { status: LeaveRequestStatus.APPROVED, totalDays: '4' },
        { status: LeaveRequestStatus.PENDING, totalDays: '1.5' },
      ]);

      const preview = await service.previewLeave(TENANT, USER, {
        leavePolicyId: 'p1',
        fromDate: FRI,
        toDate: MON,
      } as any);

      expect(preview).toMatchObject({
        calendarDays: 4,
        workingDays: 2,
        nonWorkingDates: ['2026-09-26', '2026-09-27'],
        totalDays: 2,
        durationLabel: '2 days',
        balance: {
          fiscalYear: 'FY 2026-27',
          allocation: 12,
          used: 4,
          pending: 1.5,
          available: 6.5,
          remainingAfter: 4.5,
          enforced: true,
        },
        overlap: null,
        canApply: true,
        issues: [],
      });
      expect(leaveRequests.create).not.toHaveBeenCalled();
    });

    it('refuses paid leave beyond the available balance', async () => {
      leaveModel.findAll.mockResolvedValue([
        { status: LeaveRequestStatus.APPROVED, totalDays: '11' },
      ]);

      await expect(
        service.applyLeave(TENANT, USER, {
          leavePolicyId: 'p1',
          fromDate: FRI,
          toDate: MON,
        } as any),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        message: expect.stringContaining('Only 1 day of Sick Leave available'),
      });
      expect(leaveRequests.create).not.toHaveBeenCalled();
    });

    it('never blocks unpaid leave on balance', async () => {
      policyModel.findOne.mockResolvedValue({
        id: 'p2',
        name: 'Unpaid Leave',
        annualAllocation: 0,
        isPaid: false,
        isActive: true,
      });

      const preview = await service.previewLeave(TENANT, USER, {
        leavePolicyId: 'p2',
        fromDate: FRI,
        toDate: MON,
      } as any);

      expect(preview).toMatchObject({
        canApply: true,
        balance: { enforced: false, remainingAfter: null },
      });
    });

    it('books a half day as 0.5 and only on a single date', async () => {
      await service.applyLeave(TENANT, USER, {
        leavePolicyId: 'p1',
        fromDate: FRI,
        toDate: FRI,
        halfDay: true,
      } as any);
      expect(leaveRequests.create).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ totalDays: 0.5 }),
        USER,
      );

      await expect(
        service.previewLeave(TENANT, USER, {
          leavePolicyId: 'p1',
          fromDate: FRI,
          toDate: MON,
          halfDay: true,
        } as any),
      ).rejects.toMatchObject({ message: expect.stringContaining('same date') });
    });

    it('rejects a request that falls entirely on the weekend', async () => {
      await expect(
        service.applyLeave(TENANT, USER, {
          leavePolicyId: 'p1',
          fromDate: '2026-09-26',
          toDate: '2026-09-27',
        } as any),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        message: expect.stringContaining('non-working days'),
      });
    });

    it('answers an overlap with 409', async () => {
      leaveModel.findOne.mockResolvedValue({
        id: 'l1',
        fromDate: MON,
        toDate: '2026-09-29',
        status: LeaveRequestStatus.APPROVED,
      });

      await expect(
        service.applyLeave(TENANT, USER, {
          leavePolicyId: 'p1',
          fromDate: FRI,
          toDate: MON,
        } as any),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(leaveRequests.create).not.toHaveBeenCalled();
    });

    it('refuses an inactive leave type', async () => {
      policyModel.findOne.mockResolvedValue({ id: 'p1', name: 'Old', isActive: false });
      await expect(
        service.previewLeave(TENANT, USER, {
          leavePolicyId: 'p1',
          fromDate: FRI,
          toDate: MON,
        } as any),
      ).rejects.toMatchObject({ message: expect.stringContaining('no longer available') });
    });

    it('edits a pending request without counting it against itself', async () => {
      const pendingRow = {
        id: 'l5',
        leavePolicyId: 'p1',
        fromDate: FRI,
        toDate: FRI,
        totalDays: '1',
        status: LeaveRequestStatus.PENDING,
      };
      // updateLeave's lookup, planLeave's overlap check, then getLeave.
      leaveModel.findOne
        .mockResolvedValueOnce(pendingRow)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...pendingRow, toDate: MON, totalDays: '2' });

      const result = await service.updateLeave(TENANT, USER, 'l5', { toDate: MON });

      expect(leaveRequests.update).toHaveBeenCalledWith(
        TENANT,
        'l5',
        expect.objectContaining({ fromDate: FRI, toDate: MON, totalDays: 2 }),
      );
      const balanceQuery = leaveModel.findAll.mock.calls[0][0];
      expect(balanceQuery.where.id).toBeDefined();
      expect(result).toMatchObject({ id: 'l5', duration: 2, canEdit: true });
    });

    it('refuses to edit a decided request', async () => {
      leaveModel.findOne.mockResolvedValue({ id: 'l5', status: LeaveRequestStatus.APPROVED });
      await expect(
        service.updateLeave(TENANT, USER, 'l5', { reason: 'x' }),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(leaveRequests.update).not.toHaveBeenCalled();
    });

    it('shows one request only to its owner, with the decision note', async () => {
      leaveModel.findOne.mockResolvedValue({
        id: 'l1',
        leavePolicyId: 'p1',
        leavePolicy: { id: 'p1', name: 'Sick Leave', isPaid: true },
        fromDate: FRI,
        toDate: FRI,
        totalDays: '0.5',
        status: LeaveRequestStatus.REJECTED,
        decisionNote: 'Team offsite',
      });

      const leave = await service.getLeave(TENANT, USER, 'l1');

      expect(leave).toMatchObject({
        halfDay: true,
        durationLabel: 'Half day',
        decisionNote: 'Team offsite',
        canCancel: false,
        canEdit: false,
      });
      expect(leaveModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ employeeId: EMPLOYEE }),
        }),
      );
    });

    it('reports available days and totals for a chosen fiscal year', async () => {
      policyModel.findAll.mockResolvedValue([
        { id: 'p1', name: 'Annual Leave', annualAllocation: 21, isPaid: true, isActive: true },
        { id: 'p2', name: 'Sick Leave', annualAllocation: 12, isPaid: true, isActive: true },
      ]);
      leaveModel.findAll
        .mockResolvedValueOnce([
          { leavePolicyId: 'p1', status: LeaveRequestStatus.APPROVED, totalDays: '5' },
          { leavePolicyId: 'p1', status: LeaveRequestStatus.PENDING, totalDays: '2' },
        ])
        .mockResolvedValueOnce([]);

      const summary = await service.getLeaveSummary(TENANT, USER, { fiscalYear: 2025 });

      expect(summary).toMatchObject({
        fiscalYear: 'FY 2025-26',
        fiscalYearStart: '2025-04-01',
        fiscalYearEnd: '2026-03-31',
        totals: { allocation: 33, used: 5, pending: 2, remaining: 28, available: 26 },
        upcoming: [],
      });
      expect(summary.balances[0]).toMatchObject({ remaining: 16, available: 14 });
    });

    it('filters history by status and fiscal year', async () => {
      await service.getLeaveHistory(TENANT, USER, {
        status: LeaveRequestStatus.APPROVED as any,
        fiscalYear: 2026,
        page: 2,
        limit: 5,
      });

      const args = leaveModel.findAndCountAll.mock.calls[0][0];
      expect(args.where).toMatchObject({
        employeeId: EMPLOYEE,
        status: LeaveRequestStatus.APPROVED,
      });
      expect(args.where.fromDate[Op.between]).toEqual(['2026-04-01', '2027-03-31']);
      expect(args).toMatchObject({ offset: 5, limit: 5 });
    });
  });

  describe('My Documents', () => {
    const docRow = (over: Record<string, any> = {}) => {
      const row: any = {
        id: 'doc1',
        employeeId: EMPLOYEE,
        title: 'Passport',
        category: EmployeeDocumentCategory.IDENTITY,
        fileId: 'file-1',
        fileName: 'passport.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        status: EmployeeDocumentStatus.PENDING,
        reviewNote: null,
        reviewedAt: null,
        reviewedByUserId: null,
        expiryDate: null,
        createdAt: new Date('2026-09-01'),
        ...over,
      };
      row.update = jest.fn(async (patch: Record<string, any>) => Object.assign(row, patch));
      row.destroy = jest.fn().mockResolvedValue(undefined);
      return row;
    };

    const upload = {
      title: ' Passport ',
      category: EmployeeDocumentCategory.IDENTITY,
      fileId: 'file-1',
      fileName: 'passport.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      expiryDate: '2030-01-31',
    };

    it('records an upload as pending with its expiry date', async () => {
      documentModel.findOne.mockResolvedValue(null);
      documentModel.create.mockImplementation(async (values: any) => docRow(values));

      const document = await service.uploadDocument(TENANT, USER, upload as any);

      expect(documentModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: EMPLOYEE,
          title: 'Passport',
          status: EmployeeDocumentStatus.PENDING,
          expiryDate: '2030-01-31',
        }),
      );
      expect(document).toMatchObject({ expiryDate: '2030-01-31', isExpired: false, canEdit: true });
    });

    it('refuses a file that is already attached to another document', async () => {
      documentModel.findOne.mockResolvedValue({ id: 'other' });
      await expect(service.uploadDocument(TENANT, USER, upload as any)).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
      expect(documentModel.create).not.toHaveBeenCalled();
    });

    it('locks a verified document against edits and deletion', async () => {
      documentModel.findOne.mockResolvedValue(docRow({ status: EmployeeDocumentStatus.VERIFIED }));

      await expect(
        service.updateDocument(TENANT, USER, 'doc1', { title: 'New' }),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      await expect(service.deleteDocument(TENANT, USER, 'doc1')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('sends an edited rejected document back to pending and clears the review', async () => {
      const row = docRow({
        status: EmployeeDocumentStatus.REJECTED,
        reviewNote: 'Blurry scan',
        reviewedAt: new Date(),
        reviewedByUserId: OTHER,
      });
      documentModel.findOne
        .mockResolvedValueOnce(row) // the document being edited
        .mockResolvedValueOnce(null); // no other document uses the new file

      const result = await service.updateDocument(TENANT, USER, 'doc1', {
        fileId: 'file-2',
        fileName: 'passport-clear.pdf',
        sizeBytes: 2048,
      });

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'file-2',
          status: EmployeeDocumentStatus.PENDING,
          reviewNote: null,
          reviewedByUserId: null,
        }),
      );
      expect(result).toMatchObject({ replacedFileId: 'file-1', status: EmployeeDocumentStatus.PENDING });
    });

    it('deletes an unverified document and hands back its file id', async () => {
      const row = docRow();
      documentModel.findOne.mockResolvedValue(row);

      const result = await service.deleteDocument(TENANT, USER, 'doc1');

      expect(row.destroy).toHaveBeenCalled();
      expect(result).toMatchObject({ fileId: 'file-1' });
    });

    it('records who rejected a document and why, and tells the employee', async () => {
      const row = docRow();
      documentModel.findOne.mockResolvedValue(row);
      // The reviewer is HR, not the employee who uploaded it.
      employeeModel.findOne.mockResolvedValue(null);

      await service.reviewDocument(
        TENANT,
        'doc1',
        { status: EmployeeDocumentStatus.REJECTED, note: 'Expired passport' },
        { userId: OTHER },
      );

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: EmployeeDocumentStatus.REJECTED,
          reviewNote: 'Expired passport',
          reviewedByUserId: OTHER,
        }),
      );
      expect(notificationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Document Rejected',
          body: expect.stringContaining('Expired passport'),
        }),
      );
    });

    it('flags an expired document', async () => {
      documentModel.findOne.mockResolvedValue(docRow({ expiryDate: '2020-01-01' }));
      const document = await service.getDocument(TENANT, USER, 'doc1');
      expect(document.isExpired).toBe(true);
      expect(document.expiresInDays).toBeLessThan(0);
    });

    it('lists every employee’s documents for HR with status counts', async () => {
      documentModel.findAndCountAll = jest.fn().mockResolvedValue({
        count: 1,
        rows: [
          docRow({
            employee: {
              id: EMPLOYEE,
              employeeCode: 'EMP001',
              firstName: 'Meera',
              lastName: 'Nair',
              department: { id: 'd1', name: 'Engineering' },
            },
          }),
        ],
      });
      documentModel.findAll.mockResolvedValue([
        { status: EmployeeDocumentStatus.PENDING, count: '5' },
        { status: EmployeeDocumentStatus.VERIFIED, count: '9' },
      ]);

      const result = await service.listAllDocuments(TENANT, {
        status: EmployeeDocumentStatus.PENDING,
        expiringWithinDays: 30,
        search: "o'brien",
      });

      const args = documentModel.findAndCountAll.mock.calls[0][0];
      expect(args.where.status).toBe(EmployeeDocumentStatus.PENDING);
      expect(args.where.expiryDate[Op.lte]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The search is a bound iLike value, never spliced into SQL.
      expect(args.where[Op.or][0].title[Op.iLike]).toBe("%o'brien%");
      expect(result).toMatchObject({
        total: 1,
        counts: { byStatus: { PENDING: 5, VERIFIED: 9, REJECTED: 0 } },
        data: [{ employee: { name: 'Meera Nair', department: { name: 'Engineering' } } }],
      });
    });
  });
});
