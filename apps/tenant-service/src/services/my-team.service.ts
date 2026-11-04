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
   * Whether the signed-in person leads anyone, and whether they are an
   * employee at all. Never throws — a login with no employee record (an
   * organization admin) simply leads no one — because the sidebar asks on
   * every page. `hasEmployeeProfile` is what decides whether the personal
   * pages (My Attendance, Leave, Payslips…) exist for them: a management
   * account has no attendance, leave balance or pay of its own.
   */
  async getLeadership(tenantId: string, userId: string, email?: string) {
    const me = await this.findMe(tenantId, userId, email);
    if (!me) return { directReports: 0, departmentsHeaded: 0, isLead: false, hasEmployeeProfile: false };
    return { ...(await this.leadershipOf(tenantId, me.id)), hasEmployeeProfile: true };
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
   * My own employment history: when I joined, each time my manager,
   * department or designation changed, and when I left. Only what the
   * person themselves should read: who recorded a change and the note HR
   * wrote with it stay on the admin side.
   */
  async getMyEmploymentHistory(tenantId: string, userId: string, email?: string) {
    const me = await this.findMe(tenantId, userId, email);
    if (!me) this.notFound('No employee profile is linked to this login.');
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Change = await this.modelProvider.getHierarchyChangeModel(tenantId);
    const [employee, changes] = await Promise.all([
      Employee.findOne({ where: { id: me.id, tenantId }, include: await this.include(tenantId) }) as Promise<any>,
      Change.findAll({ where: { tenantId, subjectType: 'EMPLOYEE', subjectId: me.id }, order: [['effectiveFrom', 'DESC'], ['createdAt', 'DESC']], raw: true }) as Promise<any[]>,
    ]);
    const person = this.person(employee ?? me);

    const WHAT: Record<string, string> = { REPORTING_MANAGER: 'Reporting manager', DEPARTMENT: 'Department', DESIGNATION: 'Designation' };
    type Entry = { type: string; title: string; from: string | null; to: string | null; date: string; recordedAt: Date | null };
    const entries: Entry[] = changes
      .filter((row) => WHAT[row.changeType])
      .map((row) => ({
        type: row.changeType,
        title: row.previousLabel || row.previousId ? `${WHAT[row.changeType]} changed` : `${WHAT[row.changeType]} set`,
        from: row.previousLabel ?? null,
        to: row.nextLabel ?? null,
        date: String(row.effectiveFrom).slice(0, 10),
        recordedAt: row.createdAt ?? null,
      }));
    if (person.joiningDate) entries.push({ type: 'JOINED', title: 'Joined the organization', from: null, to: null, date: String(person.joiningDate).slice(0, 10), recordedAt: null });
    if (employee?.exitDate && person.status === EmployeeStatus.RESIGNED) {
      entries.push({ type: 'LEFT', title: 'Left the organization', from: null, to: null, date: String(employee.exitDate).slice(0, 10), recordedAt: null });
    }
    entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    return {
      current: {
        status: person.status,
        joiningDate: person.joiningDate,
        designation: person.designation,
        department: person.department,
        reportingManager: person.reportingManagerId ? { id: person.reportingManagerId, name: person.reportingManagerName } : null,
      },
      data: entries,
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
   * A department head's view of what they head: each department with its
   * sub-departments, the managers in it and their teams, everyone who works in
   * it, and the people who also work for it through an additional assignment.
   * Only for someone who heads a department; it reaches nothing outside them.
   */
  async getMyDepartments(tenantId: string, userId: string, email?: string) {
    const me = await this.findMe(tenantId, userId, email);
    if (!me) this.notFound('No employee profile is linked to this login.');
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const headed = (await Department.findAll({ where: { tenantId, managerId: me.id }, order: [['name', 'ASC']] })) as any[];
    if (!headed.length) this.forbidden('This view is for people who head a department.');

    const departments = (await Department.findAll({ where: { tenantId }, attributes: ['id', 'name', 'code', 'parentDepartmentId', 'managerId', 'branchIds', 'isActive'] })) as any[];
    const childrenOf = new Map<string, any[]>();
    for (const department of departments) {
      if (!department.parentDepartmentId) continue;
      childrenOf.set(department.parentDepartmentId, [...(childrenOf.get(department.parentDepartmentId) ?? []), department]);
    }
    const subtreeIds = (rootId: string): string[] => {
      const seen = new Set<string>([rootId]);
      const queue = [rootId];
      while (queue.length) {
        for (const child of childrenOf.get(queue.shift() as string) ?? []) {
          if (seen.has(child.id)) continue; // a bad data loop must not hang the request
          seen.add(child.id);
          queue.push(child.id);
        }
      }
      return [...seen];
    };

    const wanted = [...new Set(headed.flatMap((department) => subtreeIds(department.id)))];
    const include = await this.include(tenantId);
    const people = (await Employee.findAll({
      where: { tenantId, status: { [Op.in]: CURRENT }, departmentId: { [Op.in]: wanted } },
      include,
      order: [['firstName', 'ASC']],
    })) as any[];

    const today = new Date().toISOString().slice(0, 10);
    const statuses = await this.todayFor(tenantId, people.map((person) => person.id), today);
    const inDepartment = new Set(people.map((person) => person.id));
    const reportsOf = new Map<string, any[]>();
    for (const person of people) {
      if (person.reportingManagerId && inDepartment.has(person.reportingManagerId)) {
        reportsOf.set(person.reportingManagerId, [...(reportsOf.get(person.reportingManagerId) ?? []), person]);
      }
    }
    const row = (person: any) => ({ ...this.person(person), today: statuses.get(person.id) ?? null, reportCount: (reportsOf.get(person.id) ?? []).length });

    // Heads and branch names, once.
    const headIds = [...new Set(departments.map((department) => department.managerId).filter(Boolean))] as string[];
    const heads = new Map<string, any>(
      headIds.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: headIds } }, attributes: ['id', 'firstName', 'lastName'], raw: true })) as any[]).map((head) => [head.id, head]) : [],
    );
    const branchNames = new Map<string, string>();
    const branchIds = [...new Set(departments.flatMap((department) => (Array.isArray(department.branchIds) ? department.branchIds : [])))] as string[];
    if (branchIds.length) {
      try {
        const Branch = await this.modelProvider.getBranchModel(tenantId);
        for (const branch of (await Branch.findAll({ where: { tenantId, id: { [Op.in]: branchIds } }, attributes: ['id', 'name'], raw: true })) as any[]) branchNames.set(branch.id, branch.name);
      } catch {
        /* branches unreadable: the departments still show */
      }
    }
    const branchesOf = (department: any) => (Array.isArray(department.branchIds) ? department.branchIds : []).filter((id: string) => branchNames.has(id)).map((id: string) => ({ id, name: branchNames.get(id) as string }));

    const node = (department: any, seen = new Set<string>()): any => {
      seen.add(department.id);
      const subs = (childrenOf.get(department.id) ?? []).filter((child) => !seen.has(child.id)).map((child) => node(child, seen));
      const own = people.filter((person) => person.departmentId === department.id).length;
      return {
        id: department.id,
        name: department.name,
        code: department.code ?? null,
        isActive: department.isActive !== false,
        head: department.managerId && heads.get(department.managerId) ? { id: department.managerId, name: nameOf(heads.get(department.managerId)) } : null,
        branches: branchesOf(department),
        directHeadcount: own,
        headcount: own + subs.reduce((sum: number, sub: any) => sum + sub.headcount, 0),
        subDepartments: subs,
      };
    };

    // People who also work for these departments through an additional assignment, best effort.
    const alsoHere = new Map<string, any[]>();
    try {
      const Assignment = await this.modelProvider.getEmployeeAssignmentModel(tenantId);
      const rows = (await Assignment.findAll({ where: { tenantId, departmentId: { [Op.in]: wanted } } as any, order: [['startDate', 'DESC']], limit: 500 })) as any[];
      const live = rows.filter((assignment) => !assignment.endDate || String(assignment.endDate).slice(0, 10) >= today);
      const personIds = [...new Set(live.map((assignment) => assignment.employeeId))] as string[];
      const found = personIds.length ? ((await Employee.findAll({ where: { tenantId, id: { [Op.in]: personIds }, status: { [Op.in]: CURRENT } }, include })) as any[]) : [];
      const byId = new Map(found.map((person) => [person.id, person]));
      for (const assignment of live) {
        const person = byId.get(assignment.employeeId);
        if (!person) continue;
        const entry = { employee: { id: person.id, name: nameOf(person), employeeCode: person.employeeCode ?? null, designation: person.designation?.title ?? null, primaryDepartment: person.department?.name ?? null }, title: assignment.title ?? null, since: String(assignment.startDate).slice(0, 10) };
        alsoHere.set(assignment.departmentId, [...(alsoHere.get(assignment.departmentId) ?? []), entry]);
      }
    } catch (error: any) {
      this.logger.warn(`Could not read additional assignments for the department view: ${error?.message ?? error}`);
    }

    return {
      date: today,
      departments: headed.map((department) => {
        const ids = new Set(subtreeIds(department.id));
        const members = people.filter((person) => ids.has(person.departmentId) && person.id !== me.id);
        const memberRows = members.map(row);
        const managers = memberRows
          .filter((member) => member.reportCount > 0)
          .map((manager) => ({ ...manager, team: (reportsOf.get(manager.id) ?? []).map((report: any) => ({ id: report.id, name: nameOf(report), designation: report.designation?.title ?? null })) }));
        return {
          ...node(department),
          managers,
          employees: memberRows,
          alsoWorkingHere: [...ids].flatMap((id) => alsoHere.get(id) ?? []),
          summary: this.summarize(memberRows.map((member) => member.today).filter(Boolean) as TodayStatus[]),
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
