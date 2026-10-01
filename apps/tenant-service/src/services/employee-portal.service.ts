import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, col, fn, literal } from 'sequelize';
import {
  ApplyMyLeaveDto,
  AttendanceSource,
  AttendanceStatus,
  CreateMyRequestDto,
  DecideEmployeeRequestDto,
  EMPLOYEE_PROFILE_FIELDS,
  EmployeeDocumentCategory,
  EmployeeDocumentCategoryFilter,
  EmployeeDocumentStatus,
  EmployeeNotificationKind,
  EmployeeRequestStatus,
  EmployeeRequestType,
  GetEmployeeDocumentsQueryDto,
  GetEmployeeRequestsQueryDto,
  GetMyAttendanceQueryDto,
  GetMyDocumentsQueryDto,
  GetMyLeaveHistoryQueryDto,
  GetMyLeaveSummaryQueryDto,
  GetMyNotificationsQueryDto,
  LeaveRequestStatus,
  LeaveRequestStatusFilter,
  UpdateMyDocumentDto,
  UpdateMyLeaveDto,
  ReviewEmployeeDocumentDto,
  SELF_EDITABLE_PROFILE_FIELDS,
  TenantErrorCode,
  TenantException,
  UpdateMyProfileDto,
  UploadMyDocumentDto,
} from '@app/common';
import { LeaveRequestService } from './leave-request.service';
import { AttendanceService } from './attendance.service';
import { DataScopeService } from './data-scope.service';
import { AttendanceRules, ipAllowed, isWorkingDay, normalizeIp } from './attendance-rules';
import { TenantModelProviderService } from './tenant-model-provider.service';

const REQUEST_CARDS: { type: EmployeeRequestType; title: string; description: string }[] = [
  {
    type: EmployeeRequestType.ATTENDANCE_CORRECTION,
    title: 'Attendance Correction',
    description: 'Correct a missed or incorrect check-in/out',
  },
  {
    type: EmployeeRequestType.WORK_FROM_HOME,
    title: 'Work From Home',
    description: 'Request remote work for specific days',
  },
  {
    type: EmployeeRequestType.OVERTIME,
    title: 'Overtime',
    description: 'Log additional hours worked outside schedule',
  },
  {
    type: EmployeeRequestType.GENERAL,
    title: 'General HR Request',
    description: 'Salary certificate, NOC, or other requests',
  },
];

const DOCUMENT_TABS = [
  EmployeeDocumentCategoryFilter.ALL,
  EmployeeDocumentCategoryFilter.EMPLOYMENT,
  EmployeeDocumentCategoryFilter.IDENTITY,
  EmployeeDocumentCategoryFilter.PAYROLL,
  EmployeeDocumentCategoryFilter.QUALIFICATION,
];

function timeAgo(date: Date): string {
  const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** The April–March fiscal year that begins in `startYear`. */
function fiscalYearStarting(startYear: number) {
  return {
    label: `FY ${startYear}-${String(startYear + 1).slice(2)}`,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

function fiscalYear(now = new Date()) {
  return fiscalYearStarting(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
}

/** The fiscal year a 'YYYY-MM-DD' date falls in — what a leave request draws on. */
function fiscalYearContaining(iso: string) {
  const [year, month] = iso.slice(0, 10).split('-').map(Number);
  return fiscalYearStarting(month >= 4 ? year : year - 1);
}

/** Leave days are kept to one decimal place so a half day reads as 0.5. */
function roundDays(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A single leave request longer than this is almost certainly a typo. */
const MAX_LEAVE_SPAN_DAYS = 366;

const WEEKDAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/** 'MONDAY' etc. — the names WorkingHours.workingDays stores. */
function weekdayName(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function monthBounds(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

function formatDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function periodLabel(fromDate: string, toDate: string): string {
  if (fromDate === toDate) return formatDay(fromDate);
  return `${formatDay(fromDate)} – ${formatDay(toDate)}`;
}

/**
 * "Mon Aug 19" — the Date column on the attendance table. Built from the
 * parts rather than one toLocaleDateString call, which renders this
 * combination as "Mon, Aug 19"; the comma is not what the column shows.
 */
function weekdayLabel(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${weekday} ${formatDay(iso)}`;
}

/**
 * "8h 52m". Same shape AttendanceService gives the admin table, so the two
 * attendance screens cannot disagree about how a day's hours read.
 */
function workHoursLabel(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  const total = Number(minutes);
  if (!Number.isFinite(total)) return null;
  return `${Math.floor(total / 60)}h ${String(Math.round(total % 60)).padStart(2, '0')}m`;
}

/** Every calendar day from `from` to `to`, inclusive. */
function eachDate(from: string, to: string): string[] {
  const days: string[] = [];
  const [fy, fm, fd] = from.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = to.slice(0, 10).split('-').map(Number);
  let cursor = Date.UTC(fy, fm - 1, fd);
  const last = Date.UTC(ty, tm - 1, td);
  // A malformed range would otherwise spin; an empty list is the honest answer.
  while (cursor <= last && days.length < 400) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86400000;
  }
  return days;
}

const STATUS_LABELS: Record<string, string> = {
  [AttendanceStatus.PRESENT]: 'Present',
  [AttendanceStatus.LATE]: 'Late',
  [AttendanceStatus.ABSENT]: 'Absent',
  [AttendanceStatus.ON_LEAVE]: 'On Leave',
  [AttendanceStatus.HALF_DAY]: 'Half Day',
  [AttendanceStatus.HOLIDAY]: 'Holiday',
};

function durationLabel(days: number): string {
  const value = Number(days);
  if (value === 0.5) return 'Half day';
  return `${value} day${value === 1 ? '' : 's'}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000);
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  const text = mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
  return `${text} MB`;
}

function requestTitle(type: EmployeeRequestType): string {
  return REQUEST_CARDS.find((card) => card.type === type)?.title ?? type;
}

@Injectable()
export class EmployeePortalService {
  private readonly logger = new Logger(EmployeePortalService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly leaveRequestService: LeaveRequestService,
    private readonly attendanceService: AttendanceService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  /**
   * HR-side lists (Employee Requests, Employee Documents) narrowed to the
   * caller's team or department when their role is scoped; `{}` otherwise.
   * Self-service reads are already limited to the caller's own record.
   */
  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId) : {};
  }

  private notFound(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.NOT_FOUND,
    );
  }

  private badRequest(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }

  private conflict(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.CONFLICT,
    );
  }

  private async employeeInclude(tenantId: string) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    return [
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
      {
        model: Employee,
        as: 'reportingManager',
        attributes: ['id', 'firstName', 'lastName'],
        required: false,
      },
    ];
  }

  /** The employee row for this login: user id first, then the same email. */
  private async me(tenantId: string, userId: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const include = await this.employeeInclude(tenantId);
    let employee = await Employee.findOne({ where: { tenantId, userId }, include });
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({
        where: { tenantId, email: { [Op.iLike]: email.trim() } },
        include,
      });
    }
    if (!employee) {
      this.notFound('No employee profile is linked to this login.');
    }
    return employee;
  }

  private profileOf(employee: any) {
    const manager = employee.reportingManager;
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      firstName: employee.firstName,
      lastName: employee.lastName,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
      email: employee.email,
      phone: employee.phone ?? null,
      avatarUrl: employee.avatarUrl ?? null,
      status: employee.status,
      joiningDate: employee.joiningDate ?? null,
      department: employee.department
        ? { id: employee.department.id, name: employee.department.name }
        : null,
      designation: employee.designation
        ? { id: employee.designation.id, title: employee.designation.title }
        : null,
      reportingManager: manager
        ? {
            id: manager.id,
            name: [manager.firstName, manager.lastName].filter(Boolean).join(' '),
          }
        : null,
      profile: Object.fromEntries(
        EMPLOYEE_PROFILE_FIELDS.filter((field) => field !== 'salutation').map((field) => [
          field,
          employee[field] ?? null,
        ]),
      ),
    };
  }

  /**
   * Inbox row for the Notifications tab. Best effort on purpose: by the time
   * we get here the leave, request or document write is already committed, so
   * a notification that cannot be stored — an older tenant schema, say — must
   * not turn a successful action into a 500.
   */
  async notify(
    tenantId: string,
    employeeId: string,
    input: { kind: EmployeeNotificationKind; title: string; body: string },
  ) {
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      return await Notification.create({
        tenantId,
        employeeId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        readAt: null,
      });
    } catch (error: any) {
      this.logger.warn(
        `Action saved but the employee notification was not: ${error?.message ?? error}`,
      );
      return null;
    }
  }

  /**
   * The organization's default working hours, as the attendance screens show
   * them ("of 9:00 target"). Picked the same way AttendanceService picks the
   * shift it judges lateness against, so the two can't disagree. The target
   * is the full scheduled span — worked minutes are measured check-in to
   * check-out, break included, so that is what they compare against. Null
   * when working hours haven't been configured.
   */
  private async scheduleOf(tenantId: string) {
    const WorkingHours = await this.modelProvider.getWorkingHoursModel(tenantId);
    const shift = await WorkingHours.findOne({
      where: { tenantId },
      order: [['isDefault', 'DESC']],
    });
    if (!shift?.startTime || !shift?.endTime) return null;

    const toMinutes = (value: string) => {
      const [hours, minutes] = String(value).split(':').map(Number);
      return hours * 60 + (minutes || 0);
    };
    const span = toMinutes(shift.endTime) - toMinutes(shift.startTime);
    const targetMinutes = span > 0 ? span : span + 24 * 60;

    return {
      name: shift.name,
      startTime: String(shift.startTime).slice(0, 5),
      endTime: String(shift.endTime).slice(0, 5),
      breakMinutes: shift.breakDurationMinutes ?? 0,
      workingDays: shift.workingDays ?? [],
      targetMinutes,
      targetHoursLabel: workHoursLabel(targetMinutes),
    };
  }

  async getProfile(tenantId: string, userId: string, email?: string) {
    return this.profileOf(await this.me(tenantId, userId, email));
  }

  async updateProfile(tenantId: string, userId: string, dto: UpdateMyProfileDto, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const patch: any = {};
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.avatarUrl !== undefined) patch.avatarUrl = dto.avatarUrl;
    for (const field of ['firstName', 'lastName'] as const) {
      const value = dto[field]?.trim();
      if (value) patch[field] = value;
    }
    // Blank clears a detail, the same way HR's edit form does.
    for (const field of SELF_EDITABLE_PROFILE_FIELDS) {
      if (dto[field] === undefined) continue;
      const value = dto[field] === null ? '' : String(dto[field]).trim();
      patch[field] = value === '' ? null : value;
    }
    if (patch.dateOfBirth) {
      const joining = employee.joiningDate ? String(employee.joiningDate).slice(0, 10) : null;
      if (patch.dateOfBirth >= new Date().toISOString().slice(0, 10)) {
        this.badRequest('Date of birth must be in the past.');
      }
      if (joining && patch.dateOfBirth >= joining) {
        this.badRequest('Date of birth must be before your joining date.');
      }
    }
    if (Object.keys(patch).length) await employee.update(patch);
    return this.getProfile(tenantId, userId, email);
  }

  async getAttendance(tenantId: string, userId: string, query: GetMyAttendanceQueryDto = {}, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const now = new Date();
    const month =
      query.month ??
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const { start, end } = monthBounds(month);
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const rows = await Attendance.findAll({
      where: { tenantId, employeeId: employee.id, date: { [Op.between]: [start, end] } },
      order: [['date', 'ASC']],
    });

    const summary = {
      present: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
      halfDay: 0,
      holiday: 0,
    };
    for (const row of rows) {
      if (row.status === AttendanceStatus.PRESENT) summary.present++;
      else if (row.status === AttendanceStatus.LATE) summary.late++;
      else if (row.status === AttendanceStatus.ABSENT) summary.absent++;
      else if (row.status === AttendanceStatus.ON_LEAVE) summary.onLeave++;
      else if (row.status === AttendanceStatus.HALF_DAY) summary.halfDay++;
      else if (row.status === AttendanceStatus.HOLIDAY) summary.holiday++;
    }

    // Averaged over the days actually worked, not the length of the month:
    // dividing by days off would drag "Avg Hours/Day" down every month and
    // read as underwork rather than as time off.
    const workedDays = (rows as any[]).filter(
      (row) => row.workedMinutes !== null && row.workedMinutes !== undefined,
    );
    const totalMinutes = workedDays.reduce((sum, row) => sum + Number(row.workedMinutes), 0);
    const avgMinutes = workedDays.length ? Math.round(totalMinutes / workedDays.length) : 0;

    const leaveByDate = await this.leaveTypeByDate(tenantId, employee.id, start, end);

    return {
      month,
      from: start,
      to: end,
      schedule: await this.scheduleOf(tenantId),
      summary: {
        ...summary,
        daysWorked: workedDays.length,
        totalMinutes,
        totalHoursLabel: workHoursLabel(totalMinutes) ?? '0h 00m',
        avgMinutesPerDay: avgMinutes,
        avgHoursLabel: workHoursLabel(avgMinutes) ?? '0h 00m',
      },
      days: (rows as any[]).map((row) => {
        const date = String(row.date).slice(0, 10);
        // An ON_LEAVE day reads as the leave that caused it — "Sick Leave",
        // not the generic status the record carries.
        const leaveType =
          row.status === AttendanceStatus.ON_LEAVE ? (leaveByDate.get(date) ?? null) : null;
        return {
          id: row.id,
          date,
          dayLabel: weekdayLabel(date),
          status: row.status,
          statusLabel: leaveType ?? STATUS_LABELS[row.status] ?? row.status,
          leaveType,
          checkInAt: row.checkInAt ?? null,
          checkOutAt: row.checkOutAt ?? null,
          workedMinutes: row.workedMinutes ?? null,
          workHours: workHoursLabel(row.workedMinutes),
          notes: row.notes ?? null,
          dayEndStatus: row.dayEndStatus ?? null,
          workLocation: row.workLocation ?? null,
          overtimeMinutes: row.overtimeMinutes ?? null,
        };
      }),
    };
  }

  /**
   * Maps each day of an approved leave to its type, so the attendance table
   * can name the reason a day was missed.
   */
  private async leaveTypeByDate(
    tenantId: string,
    employeeId: string,
    from: string,
    to: string,
  ): Promise<Map<string, string>> {
    const byDate = new Map<string, string>();
    try {
      const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
      const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
      const leaves = await Leave.findAll({
        where: {
          tenantId,
          employeeId,
          status: LeaveRequestStatus.APPROVED,
          fromDate: { [Op.lte]: to },
          toDate: { [Op.gte]: from },
        },
        include: [
          { model: Policy, as: 'leavePolicy', attributes: ['id', 'name'], required: false },
        ],
      });

      for (const leave of leaves as any[]) {
        const name = leave.leavePolicy?.name;
        if (!name) continue;
        for (const date of eachDate(
          String(leave.fromDate).slice(0, 10),
          String(leave.toDate).slice(0, 10),
        )) {
          if (date >= from && date <= to) byDate.set(date, name);
        }
      }
    } catch (error: any) {
      // A label, not the data. The table still renders with "On Leave".
      this.logger.warn(`Could not resolve leave types for the attendance tab: ${error?.message ?? error}`);
    }
    return byDate;
  }

  async getAttendanceToday(tenantId: string, userId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const today = new Date().toISOString().slice(0, 10);
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const row = await Attendance.findOne({
      where: { tenantId, employeeId: employee.id, date: today },
    });
    const remote = await this.remoteRequestFor(tenantId, employee.id, today);
    return {
      date: today,
      dayLabel: weekdayLabel(today),
      schedule: await this.scheduleOf(tenantId),
      // An approved work-from-home covering today — known before check-in, so
      // the dashboard can say "remote today" from the start of the day.
      workFromHome: remote,
      record: row
        ? {
            id: row.id,
            status: row.status,
            statusLabel: STATUS_LABELS[row.status] ?? row.status,
            checkInAt: row.checkInAt ?? null,
            checkOutAt: row.checkOutAt ?? null,
            workedMinutes: row.workedMinutes ?? null,
            workHours: workHoursLabel(row.workedMinutes),
            workLocation: row.workLocation ?? null,
            overtimeMinutes: row.overtimeMinutes ?? null,
            dayEndStatus: row.dayEndStatus ?? null,
          }
        : null,
    };
  }

  /**
   * Punch in for today.
   *
   * The Present/Late decision and the worked-minutes arithmetic stay with
   * AttendanceService: they depend on the organization's working hours and
   * grace period, and a second copy here would let the portal and the HR
   * screen disagree about whether the same check-in was late.
   */
  async checkIn(tenantId: string, userId: string, email?: string, clientIp?: string) {
    const employee = await this.me(tenantId, userId, email);
    const today = new Date().toISOString().slice(0, 10);
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);

    const existing = await Attendance.findOne({
      where: { tenantId, employeeId: employee.id, date: today },
    });

    if (existing?.checkInAt) {
      this.conflict('You have already checked in today.');
    }

    const rules = await this.attendanceService.getRules(tenantId);
    const remote =
      (existing as any)?.workLocation === 'REMOTE' ||
      (await this.isRemoteDay(tenantId, employee.id, today));
    this.assertPunchAllowed(rules, clientIp, remote);

    const weekend = !isWorkingDay(today, rules);
    if (weekend && rules.weekendWorkPolicy === 'NOT_ALLOWED') {
      this.badRequest("Today isn't a working day, and your organization doesn't allow weekend work.");
    }

    const now = new Date();
    const weekendNote =
      weekend && rules.weekendWorkPolicy === 'COMP_OFF' ? 'Weekend work · comp-off eligible' : null;
    const record = existing
      ? // HR may have already marked the day (ABSENT, say). Punching in
        // updates that row rather than colliding with it.
        await this.attendanceService.update(
          tenantId,
          existing.id,
          {
            checkInAt: now.toISOString(),
            ...(weekendNote
              ? { notes: existing.notes ? `${existing.notes} · ${weekendNote}`.slice(0, 500) : weekendNote }
              : {}),
          } as any,
          userId,
        )
      : await this.attendanceService.create(
          tenantId,
          {
            employeeId: employee.id,
            date: today,
            checkInAt: now.toISOString(),
            ...(weekendNote ? { notes: weekendNote } : {}),
          } as any,
          userId,
          AttendanceSource.SELF_SERVICE,
        );

    let workLocation: string | null = (existing as any)?.workLocation ?? null;
    if (!workLocation && remote) {
      try {
        await Attendance.update({ workLocation: 'REMOTE' }, { where: { id: record.id, tenantId } });
        workLocation = 'REMOTE';
      } catch (error: any) {
        this.logger.warn(`Checked in, but the day could not be marked remote: ${error?.message ?? error}`);
      }
    }

    return this.punchResult(today, { ...record, workLocation });
  }

  /** Punch out. Worked minutes are recomputed by AttendanceService. */
  async checkOut(tenantId: string, userId: string, email?: string, clientIp?: string, dayEndStatus?: string) {
    const employee = await this.me(tenantId, userId, email);
    const today = new Date().toISOString().slice(0, 10);
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);

    const existing = await Attendance.findOne({
      where: { tenantId, employeeId: employee.id, date: today },
    });

    if (!existing?.checkInAt) {
      this.badRequest('You need to check in before checking out.');
    }
    if (existing.checkOutAt) {
      this.conflict('You have already checked out today.');
    }

    const rules = await this.attendanceService.getRules(tenantId);
    this.assertPunchAllowed(rules, clientIp, (existing as any).workLocation === 'REMOTE');

    const record = await this.attendanceService.update(
      tenantId,
      existing.id,
      { checkOutAt: new Date().toISOString() } as any,
      userId,
    );

    // The day-end report is the employee's own words, kept as written.
    const status = dayEndStatus?.trim() || null;
    if (status) {
      await Attendance.update({ dayEndStatus: status }, { where: { id: existing.id, tenantId } });
    }

    return this.punchResult(today, { ...record, dayEndStatus: status ?? (existing as any).dayEndStatus ?? null });
  }

  /**
   * IP restriction: punches must come from one of the organization's allowed
   * networks. An approved work-from-home day is exempt — that's the point of
   * approving it.
   */
  private assertPunchAllowed(rules: AttendanceRules, clientIp: string | undefined, remote: boolean) {
    if (!rules.ipRestrictionEnabled || rules.allowedIpRanges.length === 0 || remote) return;
    if (!ipAllowed(clientIp, rules.allowedIpRanges)) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Attendance can only be marked from the office network${clientIp ? ` (your IP is ${normalizeIp(clientIp)})` : ''}.`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private punchResult(date: string, record: any) {
    return {
      date,
      dayLabel: weekdayLabel(date),
      record: {
        id: record.id,
        status: record.status,
        statusLabel: STATUS_LABELS[record.status] ?? record.status,
        checkInAt: record.checkInAt ?? null,
        checkOutAt: record.checkOutAt ?? null,
        workedMinutes: record.workedMinutes ?? null,
        workHours: workHoursLabel(record.workedMinutes),
        workLocation: record.workLocation ?? null,
        overtimeMinutes: record.overtimeMinutes ?? null,
        dayEndStatus: record.dayEndStatus ?? null,
      },
    };
  }

  /**
   * My Leave cards for one fiscal year (April–March). `remaining` is the
   * allocation less approved days; `available` also holds back pending
   * requests, so it is what a new application can still draw on.
   */
  async getLeaveSummary(
    tenantId: string,
    userId: string,
    query: GetMyLeaveSummaryQueryDto = {},
    email?: string,
  ) {
    const employee = await this.me(tenantId, userId, email);
    const year = query.fiscalYear ? fiscalYearStarting(query.fiscalYear) : fiscalYear();
    const today = new Date().toISOString().slice(0, 10);
    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const [policies, requests, upcoming] = await Promise.all([
      Policy.findAll({
        where: { tenantId, isActive: true },
        order: [['name', 'ASC']],
      }),
      Leave.findAll({
        where: {
          tenantId,
          employeeId: employee.id,
          status: { [Op.in]: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.PENDING] },
          fromDate: { [Op.between]: [year.start, year.end] },
        },
        attributes: ['leavePolicyId', 'status', 'totalDays'],
        raw: true,
      }),
      Leave.findAll({
        where: {
          tenantId,
          employeeId: employee.id,
          status: { [Op.in]: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.PENDING] },
          toDate: { [Op.gte]: today },
        },
        include: [
          { model: Policy, as: 'leavePolicy', attributes: ['id', 'name', 'isPaid'], required: false },
        ],
        order: [['fromDate', 'ASC']],
        limit: 5,
      }),
    ]);

    const used = new Map<string, number>();
    const pending = new Map<string, number>();
    for (const request of requests as any[]) {
      const bucket = request.status === LeaveRequestStatus.APPROVED ? used : pending;
      bucket.set(
        request.leavePolicyId,
        (bucket.get(request.leavePolicyId) ?? 0) + Number(request.totalDays ?? 0),
      );
    }

    const balances = policies.map((policy) => {
      const allocation = Number(policy.annualAllocation ?? 0);
      const usedDays = roundDays(used.get(policy.id) ?? 0);
      const pendingDays = roundDays(pending.get(policy.id) ?? 0);
      const remaining = Math.max(0, roundDays(allocation - usedDays));
      return {
        leavePolicyId: policy.id,
        name: policy.name,
        description: policy.description ?? null,
        isPaid: policy.isPaid !== false,
        allocation,
        used: usedDays,
        pending: pendingDays,
        remaining,
        available: Math.max(0, roundDays(allocation - usedDays - pendingDays)),
        usedLabel: `Used: ${usedDays} / ${allocation}`,
        progress: allocation > 0 ? Math.round((usedDays / allocation) * 100) : 0,
      };
    });

    const sum = (key: 'allocation' | 'used' | 'pending' | 'remaining' | 'available') =>
      roundDays(balances.reduce((total, row) => total + row[key], 0));

    return {
      fiscalYear: year.label,
      fiscalYearStart: year.start,
      fiscalYearEnd: year.end,
      totals: {
        allocation: sum('allocation'),
        used: sum('used'),
        pending: sum('pending'),
        remaining: sum('remaining'),
        available: sum('available'),
      },
      balances,
      upcoming: (upcoming as any[]).map((row) => this.leaveRow(row)),
    };
  }

  /** Leave History, newest first, filterable by status, type and fiscal year. */
  async getLeaveHistory(
    tenantId: string,
    userId: string,
    query: GetMyLeaveHistoryQueryDto = {},
    email?: string,
  ) {
    const employee = await this.me(tenantId, userId, email);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;

    const where: any = { tenantId, employeeId: employee.id };
    if (query.status && query.status !== LeaveRequestStatusFilter.ALL) {
      where.status = query.status;
    }
    if (query.leavePolicyId) where.leavePolicyId = query.leavePolicyId;
    if (query.fiscalYear) {
      const year = fiscalYearStarting(query.fiscalYear);
      where.fromDate = { [Op.between]: [year.start, year.end] };
    }

    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const { rows, count } = await Leave.findAndCountAll({
      where,
      include: [
        { model: Policy, as: 'leavePolicy', attributes: ['id', 'name', 'isPaid'], required: false },
      ],
      order: [['createdAt', 'DESC'], ['id', 'ASC']],
      offset: (page - 1) * limit,
      limit,
    });

    return {
      rows: (rows as any[]).map((row) => this.leaveRow(row)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /** One of the employee's own leave requests, including HR's decision note. */
  async getLeave(tenantId: string, userId: string, leaveRequestId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const row = await Leave.findOne({
      where: { id: leaveRequestId, tenantId, employeeId: employee.id },
      include: [
        { model: Policy, as: 'leavePolicy', attributes: ['id', 'name', 'isPaid'], required: false },
      ],
    });
    if (!row) this.notFound('Leave request not found.');
    return this.leaveRow(row);
  }

  /**
   * The Apply Leave dialog's live check: days that will be deducted, the
   * balance before and after, and anything that would stop the request.
   * Nothing is written.
   */
  async previewLeave(tenantId: string, userId: string, dto: ApplyMyLeaveDto, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    return this.planLeave(tenantId, employee.id, dto);
  }

  async applyLeave(tenantId: string, userId: string, dto: ApplyMyLeaveDto, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const plan = await this.planLeave(tenantId, employee.id, dto);
    this.assertPlanUsable(plan);

    const created = await this.leaveRequestService.create(
      tenantId,
      {
        employeeId: employee.id,
        leavePolicyId: dto.leavePolicyId,
        fromDate: plan.fromDate,
        toDate: plan.toDate,
        totalDays: plan.totalDays,
        reason: dto.reason,
        status: LeaveRequestStatus.PENDING,
      },
      userId,
    );
    await this.notify(tenantId, employee.id, {
      kind: EmployeeNotificationKind.LEAVE,
      title: 'Leave Request',
      body: `Your ${created.leaveType?.name ?? 'leave'} request for ${periodLabel(created.fromDate, created.toDate)} is under review.`,
    });
    return created;
  }

  /**
   * Edit a request HR has not decided yet. Re-planned exactly like a new
   * application, except the request being edited does not count against its
   * own balance or clash with its own dates.
   */
  async updateLeave(
    tenantId: string,
    userId: string,
    leaveRequestId: string,
    dto: UpdateMyLeaveDto,
    email?: string,
  ) {
    const employee = await this.me(tenantId, userId, email);
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const row = await Leave.findOne({
      where: { id: leaveRequestId, tenantId, employeeId: employee.id },
    });
    if (!row) this.notFound('Leave request not found.');
    if (row.status !== LeaveRequestStatus.PENDING) {
      this.conflict('Only a pending leave request can be edited.');
    }

    const fromDate = (dto.fromDate ?? String(row.fromDate)).slice(0, 10);
    const toDate = (dto.toDate ?? String(row.toDate)).slice(0, 10);
    const datesUnchanged =
      fromDate === String(row.fromDate).slice(0, 10) &&
      toDate === String(row.toDate).slice(0, 10);
    const plan = await this.planLeave(
      tenantId,
      employee.id,
      {
        leavePolicyId: dto.leavePolicyId ?? row.leavePolicyId,
        fromDate,
        toDate,
        // A half day stays a half day unless the dates move or it is switched off.
        halfDay: dto.halfDay ?? (datesUnchanged && Number(row.totalDays) === 0.5),
      },
      leaveRequestId,
    );
    this.assertPlanUsable(plan);

    await this.leaveRequestService.update(tenantId, leaveRequestId, {
      leavePolicyId: plan.leaveType.id,
      fromDate: plan.fromDate,
      toDate: plan.toDate,
      totalDays: plan.totalDays,
      reason: dto.reason,
    });
    return this.getLeave(tenantId, userId, leaveRequestId, email);
  }

  async cancelLeave(tenantId: string, userId: string, leaveRequestId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const row = await Leave.findOne({
      where: { id: leaveRequestId, tenantId, employeeId: employee.id },
    });
    if (!row) this.notFound('Leave request not found.');
    if (row.status !== LeaveRequestStatus.PENDING) {
      this.conflict('Only a pending leave request can be cancelled.');
    }
    return this.leaveRequestService.cancel(tenantId, leaveRequestId);
  }

  /**
   * Work out what a leave request would cost: the working days it covers
   * (the organization's weekly offs are not deducted), or 0.5 for a half
   * day, checked against the balance of the fiscal year it starts in and
   * against the employee's other open requests.
   *
   * Paid leave cannot exceed what is available; unpaid leave is reported
   * but never blocked on balance.
   */
  private async planLeave(
    tenantId: string,
    employeeId: string,
    input: { leavePolicyId: string; fromDate: string; toDate: string; halfDay?: boolean },
    excludeId?: string,
  ) {
    const fromDate = input.fromDate.slice(0, 10);
    const toDate = input.toDate.slice(0, 10);
    if (toDate < fromDate) {
      this.badRequest('The leave end date cannot be earlier than its start date.');
    }
    if (input.halfDay && fromDate !== toDate) {
      this.badRequest('A half day must start and end on the same date.');
    }
    const span = eachDate(fromDate, toDate);
    if (span.length > MAX_LEAVE_SPAN_DAYS) {
      this.badRequest(`A single leave request can cover at most ${MAX_LEAVE_SPAN_DAYS} days.`);
    }

    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const policy = await Policy.findOne({ where: { id: input.leavePolicyId, tenantId } });
    if (!policy) this.badRequest('This leave type is not offered by your organization.');
    if (!policy.isActive) this.badRequest('This leave type is no longer available.');

    const workingDays = await this.attendanceService.getWorkingDays(tenantId);
    const nonWorkingDates = span.filter((date) => !workingDays.has(weekdayName(date)));
    const workingDayCount = span.length - nonWorkingDates.length;
    const totalDays = input.halfDay ? (workingDayCount ? 0.5 : 0) : workingDayCount;

    const year = fiscalYearContaining(fromDate);
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const notThis = excludeId ? { id: { [Op.ne]: excludeId } } : {};
    const openStatuses = { [Op.in]: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.PENDING] };
    const [committed, clash] = await Promise.all([
      Leave.findAll({
        where: {
          tenantId,
          employeeId,
          leavePolicyId: policy.id,
          status: openStatuses,
          fromDate: { [Op.between]: [year.start, year.end] },
          ...notThis,
        },
        attributes: ['status', 'totalDays'],
        raw: true,
      }),
      Leave.findOne({
        where: {
          tenantId,
          employeeId,
          status: openStatuses,
          // Two ranges overlap when each starts on or before the other ends.
          fromDate: { [Op.lte]: toDate },
          toDate: { [Op.gte]: fromDate },
          ...notThis,
        },
        attributes: ['id', 'fromDate', 'toDate', 'status'],
      }),
    ]);

    let usedDays = 0;
    let pendingDays = 0;
    for (const row of committed as any[]) {
      if (row.status === LeaveRequestStatus.APPROVED) usedDays += Number(row.totalDays ?? 0);
      else pendingDays += Number(row.totalDays ?? 0);
    }
    const allocation = Number(policy.annualAllocation ?? 0);
    const available = Math.max(0, roundDays(allocation - usedDays - pendingDays));
    const enforced = policy.isPaid !== false;

    const issues: string[] = [];
    if (totalDays === 0) {
      issues.push('The selected dates fall entirely on non-working days.');
    }
    if (enforced && totalDays > available) {
      issues.push(
        `Only ${available} day${available === 1 ? '' : 's'} of ${policy.name} available in ${year.label}; this request needs ${totalDays}.`,
      );
    }
    const overlap = clash
      ? {
          id: clash.id,
          fromDate: String(clash.fromDate).slice(0, 10),
          toDate: String(clash.toDate).slice(0, 10),
          status: clash.status,
        }
      : null;
    if (overlap) {
      issues.push(
        `You already have a ${overlap.status.toLowerCase()} leave request for ${periodLabel(overlap.fromDate, overlap.toDate)}.`,
      );
    }

    return {
      leaveType: { id: policy.id, name: policy.name, isPaid: enforced },
      fromDate,
      toDate,
      halfDay: Boolean(input.halfDay),
      period: periodLabel(fromDate, toDate),
      calendarDays: span.length,
      workingDays: workingDayCount,
      nonWorkingDates,
      totalDays,
      durationLabel: durationLabel(totalDays),
      balance: {
        fiscalYear: year.label,
        allocation,
        used: roundDays(usedDays),
        pending: roundDays(pendingDays),
        available,
        remainingAfter: enforced ? roundDays(available - totalDays) : null,
        enforced,
      },
      overlap,
      canApply: issues.length === 0,
      issues,
    };
  }

  /** An overlap is a 409 like everywhere else in leave; any other issue is a 400. */
  private assertPlanUsable(plan: { canApply: boolean; overlap: unknown; issues: string[] }) {
    if (plan.canApply) return;
    if (plan.overlap) this.conflict(plan.issues.join(' '));
    this.badRequest(plan.issues.join(' '));
  }

  /** A leave request as the History table and detail view show it. */
  private leaveRow(row: any) {
    const fromDate = String(row.fromDate).slice(0, 10);
    const toDate = String(row.toDate).slice(0, 10);
    const duration = Number(row.totalDays);
    const pendingRow = row.status === LeaveRequestStatus.PENDING;
    return {
      id: row.id,
      type: row.leavePolicy?.name ?? 'Leave',
      leavePolicyId: row.leavePolicyId,
      isPaid: row.leavePolicy ? row.leavePolicy.isPaid !== false : null,
      period: periodLabel(fromDate, toDate),
      fromDate,
      toDate,
      duration,
      durationLabel: durationLabel(duration),
      halfDay: duration === 0.5,
      status: row.status,
      reason: row.reason ?? null,
      decisionNote: row.decisionNote ?? null,
      decidedAt: row.decidedAt ?? null,
      appliedOn: row.createdAt ?? null,
      canCancel: pendingRow,
      canEdit: pendingRow,
    };
  }

  /**
   * My Documents: the table for one category tab (optionally one status or
   * a search), plus counts for every tab and status so the badges need no
   * second request.
   */
  async getDocuments(tenantId: string, userId: string, query: GetMyDocumentsQueryDto = {}, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    const category = query.category ?? EmployeeDocumentCategoryFilter.ALL;
    const where: any = { tenantId, employeeId: employee.id };
    if (category !== EmployeeDocumentCategoryFilter.ALL) where.category = category;
    if (query.status) where.status = query.status;
    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [{ title: { [Op.iLike]: term } }, { fileName: { [Op.iLike]: term } }];
    }

    const [rows, grouped] = await Promise.all([
      Document.findAll({ where, order: [['createdAt', 'DESC']] }),
      Document.findAll({
        where: { tenantId, employeeId: employee.id },
        attributes: ['category', 'status', [fn('COUNT', col('id')), 'count']],
        group: ['category', 'status'],
        raw: true,
      }),
    ]);

    const byCategory: Record<string, number> = Object.fromEntries(DOCUMENT_TABS.map((tab) => [tab, 0]));
    const byStatus: Record<string, number> = Object.fromEntries(
      Object.values(EmployeeDocumentStatus).map((status) => [status, 0]),
    );
    let total = 0;
    for (const row of grouped as any[]) {
      const count = Number(row.count);
      total += count;
      byCategory[row.category] = (byCategory[row.category] ?? 0) + count;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
    }
    byCategory[EmployeeDocumentCategoryFilter.ALL] = total;

    return {
      total,
      categories: DOCUMENT_TABS,
      counts: { byCategory, byStatus },
      rows: rows.map((row) => this.documentRow(row)),
    };
  }

  /**
   * Record a document against a file already in the file store. The gateway
   * has checked the file was uploaded by this user and filled in its name,
   * size and type from the store.
   */
  async uploadDocument(tenantId: string, userId: string, dto: UploadMyDocumentDto, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    if (!dto.fileName?.trim()) this.badRequest('The uploaded file could not be identified.');
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    await this.assertFileUnused(Document, tenantId, dto.fileId);

    const created = await Document.create({
      tenantId,
      employeeId: employee.id,
      title: dto.title.trim(),
      category: dto.category,
      fileId: dto.fileId,
      fileName: dto.fileName.trim(),
      mimeType: dto.mimeType ?? null,
      sizeBytes: dto.sizeBytes ?? 0,
      status: EmployeeDocumentStatus.PENDING,
      expiryDate: dto.expiryDate ? dto.expiryDate.slice(0, 10) : null,
    });
    return this.documentRow(created);
  }

  async getDocument(tenantId: string, userId: string, documentId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    const row = await Document.findOne({
      where: { id: documentId, tenantId, employeeId: employee.id },
    });
    if (!row) this.notFound('Document not found.');
    return this.documentRow(row);
  }

  /**
   * Rename, re-categorize, change the expiry date or replace the file of a
   * document HR has not verified. Any change sends it back to Pending and
   * clears the old review, since HR has not seen the new version.
   *
   * `replacedFileId` tells the gateway which stored file is now orphaned.
   */
  async updateDocument(
    tenantId: string,
    userId: string,
    documentId: string,
    dto: UpdateMyDocumentDto,
    email?: string,
  ) {
    const employee = await this.me(tenantId, userId, email);
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    const row = await Document.findOne({
      where: { id: documentId, tenantId, employeeId: employee.id },
    });
    if (!row) this.notFound('Document not found.');
    if (row.status === EmployeeDocumentStatus.VERIFIED) {
      this.conflict('A verified document cannot be changed. Upload a new one instead.');
    }

    const patch: any = {};
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.expiryDate !== undefined) {
      patch.expiryDate = dto.expiryDate ? dto.expiryDate.slice(0, 10) : null;
    }

    let replacedFileId: string | null = null;
    if (dto.fileId && dto.fileId !== row.fileId) {
      if (!dto.fileName?.trim()) this.badRequest('The replacement file could not be identified.');
      await this.assertFileUnused(Document, tenantId, dto.fileId);
      replacedFileId = row.fileId;
      patch.fileId = dto.fileId;
      patch.fileName = dto.fileName.trim();
      patch.mimeType = dto.mimeType ?? null;
      patch.sizeBytes = dto.sizeBytes ?? 0;
    }

    if (Object.keys(patch).length) {
      Object.assign(patch, {
        status: EmployeeDocumentStatus.PENDING,
        reviewNote: null,
        reviewedAt: null,
        reviewedByUserId: null,
      });
      await row.update(patch);
    }
    return { ...this.documentRow(row), replacedFileId };
  }

  /**
   * Remove one of your documents. A verified one is part of the employment
   * record and stays; HR can reject it first if it really must go. Returns
   * the file id so the gateway can delete the stored bytes too.
   */
  async deleteDocument(tenantId: string, userId: string, documentId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    const row = await Document.findOne({
      where: { id: documentId, tenantId, employeeId: employee.id },
    });
    if (!row) this.notFound('Document not found.');
    // A verified document is part of the employee file HR signed off on;
    // removing it takes HR, not the employee.
    if (row.status === EmployeeDocumentStatus.VERIFIED) {
      this.conflict('This document has been verified by HR and can no longer be removed. Ask HR if it needs to change.');
    }
    await row.destroy();
    return { message: 'Document deleted successfully', fileId: row.fileId };
  }

  /**
   * HR verifies or rejects an uploaded document. Nobody reviews their own
   * upload — it goes to another reviewer, the same rule as requests. A
   * rejection needs a reason, since the employee has to know what to fix.
   */
  async reviewDocument(
    tenantId: string,
    documentId: string,
    dto: ReviewEmployeeDocumentDto,
    actor: { userId?: string; email?: string } = {},
  ) {
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    const row = await Document.findOne({ where: { id: documentId, tenantId, ...(await this.scopeWhere(tenantId)) } });
    if (!row) this.notFound('Document not found.');

    if (dto.status !== EmployeeDocumentStatus.VERIFIED && dto.status !== EmployeeDocumentStatus.REJECTED) {
      this.badRequest('A document can only be verified or rejected.');
    }
    const ownEmployeeId = await this.actorEmployeeId(tenantId, actor.userId, actor.email);
    if (ownEmployeeId && ownEmployeeId === row.employeeId) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        "You can't review your own document. Another HR reviewer or the organization admin will review it.",
        HttpStatus.FORBIDDEN,
      );
    }
    const note = dto.note?.trim() || null;
    if (dto.status === EmployeeDocumentStatus.REJECTED && !note) {
      this.badRequest('Add a reason so the employee knows what to fix.');
    }

    await row.update({
      status: dto.status,
      reviewNote: note,
      reviewedAt: new Date(),
      reviewedByUserId: actor.userId ?? null,
    });

    await this.notify(
      tenantId,
      row.employeeId,
      dto.status === EmployeeDocumentStatus.VERIFIED
        ? {
            kind: EmployeeNotificationKind.DOCUMENT,
            title: 'Document Verified',
            body: `${row.title} has been verified.${note ? ` ${note}` : ''}`,
          }
        : {
            kind: EmployeeNotificationKind.DOCUMENT,
            title: 'Document Rejected',
            body: `${row.title} was rejected: ${note}. Please upload a corrected copy.`,
          },
    );
    return this.documentRow(row);
  }

  /**
   * HR's Employee Documents screen: every employee's uploads in the
   * reader's data scope, pending first then newest. `status=PENDING` is the
   * verification queue, `expiringWithinDays` the renewals list. Counts per
   * status come with every page.
   */
  async listAllDocuments(
    tenantId: string,
    query: GetEmployeeDocumentsQueryDto = {},
    actor: { userId?: string; email?: string } = {},
  ) {
    const ownEmployeeId = await this.actorEmployeeId(tenantId, actor.userId, actor.email);
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);

    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 100);

    const scope = await this.scopeWhere(tenantId);
    const where: any = { tenantId, ...scope };
    if (query.status) where.status = query.status;
    if (query.category && query.category !== EmployeeDocumentCategoryFilter.ALL) where.category = query.category;
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.expiringWithinDays !== undefined) {
      where.expiryDate = { [Op.ne]: null, [Op.lte]: addDays(todayIso(), query.expiringWithinDays) };
    }

    const search = query.search?.trim();
    if (search) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [
        { title: like },
        { fileName: like },
        { '$employee.firstName$': like },
        { '$employee.lastName$': like },
        { '$employee.employeeCode$': like },
      ];
    }

    const [{ rows, count }, grouped] = await Promise.all([
      Document.findAndCountAll({
        where,
        include: await this.documentEmployeeInclude(tenantId, query.departmentId),
        order: [
          [literal(`CASE WHEN "EmployeeDocument"."status" = 'PENDING' THEN 0 ELSE 1 END`), 'ASC'],
          ['createdAt', 'DESC'],
          ['id', 'ASC'],
        ],
        limit,
        offset: (page - 1) * limit,
        subQuery: false,
        distinct: true,
      }),
      Document.findAll({
        where: { tenantId, ...scope },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
    ]);

    const byStatus: Record<string, number> = Object.fromEntries(
      Object.values(EmployeeDocumentStatus).map((status) => [status, 0]),
    );
    for (const row of grouped as any[]) byStatus[row.status] = Number(row.count);

    return {
      data: (rows as any[]).map((row) => ({
        ...this.hrDocumentRow(row),
        isOwnDocument: ownEmployeeId !== null && row.employeeId === ownEmployeeId,
      })),
      total: count,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      counts: { byStatus },
    };
  }

  /** The cards above HR's Employee Documents table. */
  async getDocumentStats(tenantId: string) {
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const scope = await this.scopeWhere(tenantId);
    const [byStatus, thisMonth] = await Promise.all([
      Document.findAll({
        where: { tenantId, ...scope },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
      Document.count({ where: { tenantId, createdAt: { [Op.gte]: monthStart }, ...scope } }),
    ]);
    const counts: Record<string, number> = {};
    for (const row of byStatus as any[]) counts[row.status] = Number(row.count);
    return {
      pending: counts[EmployeeDocumentStatus.PENDING] ?? 0,
      verified: counts[EmployeeDocumentStatus.VERIFIED] ?? 0,
      rejected: counts[EmployeeDocumentStatus.REJECTED] ?? 0,
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      thisMonth,
    };
  }

  /** HR: one document with the employee it belongs to — within the reader's data scope. */
  async getEmployeeDocument(tenantId: string, documentId: string) {
    const Document = await this.modelProvider.getEmployeeDocumentModel(tenantId);
    const row = await Document.findOne({
      where: { id: documentId, tenantId, ...(await this.scopeWhere(tenantId)) },
      include: await this.documentEmployeeInclude(tenantId),
    });
    if (!row) this.notFound('Document not found.');
    return this.hrDocumentRow(row);
  }

  /**
   * One file backs one document. Without this, the same upload could be
   * attached twice and deleting either document would orphan the other.
   */
  private async assertFileUnused(Document: any, tenantId: string, fileId: string) {
    const existing = await Document.findOne({ where: { tenantId, fileId }, attributes: ['id'] });
    if (existing) this.conflict('This file is already attached to a document.');
  }

  private async documentEmployeeInclude(tenantId: string, departmentId?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    return [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl', 'departmentId'],
        required: true,
        where: departmentId ? { departmentId } : undefined,
        include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
      },
    ];
  }

  private hrDocumentRow(row: any) {
    const employee = row.employee;
    return {
      ...this.documentRow(row),
      employee: employee
        ? {
            id: employee.id,
            employeeCode: employee.employeeCode,
            name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
            avatarUrl: employee.avatarUrl ?? null,
            department: employee.department
              ? { id: employee.department.id, name: employee.department.name }
              : null,
          }
        : null,
    };
  }
  async getRequests(tenantId: string, userId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
    const [rows, pending] = await Promise.all([
      Request.findAll({
        where: { tenantId, employeeId: employee.id },
        order: [['createdAt', 'DESC']],
        limit: 50,
      }),
      Request.count({
        where: {
          tenantId,
          employeeId: employee.id,
          status: EmployeeRequestStatus.PENDING,
        },
      }),
    ]);
    return {
      pending,
      types: REQUEST_CARDS,
      rows: rows.map((row) => this.requestRow(row)),
    };
  }

  async createRequest(tenantId: string, userId: string, dto: CreateMyRequestDto, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    if (dto.fromDate && dto.toDate && dto.toDate < dto.fromDate) {
      this.badRequest('toDate must be on or after fromDate.');
    }
    this.assertRequestFields(dto);
    const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
    const requestDate = dto.date ?? dto.fromDate ?? new Date().toISOString().slice(0, 10);
    const created = await Request.create({
      tenantId,
      employeeId: employee.id,
      type: dto.type,
      description: dto.description.trim(),
      requestDate,
      fromDate: dto.fromDate ?? null,
      toDate: dto.toDate ?? null,
      hours: dto.hours ?? null,
      timeFrom: dto.timeFrom ?? null,
      timeTo: dto.timeTo ?? null,
      status: EmployeeRequestStatus.PENDING,
    });
    const when = dto.fromDate
      ? periodLabel(dto.fromDate, dto.toDate ?? dto.fromDate)
      : formatDay(requestDate);
    await this.notify(tenantId, employee.id, {
      kind:
        dto.type === EmployeeRequestType.ATTENDANCE_CORRECTION
          ? EmployeeNotificationKind.ATTENDANCE
          : EmployeeNotificationKind.REQUEST,
      title: requestTitle(dto.type),
      body: `Your ${requestTitle(dto.type).toLowerCase()} request for ${when} is under review.`,
    });
    return this.requestRow(created);
  }

  /**
   * What each request type must carry, so HR never receives one it can't act
   * on — a work-from-home request with no dates, overtime with no hours.
   */
  private assertRequestFields(dto: CreateMyRequestDto) {
    const today = new Date().toISOString().slice(0, 10);
    switch (dto.type) {
      case EmployeeRequestType.ATTENDANCE_CORRECTION:
        if (!dto.date) this.badRequest('An attendance correction needs the date to correct.');
        if (dto.date.slice(0, 10) > today) this.badRequest('You can only correct attendance for today or earlier.');
        break;
      case EmployeeRequestType.WORK_FROM_HOME:
        if (!dto.fromDate || !dto.toDate) this.badRequest('A work-from-home request needs a start and end date.');
        break;
      case EmployeeRequestType.OVERTIME:
        if (!dto.date) this.badRequest('An overtime request needs the date the hours were worked.');
        if (dto.date.slice(0, 10) > today) this.badRequest('Overtime can only be logged for today or earlier.');
        if (!dto.hours) this.badRequest('An overtime request needs the number of hours worked.');
        break;
      default:
        break;
    }
  }

  async cancelRequest(tenantId: string, userId: string, requestId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
    const row = await Request.findOne({
      where: { id: requestId, tenantId, employeeId: employee.id },
    });
    if (!row) this.notFound('Request not found.');
    if (row.status !== EmployeeRequestStatus.PENDING) {
      this.conflict('Only a pending request can be cancelled.');
    }
    await row.update({ status: EmployeeRequestStatus.CANCELLED });
    return this.requestRow(row);
  }

  /**
   * The employee record of whoever is acting, found the same way `me` finds
   * it — or null for someone with no employee record (e.g. the org admin).
   */
  private async actorEmployeeId(tenantId: string, userId?: string, email?: string): Promise<string | null> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee = userId
      ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id'] })
      : null;
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({
        where: { tenantId, email: { [Op.iLike]: email.trim() } },
        attributes: ['id'],
      });
    }
    return employee?.id ?? null;
  }

  async decideRequest(
    tenantId: string,
    requestId: string,
    dto: DecideEmployeeRequestDto,
    actorUserId: string,
    actorEmail?: string,
  ) {
    const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
    const row = await Request.findOne({ where: { id: requestId, tenantId, ...(await this.scopeWhere(tenantId)) } });
    if (!row) this.notFound('Request not found.');
    if (row.status !== EmployeeRequestStatus.PENDING) {
      this.conflict(`This request is already ${String(row.status).toLowerCase()}.`);
    }
    // Nobody decides their own request — it waits for another approver,
    // such as the organization admin.
    if ((await this.actorEmployeeId(tenantId, actorUserId, actorEmail)) === row.employeeId) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        "You can't approve or reject your own request. Another approver, such as the organization admin, needs to decide it.",
        HttpStatus.FORBIDDEN,
      );
    }

    // Approving applies the change first; the request is only marked approved
    // once that has worked, so a failure leaves it pending to try again.
    const applied =
      dto.status === EmployeeRequestStatus.APPROVED
        ? await this.applyApproval(tenantId, row, dto, actorUserId)
        : { patch: {}, resolution: null, summary: '' };

    await row.update({
      status: dto.status,
      decisionNote: dto.note ?? null,
      decidedByUserId: actorUserId,
      decidedAt: new Date(),
      ...applied.patch,
      ...(applied.resolution ? { resolution: applied.resolution } : {}),
    });

    const verb = dto.status === EmployeeRequestStatus.APPROVED ? 'approved' : 'rejected';
    await this.notify(tenantId, row.employeeId, {
      kind: EmployeeNotificationKind.REQUEST,
      title: requestTitle(row.type),
      body: `Your ${requestTitle(row.type).toLowerCase()} request has been ${verb}.${applied.summary}${
        dto.note?.trim() ? ` Note: ${dto.note.trim()}` : ''
      }`,
    });
    return this.requestRow(row);
  }

  /**
   * What approving a request does beyond changing its status. Attendance
   * changes go through AttendanceService, so Late / Present and hours worked
   * are worked out exactly as for any other attendance edit.
   */
  private async applyApproval(
    tenantId: string,
    row: any,
    dto: DecideEmployeeRequestDto,
    actorUserId: string,
  ): Promise<{ patch: Record<string, unknown>; resolution: Record<string, unknown> | null; summary: string }> {
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const appliedAt = new Date().toISOString();

    switch (row.type as EmployeeRequestType) {
      case EmployeeRequestType.ATTENDANCE_CORRECTION: {
        if (!dto.checkInAt && !dto.checkOutAt) {
          this.badRequest('Enter the corrected check-in or check-out time to approve this correction.');
        }
        const date = String(row.requestDate).slice(0, 10);
        const existing = await Attendance.findOne({
          where: { tenantId, employeeId: row.employeeId, date },
        });

        const checkIn = dto.checkInAt ?? existing?.checkInAt?.toISOString() ?? null;
        const checkOut = dto.checkOutAt ?? existing?.checkOutAt?.toISOString() ?? null;
        if (!checkIn) {
          this.badRequest('There is no check-in on this day, so a corrected check-in time is needed.');
        }
        if (checkOut && new Date(checkOut) <= new Date(checkIn)) {
          this.badRequest('Check-out must be after check-in.');
        }

        const marker = 'Corrected via attendance correction request';
        const notes = existing?.notes ? `${existing.notes} · ${marker}`.slice(0, 500) : marker;
        const record = existing
          ? await this.attendanceService.update(
              tenantId,
              existing.id,
              {
                ...(dto.checkInAt ? { checkInAt: dto.checkInAt } : {}),
                ...(dto.checkOutAt ? { checkOutAt: dto.checkOutAt } : {}),
                notes,
              } as any,
              actorUserId,
            )
          : await this.attendanceService.create(
              tenantId,
              {
                employeeId: row.employeeId,
                date,
                checkInAt: checkIn,
                ...(checkOut ? { checkOutAt: checkOut } : {}),
                notes,
              } as any,
              actorUserId,
              AttendanceSource.MANUAL,
            );

        return {
          patch: {},
          resolution: {
            appliedAt,
            attendanceRecordId: record.id,
            checkInAt: record.checkInAt,
            checkOutAt: record.checkOutAt,
            status: record.status,
            previous: existing
              ? { checkInAt: existing.checkInAt, checkOutAt: existing.checkOutAt, status: existing.status }
              : null,
          },
          summary: ` Your attendance for ${formatDay(date)} has been updated.`,
        };
      }

      case EmployeeRequestType.OVERTIME: {
        const requestedHours = row.hours === null || row.hours === undefined ? null : Number(row.hours);
        const hours = dto.hours ?? requestedHours;
        if (!hours) this.badRequest('Enter the overtime hours to approve.');

        const date = String(row.requestDate).slice(0, 10);
        const day = await Attendance.findOne({ where: { tenantId, employeeId: row.employeeId, date } });
        if (day) await day.update({ overtimeMinutes: Math.round(hours * 60) });

        const changed = requestedHours !== null && hours !== requestedHours;
        return {
          patch: { hours },
          resolution: {
            appliedAt,
            hours,
            requested: { hours: requestedHours },
            attendanceRecordId: day?.id ?? null,
          },
          summary: changed ? ` Approved ${hours}h (you asked for ${requestedHours}h).` : ` Approved ${hours}h.`,
        };
      }

      case EmployeeRequestType.WORK_FROM_HOME: {
        const requested = { fromDate: row.fromDate ?? null, toDate: row.toDate ?? null };
        const fromDate = (dto.fromDate ?? row.fromDate)?.slice(0, 10);
        const toDate = (dto.toDate ?? row.toDate ?? fromDate)?.slice(0, 10);
        if (!fromDate || !toDate) this.badRequest('Enter the work-from-home dates to approve.');
        if (toDate < fromDate) this.badRequest('The last day must be on or after the first day.');

        // Days already recorded in the range become remote now; later days
        // pick it up when the employee checks in (see checkIn).
        const [daysMarked] = await Attendance.update(
          { workLocation: 'REMOTE' },
          { where: { tenantId, employeeId: row.employeeId, date: { [Op.between]: [fromDate, toDate] } } },
        );

        const changed = fromDate !== requested.fromDate || toDate !== requested.toDate;
        return {
          patch: { fromDate, toDate },
          resolution: { appliedAt, fromDate, toDate, requested, daysMarked },
          summary: changed ? ` Approved for ${periodLabel(fromDate, toDate)}.` : '',
        };
      }

      default:
        return { patch: {}, resolution: { appliedAt }, summary: '' };
    }
  }

  /** True when an approved work-from-home request covers this day. */
  private async isRemoteDay(tenantId: string, employeeId: string, date: string): Promise<boolean> {
    return (await this.remoteRequestFor(tenantId, employeeId, date)) !== null;
  }

  /** The approved work-from-home request covering this day, if any. */
  private async remoteRequestFor(
    tenantId: string,
    employeeId: string,
    date: string,
  ): Promise<{ requestId: string; fromDate: string; toDate: string } | null> {
    try {
      const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
      const row = await Request.findOne({
        where: {
          tenantId,
          employeeId,
          type: EmployeeRequestType.WORK_FROM_HOME,
          status: EmployeeRequestStatus.APPROVED,
          fromDate: { [Op.lte]: date },
          toDate: { [Op.gte]: date },
        },
        order: [['toDate', 'DESC']],
      });
      if (!row) return null;
      return {
        requestId: row.id,
        fromDate: String(row.fromDate).slice(0, 10),
        toDate: String(row.toDate).slice(0, 10),
      };
    } catch (error: any) {
      // Only a label — never let it get in the way of punching in.
      this.logger.warn(`Could not check work-from-home for ${date}: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * HR's Employee Requests screen: every employee's requests, newest first,
   * with who raised each one.
   */
  async listAllRequests(
    tenantId: string,
    query: GetEmployeeRequestsQueryDto = {},
    actor: { userId?: string; email?: string } = {},
  ) {
    const ownEmployeeId = await this.actorEmployeeId(tenantId, actor.userId, actor.email);
    const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 100);

    const where: any = { tenantId, ...(await this.scopeWhere(tenantId)) };
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;

    const search = query.search?.trim();
    if (search) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [
        { description: like },
        { '$employee.firstName$': like },
        { '$employee.lastName$': like },
        { '$employee.employeeCode$': like },
      ];
    }

    const { rows, count } = await Request.findAndCountAll({
      where,
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl', 'departmentId'],
          required: true,
          ...(query.departmentId ? { where: { departmentId: query.departmentId } } : {}),
          include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      // The search reaches into the joined employee, which only works when
      // the LIMIT is applied to the joined query rather than a subquery.
      subQuery: false,
      distinct: true,
    });

    // For corrections, what the day looks like now — so HR reviews "current
    // vs requested" rather than approving blind. One query for the page.
    const corrections = (rows as any[]).filter(
      (row) => row.type === EmployeeRequestType.ATTENDANCE_CORRECTION,
    );
    const dayKey = (employeeId: string, date: string) => `${employeeId}::${String(date).slice(0, 10)}`;
    const attendanceByDay = new Map<string, any>();
    if (corrections.length) {
      const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
      const days = await Attendance.findAll({
        where: {
          tenantId,
          [Op.or]: corrections.map((row) => ({
            employeeId: row.employeeId,
            date: String(row.requestDate).slice(0, 10),
          })),
        },
      });
      for (const day of days as any[]) attendanceByDay.set(dayKey(day.employeeId, day.date), day);
    }

    return {
      data: (rows as any[]).map((row) => {
        const employee = row.employee;
        const day =
          row.type === EmployeeRequestType.ATTENDANCE_CORRECTION
            ? attendanceByDay.get(dayKey(row.employeeId, row.requestDate))
            : undefined;
        return {
          ...this.requestRow(row),
          // The viewer's own request — they can see it but not decide it.
          isOwnRequest: ownEmployeeId !== null && row.employeeId === ownEmployeeId,
          currentAttendance:
            row.type === EmployeeRequestType.ATTENDANCE_CORRECTION
              ? day
                ? {
                    id: day.id,
                    status: day.status,
                    statusLabel: STATUS_LABELS[day.status] ?? day.status,
                    checkInAt: day.checkInAt ?? null,
                    checkOutAt: day.checkOutAt ?? null,
                  }
                : null
              : undefined,
          employee: employee
            ? {
                id: employee.id,
                employeeCode: employee.employeeCode,
                name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
                avatarUrl: employee.avatarUrl ?? null,
                department: employee.department
                  ? { id: employee.department.id, name: employee.department.name }
                  : null,
              }
            : null,
        };
      }),
      total: count,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    };
  }

  /** The cards above HR's Employee Requests table. */
  async getRequestStats(tenantId: string) {
    const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const scope = await this.scopeWhere(tenantId);

    const [byStatus, pendingByType, thisMonth] = await Promise.all([
      Request.findAll({
        where: { tenantId, ...scope },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
      Request.findAll({
        where: { tenantId, status: EmployeeRequestStatus.PENDING, ...scope },
        attributes: ['type', [fn('COUNT', col('id')), 'count']],
        group: ['type'],
        raw: true,
      }),
      Request.count({ where: { tenantId, createdAt: { [Op.gte]: monthStart }, ...scope } }),
    ]);

    const counts: Record<string, number> = {};
    for (const row of byStatus as any[]) counts[row.status] = Number(row.count);
    const pendingTypes: Record<string, number> = {};
    for (const row of pendingByType as any[]) pendingTypes[row.type] = Number(row.count);

    return {
      pending: counts[EmployeeRequestStatus.PENDING] ?? 0,
      approved: counts[EmployeeRequestStatus.APPROVED] ?? 0,
      rejected: counts[EmployeeRequestStatus.REJECTED] ?? 0,
      cancelled: counts[EmployeeRequestStatus.CANCELLED] ?? 0,
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      thisMonth,
      pendingByType: REQUEST_CARDS.map((card) => ({
        type: card.type,
        title: card.title,
        count: pendingTypes[card.type] ?? 0,
      })),
    };
  }

  async getNotifications(
    tenantId: string,
    userId: string,
    query: GetMyNotificationsQueryDto = {},
    email?: string,
  ) {
    const employee = await this.me(tenantId, userId, email);
    const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const [rows, unread] = await Promise.all([
      Notification.findAll({
        where: { tenantId, employeeId: employee.id },
        order: [['createdAt', 'DESC']],
        limit,
      }),
      Notification.count({
        where: { tenantId, employeeId: employee.id, readAt: null },
      }),
    ]);
    return {
      unread,
      rows: rows.map((row) => this.notificationRow(row)),
    };
  }

  async markNotificationRead(tenantId: string, userId: string, notificationId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
    const row = await Notification.findOne({
      where: { id: notificationId, tenantId, employeeId: employee.id },
    });
    if (!row) this.notFound('Notification not found.');
    if (!row.readAt) await row.update({ readAt: new Date() });
    return this.notificationRow(row);
  }

  async markAllNotificationsRead(tenantId: string, userId: string, email?: string) {
    const employee = await this.me(tenantId, userId, email);
    const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
    const [updated] = await Notification.update(
      { readAt: new Date() },
      { where: { tenantId, employeeId: employee.id, readAt: null } },
    );
    return { updated };
  }

  async getDashboard(tenantId: string, userId: string, email?: string) {
    const [profile, today, leave, requests, notifications] = await Promise.all([
      this.getProfile(tenantId, userId, email),
      this.getAttendanceToday(tenantId, userId, email),
      this.getLeaveSummary(tenantId, userId, {}, email),
      this.getRequests(tenantId, userId, email),
      this.getNotifications(tenantId, userId, { limit: 5 }, email),
    ]);
    return {
      profile,
      attendanceToday: today,
      leave,
      requests: { pending: requests.pending },
      notifications: { unread: notifications.unread, recent: notifications.rows },
    };
  }

  private documentRow(row: any) {
    const expiryDate = row.expiryDate ? String(row.expiryDate).slice(0, 10) : null;
    const expiresInDays = expiryDate ? daysBetween(todayIso(), expiryDate) : null;
    const locked = row.status === EmployeeDocumentStatus.VERIFIED;
    return {
      id: row.id,
      title: row.title,
      category: row.category as EmployeeDocumentCategory,
      fileId: row.fileId,
      fileName: row.fileName,
      mimeType: row.mimeType ?? null,
      sizeBytes: Number(row.sizeBytes ?? 0),
      sizeLabel: sizeLabel(Number(row.sizeBytes ?? 0)),
      status: row.status,
      reviewNote: row.reviewNote ?? null,
      reviewedAt: row.reviewedAt ?? null,
      expiryDate,
      expiresInDays,
      isExpired: expiresInDays !== null && expiresInDays < 0,
      canEdit: !locked,
      canDelete: !locked,
      uploadedAt: row.createdAt,
      updatedAt: row.updatedAt ?? row.createdAt,
    };
  }

  private requestRow(row: any) {
    return {
      id: row.id,
      type: row.type,
      title: requestTitle(row.type),
      description: row.description,
      date: row.requestDate,
      dateLabel: formatDay(row.requestDate),
      fromDate: row.fromDate ?? null,
      toDate: row.toDate ?? null,
      hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
      timeFrom: row.timeFrom ?? null,
      timeTo: row.timeTo ?? null,
      resolution: row.resolution ?? null,
      status: row.status,
      decisionNote: row.decisionNote ?? null,
      canCancel: row.status === EmployeeRequestStatus.PENDING,
      createdAt: row.createdAt,
    };
  }

  private notificationRow(row: any) {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      unread: row.readAt == null,
      readAt: row.readAt ?? null,
      createdAt: row.createdAt,
      timeAgo: timeAgo(row.createdAt),
    };
  }
}
