import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  AttendanceStatus,
  EmployeeRequestStatus,
  EmployeeRequestType,
  EmployeeStatus,
  LeaveRequestStatus,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

/** What someone is doing right now, as the team screens show it. */
export type TodayState = 'WORKING' | 'CHECKED_OUT' | 'ON_LEAVE' | 'ABSENT' | 'NOT_IN';

export interface TodayStatus {
  state: TodayState;
  late: boolean;
  workFromHome: boolean;
  checkInAt: string | null;
  checkOutAt: string | null;
  /** The leave type when `state` is ON_LEAVE. */
  leaveType: string | null;
}

/** Only the people still on the books show up in a team or the chart. */
const CURRENT = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

const nameOf = (employee: { firstName?: string; lastName?: string }) =>
  [employee.firstName, employee.lastName].filter(Boolean).join(' ');

/**
 * My Team and the organization hierarchy.
 *
 * Both follow the reporting line (`employees.reportingManagerId`) and the
 * department head (`departments.managerId`), not the portal role: a Team
 * Lead is usually signed in as a plain Employee, and they still need to see
 * who reports to them. Nothing here reaches past those relationships — a
 * manager sees their reports and a department head their department, and
 * the chart carries only what an org chart shows (name, title, department).
 */
@Injectable()
export class MyTeamService {
  private readonly logger = new Logger(MyTeamService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private notFound(message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, HttpStatus.NOT_FOUND);
  }

  private forbidden(message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, HttpStatus.FORBIDDEN);
  }

  /** How many people report to this employee, and how many departments they head. */
  private async leadershipOf(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const [directReports, departmentsHeaded] = await Promise.all([
      Employee.count({ where: { tenantId, reportingManagerId: employeeId, status: { [Op.in]: CURRENT } } }),
      Department.count({ where: { tenantId, managerId: employeeId } }),
    ]);
    return { directReports, departmentsHeaded, isLead: directReports > 0 || departmentsHeaded > 0 };
  }

  /**
   * Whether the signed-in person leads anyone. Never throws — a login with no
   * employee record (an organization admin) simply leads no one — because the
   * sidebar asks on every page.
   */
  async getLeadership(tenantId: string, userId: string, email?: string) {
    const me = await this.findMe(tenantId, userId, email);
    if (!me) return { directReports: 0, departmentsHeaded: 0, isLead: false };
    return this.leadershipOf(tenantId, me.id);
  }

  /** The employee row for this login: user id first, then the same email. */
  private async findMe(tenantId: string, userId: string, email?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee = await Employee.findOne({ where: { tenantId, userId } });
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } });
    }
    return employee;
  }

  private async include(tenantId: string, withManager = true) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    return [
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      { model: Designation, as: 'designation', attributes: ['id', 'title'], required: false },
      ...(withManager
        ? [{ model: Employee, as: 'reportingManager', attributes: ['id', 'firstName', 'lastName'], required: false }]
        : []),
    ];
  }

  private person(employee: any) {
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      name: nameOf(employee),
      email: employee.email,
      phone: employee.phone ?? null,
      avatarUrl: employee.avatarUrl ?? null,
      status: employee.status,
      joiningDate: employee.joiningDate ?? null,
      designation: employee.designation?.title ?? null,
      department: employee.department ? { id: employee.department.id, name: employee.department.name } : null,
      reportingManagerId: employee.reportingManagerId ?? null,
      reportingManagerName: employee.reportingManager ? nameOf(employee.reportingManager) : null,
    };
  }

  /**
   * Today's attendance, leave and work-from-home for a set of employees, in
   * three queries however many people there are.
   */
  private async todayFor(tenantId: string, employeeIds: string[], today: string) {
    const byId = new Map<string, TodayStatus>();
    if (!employeeIds.length) return byId;

    const Attendance = await this.modelProvider.getAttendanceRecordModel(tenantId);
    const records = await Attendance.findAll({
      where: { tenantId, date: today, employeeId: { [Op.in]: employeeIds } },
    });
    const recordOf = new Map((records as any[]).map((row) => [row.employeeId, row]));

    const leaveOf = new Map<string, string>();
    try {
      const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
      const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
      const leaves = await Leave.findAll({
        where: {
          tenantId,
          employeeId: { [Op.in]: employeeIds },
          status: LeaveRequestStatus.APPROVED,
          fromDate: { [Op.lte]: today },
          toDate: { [Op.gte]: today },
        },
        include: [{ model: Policy, as: 'leavePolicy', attributes: ['id', 'name'], required: false }],
      });
      for (const leave of leaves as any[]) leaveOf.set(leave.employeeId, leave.leavePolicy?.name ?? 'Leave');
    } catch (error: any) {
      this.logger.warn(`Could not read today's leave for the team: ${error?.message ?? error}`);
    }

    const remote = new Set<string>();
    try {
      const Request = await this.modelProvider.getEmployeeRequestModel(tenantId);
      const rows = await Request.findAll({
        where: {
          tenantId,
          employeeId: { [Op.in]: employeeIds },
          type: EmployeeRequestType.WORK_FROM_HOME,
          status: EmployeeRequestStatus.APPROVED,
          fromDate: { [Op.lte]: today },
          toDate: { [Op.gte]: today },
        },
        attributes: ['employeeId'],
      });
      for (const row of rows as any[]) remote.add(row.employeeId);
    } catch (error: any) {
      this.logger.warn(`Could not read today's work-from-home for the team: ${error?.message ?? error}`);
    }

    for (const id of employeeIds) {
      const record: any = recordOf.get(id);
      const leaveType = leaveOf.get(id) ?? null;
      let state: TodayState = 'NOT_IN';
      if (leaveType || record?.status === AttendanceStatus.ON_LEAVE) state = 'ON_LEAVE';
      else if (record?.checkOutAt) state = 'CHECKED_OUT';
      else if (record?.checkInAt) state = 'WORKING';
      else if (record?.status === AttendanceStatus.ABSENT) state = 'ABSENT';

      byId.set(id, {
        state,
        late: record?.status === AttendanceStatus.LATE,
        workFromHome: remote.has(id) || record?.workLocation === 'REMOTE',
        checkInAt: record?.checkInAt ?? null,
        checkOutAt: record?.checkOutAt ?? null,
        leaveType: state === 'ON_LEAVE' ? (leaveType ?? 'Leave') : null,
      });
    }
    return byId;
  }

  private summarize(statuses: TodayStatus[]) {
    return {
      total: statuses.length,
      working: statuses.filter((s) => s.state === 'WORKING').length,
      checkedOut: statuses.filter((s) => s.state === 'CHECKED_OUT').length,
      onLeave: statuses.filter((s) => s.state === 'ON_LEAVE').length,
      notIn: statuses.filter((s) => s.state === 'NOT_IN' || s.state === 'ABSENT').length,
      late: statuses.filter((s) => s.late).length,
      workFromHome: statuses.filter((s) => s.workFromHome && s.state !== 'ON_LEAVE').length,
    };
  }

  /**
   * My Team: who I report to, who reports to me (with what they're doing
   * today), and — for a department head — the whole department.
   */
  async getMyTeam(tenantId: string, userId: string, email?: string) {
    const me = await this.findMe(tenantId, userId, email);
    if (!me) this.notFound('No employee profile is linked to this login.');
    if (!(await this.leadershipOf(tenantId, me.id)).isLead) {
      this.forbidden('My Team is for people who lead a team or head a department.');
    }

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const include = await this.include(tenantId);
    const current = { tenantId, status: { [Op.in]: CURRENT } };
    const today = new Date().toISOString().slice(0, 10);

    const [manager, directReports, headed, everyone] = await Promise.all([
      me.reportingManagerId
        ? Employee.findOne({ where: { tenantId, id: me.reportingManagerId }, include })
        : Promise.resolve(null),
      Employee.findAll({
        where: { ...current, reportingManagerId: me.id },
        include,
        order: [['firstName', 'ASC']],
      }),
      Department.findAll({ where: { tenantId, managerId: me.id }, attributes: ['id', 'name'] }),
      // Id and manager only, to count everyone under me however deep.
      Employee.findAll({ where: current, attributes: ['id', 'reportingManagerId'] }),
    ]);

    const reportsOf = new Map<string, string[]>();
    for (const row of everyone as any[]) {
      if (!row.reportingManagerId) continue;
      reportsOf.set(row.reportingManagerId, [...(reportsOf.get(row.reportingManagerId) ?? []), row.id]);
    }
    const subtreeSize = (id: string, seen = new Set<string>()): number => {
      let count = 0;
      for (const child of reportsOf.get(id) ?? []) {
        if (seen.has(child)) continue; // a bad data loop must not hang the request
        seen.add(child);
        count += 1 + subtreeSize(child, seen);
      }
      return count;
    };

    const headedIds = (headed as any[]).map((department) => department.id);
    const members = headedIds.length
      ? await Employee.findAll({
          where: { ...current, departmentId: { [Op.in]: headedIds }, id: { [Op.ne]: me.id } },
          include,
          order: [['firstName', 'ASC']],
        })
      : [];

    const statusIds = [...new Set([...(directReports as any[]), ...(members as any[])].map((e) => e.id))];
    const statuses = await this.todayFor(tenantId, statusIds, today);
    const withToday = (employee: any) => ({
      ...this.person(employee),
      today: statuses.get(employee.id) ?? null,
      reportCount: (reportsOf.get(employee.id) ?? []).length,
    });

    const reportRows = (directReports as any[]).map(withToday);
    const memberRows = (members as any[]).map(withToday);

    return {
      date: today,
      me: { ...this.person(me), reportCount: reportRows.length, teamSize: subtreeSize(me.id) },
      manager: manager ? this.person(manager) : null,
      directReports: reportRows,
      directReportsSummary: this.summarize(reportRows.map((row) => row.today).filter(Boolean) as TodayStatus[]),
      departments: (headed as any[]).map((department) => {
        const rows = memberRows.filter((row) => row.department?.id === department.id);
        return {
          id: department.id,
          name: department.name,
          members: rows,
          summary: this.summarize(rows.map((row) => row.today).filter(Boolean) as TodayStatus[]),
        };
      }),
    };
  }

  /**
   * A lead's part of the chart: me, everyone under me however deep, everyone
   * in a department I head, and the managers above all of those.
   */
  private branchOf(rows: any[], departments: any[], meId: string): any[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const reportsOf = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.reportingManagerId) continue;
      reportsOf.set(row.reportingManagerId, [...(reportsOf.get(row.reportingManagerId) ?? []), row.id]);
    }

    const keep = new Set<string>([meId]);
    const queue = [meId];
    while (queue.length) {
      for (const child of reportsOf.get(queue.shift()!) ?? []) {
        if (keep.has(child)) continue; // guards against a reporting loop
        keep.add(child);
        queue.push(child);
      }
    }

    const headed = new Set(departments.filter((d) => d.managerId === meId).map((d) => d.id));
    for (const row of rows) if (row.departmentId && headed.has(row.departmentId)) keep.add(row.id);

    // The line upward for everyone kept, so no box floats unattached.
    for (const id of [...keep]) {
      let current = byId.get(id)?.reportingManagerId;
      while (current && byId.has(current) && !keep.has(current)) {
        keep.add(current);
        current = byId.get(current).reportingManagerId;
      }
    }
    return rows.filter((row) => keep.has(row.id));
  }

  /**
   * The organization chart, carrying only what an org chart shows — no
   * contact details, pay or attendance.
   *
   * Organization-wide employee access (HR, admin) sees everyone. A lead sees
   * their own branch: everyone under them, everyone in a department they
   * head, and the reporting line above those people so the chart stays
   * connected. Anyone else has no chart to see.
   */
  async getHierarchy(tenantId: string, userId: string, email?: string, canViewAll = false) {
    const [me, Employee, Department, include] = await Promise.all([
      this.findMe(tenantId, userId, email),
      this.modelProvider.getEmployeeModel(tenantId),
      this.modelProvider.getDepartmentModel(tenantId),
      // The chart draws the line itself from reportingManagerId.
      this.include(tenantId, false),
    ]);

    const [rows, departments] = await Promise.all([
      Employee.findAll({
        where: { tenantId, status: { [Op.in]: CURRENT } },
        include,
        attributes: [
          'id',
          'employeeCode',
          'firstName',
          'lastName',
          'avatarUrl',
          'reportingManagerId',
          'departmentId',
          'status',
        ],
        order: [['firstName', 'ASC']],
      }),
      Department.findAll({ where: { tenantId }, attributes: ['id', 'name', 'managerId'] }),
    ]);

    const headOf = new Map<string, string[]>();
    for (const department of departments as any[]) {
      if (!department.managerId) continue;
      headOf.set(department.managerId, [...(headOf.get(department.managerId) ?? []), department.name]);
    }

    let visible = rows as any[];
    if (!canViewAll) {
      if (!me || !(await this.leadershipOf(tenantId, me.id)).isLead) {
        this.forbidden('The hierarchy is for people who lead a team or head a department.');
      }
      visible = this.branchOf(rows as any[], departments as any[], me.id);
    }

    return {
      meId: me?.id ?? null,
      scope: canViewAll ? 'ORGANIZATION' : 'BRANCH',
      nodes: visible.map((employee) => ({
        id: employee.id,
        employeeCode: employee.employeeCode,
        name: nameOf(employee),
        avatarUrl: employee.avatarUrl ?? null,
        designation: employee.designation?.title ?? null,
        department: employee.department?.name ?? null,
        reportingManagerId: employee.reportingManagerId ?? null,
        status: employee.status,
        headOf: headOf.get(employee.id) ?? [],
      })),
    };
  }
}
