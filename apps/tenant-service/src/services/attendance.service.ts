import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, fn, col, literal, where as sqlWhere } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  AttendanceStatus,
  AttendanceStatusFilter,
  AttendanceSortableField,
  AttendanceSource,
  AttendanceTrendInterval,
  EmployeeStatus,
  CreateAttendanceRecordDto,
  UpdateAttendanceRecordDto,
  BulkMarkAttendanceDto,
  AttendancePeriodQueryDto,
  AttendanceRegisterQueryDto,
  ExportAttendanceRegisterQueryDto,
  UnmarkedAttendanceQueryDto,
  AttendanceDashboardQueryDto,
  LeaveRequestStatus,
  EXPORT_MAX_ROWS,
  ExportResult,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import {
  AttendanceRules,
  autoOvertimeMinutes,
  rulesFrom,
  statusFor,
} from './attendance-rules';

/** Flattened row for the Today's Attendance table. */
export interface AttendanceRow {
  id: string;
  date: string;
  employee: {
    id: string;
    employeeCode: string;
    name: string;
    avatarUrl: string | null;
  };
  department: { id: string; name: string } | null;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  workedMinutes: number | null;
  /** Pre-formatted "8h 30m" so the Work Hours column needs no client math. */
  workHours: string | null;
  status: AttendanceStatus;
  source: AttendanceSource;
  notes: string | null;
  /** What the employee reported when checking out. */
  dayEndStatus: string | null;
  /** 'REMOTE' on an approved work-from-home day. */
  workLocation: string | null;
  /** Overtime approved for the day, in minutes. */
  overtimeMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetAttendanceQuery {
  page?: number;
  limit?: number;
  search?: string;
  date?: string;
  from?: string;
  to?: string;
  departmentId?: string;
  employeeId?: string;
  status?: AttendanceStatusFilter;
  sortBy?: AttendanceSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

export interface AttendanceStats {
  date: string;
  presentToday: number;
  lateToday: number;
  absentToday: number;
  onLeaveToday: number;
  halfDayToday: number;
  /** ACTIVE + ON_LEAVE headcount — the denominator for the rates below. */
  totalEmployees: number;
  /** Records that exist for the day; the gap to totalEmployees is unmarked. */
  recorded: number;
  unmarked: number;
  attendanceRate: number;
  punctualityRate: number;
  /**
   * Percent change of each card against the previous day — the "vs yesterday"
   * line under the KPI cards. Compared against the day before `date`, so
   * looking back at an older day compares it with its own predecessor rather
   * than with today.
   */
  growth: {
    presentToday: number;
    lateToday: number;
    absentToday: number;
    onLeaveToday: number;
  };
}

/**
 * Percent change from the previous value to the current one, to one decimal
 * place. With no baseline to divide by, any non-zero current value is
 * reported as +100% — growth from nothing — rather than a division by zero.
 */
const pct = (current: number, previous: number): number => {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
};

const MINUTES_PER_HOUR = 60;

/** Longest period an HR attendance view will aggregate in one request. */
const MAX_PERIOD_DAYS = 366;

/** Indexed by Date#getUTCDay(), in the names WorkingHours.workingDays stores. */
const WEEKDAY_NAMES = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

/** Used when the tenant has not configured working hours yet. */
const DEFAULT_WORKING_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
];

/** Every calendar day from `from` to `to`, inclusive, as 'YYYY-MM-DD'. */
const eachDate = (from: string, to: string): string[] => {
  const days: string[] = [];
  let cursor = Date.parse(`${from}T00:00:00.000Z`);
  const last = Date.parse(`${to}T00:00:00.000Z`);
  // A malformed range would otherwise spin; the period cap bounds it anyway.
  while (cursor <= last && days.length <= MAX_PERIOD_DAYS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return days;
};

const weekdayOf = (date: string): string =>
  WEEKDAY_NAMES[new Date(`${date}T00:00:00.000Z`).getUTCDay()];

/** One employee's attendance over a period — a register row's figures. */
export interface AttendancePeriodSummary {
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  halfDay: number;
  holiday: number;
  recordedDays: number;
  /**
   * Working days (per the tenant's WorkingHours) inside the period, clipped
   * to the employee's joining/exit dates and never later than today.
   */
  expectedWorkingDays: number;
  /** Expected working days that have no record at all. */
  unmarkedDays: number;
  totalWorkedMinutes: number;
  totalWorkHours: string;
  avgWorkedMinutesPerDay: number;
  avgWorkHours: string;
  /**
   * Attended days over attended + absent + unmarked. Unmarked days count
   * against the rate, as they do on the KPI cards, so an unmaintained
   * register reads as incomplete rather than as a perfect score.
   */
  attendanceRate: number;
  /** Share of attended days that were not late. */
  punctualityRate: number;
}

export interface AttendanceEmployeeRef {
  id: string;
  employeeCode: string;
  name: string;
  avatarUrl: string | null;
  status: EmployeeStatus;
  joiningDate: string | null;
  department: { id: string; name: string } | null;
  designation: { id: string; title: string } | null;
}

export interface AttendanceRegisterRow {
  employee: AttendanceEmployeeRef;
  summary: AttendancePeriodSummary;
}

/**
 * How a calendar day reads on one employee's attendance calendar:
 * RECORDED has a row; UNMARKED is a past working day with none; WEEKLY_OFF
 * is a non-working weekday with none; UPCOMING is after today; and
 * NOT_EMPLOYED is before joining or after exit.
 */
export type AttendanceDayType =
  'RECORDED' | 'UNMARKED' | 'WEEKLY_OFF' | 'UPCOMING' | 'NOT_EMPLOYED';

/** Per-employee tallies an AttendancePeriodSummary is built from. */
interface StatusTally {
  counts: Map<string, number>;
  workedMinutes: number;
  workedDays: number;
  /** Records falling on a working weekday — what offsets expected days. */
  workingDayRecords: number;
}

const emptyTally = (): StatusTally => ({
  counts: new Map(),
  workedMinutes: 0,
  workedDays: 0,
  workingDayRecords: 0,
});

/** Statuses that mean the employee actually worked (and so accrued hours). */
const WORKED_STATUSES = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.LATE,
  AttendanceStatus.HALF_DAY,
];

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  /**
   * Narrows to the caller's team or department when their role is scoped
   * (see DataScopeService); `{}` for everyone else. `field` names the column
   * holding the employee id — `id` when querying employees themselves.
   */
  private async scopeWhere(tenantId: string, field = 'employeeId'): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, field) : {};
  }

  private async assertInScope(tenantId: string, employeeId: string): Promise<void> {
    if (this.dataScope) await this.dataScope.assertCanSee(tenantId, employeeId, 'Employee');
  }

  // ==========================================
  // Helpers
  // ==========================================

  private notFound(recordId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Attendance record '${recordId}' not found in this organization.`,
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

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** DATEONLY columns compare as 'YYYY-MM-DD' strings, so normalize to that. */
  private toDateOnly(value: string | Date): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return value.slice(0, 10);
  }

  private formatWorkHours(minutes: number | null): string | null {
    if (minutes === null || minutes === undefined) return null;
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const mins = minutes % MINUTES_PER_HOUR;
    return `${hours}h ${String(mins).padStart(2, '0')}m`;
  }

  private toRow(record: any): AttendanceRow {
    const employee = record.employee;
    return {
      id: record.id,
      date: this.toDateOnly(record.date),
      employee: employee
        ? {
            id: employee.id,
            employeeCode: employee.employeeCode,
            name: [employee.firstName, employee.lastName]
              .filter(Boolean)
              .join(' '),
            avatarUrl: employee.avatarUrl ?? null,
          }
        : {
            id: record.employeeId,
            employeeCode: '',
            name: '',
            avatarUrl: null,
          },
      department: employee?.department
        ? { id: employee.department.id, name: employee.department.name }
        : null,
      checkInAt: record.checkInAt ?? null,
      checkOutAt: record.checkOutAt ?? null,
      workedMinutes: record.workedMinutes ?? null,
      workHours: this.formatWorkHours(record.workedMinutes ?? null),
      status: record.status,
      source: record.source,
      notes: record.notes ?? null,
      dayEndStatus: record.dayEndStatus ?? null,
      workLocation: record.workLocation ?? null,
      overtimeMinutes: record.overtimeMinutes ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async buildInclude(tenantId: string, departmentId?: string) {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);

    return [
      {
        model: EmployeeModel,
        as: 'employee',
        attributes: [
          'id',
          'employeeCode',
          'firstName',
          'lastName',
          'avatarUrl',
          'departmentId',
        ],
        // A department filter has to narrow the join itself (required: true),
        // otherwise employees outside it come back with a null department.
        required: Boolean(departmentId),
        where: departmentId ? { departmentId } : undefined,
        include: [
          {
            model: DepartmentModel,
            as: 'department',
            attributes: ['id', 'name'],
            required: false,
          },
        ],
      },
    ];
  }

  /**
   * Date predicate for the table. An explicit range wins; a single `date`
   * pins one day; with neither, the screen is "Today's Attendance", so today.
   */
  private buildDateWhere(query: {
    date?: string;
    from?: string;
    to?: string;
  }): any {
    if (query.from || query.to) {
      const range: any = {};
      if (query.from) range[Op.gte] = this.toDateOnly(query.from);
      if (query.to) range[Op.lte] = this.toDateOnly(query.to);
      return range;
    }
    return this.toDateOnly(query.date ?? this.today());
  }

  private buildWhere(tenantId: string, query: GetAttendanceQuery): any {
    const where: any = { tenantId, date: this.buildDateWhere(query) };

    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.status && query.status !== AttendanceStatusFilter.ALL) {
      where.status = query.status;
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      // Employee columns live on the joined table, so the predicate has to
      // reference the alias rather than sit in the top-level where clause.
      where[Op.and] = [
        literal(
          `(concat("employee"."firstName", ' ', "employee"."lastName") ILIKE ${this.quote(term)}` +
            ` OR "employee"."employeeCode" ILIKE ${this.quote(term)})`,
        ),
      ];
    }

    return where;
  }

  /**
   * Single-quote a value for embedding in a raw SQL fragment. Only ever used
   * for the search term above, where the surrounding ILIKE comparison cannot
   * be expressed as a bind parameter through Sequelize's `literal`.
   */
  private quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private buildOrder(
    sortBy: AttendanceSortableField = 'date',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): any[] {
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    switch (sortBy) {
      case 'employeeName':
        return [
          [literal(`"employee"."firstName" ${dir}`)],
          [literal(`"employee"."lastName" ${dir}`)],
        ];
      case 'department':
        return [[literal(`"employee->department"."name" ${dir} NULLS LAST`)]];
      case 'checkInAt':
      case 'checkOutAt':
      case 'workedMinutes':
        return [[literal(`"AttendanceRecord"."${sortBy}" ${dir} NULLS LAST`)]];
      default:
        return [[sortBy, dir]];
    }
  }

  /**
   * The organization's attendance rules: its default shift (the same one
   * every attendance screen shows) and the Attendance Rules policy.
   */
  async getRules(tenantId: string): Promise<AttendanceRules> {
    const WorkingHoursModel =
      await this.modelProvider.getWorkingHoursModel(tenantId);
    const shift = await WorkingHoursModel.findOne({
      where: { tenantId },
      order: [['isDefault', 'DESC']],
    });
    const AttendancePolicyModel =
      await this.modelProvider.getAttendancePolicyModel(tenantId);
    const policy = await AttendancePolicyModel.findOne({ where: { tenantId } });
    return rulesFrom(shift, policy);
  }

  /**
   * Present / Late / Half Day / Absent from the organization's rules — shift
   * start plus grace in the shift's own time zone, then the half-day and
   * full-day hour thresholds once the day is checked out. Falls back to
   * PRESENT when working hours aren't configured: guessing a shift start
   * would silently mislabel punctual people.
   */
  private async deriveStatus(
    tenantId: string,
    date: string,
    checkInAt: Date | null,
    workedMinutes: number | null = null,
    rules?: AttendanceRules,
  ): Promise<AttendanceStatus> {
    if (!checkInAt) return AttendanceStatus.ABSENT;
    return statusFor(
      this.toDateOnly(date),
      checkInAt,
      workedMinutes,
      rules ?? (await this.getRules(tenantId)),
    );
  }

  private computeWorkedMinutes(
    checkInAt: Date | null,
    checkOutAt: Date | null,
  ): number | null {
    if (!checkInAt || !checkOutAt) return null;
    const diffMs = checkOutAt.getTime() - checkInAt.getTime();
    if (diffMs < 0) {
      this.badRequest('Check-out time cannot be earlier than check-in time.');
    }
    return Math.round(diffMs / 60000);
  }

  private async assertEmployeeExists(
    tenantId: string,
    employeeId: string,
  ): Promise<void> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const found = await EmployeeModel.findOne({
      where: { id: employeeId, tenantId },
      attributes: ['id'],
    });
    if (!found) {
      this.badRequest(
        `Employee '${employeeId}' not found in this organization.`,
      );
    }
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(
    tenantId: string,
    query: GetAttendanceQuery,
  ): Promise<{
    data: AttendanceRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);

    const { rows, count } = await AttendanceModel.findAndCountAll({
      where: { ...this.buildWhere(tenantId, query), ...(await this.scopeWhere(tenantId)) },
      include: await this.buildInclude(tenantId, query.departmentId),
      order: this.buildOrder(query.sortBy, query.sortOrder),
      offset: (page - 1) * limit,
      limit,
      distinct: false,
      subQuery: false,
    });

    return {
      data: (rows as any[]).map((row) => this.toRow(row)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /**
   * Capped at EXPORT_MAX_ROWS — attendance grows one row per employee per
   * day, so an unfiltered export over a multi-year history is the largest
   * result set in the system. Truncation is reported, not silent.
   */
  async getAllForExport(
    tenantId: string,
    query: Omit<GetAttendanceQuery, 'page' | 'limit'>,
  ): Promise<ExportResult<AttendanceRow>> {
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);

    const { rows, count } = await AttendanceModel.findAndCountAll({
      where: { ...this.buildWhere(tenantId, query), ...(await this.scopeWhere(tenantId)) },
      include: await this.buildInclude(tenantId, query.departmentId),
      order: this.buildOrder(query.sortBy, query.sortOrder),
      limit: EXPORT_MAX_ROWS,
      distinct: false,
      subQuery: false,
    });

    return {
      rows: (rows as any[]).map((row) => this.toRow(row)),
      totalMatched: count,
      truncated: count > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  async getOne(tenantId: string, recordId: string): Promise<AttendanceRow> {
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const record = await AttendanceModel.findOne({
      where: { id: recordId, tenantId, ...(await this.scopeWhere(tenantId)) },
      include: await this.buildInclude(tenantId),
    });
    if (!record) this.notFound(recordId);
    return this.toRow(record);
  }

  /** KPI cards: Present / Late / Absent / On Leave for a single day. */
  async getStats(tenantId: string, date?: string): Promise<AttendanceStats> {
    const day = this.toDateOnly(date ?? this.today());

    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    const [grouped, totalEmployees] = await Promise.all([
      AttendanceModel.findAll({
        where: { tenantId, date: day, ...(await this.scopeWhere(tenantId)) },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
      EmployeeModel.count({
        where: {
          tenantId,
          status: { [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] },
          ...(await this.scopeWhere(tenantId, 'id')),
        },
      }),
    ]);

    const byStatus = new Map<string, number>();
    for (const row of grouped as any[]) {
      byStatus.set(row.status, Number(row.count));
    }

    const presentToday = byStatus.get(AttendanceStatus.PRESENT) ?? 0;
    const lateToday = byStatus.get(AttendanceStatus.LATE) ?? 0;
    const absentToday = byStatus.get(AttendanceStatus.ABSENT) ?? 0;
    const onLeaveToday = byStatus.get(AttendanceStatus.ON_LEAVE) ?? 0;
    const halfDayToday = byStatus.get(AttendanceStatus.HALF_DAY) ?? 0;
    const holidayToday = byStatus.get(AttendanceStatus.HOLIDAY) ?? 0;

    const recorded =
      presentToday +
      lateToday +
      absentToday +
      onLeaveToday +
      halfDayToday +
      holidayToday;

    // Rates are expressed against headcount, not against however many rows
    // happen to exist, so a half-marked day reads as incomplete rather than
    // as a perfect 100%.
    const attended = presentToday + lateToday + halfDayToday;
    const rate = (part: number) =>
      totalEmployees === 0
        ? 0
        : Math.round((part / totalEmployees) * 1000) / 10;

    return {
      date: day,
      presentToday,
      lateToday,
      absentToday,
      onLeaveToday,
      halfDayToday,
      totalEmployees,
      recorded,
      unmarked: Math.max(0, totalEmployees - recorded),
      attendanceRate: rate(attended),
      punctualityRate:
        attended === 0
          ? 0
          : Math.round(((attended - lateToday) / attended) * 1000) / 10,
      growth: await this.computeDayOverDayGrowth(tenantId, day, {
        presentToday,
        lateToday,
        absentToday,
        onLeaveToday,
      }),
    };
  }

  /**
   * The "vs yesterday" line under each KPI card. One grouped query for the
   * previous day rather than a COUNT per card.
   *
   * The previous day is derived by stepping back 24h from UTC midnight of
   * `day`, so it never depends on the server's own timezone — building it
   * from a local Date would land on the wrong day either side of Greenwich.
   */
  private async computeDayOverDayGrowth(
    tenantId: string,
    day: string,
    current: {
      presentToday: number;
      lateToday: number;
      absentToday: number;
      onLeaveToday: number;
    },
  ): Promise<AttendanceStats['growth']> {
    const previousDay = new Date(
      Date.parse(`${day}T00:00:00.000Z`) - 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const grouped = await AttendanceModel.findAll({
      where: { tenantId, date: previousDay, ...(await this.scopeWhere(tenantId)) },
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
      raw: true,
    });

    const prior = new Map<string, number>();
    for (const row of grouped as any[]) {
      prior.set(row.status, Number(row.count));
    }
    const priorOf = (status: AttendanceStatus) => prior.get(status) ?? 0;

    return {
      presentToday: pct(
        current.presentToday,
        priorOf(AttendanceStatus.PRESENT),
      ),
      lateToday: pct(current.lateToday, priorOf(AttendanceStatus.LATE)),
      absentToday: pct(current.absentToday, priorOf(AttendanceStatus.ABSENT)),
      onLeaveToday: pct(
        current.onLeaveToday,
        priorOf(AttendanceStatus.ON_LEAVE),
      ),
    };
  }

  /**
   * Attendance Overview chart: one point per interval with present / late /
   * absent counts. Grouped in SQL via date_trunc so a year of daily data is
   * still a single query.
   */
  async getOverview(
    tenantId: string,
    options: {
      from?: string;
      to?: string;
      interval?: AttendanceTrendInterval;
      points?: number;
    },
  ): Promise<{
    interval: AttendanceTrendInterval;
    from: string;
    to: string;
    series: {
      period: string;
      present: number;
      late: number;
      absent: number;
      onLeave: number;
      total: number;
    }[];
  }> {
    const interval = options.interval ?? AttendanceTrendInterval.DAY;
    const points = options.points ?? 30;

    const to = this.toDateOnly(options.to ?? this.today());
    const from = options.from
      ? this.toDateOnly(options.from)
      : this.subtractIntervals(to, interval, points - 1);

    if (from > to) {
      this.badRequest('`from` must not be later than `to`.');
    }

    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);

    const truncUnit = {
      [AttendanceTrendInterval.DAY]: 'day',
      [AttendanceTrendInterval.WEEK]: 'week',
      [AttendanceTrendInterval.MONTH]: 'month',
    }[interval];

    // date_trunc as fn() rather than literal(): the unit is passed as a bound
    // argument instead of being interpolated into SQL, and GroupOption accepts
    // Fn but not Literal. Postgres casts the DATEONLY column to timestamp for
    // date_trunc on its own, so no explicit ::timestamp is needed.
    const period = fn('date_trunc', truncUnit, col('date'));

    const grouped = await AttendanceModel.findAll({
      where: { tenantId, date: { [Op.gte]: from, [Op.lte]: to }, ...(await this.scopeWhere(tenantId)) },
      attributes: [
        [period, 'period'],
        'status',
        [fn('COUNT', col('id')), 'count'],
      ],
      group: [period, 'status'],
      order: [[literal('period'), 'ASC']],
      raw: true,
    });

    const buckets = new Map<
      string,
      { present: number; late: number; absent: number; onLeave: number }
    >();

    for (const row of grouped as any[]) {
      const period = this.toDateOnly(new Date(row.period));
      let bucket = buckets.get(period);
      if (!bucket) {
        bucket = { present: 0, late: 0, absent: 0, onLeave: 0 };
        buckets.set(period, bucket);
      }
      const count = Number(row.count);
      if (row.status === AttendanceStatus.PRESENT) bucket.present += count;
      else if (row.status === AttendanceStatus.LATE) bucket.late += count;
      else if (row.status === AttendanceStatus.ABSENT) bucket.absent += count;
      else if (row.status === AttendanceStatus.ON_LEAVE)
        bucket.onLeave += count;
      else if (row.status === AttendanceStatus.HALF_DAY)
        bucket.present += count;
    }

    const series = [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([period, counts]) => ({
        period,
        ...counts,
        total: counts.present + counts.late + counts.absent + counts.onLeave,
      }));

    return { interval, from, to, series };
  }

  private subtractIntervals(
    fromDate: string,
    interval: AttendanceTrendInterval,
    count: number,
  ): string {
    const date = new Date(`${fromDate}T00:00:00.000Z`);
    if (interval === AttendanceTrendInterval.DAY) {
      date.setUTCDate(date.getUTCDate() - count);
    } else if (interval === AttendanceTrendInterval.WEEK) {
      date.setUTCDate(date.getUTCDate() - count * 7);
    } else {
      date.setUTCMonth(date.getUTCMonth() - count);
    }
    return date.toISOString().slice(0, 10);
  }

  /**
   * Department Wise Attendance donut: attendance rate per department, where
   * the rate is attended records over total records for that department.
   */
  async getByDepartment(
    tenantId: string,
    options: { date?: string; from?: string; to?: string },
  ): Promise<{
    from: string;
    to: string;
    total: number;
    departments: {
      departmentId: string | null;
      departmentName: string;
      present: number;
      late: number;
      absent: number;
      onLeave: number;
      total: number;
      attendanceRate: number;
    }[];
  }> {
    const dateWhere = this.buildDateWhere(options);
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);

    const grouped = await AttendanceModel.findAll({
      where: { tenantId, date: dateWhere, ...(await this.scopeWhere(tenantId)) },
      attributes: [
        'status',
        [fn('COUNT', col('AttendanceRecord.id')), 'count'],
      ],
      include: [
        {
          model: EmployeeModel,
          as: 'employee',
          attributes: ['departmentId'],
          required: true,
          include: [
            {
              model: DepartmentModel,
              as: 'department',
              attributes: ['id', 'name'],
              required: false,
            },
          ],
        },
      ],
      group: [
        'AttendanceRecord.status',
        'employee.departmentId',
        'employee->department.id',
        'employee->department.name',
      ],
      raw: true,
      nest: true,
    });

    const byDepartment = new Map<
      string,
      {
        departmentId: string | null;
        departmentName: string;
        present: number;
        late: number;
        absent: number;
        onLeave: number;
      }
    >();

    for (const row of grouped as any[]) {
      const departmentId = row.employee?.department?.id ?? null;
      const departmentName = row.employee?.department?.name ?? 'Unassigned';
      const key = departmentId ?? 'unassigned';

      let bucket = byDepartment.get(key);
      if (!bucket) {
        bucket = {
          departmentId,
          departmentName,
          present: 0,
          late: 0,
          absent: 0,
          onLeave: 0,
        };
        byDepartment.set(key, bucket);
      }
      const count = Number(row.count);
      if (row.status === AttendanceStatus.PRESENT) bucket.present += count;
      else if (row.status === AttendanceStatus.LATE) bucket.late += count;
      else if (row.status === AttendanceStatus.ABSENT) bucket.absent += count;
      else if (row.status === AttendanceStatus.ON_LEAVE)
        bucket.onLeave += count;
      else if (row.status === AttendanceStatus.HALF_DAY)
        bucket.present += count;
    }

    const departments = [...byDepartment.values()]
      .map((entry) => {
        const total = entry.present + entry.late + entry.absent + entry.onLeave;
        const attended = entry.present + entry.late;
        return {
          ...entry,
          total,
          attendanceRate:
            total === 0 ? 0 : Math.round((attended / total) * 1000) / 10,
        };
      })
      .sort((a, b) => b.total - a.total);

    const resolvedDate = this.toDateOnly(options.date ?? this.today());
    return {
      from: options.from ? this.toDateOnly(options.from) : resolvedDate,
      to: options.to ? this.toDateOnly(options.to) : resolvedDate,
      total: departments.reduce((sum, entry) => sum + entry.total, 0),
      departments,
    };
  }

  // ==========================================
  // Writes (admin manual entry / correction)
  // ==========================================

  async create(
    tenantId: string,
    dto: CreateAttendanceRecordDto,
    markedByUserId?: string,
    /**
     * Who produced the record. Defaults to MANUAL — an admin typing it in —
     * so existing callers are unchanged; the employee portal passes
     * SELF_SERVICE so HR can tell a punch from an entry made on someone's
     * behalf.
     */
    source: AttendanceSource = AttendanceSource.MANUAL,
  ): Promise<AttendanceRow> {
    await this.assertEmployeeExists(tenantId, dto.employeeId);
    await this.assertInScope(tenantId, dto.employeeId);

    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const date = this.toDateOnly(dto.date);

    const existing = await AttendanceModel.findOne({
      where: { tenantId, employeeId: dto.employeeId, date },
    });
    if (existing) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Attendance for this employee on ${date} already exists. Update record '${existing.id}' instead.`,
        HttpStatus.CONFLICT,
      );
    }

    const checkInAt = dto.checkInAt ? new Date(dto.checkInAt) : null;
    const checkOutAt = dto.checkOutAt ? new Date(dto.checkOutAt) : null;
    const workedMinutes = this.computeWorkedMinutes(checkInAt, checkOutAt);
    const rules = await this.getRules(tenantId);
    const overtime = autoOvertimeMinutes(date, workedMinutes, rules);

    const created = await AttendanceModel.create({
      tenantId,
      employeeId: dto.employeeId,
      date,
      checkInAt,
      checkOutAt,
      workedMinutes,
      status:
        dto.status ??
        (await this.deriveStatus(tenantId, date, checkInAt, workedMinutes, rules)),
      ...(overtime !== undefined ? { overtimeMinutes: overtime } : {}),
      source,
      notes: dto.notes ?? null,
      markedByUserId: markedByUserId ?? null,
    });

    return this.getOne(tenantId, created.id);
  }

  async update(
    tenantId: string,
    recordId: string,
    dto: UpdateAttendanceRecordDto,
    markedByUserId?: string,
  ): Promise<AttendanceRow> {
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const record = await AttendanceModel.findOne({
      where: { id: recordId, tenantId, ...(await this.scopeWhere(tenantId)) },
    });
    if (!record) this.notFound(recordId);

    const patch: any = {
      markedByUserId: markedByUserId ?? record.markedByUserId,
    };

    if (dto.date !== undefined) {
      const date = this.toDateOnly(dto.date);
      if (date !== this.toDateOnly(record.date)) {
        const clash = await AttendanceModel.findOne({
          where: {
            tenantId,
            employeeId: record.employeeId,
            date,
            id: { [Op.ne]: recordId },
          },
        });
        if (clash) {
          throw new TenantException(
            TenantErrorCode.INVALID_TENANT_CONTEXT,
            `This employee already has an attendance record for ${date}.`,
            HttpStatus.CONFLICT,
          );
        }
      }
      patch.date = date;
    }

    const checkInAt =
      dto.checkInAt !== undefined
        ? dto.checkInAt
          ? new Date(dto.checkInAt)
          : null
        : record.checkInAt;
    const checkOutAt =
      dto.checkOutAt !== undefined
        ? dto.checkOutAt
          ? new Date(dto.checkOutAt)
          : null
        : record.checkOutAt;

    const timesChanged =
      dto.checkInAt !== undefined || dto.checkOutAt !== undefined;
    if (dto.checkInAt !== undefined) patch.checkInAt = checkInAt;
    if (dto.checkOutAt !== undefined) patch.checkOutAt = checkOutAt;
    if (timesChanged) {
      patch.workedMinutes = this.computeWorkedMinutes(checkInAt, checkOutAt);
    }

    const date = patch.date ?? this.toDateOnly(record.date);
    const rules = timesChanged ? await this.getRules(tenantId) : undefined;

    // Statuses the rules produce. Leave, holiday or an Absent HR marked on a
    // day with no punch are HR's call, so a check-out alone never rewrites them.
    const ruleDerived =
      [
        AttendanceStatus.PRESENT,
        AttendanceStatus.LATE,
        AttendanceStatus.HALF_DAY,
      ].includes(record.status) ||
      (record.status === AttendanceStatus.ABSENT && Boolean(record.checkInAt));

    if (dto.status !== undefined) {
      patch.status = dto.status;
    } else if (
      dto.checkInAt !== undefined ||
      (dto.checkOutAt !== undefined && ruleDerived)
    ) {
      // Times moved but the admin didn't name a status, so re-derive it
      // rather than leaving a stale PRESENT on a now-late or short day.
      patch.status = await this.deriveStatus(
        tenantId,
        date,
        checkInAt,
        patch.workedMinutes ?? null,
        rules,
      );
    }

    if (rules) {
      // Keep an approved overtime figure: only replace what the rules
      // themselves put there (or an empty value).
      const previousAuto = autoOvertimeMinutes(
        this.toDateOnly(record.date),
        record.workedMinutes ?? null,
        rules,
      );
      const current = record.overtimeMinutes ?? null;
      const next = autoOvertimeMinutes(date, patch.workedMinutes ?? null, rules);
      if (
        next !== undefined &&
        (current === null || current === (previousAuto ?? null))
      ) {
        patch.overtimeMinutes = next;
      }
    }

    if (dto.notes !== undefined) patch.notes = dto.notes;

    await record.update(patch);
    return this.getOne(tenantId, recordId);
  }

  async remove(
    tenantId: string,
    recordId: string,
  ): Promise<{ message: string }> {
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const record = await AttendanceModel.findOne({
      where: { id: recordId, tenantId, ...(await this.scopeWhere(tenantId)) },
    });
    if (!record) this.notFound(recordId);
    await record.destroy();
    return { message: 'Attendance record deleted successfully.' };
  }

  /**
   * Mark a whole day at once. Upserts per employee so re-running for the
   * same date corrects the existing rows instead of colliding with the
   * (employeeId, date) unique index.
   */
  async bulkMark(
    tenantId: string,
    dto: BulkMarkAttendanceDto,
    markedByUserId?: string,
  ): Promise<{
    date: string;
    created: number;
    updated: number;
    skipped: string[];
  }> {
    const date = this.toDateOnly(dto.date);
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    const entries = [...dto.entries];

    // Anyone active but absent from `entries` gets the fill status, so an
    // admin can mark exceptions and let the rest default.
    if (dto.fillRemainingWith) {
      const named = new Set(entries.map((entry) => entry.employeeId));
      const active = await EmployeeModel.findAll({
        where: { tenantId, status: EmployeeStatus.ACTIVE, ...(await this.scopeWhere(tenantId, 'id')) },
        attributes: ['id'],
        raw: true,
      });
      for (const row of active as any[]) {
        if (!named.has(row.id)) {
          entries.push({ employeeId: row.id, status: dto.fillRemainingWith });
        }
      }
    }

    if (entries.length === 0) {
      this.badRequest('No attendance entries to apply.');
    }

    const validIds = new Set(
      (
        (await EmployeeModel.findAll({
          where: {
            tenantId,
            // Anyone outside the caller's team/department is skipped, not marked.
            [Op.and]: [
              { id: { [Op.in]: entries.map((e) => e.employeeId) } },
              await this.scopeWhere(tenantId, 'id'),
            ],
          },
          attributes: ['id'],
          raw: true,
        })) as any[]
      ).map((row) => row.id),
    );

    const skipped: string[] = [];
    const applicable = entries.filter((entry) => {
      if (validIds.has(entry.employeeId)) return true;
      skipped.push(entry.employeeId);
      return false;
    });

    // One query to learn which rows already exist, instead of a findOne per
    // employee. Marking a whole day for a 500-person organization previously
    // issued 500 SELECTs plus 500 INSERT/UPDATEs serially — ~1,000 sequential
    // round trips, which is minutes of wall clock on networked Postgres and
    // the single slowest write path in the service.
    const existingIds = new Set(
      (
        (await AttendanceModel.findAll({
          where: {
            tenantId,
            date,
            employeeId: { [Op.in]: applicable.map((e) => e.employeeId) },
          },
          attributes: ['employeeId'],
          raw: true,
        })) as any[]
      ).map((row) => row.employeeId),
    );

    const rows = applicable.map((entry) => {
      const checkInAt = entry.checkInAt ? new Date(entry.checkInAt) : null;
      const checkOutAt = entry.checkOutAt ? new Date(entry.checkOutAt) : null;
      return {
        tenantId,
        employeeId: entry.employeeId,
        date,
        checkInAt,
        checkOutAt,
        workedMinutes: this.computeWorkedMinutes(checkInAt, checkOutAt),
        status: entry.status,
        source: AttendanceSource.MANUAL,
        notes: entry.notes ?? null,
        markedByUserId: markedByUserId ?? null,
      };
    });

    // Counted before the write, from the pre-read: `bulkCreate` cannot report
    // which rows it inserted versus updated, and re-querying afterwards would
    // not distinguish them either.
    const updated = rows.filter((row) =>
      existingIds.has(row.employeeId),
    ).length;
    const created = rows.length - updated;

    if (rows.length > 0) {
      // One statement, and atomic: a partial bulk-mark would leave the day
      // half-applied with no indication of where it stopped.
      // `updateOnDuplicate` resolves against the existing
      // `unique_attendance_employee_date` index on (employeeId, date) — the
      // same constraint the single-record path already relies on for
      // idempotency, so re-running a bulk-mark updates rather than failing on
      // a duplicate key.
      await AttendanceModel.bulkCreate(rows as any[], {
        updateOnDuplicate: [
          'checkInAt',
          'checkOutAt',
          'workedMinutes',
          'status',
          'source',
          'notes',
          'markedByUserId',
          'updatedAt',
        ],
      });
    }

    this.logger.log(
      `Bulk attendance for tenant ${tenantId} on ${date}: ${created} created, ${updated} updated, ${skipped.length} skipped`,
    );
    return { date, created, updated, skipped };
  }

  // ==========================================
  // HR: screen aggregate, all-employee register, per-employee detail,
  // unmarked follow-up list
  // ==========================================

  /**
   * The whole Attendance screen in one round trip — KPI cards, overview
   * chart, department breakdown and the first page of the day's table.
   * Composes the existing reads so the screen and its individual endpoints
   * can never disagree.
   */
  async getDashboard(
    tenantId: string,
    query: AttendanceDashboardQueryDto = {},
  ) {
    const date = this.toDateOnly(query.date ?? this.today());
    const [stats, overview, byDepartment, todayAttendance] = await Promise.all([
      this.getStats(tenantId, date),
      this.getOverview(tenantId, {
        to: date,
        interval: query.interval,
        points: query.points,
      }),
      this.getByDepartment(tenantId, { date }),
      this.getAll(tenantId, { date, page: 1, limit: 10 }),
    ]);
    return { date, stats, overview, byDepartment, todayAttendance };
  }

  /**
   * All Employees Attendance register: one row per employee with their
   * present / late / absent / leave / unmarked days and hours for a period.
   * Paginates employees first, then aggregates only that page in one
   * grouped query.
   */
  async getRegister(tenantId: string, query: AttendanceRegisterQueryDto = {}) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;
    const period = this.resolvePeriod(query);

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const { rows, count } = await EmployeeModel.findAndCountAll({
      where: this.buildRegisterEmployeeWhere(tenantId, query, period),
      include: await this.buildEmployeeInclude(tenantId),
      order: this.buildRegisterOrder(query.sortBy, query.sortOrder),
      offset: (page - 1) * limit,
      limit,
      distinct: true,
    });

    const workingDays = await this.getWorkingDays(tenantId);
    const data = await this.buildRegisterRows(
      tenantId,
      rows as any[],
      period,
      workingDays,
    );

    return {
      ...period,
      workingDays: [...workingDays],
      data,
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /** The register without pagination, capped at EXPORT_MAX_ROWS employees. */
  async getRegisterForExport(
    tenantId: string,
    query: ExportAttendanceRegisterQueryDto = {},
  ): Promise<
    ExportResult<AttendanceRegisterRow> & { from: string; to: string }
  > {
    const period = this.resolvePeriod(query);

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const { rows, count } = await EmployeeModel.findAndCountAll({
      where: this.buildRegisterEmployeeWhere(tenantId, query, period),
      include: await this.buildEmployeeInclude(tenantId),
      order: this.buildRegisterOrder(query.sortBy, query.sortOrder),
      limit: EXPORT_MAX_ROWS,
      distinct: true,
    });

    const workingDays = await this.getWorkingDays(tenantId);
    const data = await this.buildRegisterRows(
      tenantId,
      rows as any[],
      period,
      workingDays,
    );

    return {
      from: period.from,
      to: period.to,
      rows: data,
      totalMatched: count,
      truncated: count > data.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  /**
   * One employee's attendance calendar for a period: every day, recorded or
   * not, so HR can see the gaps, plus the same summary the register shows.
   */
  async getEmployeeAttendance(
    tenantId: string,
    employeeId: string,
    query: AttendancePeriodQueryDto = {},
  ) {
    const period = this.resolvePeriod(query);

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await EmployeeModel.findOne({
      where: { id: employeeId, tenantId },
      include: await this.buildEmployeeInclude(tenantId),
    });
    if (!employee) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Employee '${employeeId}' not found in this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const [records, workingDays, leaveByDate] = await Promise.all([
      AttendanceModel.findAll({
        where: {
          tenantId,
          employeeId,
          date: { [Op.gte]: period.from, [Op.lte]: period.to },
        },
        order: [['date', 'ASC']],
      }),
      this.getWorkingDays(tenantId),
      this.leaveTypeByDate(tenantId, employeeId, period.from, period.to),
    ]);

    const byDate = new Map<string, any>();
    const tally = emptyTally();
    for (const record of records as any[]) {
      const date = this.toDateOnly(record.date);
      byDate.set(date, record);
      this.addToTally(tally, record.status, 1, record.workedMinutes, {
        workedDays:
          record.workedMinutes !== null && record.workedMinutes !== undefined
            ? 1
            : 0,
        workingDayRecords: workingDays.has(weekdayOf(date)) ? 1 : 0,
      });
    }

    const today = this.today();
    const { start, end } = this.employmentWindow(employee, period, today);
    const exit = employee.exitDate ? this.toDateOnly(employee.exitDate) : null;

    const days = eachDate(period.from, period.to).map((date) => {
      const record = byDate.get(date);
      const isWorkingDay = workingDays.has(weekdayOf(date));
      let dayType: AttendanceDayType;
      if (record) dayType = 'RECORDED';
      else if (date < start || (exit && date > exit)) dayType = 'NOT_EMPLOYED';
      else if (date > today) dayType = 'UPCOMING';
      else dayType = isWorkingDay ? 'UNMARKED' : 'WEEKLY_OFF';

      return {
        date,
        weekday: weekdayOf(date),
        isWorkingDay,
        dayType,
        status: (record?.status as AttendanceStatus) ?? null,
        leaveType:
          record?.status === AttendanceStatus.ON_LEAVE
            ? (leaveByDate.get(date) ?? null)
            : null,
        record: record
          ? {
              id: record.id,
              checkInAt: record.checkInAt ?? null,
              checkOutAt: record.checkOutAt ?? null,
              workedMinutes: record.workedMinutes ?? null,
              workHours: this.formatWorkHours(record.workedMinutes ?? null),
              source: record.source,
              notes: record.notes ?? null,
              dayEndStatus: record.dayEndStatus ?? null,
            }
          : null,
      };
    });

    return {
      ...period,
      workingDays: [...workingDays],
      employee: this.toEmployeeRef(employee),
      summary: this.summarize(
        tally,
        this.countWorkingDates(start, end, workingDays),
      ),
      days,
    };
  }

  /**
   * Employees expected on a day who have no record for it yet — the list HR
   * works through before closing the day (or bulk-marks with
   * `fillRemainingWith`). Resolved with NOT EXISTS so it stays one query
   * however large the organization is.
   */
  async getUnmarked(tenantId: string, query: UnmarkedAttendanceQueryDto = {}) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const date = this.toDateOnly(query.date ?? this.today());

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);

    const table: any = AttendanceModel.getTableName();
    const tableSql =
      typeof table === 'string'
        ? `"${table}"`
        : `"${table.schema}"."${table.tableName}"`;

    const conditions: any[] = [
      { [Op.or]: [{ joiningDate: null }, { joiningDate: { [Op.lte]: date } }] },
      { [Op.or]: [{ exitDate: null }, { exitDate: { [Op.gte]: date } }] },
      literal(
        `NOT EXISTS (SELECT 1 FROM ${tableSql} AS "ar" WHERE "ar"."employeeId" = "Employee"."id" AND "ar"."date" = ${this.quote(date)})`,
      ),
    ];
    const search = this.buildEmployeeSearch(query.search);
    if (search) conditions.push(search);

    const where: any = {
      tenantId,
      status: { [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] },
      [Op.and]: conditions,
    };
    if (query.departmentId) where.departmentId = query.departmentId;

    const [{ rows, count }, workingDays] = await Promise.all([
      EmployeeModel.findAndCountAll({
        where,
        include: await this.buildEmployeeInclude(tenantId),
        order: this.buildRegisterOrder('employeeName', 'ASC'),
        offset: (page - 1) * limit,
        limit,
        distinct: true,
      }),
      this.getWorkingDays(tenantId),
    ]);

    return {
      date,
      isWorkingDay: workingDays.has(weekdayOf(date)),
      data: (rows as any[]).map((row) => this.toEmployeeRef(row)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  // ---------- HR view helpers ----------

  /**
   * The period an HR view reports on. An explicit range wins over `month`;
   * with neither, the current calendar month.
   */
  private resolvePeriod(query: AttendancePeriodQueryDto = {}): {
    month: string | null;
    from: string;
    to: string;
  } {
    let month: string | null = null;
    let from: string;
    let to: string;

    if (query.from || query.to) {
      to = this.toDateOnly(query.to ?? this.today());
      from = query.from ? this.toDateOnly(query.from) : `${to.slice(0, 7)}-01`;
    } else {
      month = query.month ?? this.today().slice(0, 7);
      const [year, monthNumber] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      from = `${month}-01`;
      to = `${month}-${String(lastDay).padStart(2, '0')}`;
    }

    if (from > to) this.badRequest('`from` must not be later than `to`.');
    const spanDays =
      (Date.parse(`${to}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000 +
      1;
    if (spanDays > MAX_PERIOD_DAYS) {
      this.badRequest(
        `The period can cover at most ${MAX_PERIOD_DAYS} days; got ${spanDays}.`,
      );
    }
    return { month, from, to };
  }

  /**
   * Weekday names the default shift works; Monday–Friday if none is set.
   * Public so leave day-counting uses the same definition of a working day.
   */
  async getWorkingDays(tenantId: string): Promise<Set<string>> {
    const WorkingHoursModel =
      await this.modelProvider.getWorkingHoursModel(tenantId);
    const shift = await WorkingHoursModel.findOne({
      where: { tenantId },
      order: [['isDefault', 'DESC']],
    });
    const days: string[] =
      Array.isArray(shift?.workingDays) && shift.workingDays.length
        ? shift.workingDays
        : DEFAULT_WORKING_DAYS;
    // Shifts are stored as 'Mon' (the shifts screen) or 'MONDAY' (organization
    // setup). Every caller compares against WEEKDAY_NAMES, so normalise both
    // forms to the full name — upper-casing alone turned 'Mon' into 'MON',
    // which matched nothing and made every day a non-working day.
    const full = days
      .map((day) => WEEKDAY_NAMES.find((name) => name.startsWith(String(day).trim().slice(0, 3).toUpperCase())))
      .filter((name): name is string => Boolean(name));
    return new Set(full.length ? full : DEFAULT_WORKING_DAYS);
  }

  private async buildEmployeeInclude(tenantId: string) {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const DesignationModel =
      await this.modelProvider.getDesignationModel(tenantId);
    return [
      {
        model: DepartmentModel,
        as: 'department',
        attributes: ['id', 'name'],
        required: false,
      },
      {
        model: DesignationModel,
        as: 'designation',
        attributes: ['id', 'title'],
        required: false,
      },
    ];
  }

  private buildEmployeeSearch(search?: string): any {
    if (!search?.trim()) return null;
    const term = `%${search.trim()}%`;
    return {
      [Op.or]: [
        sqlWhere(
          fn(
            'concat',
            col('Employee.firstName'),
            ' ',
            col('Employee.lastName'),
          ),
          { [Op.iLike]: term },
        ),
        { employeeCode: { [Op.iLike]: term } },
      ],
    };
  }

  /**
   * Everyone employed at some point in the period: joined by its end, and
   * either still on the books or exited no earlier than its start — so
   * someone who resigned mid-month still has that month's row.
   */
  private buildRegisterEmployeeWhere(
    tenantId: string,
    query: { search?: string; departmentId?: string },
    period: { from: string; to: string },
  ): any {
    const conditions: any[] = [
      {
        [Op.or]: [
          { joiningDate: null },
          { joiningDate: { [Op.lte]: period.to } },
        ],
      },
      {
        [Op.or]: [
          {
            status: {
              [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE],
            },
          },
          { exitDate: { [Op.gte]: period.from } },
        ],
      },
    ];
    const search = this.buildEmployeeSearch(query.search);
    if (search) conditions.push(search);

    const where: any = { tenantId, [Op.and]: conditions };
    if (query.departmentId) where.departmentId = query.departmentId;
    return where;
  }

  private buildRegisterOrder(
    sortBy: string = 'employeeName',
    sortOrder: 'ASC' | 'DESC' = 'ASC',
  ): any[] {
    const dir = sortOrder === 'DESC' ? 'DESC' : 'ASC';
    // `id` last on every ordering so pages never overlap or skip on ties.
    switch (sortBy) {
      case 'employeeCode':
        return [
          ['employeeCode', dir],
          ['id', 'ASC'],
        ];
      case 'department':
        return [
          [literal(`"department"."name" ${dir} NULLS LAST`)],
          ['firstName', 'ASC'],
          ['id', 'ASC'],
        ];
      case 'joiningDate':
        return [
          [literal(`"Employee"."joiningDate" ${dir} NULLS LAST`)],
          ['id', 'ASC'],
        ];
      default:
        return [
          ['firstName', dir],
          ['lastName', dir],
          ['id', 'ASC'],
        ];
    }
  }

  /**
   * One grouped query per chunk of employees: per (employee, status) the
   * record count, worked minutes, and how many records fall on a working
   * weekday. Chunked so an export's IN list stays a sane size.
   */
  private async tallyByEmployee(
    tenantId: string,
    employeeIds: string[],
    period: { from: string; to: string },
    workingDays: Set<string>,
  ): Promise<Map<string, StatusTally>> {
    const tallies = new Map<string, StatusTally>();
    if (employeeIds.length === 0) return tallies;

    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);

    // Postgres DOW is 0 = Sunday, the same indexing as WEEKDAY_NAMES. The
    // values are integers derived here, never user input.
    const dows = WEEKDAY_NAMES.map((name, index) =>
      workingDays.has(name) ? index : -1,
    ).filter((index) => index >= 0);
    const workingDayCount = dows.length
      ? literal(
          `COUNT(*) FILTER (WHERE EXTRACT(DOW FROM "date") IN (${dows.join(',')}))`,
        )
      : literal('0');

    const CHUNK = 1000;
    for (let i = 0; i < employeeIds.length; i += CHUNK) {
      const grouped = await AttendanceModel.findAll({
        where: {
          tenantId,
          employeeId: { [Op.in]: employeeIds.slice(i, i + CHUNK) },
          date: { [Op.gte]: period.from, [Op.lte]: period.to },
        },
        attributes: [
          'employeeId',
          'status',
          [fn('COUNT', col('id')), 'count'],
          [fn('COALESCE', fn('SUM', col('workedMinutes')), 0), 'workedMinutes'],
          [fn('COUNT', col('workedMinutes')), 'workedDays'],
          [workingDayCount, 'workingDayRecords'],
        ],
        group: ['employeeId', 'status'],
        raw: true,
      });

      for (const row of grouped as any[]) {
        let tally = tallies.get(row.employeeId);
        if (!tally) {
          tally = emptyTally();
          tallies.set(row.employeeId, tally);
        }
        this.addToTally(
          tally,
          row.status,
          Number(row.count),
          row.workedMinutes,
          {
            workedDays: Number(row.workedDays) || 0,
            workingDayRecords: Number(row.workingDayRecords) || 0,
          },
        );
      }
    }
    return tallies;
  }

  private addToTally(
    tally: StatusTally,
    status: string,
    count: number,
    workedMinutes: number | string | null | undefined,
    extra: { workedDays: number; workingDayRecords: number },
  ): void {
    tally.counts.set(status, (tally.counts.get(status) ?? 0) + count);
    tally.workedMinutes += Number(workedMinutes) || 0;
    tally.workedDays += extra.workedDays;
    tally.workingDayRecords += extra.workingDayRecords;
  }

  private async buildRegisterRows(
    tenantId: string,
    employees: any[],
    period: { from: string; to: string },
    workingDays: Set<string>,
  ): Promise<AttendanceRegisterRow[]> {
    const tallies = await this.tallyByEmployee(
      tenantId,
      employees.map((employee) => employee.id),
      period,
      workingDays,
    );
    const today = this.today();

    return employees.map((employee) => {
      const { start, end } = this.employmentWindow(employee, period, today);
      return {
        employee: this.toEmployeeRef(employee),
        summary: this.summarize(
          tallies.get(employee.id) ?? emptyTally(),
          this.countWorkingDates(start, end, workingDays),
        ),
      };
    });
  }

  /**
   * The slice of the period an employee was expected to attend: from the
   * later of period start and joining date, to the earliest of period end,
   * today and exit date. `start > end` means no expected days.
   */
  private employmentWindow(
    employee: any,
    period: { from: string; to: string },
    today: string,
  ): { start: string; end: string } {
    const joining = employee.joiningDate
      ? this.toDateOnly(employee.joiningDate)
      : null;
    const exit = employee.exitDate ? this.toDateOnly(employee.exitDate) : null;
    const start = joining && joining > period.from ? joining : period.from;
    let end = period.to < today ? period.to : today;
    if (exit && exit < end) end = exit;
    return { start, end };
  }

  private countWorkingDates(
    start: string,
    end: string,
    workingDays: Set<string>,
  ): number {
    if (start > end) return 0;
    return eachDate(start, end).filter((date) =>
      workingDays.has(weekdayOf(date)),
    ).length;
  }

  private summarize(
    tally: StatusTally,
    expectedWorkingDays: number,
  ): AttendancePeriodSummary {
    const of = (status: AttendanceStatus) => tally.counts.get(status) ?? 0;
    const present = of(AttendanceStatus.PRESENT);
    const late = of(AttendanceStatus.LATE);
    const absent = of(AttendanceStatus.ABSENT);
    const onLeave = of(AttendanceStatus.ON_LEAVE);
    const halfDay = of(AttendanceStatus.HALF_DAY);
    const holiday = of(AttendanceStatus.HOLIDAY);

    const recordedDays = [...tally.counts.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    const unmarkedDays = Math.max(
      0,
      expectedWorkingDays - tally.workingDayRecords,
    );
    const attended = present + late + halfDay;
    const denominator = attended + absent + unmarkedDays;
    const avgWorkedMinutesPerDay = tally.workedDays
      ? Math.round(tally.workedMinutes / tally.workedDays)
      : 0;

    return {
      present,
      late,
      absent,
      onLeave,
      halfDay,
      holiday,
      recordedDays,
      expectedWorkingDays,
      unmarkedDays,
      totalWorkedMinutes: tally.workedMinutes,
      totalWorkHours: this.formatWorkHours(tally.workedMinutes) ?? '0h 00m',
      avgWorkedMinutesPerDay,
      avgWorkHours: this.formatWorkHours(avgWorkedMinutesPerDay) ?? '0h 00m',
      attendanceRate:
        denominator === 0
          ? 0
          : Math.round((attended / denominator) * 1000) / 10,
      punctualityRate:
        attended === 0
          ? 0
          : Math.round(((attended - late) / attended) * 1000) / 10,
    };
  }

  private toEmployeeRef(employee: any): AttendanceEmployeeRef {
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
      avatarUrl: employee.avatarUrl ?? null,
      status: employee.status,
      joiningDate: employee.joiningDate
        ? this.toDateOnly(employee.joiningDate)
        : null,
      department: employee.department
        ? { id: employee.department.id, name: employee.department.name }
        : null,
      designation: employee.designation
        ? { id: employee.designation.id, title: employee.designation.title }
        : null,
    };
  }

  /**
   * Maps each day of an approved leave to its type, so an ON_LEAVE day on
   * the calendar reads "Sick Leave" rather than the generic status.
   */
  private async leaveTypeByDate(
    tenantId: string,
    employeeId: string,
    from: string,
    to: string,
  ): Promise<Map<string, string>> {
    const byDate = new Map<string, string>();
    try {
      const LeaveModel =
        await this.modelProvider.getLeaveRequestModel(tenantId);
      const PolicyModel =
        await this.modelProvider.getLeavePolicyModel(tenantId);
      const leaves = await LeaveModel.findAll({
        where: {
          tenantId,
          employeeId,
          status: LeaveRequestStatus.APPROVED,
          fromDate: { [Op.lte]: to },
          toDate: { [Op.gte]: from },
        },
        include: [
          {
            model: PolicyModel,
            as: 'leavePolicy',
            attributes: ['id', 'name'],
            required: false,
          },
        ],
      });

      for (const leave of leaves as any[]) {
        const name = leave.leavePolicy?.name;
        if (!name) continue;
        const start = this.toDateOnly(leave.fromDate);
        const end = this.toDateOnly(leave.toDate);
        for (const date of eachDate(
          start > from ? start : from,
          end < to ? end : to,
        )) {
          byDate.set(date, name);
        }
      }
    } catch (error: any) {
      // A label, not the data — the calendar still renders with "On Leave".
      this.logger.warn(
        `Could not resolve leave types for employee attendance: ${error?.message ?? error}`,
      );
    }
    return byDate;
  }

  /** Total worked minutes over a range — used by payroll-facing summaries. */
  async sumWorkedMinutes(
    tenantId: string,
    employeeId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const AttendanceModel =
      await this.modelProvider.getAttendanceRecordModel(tenantId);
    const total = await AttendanceModel.sum('workedMinutes', {
      where: {
        tenantId,
        employeeId,
        status: { [Op.in]: WORKED_STATUSES },
        date: {
          [Op.gte]: this.toDateOnly(from),
          [Op.lte]: this.toDateOnly(to),
        },
      },
    });
    return Number(total) || 0;
  }
}
