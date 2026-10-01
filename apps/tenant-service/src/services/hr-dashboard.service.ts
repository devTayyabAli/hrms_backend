import { Injectable, Optional } from '@nestjs/common';
import { Op, col, fn, literal } from 'sequelize';
import {
  AdminDashboardQueryDto,
  AdminDashboardRange,
  EmployeeDocumentStatus,
  EmployeeRequestStatus,
  EmployeeStatus,
  HrDashboardQueryDto,
  LEAVE_URGENT_WITHIN_DAYS,
  LeaveApprovalUrgency,
  LeaveApprovalsQueryDto,
  LeaveRequestStatus,
} from '@app/common';
import { EmployeeService } from './employee.service';
import { AttendanceService } from './attendance.service';
import { OnboardingService } from './onboarding.service';
import { LeaveRequestService } from './leave-request.service';
import { OrganizationDepartmentsService } from './organization-departments.service';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { Tenant } from '../models/tenant.model';

/** Days between two calendar dates, ignoring clock time and zone drift. */
function daysUntil(isoDate: string, today: string): number {
  const toUtc = (iso: string) => {
    const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(isoDate) - toUtc(today)) / 86400000);
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

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Calendar bounds (inclusive, `YYYY-MM-DD`) of a dashboard range around `today`. */
export function rangeBounds(range: AdminDashboardRange, today: string): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number);
  const utc = (year: number, month: number, day: number) => isoDay(new Date(Date.UTC(year, month, day)));
  switch (range) {
    case AdminDashboardRange.TODAY:
      return { from: today, to: today };
    case AdminDashboardRange.THIS_WEEK: {
      // Monday to Sunday.
      const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
      return { from: utc(y, m - 1, d - weekday), to: utc(y, m - 1, d - weekday + 6) };
    }
    case AdminDashboardRange.LAST_MONTH:
      return { from: utc(y, m - 2, 1), to: utc(y, m - 1, 0) };
    case AdminDashboardRange.THIS_QUARTER: {
      const start = Math.floor((m - 1) / 3) * 3;
      return { from: utc(y, start, 1), to: utc(y, start + 3, 0) };
    }
    case AdminDashboardRange.THIS_YEAR:
      return { from: utc(y, 0, 1), to: utc(y, 11, 31) };
    case AdminDashboardRange.ALL_TIME:
      return { from: '2000-01-01', to: today };
    case AdminDashboardRange.THIS_MONTH:
    default:
      return { from: utc(y, m - 1, 1), to: utc(y, m, 0) };
  }
}

/** `count` evenly spaced days from `from` to `to`, both ends included. */
export function samplePoints(from: string, to: string, count: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end <= start) return [from];
  const days = Math.round((end - start) / 86400000);
  const steps = Math.min(count - 1, days);
  const points = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    points.add(isoDay(new Date(start + Math.round((days * i) / steps) * 86400000)));
  }
  return [...points];
}

/** Percent change, one decimal; growth from nothing reads as +100%. */
function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

const startOfDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const endOfDay = (iso: string) => new Date(`${iso}T23:59:59.999Z`);

/**
 * The HR Dashboard screen.
 *
 * Every figure here already has an owner — headcount belongs to
 * EmployeeService, today's attendance to AttendanceService, and so on. This
 * service composes those rather than re-querying, so a rule that changes in
 * one place (which employee statuses count as headcount, how a new hire's
 * onboarding status is derived) changes on this screen too.
 */
@Injectable()
export class HrDashboardService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly employees: EmployeeService,
    private readonly attendance: AttendanceService,
    private readonly onboarding: OnboardingService,
    private readonly leaveRequests: LeaveRequestService,
    private readonly departments: OrganizationDepartmentsService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  /** Narrows to the caller's team or department when their role is scoped; `{}` otherwise. */
  private async scopeWhere(tenantId: string, field: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, field) : {};
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * The five KPI cards: Total Employees, New Joiners (Month),
   * Pending Onboarding, Present Today and Pending Leave.
   */
  async getStats(tenantId: string) {
    const [employees, attendance, onboarding, leave, departments] = await Promise.all([
      this.employees.getStats(tenantId),
      this.attendance.getStats(tenantId),
      this.onboarding.getStats(tenantId),
      this.leaveRequests.getStats(tenantId),
      this.departments.getStats(tenantId),
    ]);

    // Hires who have not finished their checklist — the ones still on the
    // Onboarding screen. OnboardingStats counts completed hires and pending
    // *tasks*; neither alone is the "Pending Onboarding" card.
    const pendingOnboarding = Math.max(
      0,
      onboarding.totalNewHires - onboarding.completedOnboarding,
    );

    // A Team Lead or Department Manager reads "across N departments" as the
    // departments *their* people sit in, not the whole organization's.
    let totalDepartments = departments.totalDepartments;
    const scope = await this.scopeWhere(tenantId, 'id');
    if (Object.keys(scope).length > 0) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const rows = (await Employee.findAll({
        where: { tenantId, ...scope, departmentId: { [Op.ne]: null } },
        attributes: ['departmentId'],
        group: ['departmentId'],
        raw: true,
      })) as { departmentId: string }[];
      totalDepartments = rows.length;
    }

    return {
      date: attendance.date,
      totalEmployees: employees.totalEmployees,
      newJoinersThisMonth: employees.newThisMonth,
      pendingOnboarding,
      presentToday: attendance.presentToday,
      pendingLeave: leave.pending,
      // The Employees screen header — "247 employees · 8 departments".
      totalDepartments,
      cards: {
        totalEmployees: {
          label: 'Total Employees',
          value: employees.totalEmployees,
          growth: employees.growth.totalEmployees,
        },
        newJoiners: {
          label: 'New Joiners (Month)',
          value: employees.newThisMonth,
          growth: employees.growth.totalEmployees,
        },
        pendingOnboarding: {
          label: 'Pending Onboarding',
          value: pendingOnboarding,
          growth: onboarding.growth.totalNewHires,
        },
        presentToday: {
          label: 'Present Today',
          value: attendance.presentToday,
          growth: attendance.growth.presentToday,
        },
        pendingLeave: {
          label: 'Pending Leave',
          value: leave.pending,
          growth: leave.growth.pending,
        },
      },
    };
  }

  /**
   * The Leave Approvals Pending panel. Soonest first, because the badge that
   * matters is the leave that starts tomorrow, not the one filed first.
   */
  async getLeaveApprovals(tenantId: string, query: LeaveApprovalsQueryDto = {}) {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 100);
    const today = this.today();

    const LeaveRequest = await this.modelProvider.getLeaveRequestModel(tenantId);
    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const employeeInclude: any = {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl', 'departmentId'],
      required: Boolean(query.departmentId),
      include: [
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      ],
    };
    if (query.departmentId) {
      employeeInclude.where = { departmentId: query.departmentId };
    }

    // Every pending request is fetched, not just the page: urgency is derived
    // per row and then filtered, so paging before the filter would drop rows
    // that belong on the screen. Pending leave is a small, bounded set.
    const rows = await LeaveRequest.findAll({
      where: { tenantId, status: LeaveRequestStatus.PENDING, ...(await this.scopeWhere(tenantId, 'employeeId')) },
      include: [
        employeeInclude,
        { model: Policy, as: 'leavePolicy', attributes: ['id', 'name'], required: false },
      ],
      order: [['fromDate', 'ASC']],
    });

    const mapped = (rows as any[]).map((row) => {
      const startsIn = daysUntil(row.fromDate, today);
      const urgency =
        startsIn < 0
          ? LeaveApprovalUrgency.OVERDUE
          : startsIn <= LEAVE_URGENT_WITHIN_DAYS
            ? LeaveApprovalUrgency.URGENT
            : LeaveApprovalUrgency.NORMAL;
      const days = Number(row.totalDays ?? 0);
      const employee = row.employee;

      return {
        id: row.id,
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
        type: row.leavePolicy?.name ?? 'Leave',
        leavePolicyId: row.leavePolicyId,
        duration: days,
        durationLabel: `${days}d`,
        // "Annual Leave · 5d", as the dashboard row reads.
        summary: `${row.leavePolicy?.name ?? 'Leave'} · ${days}d`,
        fromDate: row.fromDate,
        toDate: row.toDate,
        period: periodLabel(row.fromDate, row.toDate),
        reason: row.reason ?? null,
        status: row.status,
        startsInDays: startsIn,
        urgency,
        isUrgent: urgency !== LeaveApprovalUrgency.NORMAL,
        appliedAt: row.createdAt,
      };
    });

    const filtered = query.urgency
      ? mapped.filter((row) => row.urgency === query.urgency)
      : mapped;

    return {
      pending: mapped.length,
      urgent: mapped.filter((row) => row.isUrgent).length,
      total: filtered.length,
      rows: filtered.slice(0, limit),
    };
  }

  /**
   * The richer half of the HR Dashboard: today's attendance broken down, the
   * last 7 days, headcount by department, who is out or remote today, leave
   * coming up, work anniversaries and what is waiting for HR. Kept apart from
   * `getDashboard` so the KPI cards stay one fast call and a slow panel here
   * never holds them up. Each panel fails on its own — one broken query
   * leaves an empty panel, not an error page.
   */
  async getInsights(tenantId: string) {
    const today = this.today();
    const safe = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await work();
      } catch {
        return fallback;
      }
    };

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const employeeInclude = {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl', 'departmentId'],
      required: true,
      include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
    };
    const person = (employee: any) => ({
      id: employee.id,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
      employeeCode: employee.employeeCode,
      avatarUrl: employee.avatarUrl ?? null,
      department: employee.department?.name ?? null,
    });

    // A Team Lead or department manager sees their people only (see DataScopeService).
    const byEmployee = await this.scopeWhere(tenantId, 'employeeId');
    const byId = await this.scopeWhere(tenantId, 'id');

    const [attendanceToday, remoteToday, trend, departments, outToday, upcomingLeave, people, pendingReview] =
      await Promise.all([
        safe(() => this.attendance.getStats(tenantId), null),
        safe(async () => {
          const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
          return Attendance.count({ where: { tenantId, date: today, workLocation: 'REMOTE', ...byEmployee } });
        }, 0),
        safe(() => this.lastSevenDays(tenantId, today), []),
        safe(async () => {
          const rows = (await Employee.findAll({
            where: { tenantId, status: { [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] }, ...byId },
            attributes: ['departmentId', [fn('COUNT', col('id')), 'count']],
            group: ['departmentId'],
            raw: true,
          })) as any[];
          const names = new Map(
            ((await Department.findAll({ where: { tenantId }, attributes: ['id', 'name'], raw: true })) as any[]).map(
              (d) => [d.id, d.name],
            ),
          );
          return rows
            .map((row) => ({
              departmentId: row.departmentId ?? null,
              name: row.departmentId ? (names.get(row.departmentId) ?? 'Unknown') : 'Unassigned',
              count: Number(row.count),
            }))
            .sort((a, b) => b.count - a.count);
        }, [] as { departmentId: string | null; name: string; count: number }[]),
        safe(async () => {
          const LeaveRequest = await this.modelProvider.getLeaveRequestModel(tenantId);
          const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
          const rows = (await LeaveRequest.findAll({
            where: {
              tenantId,
              status: LeaveRequestStatus.APPROVED,
              ...byEmployee,
              fromDate: { [Op.lte]: today },
              toDate: { [Op.gte]: today },
            },
            include: [employeeInclude, { model: Policy, as: 'leavePolicy', attributes: ['name'], required: false }],
            order: [['toDate', 'ASC']],
            limit: 8,
          })) as any[];
          return rows.map((row) => ({
            id: row.id,
            employee: person(row.employee),
            type: row.leavePolicy?.name ?? 'Leave',
            until: String(row.toDate).slice(0, 10),
            returnsLabel: daysUntil(String(row.toDate), today) === 0 ? 'Back tomorrow' : `Until ${formatDay(String(row.toDate))}`,
          }));
        }, [] as any[]),
        safe(async () => {
          const LeaveRequest = await this.modelProvider.getLeaveRequestModel(tenantId);
          const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
          const inAWeek = new Date(`${today}T00:00:00Z`);
          inAWeek.setUTCDate(inAWeek.getUTCDate() + 14);
          const rows = (await LeaveRequest.findAll({
            where: {
              tenantId,
              status: LeaveRequestStatus.APPROVED,
              ...byEmployee,
              fromDate: { [Op.gt]: today, [Op.lte]: inAWeek.toISOString().slice(0, 10) },
            },
            include: [employeeInclude, { model: Policy, as: 'leavePolicy', attributes: ['name'], required: false }],
            order: [['fromDate', 'ASC']],
            limit: 6,
          })) as any[];
          return rows.map((row) => ({
            id: row.id,
            employee: person(row.employee),
            type: row.leavePolicy?.name ?? 'Leave',
            fromDate: String(row.fromDate).slice(0, 10),
            toDate: String(row.toDate).slice(0, 10),
            period: periodLabel(String(row.fromDate), String(row.toDate)),
            days: Number(row.totalDays ?? 0),
            startsInDays: daysUntil(String(row.fromDate), today),
          }));
        }, [] as any[]),
        safe(async () => {
          const rows = (await Employee.findAll({
            where: {
              tenantId,
              status: { [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] },
              joiningDate: { [Op.ne]: null },
              ...byId,
            },
            attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl', 'departmentId', 'joiningDate'],
            include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
          })) as any[];
          return this.peopleMoments(rows, today, person);
        }, { anniversaries: [] as any[], recentJoiners: [] as any[] }),
        safe(async () => {
          const [Document, Request] = await Promise.all([
            this.modelProvider.getEmployeeDocumentModel(tenantId),
            this.modelProvider.getEmployeeRequestModel(tenantId),
          ]);
          const [documents, requests] = await Promise.all([
            Document.count({ where: { tenantId, status: EmployeeDocumentStatus.PENDING, ...byEmployee } }),
            Request.count({ where: { tenantId, status: EmployeeRequestStatus.PENDING, ...byEmployee } }),
          ]);
          return { documents, requests };
        }, { documents: 0, requests: 0 }),
      ]);

    return {
      date: today,
      attendanceToday: attendanceToday
        ? {
            present: attendanceToday.presentToday,
            late: attendanceToday.lateToday,
            halfDay: attendanceToday.halfDayToday,
            onLeave: attendanceToday.onLeaveToday,
            absent: attendanceToday.absentToday,
            notMarked: attendanceToday.unmarked,
            remote: remoteToday,
            workforce: attendanceToday.totalEmployees,
            attendanceRate: attendanceToday.attendanceRate,
            punctualityRate: attendanceToday.punctualityRate,
          }
        : null,
      trend,
      departments,
      outToday,
      upcomingLeave,
      anniversaries: people.anniversaries,
      recentJoiners: people.recentJoiners,
      pendingReview,
    };
  }

  /** Present / late / absent / on-leave for each of the last 7 days, zeros filled in. */
  private async lastSevenDays(tenantId: string, today: string) {
    const overview = await this.attendance.getOverview(tenantId, { to: today, points: 7 });
    const byDay = new Map(overview.series.map((point) => [point.period, point]));
    const days: { date: string; label: string; present: number; late: number; absent: number; onLeave: number }[] = [];
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - offset);
      const iso = date.toISOString().slice(0, 10);
      const point = byDay.get(iso);
      days.push({
        date: iso,
        label: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        present: point?.present ?? 0,
        late: point?.late ?? 0,
        absent: point?.absent ?? 0,
        onLeave: point?.onLeave ?? 0,
      });
    }
    return days;
  }

  /**
   * Work anniversaries in the next 30 days (one year or more), and people
   * who joined in the last 30 — both from the joining date, so nothing new
   * has to be recorded.
   */
  private peopleMoments(rows: any[], today: string, person: (employee: any) => any) {
    const anniversaries: any[] = [];
    const recentJoiners: any[] = [];
    const [ty] = today.split('-').map(Number);

    for (const row of rows) {
      const joined = String(row.joiningDate).slice(0, 10);
      const [jy, jm, jd] = joined.split('-').map(Number);
      const sinceJoining = daysUntil(today, joined);
      if (sinceJoining >= 0 && sinceJoining <= 30) {
        recentJoiners.push({ employee: person(row), joiningDate: joined, daysAgo: sinceJoining });
      }

      let year = ty;
      let next = `${year}-${String(jm).padStart(2, '0')}-${String(jd).padStart(2, '0')}`;
      if (daysUntil(next, today) < 0) {
        year += 1;
        next = `${year}-${String(jm).padStart(2, '0')}-${String(jd).padStart(2, '0')}`;
      }
      const inDays = daysUntil(next, today);
      const years = year - jy;
      if (years >= 1 && inDays <= 30) {
        anniversaries.push({
          employee: person(row),
          date: next,
          dateLabel: formatDay(next),
          years,
          inDays,
        });
      }
    }

    anniversaries.sort((a, b) => a.inDays - b.inDays);
    recentJoiners.sort((a, b) => a.daysAgo - b.daysAgo);
    return { anniversaries: anniversaries.slice(0, 6), recentJoiners: recentJoiners.slice(0, 5) };
  }

  /**
   * The organization admin dashboard, card by card. Each card has its own
   * range picker, so each gets its own range; everything else is "now".
   * Like `getInsights`, a failing card comes back empty rather than taking
   * the whole screen down.
   */
  async getAdminOverview(tenantId: string, query: AdminDashboardQueryDto = {}) {
    const today = this.today();
    const safe = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await work();
      } catch {
        return fallback;
      }
    };

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const counted = { [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] };
    // Organization admins see everyone; a scoped caller who reaches this sees their people only.
    const adminScope = await this.scopeWhere(tenantId, 'id');

    const [headline, leave, statistics, departments, performance, attendance, tasks, recentJoiners, payroll] =
      await Promise.all([
        safe(async () => {
          const [employees, att] = await Promise.all([
            this.employees.getStats(tenantId),
            this.attendance.getStats(tenantId),
          ]);
          const month = rangeBounds(AdminDashboardRange.THIS_MONTH, today);
          const last = rangeBounds(AdminDashboardRange.LAST_MONTH, today);
          const [joinedThisMonth, joinedLastMonth] = await Promise.all([
            Employee.count({ where: { tenantId, joiningDate: { [Op.between]: [month.from, month.to] } } }),
            Employee.count({ where: { tenantId, joiningDate: { [Op.between]: [last.from, last.to] } } }),
          ]);
          return {
            totalEmployees: { value: employees.totalEmployees, growth: employees.growth.totalEmployees },
            presentToday: { value: att.presentToday, growth: att.growth.presentToday },
            onLeaveToday: { value: att.onLeaveToday, growth: att.growth.onLeaveToday },
            newJoiners: { value: joinedThisMonth, growth: pctChange(joinedThisMonth, joinedLastMonth) },
          };
        }, null),

        safe(async () => {
          const stats = await this.leaveRequests.getStats(tenantId);
          return {
            total: stats.totalRequests ?? stats.approved + stats.pending + stats.rejected,
            approved: stats.approved,
            pending: stats.pending,
            rejected: stats.rejected,
          };
        }, null),

        safe(async () => {
          const range = query.statsRange ?? AdminDashboardRange.THIS_MONTH;
          const { from, to } = rangeBounds(range, today);
          const end = to > today ? today : to;
          const rows = (await Employee.findAll({
            where: { tenantId, status: counted, ...adminScope },
            attributes: ['joiningDate', 'createdAt'],
            raw: true,
          })) as any[];
          const joined = rows.map((row) => String(row.joiningDate ?? row.createdAt).slice(0, 10)).sort();
          const points = samplePoints(from, end, range === AdminDashboardRange.THIS_QUARTER ? 7 : 6);
          return {
            range,
            points: points.map((date) => ({
              date,
              label: formatDay(date),
              headcount: joined.filter((day) => day <= date).length,
            })),
          };
        }, null),

        safe(async () => {
          const rows = (await Employee.findAll({
            where: { tenantId, status: counted, ...adminScope },
            attributes: ['departmentId', [fn('COUNT', col('id')), 'count']],
            group: ['departmentId'],
            raw: true,
          })) as any[];
          const names = new Map(
            ((await Department.findAll({ where: { tenantId }, attributes: ['id', 'name'], raw: true })) as any[]).map(
              (d) => [d.id, d.name],
            ),
          );
          return rows
            .map((row) => ({
              departmentId: row.departmentId ?? null,
              name: row.departmentId ? (names.get(row.departmentId) ?? 'Unknown') : 'Unassigned',
              count: Number(row.count),
            }))
            .sort((a, b) => b.count - a.count);
        }, [] as { departmentId: string | null; name: string; count: number }[]),

        safe(async () => {
          const range = query.performanceRange ?? AdminDashboardRange.THIS_MONTH;
          const { from, to } = rangeBounds(range, today);
          const Goal = await this.modelProvider.getPerformanceGoalModel(tenantId);
          // Goals due in the period; goals with no due date count by when they were set.
          const goals = (await Goal.findAll({
            where: {
              tenantId,
              [Op.or]: [
                { dueDate: { [Op.between]: [from, to] } },
                { dueDate: null, createdAt: { [Op.between]: [startOfDay(from), endOfDay(to)] } },
              ],
            },
            attributes: ['progress', 'status'],
            raw: true,
          })) as any[];
          const progress = goals.map((goal) =>
            goal.status === 'COMPLETED' ? 100 : Math.max(0, Math.min(100, Number(goal.progress ?? 0))),
          );
          const achieved = progress.length
            ? Math.round(progress.reduce((sum, value) => sum + value, 0) / progress.length)
            : 0;
          return { range, achieved, goals: goals.length };
        }, null),

        safe(async () => {
          const range = query.attendanceRange ?? AdminDashboardRange.THIS_MONTH;
          const { from, to } = rangeBounds(range, today);
          const overview = await this.attendance.getOverview(tenantId, { from, to: to > today ? today : to });
          const sum = (key: 'present' | 'late' | 'absent') =>
            overview.series.reduce((total, point) => total + point[key], 0);
          return { range, present: sum('present'), absent: sum('absent'), late: sum('late') };
        }, null),

        safe(async () => {
          const range = query.taskRange ?? AdminDashboardRange.THIS_MONTH;
          const { from, to } = rangeBounds(range, today);
          const created =
            range === AdminDashboardRange.ALL_TIME ? {} : { createdAt: { [Op.between]: [startOfDay(from), endOfDay(to)] } };
          const [Goal, Task] = await Promise.all([
            this.modelProvider.getPerformanceGoalModel(tenantId),
            this.modelProvider.getOnboardingTaskModel(tenantId),
          ]);
          const [goalRows, taskRows] = await Promise.all([
            Goal.findAll({
              where: { tenantId, ...created },
              attributes: ['status', [fn('COUNT', col('id')), 'count']],
              group: ['status'],
              raw: true,
            }),
            Task.findAll({
              where: { tenantId, ...created },
              attributes: ['status', [fn('COUNT', col('id')), 'count']],
              group: ['status'],
              raw: true,
            }),
          ]);
          const count = (rows: any[], status: string) =>
            Number(rows.find((row) => row.status === status)?.count ?? 0);
          const completed = count(goalRows as any[], 'COMPLETED') + count(taskRows as any[], 'COMPLETED');
          const inProgress = count(goalRows as any[], 'IN_PROGRESS');
          const pending = count(goalRows as any[], 'NOT_STARTED') + count(taskRows as any[], 'PENDING');
          return { range, total: completed + inProgress + pending, completed, inProgress, pending };
        }, null),

        safe(async () => {
          const Designation = await this.modelProvider.getDesignationModel(tenantId);
          const rows = (await Employee.findAll({
            where: { tenantId, status: counted, ...adminScope },
            attributes: ['id', 'firstName', 'lastName', 'avatarUrl', 'joiningDate', 'createdAt'],
            include: [{ model: Designation, as: 'designation', attributes: ['title'], required: false }],
            order: [
              [literal('"Employee"."joiningDate" IS NULL'), 'ASC'],
              ['joiningDate', 'DESC'],
              ['createdAt', 'DESC'],
            ],
            limit: 4,
          })) as any[];
          return rows.map((row) => ({
            id: row.id,
            name: [row.firstName, row.lastName].filter(Boolean).join(' '),
            designation: row.designation?.title ?? null,
            avatarUrl: row.avatarUrl ?? null,
            joinedOn: String(row.joiningDate ?? row.createdAt).slice(0, 10),
          }));
        }, [] as any[]),

        safe(async () => {
          const range = query.payrollRange ?? AdminDashboardRange.THIS_MONTH;
          const { from, to } = rangeBounds(range, today);
          const Run = await this.modelProvider.getPayrollRunModel(tenantId);
          // Runs whose pay period overlaps the range.
          const runs = (await Run.findAll({
            where: { tenantId, periodStart: { [Op.lte]: to }, periodEnd: { [Op.gte]: from } },
            attributes: ['status', 'grossPay', 'netPay', 'employeeCount'],
            raw: true,
          })) as any[];
          const tenant = await Tenant.findByPk(tenantId, { attributes: ['currency'] }).catch(() => null);
          const completed = runs.filter((run) => run.status === 'COMPLETED');
          const money = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;
          const netOf = (list: any[]) => list.reduce((sum, run) => sum + money(run.netPay), 0);
          return {
            range,
            currency: tenant?.currency || 'PKR',
            totalPayroll: runs.reduce((sum, run) => sum + money(run.grossPay), 0),
            paidAmount: netOf(completed),
            pendingAmount: netOf(runs.filter((run) => run.status !== 'COMPLETED')),
            employeesPaid: completed.reduce((sum, run) => sum + Number(run.employeeCount ?? 0), 0),
            runs: runs.length,
          };
        }, null),
      ]);

    return {
      date: today,
      headline,
      leave,
      statistics,
      departments,
      performance,
      attendance,
      tasks,
      recentJoiners,
      payroll,
    };
  }

  /** Everything the screen needs in one call. */
  async getDashboard(tenantId: string, query: HrDashboardQueryDto = {}) {
    const [stats, approvals] = await Promise.all([
      this.getStats(tenantId),
      this.getLeaveApprovals(tenantId, { limit: query.approvalsLimit ?? 5 }),
    ]);

    return {
      stats,
      leaveApprovals: approvals,
      /**
       * The Quick Actions row. Each one is an existing endpoint — the
       * dashboard only says which, so the buttons cannot drift from the
       * routes they open.
       */
      quickActions: [
        { key: 'ADD_EMPLOYEE', label: 'Add Employee', method: 'POST', path: '/organization/employees' },
        {
          key: 'INVITE_EMPLOYEE',
          label: 'Invite Employee',
          method: 'POST',
          path: '/organization/hr/invitations',
        },
        {
          key: 'APPROVE_LEAVE',
          label: 'Approve Leave',
          method: 'PATCH',
          path: '/organization/leave-requests/{leaveRequestId}/decision',
        },
        {
          key: 'VIEW_ATTENDANCE',
          label: 'View Attendance',
          method: 'GET',
          path: '/organization/attendance',
        },
      ],
    };
  }

  /**
   * The Onboarding Checklist Matrix — task rows against new-hire columns.
   *
   * Tasks are seeded per hire from the same default checklist, so the same
   * work appears under a different id for each person. Rows are keyed by
   * title to line those up; a task one hire has and another does not simply
   * leaves that cell null.
   */
  async getOnboardingMatrix(
    tenantId: string,
    query: { departmentId?: string; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 25);

    const NewHire = await this.modelProvider.getNewHireModel(tenantId);
    const Task = await this.modelProvider.getOnboardingTaskModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const where: any = { tenantId };
    if (query.departmentId) where.departmentId = query.departmentId;

    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const hires = await NewHire.findAll({
      where,
      include: [
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
        { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
      ],
      order: [['joiningDate', 'DESC']],
      limit,
    });

    if (!hires.length) {
      return { tasks: [], hires: [], cells: [] };
    }

    const hireIds = (hires as any[]).map((hire) => hire.id);
    const tasks = await Task.findAll({
      where: { tenantId, newHireId: { [Op.in]: hireIds } },
      order: [['sortOrder', 'ASC'], ['title', 'ASC']],
    });

    // Column order is the hire order; row order is the checklist's own
    // sortOrder, first time each title is seen.
    const rowOrder: string[] = [];
    const byTitle = new Map<string, Map<string, any>>();
    for (const task of tasks as any[]) {
      if (!byTitle.has(task.title)) {
        byTitle.set(task.title, new Map());
        rowOrder.push(task.title);
      }
      byTitle.get(task.title)!.set(task.newHireId, task);
    }

    const completedFor = new Map<string, { done: number; total: number }>();
    for (const task of tasks as any[]) {
      const tally = completedFor.get(task.newHireId) ?? { done: 0, total: 0 };
      tally.total++;
      if (task.completedAt) tally.done++;
      completedFor.set(task.newHireId, tally);
    }

    return {
      tasks: rowOrder.map((title) => {
        const perHire = byTitle.get(title)!;
        const sample = [...perHire.values()][0];
        return { title, category: sample?.category ?? null };
      }),
      hires: (hires as any[]).map((hire) => {
        const tally = completedFor.get(hire.id) ?? { done: 0, total: 0 };
        return {
          id: hire.id,
          name: [hire.firstName, hire.lastName].filter(Boolean).join(' '),
          // `position` is the free-text title typed on the hire; the
          // designation relation is the catalogued one when it was picked.
          designation: hire.designation?.title ?? hire.position ?? null,
          department: hire.department
            ? { id: hire.department.id, name: hire.department.name }
            : null,
          joiningDate: hire.joiningDate ?? null,
          completedTasks: tally.done,
          totalTasks: tally.total,
          progressLabel: `${tally.done}/${tally.total}`,
          progress: tally.total ? Math.round((tally.done / tally.total) * 100) : 0,
        };
      }),
      cells: rowOrder.map((title) => {
        const perHire = byTitle.get(title)!;
        return {
          title,
          byHire: (hires as any[]).map((hire) => {
            const task = perHire.get(hire.id);
            if (!task) return { hireId: hire.id, taskId: null, status: null, completed: null };
            return {
              hireId: hire.id,
              taskId: task.id,
              status: task.status,
              completed: Boolean(task.completedAt),
              dueDate: task.dueDate ?? null,
            };
          }),
        };
      }),
    };
  }
}
