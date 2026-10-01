import { HttpStatus, Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  EXPORT_MAX_ROWS,
  GenerateHrReportDto,
  HrReportFormat,
  HrReportRange,
  HrReportType,
  LeaveRequestStatus,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

interface ReportWindow {
  from: string;
  to: string;
  label: string;
}

const TEMPLATES: {
  type: HrReportType;
  title: string;
  description: string;
}[] = [
  {
    type: HrReportType.EMPLOYEE,
    title: 'Employee Report',
    description: 'Full employee list with details, status, and tenure',
  },
  {
    type: HrReportType.ATTENDANCE,
    title: 'Attendance Report',
    description: 'Daily/weekly/monthly attendance summary and trends',
  },
  {
    type: HrReportType.LEAVE,
    title: 'Leave Report',
    description: 'Leave requests, approvals, and balances by employee/dept',
  },
  {
    type: HrReportType.ONBOARDING,
    title: 'Onboarding Report',
    description: 'New joiner progress and pending onboarding tasks',
  },
  {
    type: HrReportType.DEPARTMENT_SUMMARY,
    title: 'Department Summary',
    description: 'Headcount, attendance, and leave summary by department',
  },
  {
    type: HrReportType.CUSTOM,
    title: 'Custom Report',
    description: 'Build a custom report with your own filters and columns',
  },
];

/**
 * Formats the date's own calendar day, not its UTC one.
 *
 * `toISOString().slice(0, 10)` looks equivalent and is not: every bound here
 * is built with `new Date(year, month, day)`, which is local midnight, and in
 * any zone ahead of UTC that instant is still the previous day in UTC. Going
 * through ISO would have shifted every report window back a day — "This
 * Month" starting on the 31st of the month before.
 */
const toDateOnly = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

function timeAgo(date: Date | null): string {
  if (!date) return 'Never';
  const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/** Whole months, for a tenure column that reads in years and months. */
function tenureLabel(joiningDate: string | null): string {
  if (!joiningDate) return '—';
  const [year, month, day] = joiningDate.slice(0, 10).split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const now = new Date();
  let months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth());
  if (now.getUTCDate() < start.getUTCDate()) months--;
  if (months < 0) return 'Not started';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return `${rest}m`;
  return rest ? `${years}y ${rest}m` : `${years}y`;
}

/**
 * The Reports screen. Six templates, each generating rows for a date range
 * and optional department, returned as JSON or streamed out as CSV by the
 * gateway.
 */
@Injectable()
export class HrReportsService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private badRequest(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Turns the Date Range select into concrete bounds. Every preset is
   * resolved here rather than on the client so two clients cannot disagree
   * about where "This Quarter" starts.
   */
  private resolveWindow(dto: GenerateHrReportDto): ReportWindow {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const range = dto.range ?? HrReportRange.THIS_MONTH;

    const window = (from: Date, to: Date, label: string): ReportWindow => ({
      from: toDateOnly(from),
      to: toDateOnly(to),
      label,
    });

    switch (range) {
      case HrReportRange.LAST_MONTH:
        return window(
          new Date(year, month - 1, 1),
          new Date(year, month, 0),
          'Last Month',
        );
      case HrReportRange.LAST_7_DAYS:
        return window(
          new Date(year, month, now.getDate() - 6),
          now,
          'Last 7 Days',
        );
      case HrReportRange.LAST_30_DAYS:
        return window(
          new Date(year, month, now.getDate() - 29),
          now,
          'Last 30 Days',
        );
      case HrReportRange.THIS_QUARTER: {
        const quarterStart = Math.floor(month / 3) * 3;
        return window(
          new Date(year, quarterStart, 1),
          new Date(year, quarterStart + 3, 0),
          'This Quarter',
        );
      }
      case HrReportRange.THIS_YEAR:
        return window(new Date(year, 0, 1), new Date(year, 11, 31), 'This Year');
      case HrReportRange.CUSTOM: {
        if (!dto.from || !dto.to) {
          this.badRequest('A custom range needs both from and to.');
        }
        if (dto.to < dto.from) {
          this.badRequest('to must be on or after from.');
        }
        return { from: dto.from, to: dto.to, label: `${dto.from} to ${dto.to}` };
      }
      case HrReportRange.THIS_MONTH:
      default:
        return window(
          new Date(year, month, 1),
          new Date(year, month + 1, 0),
          'This Month',
        );
    }
  }

  /** The six cards, each with when it was last generated. */
  async getTemplates(tenantId: string) {
    const Run = await this.modelProvider.getHrReportRunModel(tenantId);
    const runs = await Run.findAll({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
    });

    const lastRunByType = new Map<string, Date>();
    for (const run of runs as any[]) {
      if (!lastRunByType.has(run.type)) lastRunByType.set(run.type, run.createdAt);
    }

    return {
      templates: TEMPLATES.map((template) => {
        const lastRunAt = lastRunByType.get(template.type) ?? null;
        return {
          ...template,
          lastRunAt,
          lastRunLabel: timeAgo(lastRunAt),
        };
      }),
      ranges: Object.values(HrReportRange),
      formats: Object.values(HrReportFormat),
    };
  }

  /**
   * Builds one report. `record` is false for the CSV path so a download does
   * not log a second run for the same click.
   */
  async generate(
    tenantId: string,
    dto: GenerateHrReportDto,
    actorUserId?: string,
    record = true,
  ) {
    const window = this.resolveWindow(dto);
    const template = TEMPLATES.find((row) => row.type === dto.type);

    const built = await this.buildRows(tenantId, dto, window);

    if (record) {
      const Run = await this.modelProvider.getHrReportRunModel(tenantId);
      await Run.create({
        tenantId,
        type: dto.type,
        rangeLabel: window.label,
        fromDate: window.from,
        toDate: window.to,
        departmentId: dto.departmentId ?? null,
        format: dto.format ?? HrReportFormat.JSON,
        rowCount: built.rows.length,
        generatedByUserId: actorUserId ?? null,
      });
    }

    return {
      type: dto.type,
      title: template?.title ?? dto.type,
      description: template?.description ?? null,
      range: dto.range ?? HrReportRange.THIS_MONTH,
      rangeLabel: window.label,
      from: window.from,
      to: window.to,
      departmentId: dto.departmentId ?? null,
      format: dto.format ?? HrReportFormat.JSON,
      generatedAt: new Date(),
      columns: built.columns,
      summary: built.summary,
      rowCount: built.rows.length,
      rows: built.rows,
    };
  }

  /** The CSV download path — the same rows, shaped for the export helper. */
  async export(tenantId: string, dto: GenerateHrReportDto, actorUserId?: string) {
    const report = await this.generate(tenantId, dto, actorUserId, true);
    return {
      rows: report.rows,
      totalMatched: report.rowCount,
      truncated: report.rowCount >= EXPORT_MAX_ROWS,
      limit: EXPORT_MAX_ROWS,
      columns: report.columns,
      meta: {
        type: report.type,
        title: report.title,
        from: report.from,
        to: report.to,
        rangeLabel: report.rangeLabel,
      },
    };
  }

  private async buildRows(
    tenantId: string,
    dto: GenerateHrReportDto,
    window: ReportWindow,
  ): Promise<{ columns: string[]; rows: any[]; summary: Record<string, any> }> {
    switch (dto.type) {
      case HrReportType.EMPLOYEE:
        return this.employeeReport(tenantId, dto, window);
      case HrReportType.ATTENDANCE:
        return this.attendanceReport(tenantId, dto, window);
      case HrReportType.LEAVE:
        return this.leaveReport(tenantId, dto, window);
      case HrReportType.ONBOARDING:
        return this.onboardingReport(tenantId, dto, window);
      case HrReportType.DEPARTMENT_SUMMARY:
        return this.departmentSummary(tenantId, dto, window);
      case HrReportType.CUSTOM:
        // Until the column builder exists, Custom returns the employee
        // dataset — the widest one — rather than an empty report.
        return this.employeeReport(tenantId, dto, window);
      default:
        return { columns: [], rows: [], summary: {} };
    }
  }

  private async employeeInclude(tenantId: string, departmentId?: string) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const include: any[] = [
      {
        model: Department,
        as: 'department',
        attributes: ['id', 'name'],
        required: Boolean(departmentId),
        ...(departmentId ? { where: { id: departmentId } } : {}),
      },
      { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
    ];
    return include;
  }

  private async employeeReport(
    tenantId: string,
    dto: GenerateHrReportDto,
    window: ReportWindow,
  ) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = await Employee.findAll({
      where: { tenantId },
      include: await this.employeeInclude(tenantId, dto.departmentId),
      order: [['employeeCode', 'ASC']],
      limit: EXPORT_MAX_ROWS,
    });

    const mapped = (rows as any[]).map((row) => ({
      employeeCode: row.employeeCode,
      name: [row.firstName, row.lastName].filter(Boolean).join(' '),
      email: row.email,
      phone: row.phone ?? null,
      department: row.department?.name ?? null,
      designation: row.designation?.title ?? null,
      status: row.status,
      joiningDate: row.joiningDate ?? null,
      exitDate: row.exitDate ?? null,
      tenure: tenureLabel(row.joiningDate),
    }));

    const joinedInWindow = mapped.filter(
      (row) => row.joiningDate && row.joiningDate >= window.from && row.joiningDate <= window.to,
    ).length;

    return {
      columns: [
        'employeeCode',
        'name',
        'email',
        'phone',
        'department',
        'designation',
        'status',
        'joiningDate',
        'exitDate',
        'tenure',
      ],
      rows: mapped,
      summary: { total: mapped.length, joinedInRange: joinedInWindow },
    };
  }

  private async attendanceReport(
    tenantId: string,
    dto: GenerateHrReportDto,
    window: ReportWindow,
  ) {
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const employeeInclude: any = {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeCode', 'firstName', 'lastName'],
      required: Boolean(dto.departmentId),
      include: [
        {
          model: Department,
          as: 'department',
          attributes: ['id', 'name'],
          required: Boolean(dto.departmentId),
          ...(dto.departmentId ? { where: { id: dto.departmentId } } : {}),
        },
      ],
    };

    const rows = await Attendance.findAll({
      where: { tenantId, date: { [Op.between]: [window.from, window.to] } },
      include: [employeeInclude],
      order: [['date', 'ASC']],
      limit: EXPORT_MAX_ROWS,
    });

    const tally: Record<string, number> = {};
    const mapped = (rows as any[]).map((row) => {
      tally[row.status] = (tally[row.status] ?? 0) + 1;
      return {
        date: row.date,
        employeeCode: row.employee?.employeeCode ?? null,
        name: row.employee
          ? [row.employee.firstName, row.employee.lastName].filter(Boolean).join(' ')
          : null,
        department: row.employee?.department?.name ?? null,
        status: row.status,
        checkInAt: row.checkInAt ?? null,
        checkOutAt: row.checkOutAt ?? null,
        workedMinutes: row.workedMinutes ?? null,
        workedHours:
          row.workedMinutes === null || row.workedMinutes === undefined
            ? null
            : Math.round((Number(row.workedMinutes) / 60) * 10) / 10,
      };
    });

    return {
      columns: [
        'date',
        'employeeCode',
        'name',
        'department',
        'status',
        'checkInAt',
        'checkOutAt',
        'workedHours',
      ],
      rows: mapped,
      summary: { total: mapped.length, byStatus: tally },
    };
  }

  private async leaveReport(
    tenantId: string,
    dto: GenerateHrReportDto,
    window: ReportWindow,
  ) {
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const employeeInclude: any = {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeCode', 'firstName', 'lastName'],
      required: Boolean(dto.departmentId),
      include: [
        {
          model: Department,
          as: 'department',
          attributes: ['id', 'name'],
          required: Boolean(dto.departmentId),
          ...(dto.departmentId ? { where: { id: dto.departmentId } } : {}),
        },
      ],
    };

    // Dated on when the leave falls, not when it was filed: a leave report
    // for August is about who was away in August.
    const rows = await Leave.findAll({
      where: {
        tenantId,
        fromDate: { [Op.lte]: window.to },
        toDate: { [Op.gte]: window.from },
      },
      include: [
        employeeInclude,
        { model: Policy, as: 'leavePolicy', attributes: ['id', 'name'], required: false },
      ],
      order: [['fromDate', 'ASC']],
      limit: EXPORT_MAX_ROWS,
    });

    const tally: Record<string, number> = {};
    let approvedDays = 0;
    const mapped = (rows as any[]).map((row) => {
      tally[row.status] = (tally[row.status] ?? 0) + 1;
      const days = Number(row.totalDays ?? 0);
      if (row.status === LeaveRequestStatus.APPROVED) approvedDays += days;
      return {
        employeeCode: row.employee?.employeeCode ?? null,
        name: row.employee
          ? [row.employee.firstName, row.employee.lastName].filter(Boolean).join(' ')
          : null,
        department: row.employee?.department?.name ?? null,
        type: row.leavePolicy?.name ?? 'Leave',
        fromDate: row.fromDate,
        toDate: row.toDate,
        days,
        status: row.status,
        reason: row.reason ?? null,
        decidedAt: row.decidedAt ?? null,
      };
    });

    return {
      columns: [
        'employeeCode',
        'name',
        'department',
        'type',
        'fromDate',
        'toDate',
        'days',
        'status',
        'reason',
      ],
      rows: mapped,
      summary: {
        total: mapped.length,
        byStatus: tally,
        approvedDays: Math.round(approvedDays * 10) / 10,
      },
    };
  }

  private async onboardingReport(
    tenantId: string,
    dto: GenerateHrReportDto,
    window: ReportWindow,
  ) {
    const NewHire = await this.modelProvider.getNewHireModel(tenantId);
    const Task = await this.modelProvider.getOnboardingTaskModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const where: any = {
      tenantId,
      joiningDate: { [Op.between]: [window.from, window.to] },
    };
    if (dto.departmentId) where.departmentId = dto.departmentId;

    const hires = await NewHire.findAll({
      where,
      include: [
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      ],
      order: [['joiningDate', 'ASC']],
      limit: EXPORT_MAX_ROWS,
    });

    const hireIds = (hires as any[]).map((hire) => hire.id);
    const tasks = hireIds.length
      ? await Task.findAll({
          where: { tenantId, newHireId: { [Op.in]: hireIds } },
          attributes: ['newHireId', 'completedAt'],
          raw: true,
        })
      : [];

    const tallies = new Map<string, { done: number; total: number }>();
    for (const task of tasks as any[]) {
      const tally = tallies.get(task.newHireId) ?? { done: 0, total: 0 };
      tally.total++;
      if (task.completedAt) tally.done++;
      tallies.set(task.newHireId, tally);
    }

    let completedHires = 0;
    const mapped = (hires as any[]).map((hire) => {
      const tally = tallies.get(hire.id) ?? { done: 0, total: 0 };
      const complete = tally.total > 0 && tally.done === tally.total;
      if (complete) completedHires++;
      return {
        name: [hire.firstName, hire.lastName].filter(Boolean).join(' '),
        email: hire.email,
        position: hire.position ?? null,
        department: hire.department?.name ?? null,
        joiningDate: hire.joiningDate,
        completedTasks: tally.done,
        totalTasks: tally.total,
        pendingTasks: Math.max(0, tally.total - tally.done),
        progress: tally.total ? Math.round((tally.done / tally.total) * 100) : 0,
        onboardingComplete: complete,
      };
    });

    return {
      columns: [
        'name',
        'email',
        'position',
        'department',
        'joiningDate',
        'completedTasks',
        'totalTasks',
        'pendingTasks',
        'progress',
      ],
      rows: mapped,
      summary: {
        total: mapped.length,
        completed: completedHires,
        inProgress: mapped.length - completedHires,
        pendingTasks: mapped.reduce((sum, row) => sum + row.pendingTasks, 0),
      },
    };
  }

  /** Headcount, attendance and leave rolled up per department. */
  private async departmentSummary(
    tenantId: string,
    dto: GenerateHrReportDto,
    window: ReportWindow,
  ) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);

    const departmentWhere: any = { tenantId };
    if (dto.departmentId) departmentWhere.id = dto.departmentId;

    const [departments, employees] = await Promise.all([
      Department.findAll({ where: departmentWhere, order: [['name', 'ASC']] }),
      Employee.findAll({
        where: { tenantId },
        attributes: ['id', 'departmentId', 'status'],
        raw: true,
      }),
    ]);

    const employeesByDepartment = new Map<string, string[]>();
    for (const employee of employees as any[]) {
      if (!employee.departmentId) continue;
      const list = employeesByDepartment.get(employee.departmentId) ?? [];
      list.push(employee.id);
      employeesByDepartment.set(employee.departmentId, list);
    }

    const allEmployeeIds = (employees as any[]).map((row) => row.id);
    const [attendanceRows, leaveRows] = await Promise.all([
      allEmployeeIds.length
        ? Attendance.findAll({
            where: {
              tenantId,
              date: { [Op.between]: [window.from, window.to] },
            },
            attributes: ['employeeId', 'status'],
            raw: true,
          })
        : [],
      allEmployeeIds.length
        ? Leave.findAll({
            where: {
              tenantId,
              fromDate: { [Op.lte]: window.to },
              toDate: { [Op.gte]: window.from },
            },
            attributes: ['employeeId', 'status', 'totalDays'],
            raw: true,
          })
        : [],
    ]);

    const presentByEmployee = new Map<string, number>();
    const recordedByEmployee = new Map<string, number>();
    for (const row of attendanceRows as any[]) {
      recordedByEmployee.set(row.employeeId, (recordedByEmployee.get(row.employeeId) ?? 0) + 1);
      if (row.status === 'PRESENT' || row.status === 'LATE') {
        presentByEmployee.set(row.employeeId, (presentByEmployee.get(row.employeeId) ?? 0) + 1);
      }
    }

    const leaveDaysByEmployee = new Map<string, number>();
    const pendingByEmployee = new Map<string, number>();
    for (const row of leaveRows as any[]) {
      if (row.status === LeaveRequestStatus.APPROVED) {
        leaveDaysByEmployee.set(
          row.employeeId,
          (leaveDaysByEmployee.get(row.employeeId) ?? 0) + Number(row.totalDays ?? 0),
        );
      }
      if (row.status === LeaveRequestStatus.PENDING) {
        pendingByEmployee.set(row.employeeId, (pendingByEmployee.get(row.employeeId) ?? 0) + 1);
      }
    }

    const mapped = (departments as any[]).map((department) => {
      const ids = employeesByDepartment.get(department.id) ?? [];
      const sum = (map: Map<string, number>) =>
        ids.reduce((total, id) => total + (map.get(id) ?? 0), 0);

      const recorded = sum(recordedByEmployee);
      const present = sum(presentByEmployee);

      return {
        department: department.name,
        departmentId: department.id,
        headcount: ids.length,
        attendanceRecords: recorded,
        presentRecords: present,
        attendanceRate: recorded ? Math.round((present / recorded) * 1000) / 10 : 0,
        approvedLeaveDays: Math.round(sum(leaveDaysByEmployee) * 10) / 10,
        pendingLeaveRequests: sum(pendingByEmployee),
      };
    });

    return {
      columns: [
        'department',
        'headcount',
        'attendanceRecords',
        'presentRecords',
        'attendanceRate',
        'approvedLeaveDays',
        'pendingLeaveRequests',
      ],
      rows: mapped,
      summary: {
        departments: mapped.length,
        headcount: mapped.reduce((sum, row) => sum + row.headcount, 0),
        unassigned: (employees as any[]).filter((row) => !row.departmentId).length,
      },
    };
  }
}
