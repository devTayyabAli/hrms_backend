import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  EmployeeStatus,
  ReassignReportsDto,
  TenantErrorCode,
  TenantException,
  UpdateEmployeeReportingDto,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { LeaveRequestService } from './leave-request.service';
import { PayrollCompensationService } from './payroll-compensation.service';
import { EmployeePortalService } from './employee-portal.service';
import { PerformanceDashboardService } from './performance-dashboard.service';
import { PerformanceSyncService } from './performance-sync.service';
import type {
  HierarchyChangeType,
  HierarchySubjectType,
} from '../models/hierarchy-change.model';

/** Deep enough for any real reporting line; a loop in old data can't hang a request. */
const MAX_CHAIN_DEPTH = 50;

/** Only people still on the books appear in the trees. */
const CURRENT = [
  EmployeeStatus.ACTIVE,
  EmployeeStatus.ON_LEAVE,
  EmployeeStatus.INACTIVE,
];

const nameOf = (
  row:
    { firstName?: string | null; lastName?: string | null } | null | undefined,
) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : null);

const today = () => new Date().toISOString().slice(0, 10);

/** One structure change about to be written. */
export interface StructureChange {
  changeType: HierarchyChangeType;
  previousId: string | null;
  previousLabel: string | null;
  nextId: string | null;
  nextLabel: string | null;
}

/** The assignment fields the history tracks on an employee row. */
export interface EmployeeAssignment {
  reportingManagerId: string | null;
  departmentId: string | null;
  designationId: string | null;
}

export interface DepartmentTreeNode {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  location: string | null;
  isActive: boolean;
  parentDepartmentId: string | null;
  head: {
    id: string;
    employeeCode: string;
    name: string;
    avatarUrl: string | null;
  } | null;
  /** Current employees seated directly in this department. */
  employeeCount: number;
  /** This department plus every sub-department below it. */
  totalEmployeeCount: number;
  children: DepartmentTreeNode[];
}

export interface ReportingTreeNode {
  id: string;
  employeeCode: string;
  name: string;
  avatarUrl: string | null;
  status: string;
  designation: string | null;
  department: { id: string; name: string } | null;
  reportingManagerId: string | null;
  /** Departments this person heads. */
  headOf: { id: string; name: string }[];
  directReports: number;
  /** Everyone under them, however deep. */
  teamSize: number;
  children: ReportingTreeNode[];
}

/**
 * Department Hierarchy: how departments nest, who reports to whom, and the
 * record of every change to that.
 *
 * Nothing here is a second copy of the structure. Departments keep their
 * `parentDepartmentId` and `managerId`; employees keep `departmentId`,
 * `designationId` and `reportingManagerId`. Those columns are what
 * DataScopeService, approvals, My Team and the org chart already read, so a
 * change made here is visible everywhere on the next request. What this
 * service adds is the tree views, the guard against reporting loops, and the
 * append-only history (`hierarchy_changes`).
 *
 * Visibility follows the caller's data scope: an organization-wide caller
 * sees the whole structure; a department head or team lead sees the part
 * that contains the people they are allowed to see.
 */
@Injectable()
export class OrganizationHierarchyService {
  private readonly logger = new Logger(OrganizationHierarchyService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional() private readonly leaveRequests?: LeaveRequestService,
    @Optional() private readonly compensation?: PayrollCompensationService,
    @Optional() private readonly portal?: EmployeePortalService,
    @Optional() private readonly performance?: PerformanceDashboardService,
    @Optional() private readonly performanceSync?: PerformanceSyncService,
  ) {}

  /** A change to who someone answers to (an additional manager added or ended): their pending approvals follow the new route. */
  async followApprovalRoute(tenantId: string, employeeId: string): Promise<void> {
    await this.rerouteLeave(tenantId, employeeId);
  }

  /** Pending leave, reimbursements and employee requests follow a changed reporting line. A failure here does not undo the move. */
  private async rerouteLeave(tenantId: string, employeeId: string): Promise<void> {
    if (this.leaveRequests) {
      try {
        await this.leaveRequests.rerouteAfterReportingChange(tenantId, employeeId);
      } catch (error: any) {
        this.logger.warn(`Pending leave for ${employeeId} was not re-routed after the reporting change: ${error?.message ?? error}`);
      }
    }
    if (this.compensation) {
      try {
        await this.compensation.rerouteReimbursementsAfterReportingChange(tenantId, employeeId);
      } catch (error: any) {
        this.logger.warn(`Pending reimbursements for ${employeeId} were not re-routed after the reporting change: ${error?.message ?? error}`);
      }
    }
    if (this.performance) {
      try {
        await this.performance.followManagerChange(tenantId, employeeId);
      } catch (error: any) {
        this.logger.warn(`Open performance reviews for ${employeeId} did not follow the reporting change: ${error?.message ?? error}`);
      }
    }
    if (this.portal) {
      try {
        await this.portal.rerouteRequestsAfterReportingChange(tenantId, employeeId);
      } catch (error: any) {
        this.logger.warn(`Pending requests for ${employeeId} were not re-routed after the reporting change: ${error?.message ?? error}`);
      }
    }
  }

  private badRequest(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }

  private notFound(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.NOT_FOUND,
    );
  }

  // ==========================================
  // Guards
  // ==========================================

  /**
   * Refuses a reporting manager that would close a loop: the manager is the
   * employee themself, or someone who (directly or further up) reports to
   * the employee. Walks the manager's own chain upward; if it ever reaches
   * the employee, the assignment is circular.
   */
  async assertNoReportingCycle(
    tenantId: string,
    employeeId: string,
    managerId: string | null | undefined,
  ): Promise<void> {
    if (!managerId) return;
    if (managerId === employeeId)
      this.badRequest('An employee cannot report to themselves.');

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const seen = new Set<string>([managerId]);
    let current: string | null = managerId;
    for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth++) {
      const row = (await Employee.findOne({
        where: { tenantId, id: current },
        attributes: ['reportingManagerId'],
        raw: true,
      })) as { reportingManagerId: string | null } | null;
      const next: string | null = row?.reportingManagerId ?? null;
      if (!next) return;
      if (next === employeeId) {
        this.badRequest(
          'This would create a circular reporting line: the chosen manager already reports to this employee.',
        );
      }
      if (seen.has(next)) return; // pre-existing loop elsewhere; not made worse by this change
      seen.add(next);
      current = next;
    }
  }

  /** An active employee of this tenant, usable as somebody's manager. */
  private async assertManagerUsable(
    tenantId: string,
    managerId: string,
  ): Promise<void> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const manager = (await Employee.findOne({
      where: { tenantId, id: managerId },
      attributes: ['id', 'status'],
      raw: true,
    })) as { id: string; status: EmployeeStatus } | null;
    if (!manager)
      this.badRequest('Reporting manager not found in this organization.');
    if (manager.status === EmployeeStatus.RESIGNED) {
      this.badRequest(
        'A resigned employee cannot be assigned as a reporting manager.',
      );
    }
  }

  // ==========================================
  // History
  // ==========================================

  /** Names for ids, so history rows stay readable after a delete. */
  private async labelsFor(
    tenantId: string,
    ids: {
      employees?: (string | null | undefined)[];
      departments?: (string | null | undefined)[];
      designations?: (string | null | undefined)[];
    },
  ): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const clean = (list?: (string | null | undefined)[]) => [
      ...new Set((list ?? []).filter(Boolean) as string[]),
    ];

    const employeeIds = clean(ids.employees);
    if (employeeIds.length) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const rows = (await Employee.findAll({
        where: { tenantId, id: { [Op.in]: employeeIds } },
        attributes: ['id', 'firstName', 'lastName'],
        raw: true,
      })) as any[];
      for (const row of rows) labels.set(row.id, nameOf(row) ?? row.id);
    }

    const departmentIds = clean(ids.departments);
    if (departmentIds.length) {
      const Department = await this.modelProvider.getDepartmentModel(tenantId);
      const rows = (await Department.findAll({
        where: { tenantId, id: { [Op.in]: departmentIds } },
        attributes: ['id', 'name'],
        raw: true,
      })) as any[];
      for (const row of rows) labels.set(row.id, row.name);
    }

    const designationIds = clean(ids.designations);
    if (designationIds.length) {
      const Designation =
        await this.modelProvider.getDesignationModel(tenantId);
      const rows = (await Designation.findAll({
        where: { tenantId, id: { [Op.in]: designationIds } },
        attributes: ['id', 'title'],
        raw: true,
      })) as any[];
      for (const row of rows) labels.set(row.id, row.title);
    }

    return labels;
  }

  /**
   * Append history rows. Never throws: a failure to write history must not
   * roll back the structural change the user actually asked for — it is
   * logged instead.
   */
  async recordChanges(
    tenantId: string,
    subjectType: HierarchySubjectType,
    subjectId: string,
    changes: StructureChange[],
    options: { effectiveFrom?: string; note?: string } = {},
  ): Promise<void> {
    if (!changes.length) return;
    try {
      const HierarchyChangeModel =
        await this.modelProvider.getHierarchyChangeModel(tenantId);
      const actor = currentRpcActor();
      await HierarchyChangeModel.bulkCreate(
        changes.map((change) => ({
          tenantId,
          subjectType,
          subjectId,
          ...change,
          effectiveFrom: options.effectiveFrom ?? today(),
          note: options.note?.trim() || null,
          changedById: actor?.userId ?? null,
          changedByEmail: actor?.email ?? null,
        })),
      );
    } catch (error: any) {
      this.logger.error(
        `Could not record hierarchy history for ${subjectType} ${subjectId}: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * The history rows for an employee's manager/department/designation moving
   * from `before` to `after`. Unchanged fields produce nothing.
   */
  async recordEmployeeAssignment(
    tenantId: string,
    employeeId: string,
    before: Partial<EmployeeAssignment>,
    after: Partial<EmployeeAssignment>,
    options: { effectiveFrom?: string; note?: string } = {},
  ): Promise<void> {
    const fields: {
      key: keyof EmployeeAssignment;
      changeType: HierarchyChangeType;
      kind: 'employees' | 'departments' | 'designations';
    }[] = [
      {
        key: 'reportingManagerId',
        changeType: 'REPORTING_MANAGER',
        kind: 'employees',
      },
      { key: 'departmentId', changeType: 'DEPARTMENT', kind: 'departments' },
      { key: 'designationId', changeType: 'DESIGNATION', kind: 'designations' },
    ];
    const moved = fields.filter(
      ({ key }) =>
        after[key] !== undefined &&
        (before[key] ?? null) !== (after[key] ?? null),
    );
    if (!moved.length) return;

    const ids: Record<
      'employees' | 'departments' | 'designations',
      (string | null | undefined)[]
    > = {
      employees: [],
      departments: [],
      designations: [],
    };
    for (const { key, kind } of moved) ids[kind].push(before[key], after[key]);
    const labels = await this.labelsFor(tenantId, ids);

    await this.recordChanges(
      tenantId,
      'EMPLOYEE',
      employeeId,
      moved.map(({ key, changeType }) => ({
        changeType,
        previousId: before[key] ?? null,
        previousLabel: before[key]
          ? (labels.get(before[key] as string) ?? null)
          : null,
        nextId: after[key] ?? null,
        nextLabel: after[key]
          ? (labels.get(after[key] as string) ?? null)
          : null,
      })),
      options,
    );

    if (moved.some(({ key }) => key === 'reportingManagerId')) await this.rerouteLeave(tenantId, employeeId);
    // A department or designation change flags their open reviews for HR's decision.
    if (this.performanceSync && moved.some(({ key }) => key === 'departmentId' || key === 'designationId')) {
      try {
        await this.performanceSync.onAssignmentChange(tenantId, employeeId, before, after);
      } catch (error: any) {
        this.logger.warn(`Open performance reviews for ${employeeId} were not flagged after the transfer: ${error?.message ?? error}`);
      }
    }
  }

  /** The department head changing: written by the Departments screen's assign-manager action. */
  async recordDepartmentHead(
    tenantId: string,
    departmentId: string,
    previousManagerId: string | null,
    nextManagerId: string | null,
  ): Promise<void> {
    if ((previousManagerId ?? null) === (nextManagerId ?? null)) return;
    const labels = await this.labelsFor(tenantId, {
      employees: [previousManagerId, nextManagerId],
    });
    await this.recordChanges(tenantId, 'DEPARTMENT', departmentId, [
      {
        changeType: 'DEPARTMENT_HEAD',
        previousId: previousManagerId,
        previousLabel: previousManagerId
          ? (labels.get(previousManagerId) ?? null)
          : null,
        nextId: nextManagerId,
        nextLabel: nextManagerId ? (labels.get(nextManagerId) ?? null) : null,
      },
    ]);
  }

  /** A department moving under a different parent: written by the department update. */
  async recordParentDepartment(
    tenantId: string,
    departmentId: string,
    previousParentId: string | null,
    nextParentId: string | null,
  ): Promise<void> {
    if ((previousParentId ?? null) === (nextParentId ?? null)) return;
    const labels = await this.labelsFor(tenantId, {
      departments: [previousParentId, nextParentId],
    });
    await this.recordChanges(tenantId, 'DEPARTMENT', departmentId, [
      {
        changeType: 'PARENT_DEPARTMENT',
        previousId: previousParentId,
        previousLabel: previousParentId
          ? (labels.get(previousParentId) ?? null)
          : null,
        nextId: nextParentId,
        nextLabel: nextParentId ? (labels.get(nextParentId) ?? null) : null,
      },
    ]);
  }

  private async history(
    tenantId: string,
    subjectType: HierarchySubjectType,
    subjectId: string,
  ) {
    const HierarchyChangeModel =
      await this.modelProvider.getHierarchyChangeModel(tenantId);
    const rows = (await HierarchyChangeModel.findAll({
      where: { tenantId, subjectType, subjectId },
      order: [
        ['effectiveFrom', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      raw: true,
    })) as any[];
    return rows.map((row) => ({
      id: row.id,
      changeType: row.changeType,
      previous:
        row.previousId || row.previousLabel
          ? { id: row.previousId, label: row.previousLabel }
          : null,
      next:
        row.nextId || row.nextLabel
          ? { id: row.nextId, label: row.nextLabel }
          : null,
      effectiveFrom: row.effectiveFrom,
      note: row.note,
      changedBy: row.changedByEmail ?? row.changedById ?? null,
      recordedAt: row.createdAt,
    }));
  }

  /** Every manager, department and designation change for one employee, newest first. */
  async getEmployeeHistory(tenantId: string, employeeId: string) {
    await this.assertEmployeeVisible(tenantId, employeeId);
    return this.history(tenantId, 'EMPLOYEE', employeeId);
  }

  /** Head and parent changes for one department, newest first. */
  async getDepartmentHistory(tenantId: string, departmentId: string) {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const exists = await Department.count({
      where: { tenantId, id: departmentId },
    });
    if (!exists)
      this.notFound(
        `Department '${departmentId}' not found in this organization.`,
      );
    return this.history(tenantId, 'DEPARTMENT', departmentId);
  }

  // ==========================================
  // Reporting assignments
  // ==========================================

  private async assertEmployeeVisible(tenantId: string, employeeId: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({
      where: { tenantId, id: employeeId },
    });
    if (
      !employee ||
      (this.dataScope && !(await this.dataScope.canSee(tenantId, employeeId)))
    ) {
      this.notFound(`Employee '${employeeId}' not found in this organization.`);
    }
    return employee;
  }

  /**
   * One employee's place in the structure: their department, designation,
   * the managers above them, and who reports to them.
   */
  async getEmployeeReporting(tenantId: string, employeeId: string) {
    const employee = await this.assertEmployeeVisible(tenantId, employeeId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);

    const person = (row: any) => ({
      id: row.id,
      employeeCode: row.employeeCode,
      name: nameOf(row),
      avatarUrl: row.avatarUrl ?? null,
      designation: row.designation?.title ?? null,
      department: row.department
        ? { id: row.department.id, name: row.department.name }
        : null,
    });
    const include = [
      {
        model: Department,
        as: 'department',
        attributes: ['id', 'name'],
        required: false,
      },
      {
        model: Designation,
        as: 'designation',
        attributes: ['id', 'title'],
        required: false,
      },
    ];

    // The line upward, nearest manager first.
    const chain: any[] = [];
    const seen = new Set<string>([employeeId]);
    let managerId: string | null = employee.reportingManagerId ?? null;
    while (
      managerId &&
      !seen.has(managerId) &&
      chain.length < MAX_CHAIN_DEPTH
    ) {
      seen.add(managerId);
      const manager = await Employee.findOne({
        where: { tenantId, id: managerId },
        include,
      });
      if (!manager) break;
      chain.push(manager);
      managerId = manager.reportingManagerId ?? null;
    }

    const [self, reports, headed] = await Promise.all([
      Employee.findOne({ where: { tenantId, id: employeeId }, include }),
      Employee.findAll({
        where: {
          tenantId,
          reportingManagerId: employeeId,
          status: { [Op.in]: CURRENT },
        },
        include,
        order: [['firstName', 'ASC']],
      }),
      Department.findAll({
        where: { tenantId, managerId: employeeId },
        attributes: ['id', 'name'],
        raw: true,
      }),
    ]);

    return {
      employee: {
        ...person(self),
        status: self!.status,
        joiningDate: self!.joiningDate ?? null,
      },
      reportingManager: chain.length ? person(chain[0]) : null,
      /** Nearest first — the approval route for this person's requests. */
      reportingChain: chain.map(person),
      directReports: (reports as any[]).map(person),
      headOf: (headed as any[]).map((d) => ({ id: d.id, name: d.name })),
    };
  }

  /**
   * Move an employee: new manager, department and/or designation. Checks the
   * references belong to this tenant, refuses a reporting loop, applies the
   * change and writes the history.
   */
  async updateEmployeeReporting(
    tenantId: string,
    employeeId: string,
    dto: UpdateEmployeeReportingDto,
  ) {
    const employee = await this.assertEmployeeVisible(tenantId, employeeId);
    const patch: Partial<EmployeeAssignment> = {};

    if (dto.reportingManagerId !== undefined) {
      if (dto.reportingManagerId) {
        await this.assertManagerUsable(tenantId, dto.reportingManagerId);
        await this.assertNoReportingCycle(
          tenantId,
          employeeId,
          dto.reportingManagerId,
        );
      }
      patch.reportingManagerId = dto.reportingManagerId ?? null;
    }

    if (dto.departmentId !== undefined) {
      if (dto.departmentId) {
        const Department =
          await this.modelProvider.getDepartmentModel(tenantId);
        const found = await Department.count({
          where: { tenantId, id: dto.departmentId },
        });
        if (!found)
          this.badRequest('Department not found in this organization.');
      }
      patch.departmentId = dto.departmentId ?? null;
    }

    if (dto.designationId !== undefined) {
      if (dto.designationId) {
        const Designation =
          await this.modelProvider.getDesignationModel(tenantId);
        const found = await Designation.count({
          where: { tenantId, id: dto.designationId },
        });
        if (!found)
          this.badRequest('Designation not found in this organization.');
      }
      patch.designationId = dto.designationId ?? null;
    }

    if (!Object.keys(patch).length)
      this.badRequest(
        'Nothing to change: send a reporting manager, department or designation.',
      );

    const before: EmployeeAssignment = {
      reportingManagerId: employee.reportingManagerId ?? null,
      departmentId: employee.departmentId ?? null,
      designationId: employee.designationId ?? null,
    };
    await employee.update(patch);
    await this.recordEmployeeAssignment(tenantId, employeeId, before, patch, {
      effectiveFrom: dto.effectiveFrom,
      note: dto.note,
    });
    return this.getEmployeeReporting(tenantId, employeeId);
  }

  /**
   * Hand every direct report of one manager to another (or to nobody). Used
   * when a manager leaves or changes role, so their team is not left
   * reporting to someone who no longer manages them.
   */
  async reassignReports(tenantId: string, dto: ReassignReportsDto) {
    const toManagerId = dto.toManagerId ?? null;
    if (toManagerId === dto.fromManagerId)
      this.badRequest(
        'The new manager must be different from the current one.',
      );

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const from = await Employee.count({
      where: { tenantId, id: dto.fromManagerId },
    });
    if (!from)
      this.badRequest('Current manager not found in this organization.');
    if (toManagerId) await this.assertManagerUsable(tenantId, toManagerId);

    const scope = this.dataScope
      ? await this.dataScope.employeeWhere(tenantId, 'id')
      : {};
    const reports = (await Employee.findAll({
      where: { tenantId, reportingManagerId: dto.fromManagerId, ...scope },
      attributes: ['id', 'firstName', 'lastName'],
    })) as any[];

    // The new manager may themself report to someone being moved — that
    // would close a loop, so each report is checked, not just the first.
    for (const report of reports) {
      if (toManagerId)
        await this.assertNoReportingCycle(tenantId, report.id, toManagerId);
    }

    const labels = await this.labelsFor(tenantId, {
      employees: [dto.fromManagerId, toManagerId],
    });
    const change: StructureChange = {
      changeType: 'REPORTING_MANAGER',
      previousId: dto.fromManagerId,
      previousLabel: labels.get(dto.fromManagerId) ?? null,
      nextId: toManagerId,
      nextLabel: toManagerId ? (labels.get(toManagerId) ?? null) : null,
    };
    for (const report of reports) {
      await report.update({ reportingManagerId: toManagerId });
      await this.recordChanges(tenantId, 'EMPLOYEE', report.id, [change], {
        effectiveFrom: dto.effectiveFrom,
        note: dto.note,
      });
      await this.rerouteLeave(tenantId, report.id);
    }

    return {
      moved: reports.length,
      employees: reports.map((row) => ({ id: row.id, name: nameOf(row) })),
      toManager: toManagerId
        ? { id: toManagerId, name: labels.get(toManagerId) ?? null }
        : null,
    };
  }

  // ==========================================
  // Trees
  // ==========================================

  /**
   * Departments nested under their parents, each with its head and
   * headcount. A scoped caller gets only the departments that hold people
   * they may see, plus the parents above those so the tree stays connected.
   */
  async getDepartmentTree(
    tenantId: string,
  ): Promise<{ scope: string; departments: DepartmentTreeNode[] }> {
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const visible = this.dataScope
      ? await this.dataScope.visibleEmployeeIds(tenantId)
      : null;

    const [departments, employees] = await Promise.all([
      Department.findAll({
        where: { tenantId },
        order: [['name', 'ASC']],
        raw: true,
      }) as Promise<any[]>,
      Employee.findAll({
        where: { tenantId, status: { [Op.in]: CURRENT } },
        attributes: ['id', 'departmentId'],
        raw: true,
      }) as Promise<any[]>,
    ]);

    const counts = new Map<string, number>();
    const visibleSet = visible ? new Set(visible) : null;
    const touched = new Set<string>();
    for (const row of employees) {
      if (!row.departmentId) continue;
      if (visibleSet && !visibleSet.has(row.id)) continue;
      counts.set(row.departmentId, (counts.get(row.departmentId) ?? 0) + 1);
      touched.add(row.departmentId);
    }

    const byId = new Map<string, any>(departments.map((d) => [d.id, d]));
    let kept: any[] = departments;
    if (visibleSet) {
      // Departments headed by someone visible count too, then walk up.
      for (const d of departments)
        if (d.managerId && visibleSet.has(d.managerId)) touched.add(d.id);
      const keep = new Set<string>();
      for (const id of touched) {
        let current: string | null = id;
        let guard = 0;
        while (current && !keep.has(current) && guard++ < MAX_CHAIN_DEPTH) {
          keep.add(current);
          current = byId.get(current)?.parentDepartmentId ?? null;
        }
      }
      kept = departments.filter((d) => keep.has(d.id));
    }

    const heads = await this.labelsForHeads(
      tenantId,
      kept.map((d) => d.managerId),
    );
    const nodes = new Map<string, DepartmentTreeNode>();
    for (const d of kept) {
      nodes.set(d.id, {
        id: d.id,
        name: d.name,
        code: d.code ?? null,
        description: d.description ?? null,
        location: d.location ?? null,
        isActive: d.isActive !== false,
        parentDepartmentId: d.parentDepartmentId ?? null,
        head: d.managerId ? (heads.get(d.managerId) ?? null) : null,
        employeeCount: counts.get(d.id) ?? 0,
        totalEmployeeCount: 0,
        children: [],
      });
    }

    const roots: DepartmentTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentDepartmentId
        ? nodes.get(node.parentDepartmentId)
        : undefined;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    const total = (
      node: DepartmentTreeNode,
      seen = new Set<string>(),
    ): number => {
      if (seen.has(node.id)) return 0; // a parent loop in old data must not recurse forever
      seen.add(node.id);
      node.totalEmployeeCount =
        node.employeeCount +
        node.children.reduce((sum, child) => sum + total(child, seen), 0);
      return node.totalEmployeeCount;
    };
    roots.forEach((root) => total(root));

    return { scope: visible ? 'SCOPED' : 'ORGANIZATION', departments: roots };
  }

  private async labelsForHeads(
    tenantId: string,
    managerIds: (string | null)[],
  ) {
    const ids = [...new Set(managerIds.filter(Boolean) as string[])];
    const heads = new Map<string, DepartmentTreeNode['head']>();
    if (!ids.length) return heads;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({
      where: { tenantId, id: { [Op.in]: ids } },
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl'],
      raw: true,
    })) as any[];
    for (const row of rows) {
      heads.set(row.id, {
        id: row.id,
        employeeCode: row.employeeCode,
        name: nameOf(row) ?? '',
        avatarUrl: row.avatarUrl ?? null,
      });
    }
    return heads;
  }

  /**
   * Who reports to whom, nested. Roots are the people whose manager is not
   * in the visible set (for the whole organization: people with no manager).
   * `rootEmployeeId` narrows the result to that person's branch.
   */
  async getReportingTree(
    tenantId: string,
    rootEmployeeId?: string,
  ): Promise<{ scope: string; roots: ReportingTreeNode[] }> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const visible = this.dataScope
      ? await this.dataScope.visibleEmployeeIds(tenantId)
      : null;

    if (rootEmployeeId && visible && !visible.includes(rootEmployeeId)) {
      this.notFound(
        `Employee '${rootEmployeeId}' not found in your team or department.`,
      );
    }

    const [rows, departments] = await Promise.all([
      Employee.findAll({
        where: {
          tenantId,
          status: { [Op.in]: CURRENT },
          ...(visible ? { id: { [Op.in]: visible } } : {}),
        },
        include: [
          {
            model: Department,
            as: 'department',
            attributes: ['id', 'name'],
            required: false,
          },
          {
            model: Designation,
            as: 'designation',
            attributes: ['id', 'title'],
            required: false,
          },
        ],
        attributes: [
          'id',
          'employeeCode',
          'firstName',
          'lastName',
          'avatarUrl',
          'status',
          'reportingManagerId',
          'departmentId',
        ],
        order: [['firstName', 'ASC']],
      }) as Promise<any[]>,
      Department.findAll({
        where: { tenantId, managerId: { [Op.ne]: null } },
        attributes: ['id', 'name', 'managerId'],
        raw: true,
      }) as Promise<any[]>,
    ]);

    const headOf = new Map<string, { id: string; name: string }[]>();
    for (const d of departments)
      headOf.set(d.managerId, [
        ...(headOf.get(d.managerId) ?? []),
        { id: d.id, name: d.name },
      ]);

    const nodes = new Map<string, ReportingTreeNode>();
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        employeeCode: row.employeeCode,
        name: nameOf(row) ?? '',
        avatarUrl: row.avatarUrl ?? null,
        status: row.status,
        designation: row.designation?.title ?? null,
        department: row.department
          ? { id: row.department.id, name: row.department.name }
          : null,
        reportingManagerId: row.reportingManagerId ?? null,
        headOf: headOf.get(row.id) ?? [],
        directReports: 0,
        teamSize: 0,
        children: [],
      });
    }

    const roots: ReportingTreeNode[] = [];
    for (const node of nodes.values()) {
      const manager = node.reportingManagerId
        ? nodes.get(node.reportingManagerId)
        : undefined;
      if (manager && manager !== node) manager.children.push(node);
      else roots.push(node);
    }
    const size = (
      node: ReportingTreeNode,
      seen = new Set<string>(),
    ): number => {
      if (seen.has(node.id)) return 0;
      seen.add(node.id);
      node.directReports = node.children.length;
      node.teamSize = node.children.reduce(
        (sum, child) => sum + 1 + size(child, seen),
        0,
      );
      return node.teamSize;
    };
    roots.forEach((root) => size(root));

    if (rootEmployeeId) {
      const root = nodes.get(rootEmployeeId);
      if (!root)
        this.notFound(
          `Employee '${rootEmployeeId}' not found in this organization.`,
        );
      return { scope: visible ? 'SCOPED' : 'ORGANIZATION', roots: [root] };
    }
    return { scope: visible ? 'SCOPED' : 'ORGANIZATION', roots };
  }
}
