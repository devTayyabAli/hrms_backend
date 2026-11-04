import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, fn, col, literal, where as sqlWhere } from 'sequelize';
import { DirectoryRoleCategory, DirectorySourceType, PlatformDirectoryPerson } from '@app/database';
import {
  TenantException,
  TenantErrorCode,
  DataScope,
  LeaveRequestStatus,
  LeaveRequestStatusFilter,
  LeaveRequestSortableField,
  CreateLeaveRequestDto,
  UpdateLeaveRequestDto,
  DecideLeaveRequestDto,
  EmployeeNotificationKind,
  EXPORT_MAX_ROWS,
  ExportResult,
} from '@app/common';
import { currentRpcActor } from '@app/tenant-context';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import {
  Actor,
  Approval,
  ApprovalStep,
  DEFAULT_LEAVE_POLICY,
  PolicyStage,
  RouteLookup,
  advanceApproval,
  buildApproval,
  canActOnStage,
  completeApproval,
  handOnApproval,
  rejectApproval,
  rerouteApproval,
  resolveStages,
  stagesOf,
} from './approval-engine';
import { createRouteLookup, loadPolicyStages } from './approval-route-lookup';

/** Flattened row for the Leave Requests table. */
export interface LeaveRequestRow {
  id: string;
  employee: {
    id: string;
    employeeCode: string;
    name: string;
    email: string | null;
    avatarUrl: string | null;
  };
  department: { id: string; name: string } | null;
  leaveType: { id: string; name: string; isPaid: boolean } | null;
  fromDate: string;
  toDate: string;
  totalDays: number;
  /** Pre-formatted "5 days" so the Duration column needs no client math. */
  duration: string;
  reason: string | null;
  status: LeaveRequestStatus;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Where a pending request is, and the sentences the employee is shown. Null on older requests. */
  approval: LeaveApproval | null;
  /** Whether the signed-in person is the one this request is waiting on. */
  canDecide: boolean;
}

/** One line of the trail shown on the request. */
export type LeaveApprovalStep = ApprovalStep;

/**
 * Where a pending leave request is on its route: the stages the organization
 * configured (by default the reporting manager, then their manager or HR),
 * which one is current, and the sentences the employee is shown.
 * `currentApproverId` null means it is with HR or with anyone holding a permission.
 */
export type LeaveApproval = Approval;

export interface GetLeaveRequestsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: LeaveRequestStatusFilter;
  employeeId?: string;
  departmentId?: string;
  leavePolicyId?: string;
  from?: string;
  to?: string;
  sortBy?: LeaveRequestSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

export interface LeaveStats {
  totalRequests: number;
  approved: number;
  pending: number;
  rejected: number;
  cancelled: number;
  /** Days already committed — the sum over approved requests. */
  approvedDays: number;
  /**
   * The "Approved (Month)" and "Rejected (Month)" cards. Counted on when the
   * decision was taken, not when the request was filed: the card reports how
   * much HR got through this month, and a request filed in July but approved
   * in August is August's work.
   */
  approvedThisMonth: number;
  rejectedThisMonth: number;
  /** Percent change vs. the previous calendar month, by filing date. */
  growth: {
    totalRequests: number;
    approved: number;
    pending: number;
    rejected: number;
  };
}

/**
 * A request in one of these states holds the employee's dates. A REJECTED or
 * CANCELLED one does not, so the same dates are free to be requested again.
 */
const BLOCKING_STATUSES = [
  LeaveRequestStatus.PENDING,
  LeaveRequestStatus.APPROVED,
];

/**
 * Percent change from the previous value to the current one, to one decimal
 * place. With no baseline to divide by, any non-zero current value is
 * reported as +100% — growth from nothing — rather than a division by zero.
 */
const pct = (current: number, previous: number): number => {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
};

/**
 * The admin Leave Management screen: KPI cards, the Leave Requests table and
 * the approve / reject / cancel lifecycle.
 *
 * Leave *types* are not owned here — they are the tenant's own LeavePolicy
 * rows, created by the Setup Wizard and edited at
 * POST|PATCH|DELETE /organization/leave-policy. This service only ever reads
 * them, so allocation and the paid/unpaid flag stay defined in one place.
 */
@Injectable()
export class LeaveRequestService {
  private readonly logger = new Logger(LeaveRequestService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
    @Optional()
    @InjectModel(PlatformDirectoryPerson)
    private readonly directory?: typeof PlatformDirectoryPerson,
  ) {}

  /** Narrows to the caller's team or department when their role is scoped; `{}` otherwise. */
  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId) : {};
  }

  // ==========================================
  // Helpers
  // ==========================================

  private notFound(leaveRequestId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Leave request '${leaveRequestId}' not found in this organization.`,
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

  /** DATEONLY columns compare as 'YYYY-MM-DD' strings, so normalize to that. */
  private toDateOnly(value: string | Date): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return value.slice(0, 10);
  }

  /**
   * Inclusive calendar span: 18 Sep to 18 Sep is one day off, not zero.
   * Parsed as UTC midnight on both ends so the subtraction cannot be thrown
   * off by a daylight-saving shift in the middle of the range.
   *
   * An unparseable date yields NaN here rather than a number, and the caller
   * rejects it. The DTO already validates the format, but NaN fails every
   * comparison silently — including `span < 1` — so a malformed date would
   * otherwise sail through validation and land in the database.
   */
  private calendarDays(fromDate: string, toDate: string): number {
    const from = Date.parse(`${this.toDateOnly(fromDate)}T00:00:00.000Z`);
    const to = Date.parse(`${this.toDateOnly(toDate)}T00:00:00.000Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return NaN;
    return Math.round((to - from) / 86_400_000) + 1;
  }

  private formatDuration(totalDays: number): string {
    return totalDays === 1 ? '1 day' : `${totalDays} days`;
  }

  private toRow(record: any): LeaveRequestRow {
    const employee = record.employee;
    const policy = record.leavePolicy;
    // DECIMAL comes back from Postgres as a string, so the Duration column
    // and any client-side arithmetic would get "5" rather than 5 without this.
    const totalDays = Number(record.totalDays);

    return {
      id: record.id,
      employee: employee
        ? {
            id: employee.id,
            employeeCode: employee.employeeCode,
            name: [employee.firstName, employee.lastName]
              .filter(Boolean)
              .join(' '),
            email: employee.email ?? null,
            avatarUrl: employee.avatarUrl ?? null,
          }
        : {
            id: record.employeeId,
            employeeCode: '',
            name: '',
            email: null,
            avatarUrl: null,
          },
      department: employee?.department
        ? { id: employee.department.id, name: employee.department.name }
        : null,
      leaveType: policy
        ? { id: policy.id, name: policy.name, isPaid: policy.isPaid }
        : null,
      fromDate: this.toDateOnly(record.fromDate),
      toDate: this.toDateOnly(record.toDate),
      totalDays,
      duration: this.formatDuration(totalDays),
      reason: record.reason ?? null,
      status: record.status,
      decisionNote: record.decisionNote ?? null,
      decidedByUserId: record.decidedByUserId ?? null,
      decidedAt: record.decidedAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      approval: (record.approval as unknown as LeaveApproval | null) ?? null,
      canDecide: false,
    };
  }

  private async buildInclude(tenantId: string, departmentId?: string) {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const LeavePolicyModel =
      await this.modelProvider.getLeavePolicyModel(tenantId);

    return [
      {
        model: EmployeeModel,
        as: 'employee',
        attributes: [
          'id',
          'employeeCode',
          'firstName',
          'lastName',
          'email',
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
      {
        model: LeavePolicyModel,
        as: 'leavePolicy',
        attributes: ['id', 'name', 'isPaid'],
        required: false,
      },
    ];
  }

  /**
   * Single-quote a value for embedding in a raw SQL fragment. Only ever used
   * for the search term below, where the surrounding ILIKE comparison cannot
   * be expressed as a bind parameter through Sequelize's `literal`.
   */
  private quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private buildWhere(tenantId: string, query: GetLeaveRequestsQuery): any {
    const where: any = { tenantId };

    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.leavePolicyId) where.leavePolicyId = query.leavePolicyId;
    if (query.status && query.status !== LeaveRequestStatusFilter.ALL) {
      where.status = query.status;
    }

    // A date range selects requests whose leave period *overlaps* it, not
    // ones contained by it: a 40-day maternity leave spanning the whole month
    // still belongs in that month's list.
    if (query.from) where.toDate = { [Op.gte]: this.toDateOnly(query.from) };
    if (query.to) where.fromDate = { [Op.lte]: this.toDateOnly(query.to) };

    if (query.search?.trim()) {
      const term = this.quote(`%${query.search.trim()}%`);
      // Employee columns live on the joined table, so the predicate has to
      // reference the alias rather than sit in the top-level where clause.
      where[Op.and] = [
        literal(
          `(concat("employee"."firstName", ' ', "employee"."lastName") ILIKE ${term}` +
            ` OR "employee"."employeeCode" ILIKE ${term}` +
            ` OR "LeaveRequest"."reason" ILIKE ${term})`,
        ),
      ];
    }

    return where;
  }

  private buildOrder(
    sortBy: LeaveRequestSortableField = 'fromDate',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): any[] {
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    switch (sortBy) {
      case 'employeeName':
        return [
          [literal(`"employee"."firstName" ${dir}`)],
          [literal(`"employee"."lastName" ${dir}`)],
        ];
      case 'leaveType':
        return [[literal(`"leavePolicy"."name" ${dir} NULLS LAST`)]];
      default:
        return [[sortBy, dir]];
    }
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

  /**
   * The leave type has to be one this organization actually offers, and an
   * archived one cannot be picked for a new request — otherwise a policy the
   * admin retired keeps appearing on fresh requests.
   */
  private async assertLeavePolicyUsable(
    tenantId: string,
    leavePolicyId: string,
  ): Promise<void> {
    const LeavePolicyModel =
      await this.modelProvider.getLeavePolicyModel(tenantId);
    const policy = await LeavePolicyModel.findOne({
      where: { id: leavePolicyId, tenantId },
      attributes: ['id', 'isActive'],
    });
    if (!policy) {
      this.badRequest(
        `Leave type '${leavePolicyId}' is not configured for this organization.`,
      );
    }
    if (!policy.isActive) {
      this.badRequest(
        `Leave type '${leavePolicyId}' is inactive and cannot be requested.`,
      );
    }
  }

  /**
   * Refuse a request that overlaps one the employee already holds. Without
   * this an employee can be booked off twice for the same week and every
   * balance and coverage figure downstream is wrong. Rejected and cancelled
   * requests release their dates, and `excludeId` lets an edit ignore the
   * row being edited.
   *
   * This is a check-then-insert, so two requests filed for the same employee
   * in the same instant can both pass it. Closing that window needs a
   * database-level range guard — a Postgres `EXCLUDE USING gist` constraint
   * over (employeeId, daterange(fromDate, toDate)) restricted to the blocking
   * statuses — which Sequelize's `sync()` cannot express and so belongs in a
   * migration. Until then the residual risk is two admins double-booking one
   * employee within the same few milliseconds, which the table then shows.
   */
  private async assertNoOverlap(
    tenantId: string,
    employeeId: string,
    fromDate: string,
    toDate: string,
    excludeId?: string,
  ): Promise<void> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);

    const where: any = {
      tenantId,
      employeeId,
      status: { [Op.in]: BLOCKING_STATUSES },
      // Two ranges overlap when each starts on or before the other ends.
      fromDate: { [Op.lte]: this.toDateOnly(toDate) },
      toDate: { [Op.gte]: this.toDateOnly(fromDate) },
    };
    if (excludeId) where.id = { [Op.ne]: excludeId };

    const clash = await LeaveRequestModel.findOne({
      where,
      attributes: ['id', 'fromDate', 'toDate', 'status'],
    });
    if (clash) {
      this.conflict(
        `This employee already has a ${clash.status.toLowerCase()} leave request ` +
          `from ${this.toDateOnly(clash.fromDate)} to ${this.toDateOnly(clash.toDate)}.`,
      );
    }
  }

  /**
   * Validate the period and settle on the number of days to deduct. An
   * explicit `totalDays` wins (a half day, or a span with the weekend taken
   * out), but never exceeds the calendar span it claims to describe.
   */
  private resolveTotalDays(
    fromDate: string,
    toDate: string,
    totalDays?: number,
  ): number {
    const span = this.calendarDays(fromDate, toDate);
    if (!Number.isFinite(span)) {
      this.badRequest('The leave dates could not be read as calendar dates.');
    }
    if (span < 1) {
      this.badRequest(
        'The leave end date cannot be earlier than its start date.',
      );
    }
    if (totalDays === undefined) return span;
    if (totalDays > span) {
      this.badRequest(
        `totalDays (${totalDays}) cannot exceed the ${span}-day period requested.`,
      );
    }
    return totalDays;
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(
    tenantId: string,
    query: GetLeaveRequestsQuery,
  ): Promise<{
    data: LeaveRequestRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);

    const { rows, count } = await LeaveRequestModel.findAndCountAll({
      where: { ...this.buildWhere(tenantId, query), ...(await this.visibleWhere(tenantId)) },
      include: await this.buildInclude(tenantId, query.departmentId),
      order: this.buildOrder(query.sortBy, query.sortOrder),
      offset: (page - 1) * limit,
      limit,
      distinct: false,
      subQuery: false,
    });

    return {
      data: await Promise.all((rows as any[]).map((row) => this.present(tenantId, row))),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /**
   * Capped at EXPORT_MAX_ROWS, and the truncation is reported rather than
   * silently handing back a CSV that looks complete.
   */
  async getAllForExport(
    tenantId: string,
    query: Omit<GetLeaveRequestsQuery, 'page' | 'limit'>,
  ): Promise<ExportResult<LeaveRequestRow>> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);

    const { rows, count } = await LeaveRequestModel.findAndCountAll({
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

  async getOne(
    tenantId: string,
    leaveRequestId: string,
  ): Promise<LeaveRequestRow> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);
    const record = await LeaveRequestModel.findOne({
      where: { id: leaveRequestId, tenantId, ...(await this.visibleWhere(tenantId)) },
      include: await this.buildInclude(tenantId),
    });
    if (!record) this.notFound(leaveRequestId);
    return this.present(tenantId, record);
  }

  /** KPI cards: Total Requests / Approved / Pending / Rejected. */
  async getStats(tenantId: string): Promise<LeaveStats> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);

    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const scope = await this.scopeWhere(tenantId);

    // One grouped query for the status tallies instead of four COUNTs, and a
    // second grouped by this month's decisions for the two "(Month)" cards.
    const [grouped, approvedDays, decidedThisMonth] = await Promise.all([
      LeaveRequestModel.findAll({
        where: { tenantId, ...scope },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
      LeaveRequestModel.sum('totalDays', {
        where: { tenantId, status: LeaveRequestStatus.APPROVED, ...scope },
      }),
      LeaveRequestModel.findAll({
        where: { tenantId, decidedAt: { [Op.gte]: monthStart }, ...scope },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
    ]);

    const decidedByStatus = new Map<string, number>();
    for (const row of decidedThisMonth as any[]) {
      decidedByStatus.set(row.status, Number(row.count));
    }

    const byStatus = new Map<string, number>();
    for (const row of grouped as any[]) {
      byStatus.set(row.status, Number(row.count));
    }

    const approved = byStatus.get(LeaveRequestStatus.APPROVED) ?? 0;
    const pending = byStatus.get(LeaveRequestStatus.PENDING) ?? 0;
    const rejected = byStatus.get(LeaveRequestStatus.REJECTED) ?? 0;
    const cancelled = byStatus.get(LeaveRequestStatus.CANCELLED) ?? 0;

    return {
      totalRequests: approved + pending + rejected + cancelled,
      approved,
      pending,
      rejected,
      cancelled,
      // sum() gives null on an empty set, and a DECIMAL column comes back as
      // a string, so neither reaches the client as-is.
      approvedDays: Number(approvedDays ?? 0),
      approvedThisMonth: decidedByStatus.get(LeaveRequestStatus.APPROVED) ?? 0,
      rejectedThisMonth: decidedByStatus.get(LeaveRequestStatus.REJECTED) ?? 0,
      growth: await this.computeGrowth(tenantId),
    };
  }

  /**
   * Month-over-month change per KPI card, counted on when each request was
   * filed (createdAt) rather than when the leave falls. A card asking "how
   * busy was this month" is asking about the filing, and leave is routinely
   * booked months ahead — dating it by fromDate would credit those requests
   * to a month that has not started yet.
   *
   * One grouped query per month rather than a COUNT per card: four cards
   * across two months is eight round trips for a figure the database can
   * return in two.
   */
  private async computeGrowth(tenantId: string): Promise<LeaveStats['growth']> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const scope = await this.scopeWhere(tenantId);

    const tallyFor = async (from: Date, to: Date) => {
      const grouped = await LeaveRequestModel.findAll({
        where: { tenantId, createdAt: { [Op.gte]: from, [Op.lt]: to }, ...scope },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      });
      const byStatus = new Map<string, number>();
      let total = 0;
      for (const row of grouped as any[]) {
        const count = Number(row.count);
        byStatus.set(row.status, count);
        total += count;
      }
      return { byStatus, total };
    };

    const [thisMonth, prevMonth] = await Promise.all([
      tallyFor(monthStart, now),
      tallyFor(prevMonthStart, monthStart),
    ]);

    const change = (status: LeaveRequestStatus) =>
      pct(
        thisMonth.byStatus.get(status) ?? 0,
        prevMonth.byStatus.get(status) ?? 0,
      );

    return {
      totalRequests: pct(thisMonth.total, prevMonth.total),
      approved: change(LeaveRequestStatus.APPROVED),
      pending: change(LeaveRequestStatus.PENDING),
      rejected: change(LeaveRequestStatus.REJECTED),
    };
  }

  // ==========================================
  // Two-step approval: reporting manager, then their manager or HR
  // ==========================================

  private personName(row?: { firstName?: string | null; lastName?: string | null } | null): string {
    return row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '';
  }

  /** The organization's route for leave: what it saved, else the reporting manager, then their manager, else HR. */
  private async leavePolicy(tenantId: string): Promise<PolicyStage[]> {
    return (await loadPolicyStages(this.modelProvider, tenantId, 'LEAVE')) ?? DEFAULT_LEAVE_POLICY;
  }

  /** People, titles and department heads for working out a route, each looked up once. */
  private routeLookup(tenantId: string): Promise<RouteLookup> {
    return createRouteLookup(this.modelProvider, tenantId);
  }

  /** The route for a new request, from the organization's policy. */
  private async routeFor(tenantId: string, employeeId: string): Promise<LeaveApproval> {
    const lookup = await this.routeLookup(tenantId);
    const stages = await resolveStages(await this.leavePolicy(tenantId), employeeId, lookup);
    const requester = await lookup.person(employeeId);
    return buildApproval(stages, this.personName(requester) || 'the employee');
  }

  /** Who is deciding: their employee record, whether their scope is organization-wide, and what they hold. */
  private async actorFor(tenantId: string): Promise<Actor> {
    const rpc = currentRpcActor();
    return {
      employeeId: this.dataScope ? await this.dataScope.actorEmployeeId(tenantId) : null,
      orgWide: !this.dataScope || this.dataScope.scope() === DataScope.ORGANIZATION,
      permissions: rpc?.permissions ?? [],
      isFullAccess: rpc?.isFullAccess === true,
    };
  }

  /** Tells the employee and whoever it is now waiting on. Best effort. */
  private async announceMove(tenantId: string, record: any, approval: LeaveApproval): Promise<void> {
    try {
      const saved = await this.getOne(tenantId, record.id);
      const typeName = saved.leaveType?.name ?? 'leave';
      const when = `${saved.fromDate} to ${saved.toDate}`;
      await this.notifyPerson(tenantId, record.employeeId, 'Leave update', `Your ${typeName} request for ${when} changed hands. ${approval.statusText}`);
      if (approval.currentApproverId) {
        await this.notifyPerson(tenantId, approval.currentApproverId, 'Leave request waiting', `A ${typeName} request for ${when} is waiting for your approval.`);
      } else {
        await this.notifyHr(tenantId, [record.employeeId], 'Leave request waiting', `A ${typeName} request for ${when} is waiting for HR approval.`);
      }
    } catch (error: any) {
      this.logger.warn(`Leave request ${record.id} was moved but nobody was told: ${error?.message ?? error}`);
    }
  }

  /**
   * Someone's reporting line changed. Their pending leave, and their direct
   * reports' (whose later approvers are above this person), follow the new
   * route. Where nobody has approved yet the request is rebuilt from the
   * current policy. Where some stages are done it only moves when its approver
   * is no longer on the route, and then to the next stage or HR. Returns how
   * many requests moved.
   */
  async rerouteAfterReportingChange(tenantId: string, employeeId: string): Promise<number> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const reports = (await Employee.findAll({ where: { tenantId, reportingManagerId: employeeId }, attributes: ['id'], raw: true })) as unknown as { id: string }[];
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const pending: any[] = (await Leave.findAll({
      where: { tenantId, status: LeaveRequestStatus.PENDING, employeeId: { [Op.in]: [employeeId, ...reports.map((row) => row.id)] } },
    })) as any[];
    if (!pending.length) return 0;

    const lookup = await this.routeLookup(tenantId);
    const policy = await this.leavePolicy(tenantId);
    let moved = 0;
    for (const record of pending) {
      const approval = record.approval as LeaveApproval | null;
      if (!approval) continue;
      const next = rerouteApproval(approval, await resolveStages(policy, record.employeeId, lookup));
      if (!next) continue;
      await record.update({ approval: next });
      await this.announceMove(tenantId, record, next);
      moved++;
    }
    return moved;
  }

  /** Someone left: whatever was waiting on them goes to the next stage, or HR. */
  async releaseWaitingOn(tenantId: string, approverId: string): Promise<number> {
    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const waiting: any[] = (await Leave.findAll({
      where: {
        tenantId,
        status: LeaveRequestStatus.PENDING,
        [Op.and]: [sqlWhere(literal(`"LeaveRequest"."approval"->>'currentApproverId'`), approverId)],
      },
    })) as any[];

    let moved = 0;
    for (const record of waiting) {
      const approval = record.approval as LeaveApproval | null;
      if (!approval || approval.currentApproverId !== approverId) continue;
      const next = handOnApproval(approval, `${approval.currentApproverName ?? 'The approver'} is no longer with the organization.`);
      await record.update({ approval: next });
      await this.announceMove(tenantId, record, next);
      moved++;
    }
    return moved;
  }

  /** Requests in the caller's team, plus any request currently waiting on them. */
  private async visibleWhere(tenantId: string): Promise<Record<string, unknown>> {
    const scope = await this.scopeWhere(tenantId);
    if (Object.keys(scope).length === 0) return scope;
    const actorId = this.dataScope ? await this.dataScope.actorEmployeeId(tenantId) : null;
    const permissions = [...(currentRpcActor()?.permissions ?? [])].filter((permission) => permission !== '*');
    const alsoWaitingOnMe: any[] = [];
    if (actorId) alsoWaitingOnMe.push(sqlWhere(literal(`"LeaveRequest"."approval"->>'currentApproverId'`), actorId));
    // A stage that any holder of a permission decides is visible to every holder.
    if (permissions.length) alsoWaitingOnMe.push(sqlWhere(literal(`"LeaveRequest"."approval"->>'currentPermission'`), { [Op.in]: permissions } as any));
    return alsoWaitingOnMe.length ? { [Op.or]: [scope, ...alsoWaitingOnMe] } : scope;
  }

  private async canDecide(tenantId: string, record: any): Promise<boolean> {
    if (record.status !== LeaveRequestStatus.PENDING) return false;
    const actor = await this.actorFor(tenantId);
    if (actor.employeeId && actor.employeeId === record.employeeId) return false;
    const approval = record.approval as unknown as LeaveApproval | null;
    if (!approval) return true;
    const { stages, index } = stagesOf(approval);
    return canActOnStage(stages[index], actor);
  }

  private async present(tenantId: string, record: any): Promise<LeaveRequestRow> {
    const row = this.toRow(record);
    row.canDecide = await this.canDecide(tenantId, record);
    return row;
  }

  private async notifyPerson(
    tenantId: string,
    employeeId: string | null | undefined,
    title: string,
    body: string,
  ): Promise<void> {
    if (!employeeId) return;
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({
        tenantId,
        employeeId,
        kind: EmployeeNotificationKind.LEAVE,
        title,
        body,
        readAt: null,
      });
    } catch (error: any) {
      this.logger.warn(`Leave saved but the notification was not: ${error?.message ?? error}`);
    }
  }

  /**
   * HR has no single employee id on the request, so each active HR login that
   * also has an employee record gets their own inbox row. The directory is
   * the link between the HR role (user-service) and the employee inbox.
   * Failure here must not fail the leave itself.
   */
  private async notifyHr(tenantId: string, exceptIds: string[], title: string, body: string): Promise<void> {
    if (!this.directory) return;
    try {
      const people = (await this.directory.findAll({
        where: {
          tenantId,
          roleCategory: DirectoryRoleCategory.HR,
          isActive: true,
          sourceType: DirectorySourceType.USER,
        },
        attributes: ['sourceId', 'email'],
        raw: true,
      })) as { sourceId: string; email: string }[];
      const userIds = people.map((person) => person.sourceId).filter(Boolean);
      const emails = people.map((person) => person.email).filter(Boolean);
      if (!userIds.length && !emails.length) return;

      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const rows = (await Employee.findAll({
        where: {
          tenantId,
          [Op.or]: [
            ...(userIds.length ? [{ userId: { [Op.in]: userIds } }] : []),
            ...emails.map((email) => ({ email: { [Op.iLike]: email } })),
          ],
        },
        attributes: ['id'],
        raw: true,
      })) as { id: string }[];
      const skip = new Set(exceptIds);
      for (const id of [...new Set(rows.map((row) => row.id))].filter((id) => !skip.has(id))) {
        await this.notifyPerson(tenantId, id, title, body);
      }
    } catch (error: any) {
      this.logger.warn(`Leave saved but HR was not notified: ${error?.message ?? error}`);
    }
  }

  // ==========================================
  // Writes
  // ==========================================

  async create(
    tenantId: string,
    dto: CreateLeaveRequestDto,
    appliedByUserId?: string,
  ): Promise<LeaveRequestRow> {
    await this.assertEmployeeExists(tenantId, dto.employeeId);
    await this.assertLeavePolicyUsable(tenantId, dto.leavePolicyId);

    const totalDays = this.resolveTotalDays(
      dto.fromDate,
      dto.toDate,
      dto.totalDays,
    );
    await this.assertNoOverlap(
      tenantId,
      dto.employeeId,
      dto.fromDate,
      dto.toDate,
    );

    const status = dto.status ?? LeaveRequestStatus.PENDING;
    const decided =
      status === LeaveRequestStatus.APPROVED ||
      status === LeaveRequestStatus.REJECTED;

    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);
    const created = await LeaveRequestModel.create({
      tenantId,
      employeeId: dto.employeeId,
      leavePolicyId: dto.leavePolicyId,
      fromDate: this.toDateOnly(dto.fromDate),
      toDate: this.toDateOnly(dto.toDate),
      totalDays,
      reason: dto.reason ?? null,
      status,
      approval: decided ? null : await this.routeFor(tenantId, dto.employeeId),
      // Filing something already decided still records who decided it, so the
      // row is not left looking like it approved itself.
      decidedByUserId: decided ? (appliedByUserId ?? null) : null,
      decidedAt: decided ? new Date() : null,
      appliedByUserId: appliedByUserId ?? null,
    } as any);

    const saved = await this.getOne(tenantId, created.id);
    if (!decided && saved.approval) {
      const typeName = saved.leaveType?.name ?? 'leave';
      const when = `${saved.fromDate} to ${saved.toDate}`;
      await this.notifyPerson(
        tenantId,
        dto.employeeId,
        'Leave Request',
        `Your ${typeName} request for ${when} ${saved.approval.statusText.charAt(0).toLowerCase()}${saved.approval.statusText.slice(1)}`,
      );
      if (saved.approval.currentApproverId) {
        await this.notifyPerson(
          tenantId,
          saved.approval.currentApproverId,
          'Leave request waiting',
          `A ${typeName} request for ${when} is waiting for your approval.`,
        );
      } else if (saved.approval.stage === 'WITH_HR') {
        await this.notifyHr(
          tenantId,
          [dto.employeeId],
          'Leave request waiting',
          `A ${typeName} request for ${when} is waiting for HR approval.`,
        );
      }
    }
    return saved;
  }

  /**
   * Edit a request that has not been decided yet. Changing an approved or
   * rejected one is refused: the dates it was decided on are the record of
   * what was agreed, and silently moving them would rewrite that history.
   */
  async update(
    tenantId: string,
    leaveRequestId: string,
    dto: UpdateLeaveRequestDto,
  ): Promise<LeaveRequestRow> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);
    const record = await LeaveRequestModel.findOne({
      where: { id: leaveRequestId, tenantId, ...(await this.scopeWhere(tenantId)) },
    });
    if (!record) this.notFound(leaveRequestId);

    if (record.status !== LeaveRequestStatus.PENDING) {
      this.conflict(
        `This request is already ${record.status.toLowerCase()} and can no longer be edited.`,
      );
    }

    if (dto.leavePolicyId) {
      await this.assertLeavePolicyUsable(tenantId, dto.leavePolicyId);
    }

    const fromDate = this.toDateOnly(dto.fromDate ?? record.fromDate);
    const toDate = this.toDateOnly(dto.toDate ?? record.toDate);
    const datesChanged =
      fromDate !== this.toDateOnly(record.fromDate) ||
      toDate !== this.toDateOnly(record.toDate);

    // Re-derive the span when the dates move and the caller did not pin a
    // figure, so a shortened request does not keep the old day count.
    const totalDays = this.resolveTotalDays(
      fromDate,
      toDate,
      dto.totalDays ?? (datesChanged ? undefined : Number(record.totalDays)),
    );

    if (datesChanged) {
      await this.assertNoOverlap(
        tenantId,
        record.employeeId,
        fromDate,
        toDate,
        leaveRequestId,
      );
    }

    await record.update({
      leavePolicyId: dto.leavePolicyId ?? record.leavePolicyId,
      fromDate,
      toDate,
      totalDays,
      reason: dto.reason ?? record.reason,
    });

    return this.getOne(tenantId, leaveRequestId);
  }

  /** Approve or reject a pending request (the row Approve / Reject actions). */
  async decide(
    tenantId: string,
    leaveRequestId: string,
    dto: DecideLeaveRequestDto,
    decidedByUserId?: string,
  ): Promise<LeaveRequestRow> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);
    const record = await LeaveRequestModel.findOne({
      where: { id: leaveRequestId, tenantId, ...(await this.visibleWhere(tenantId)) },
    });
    if (!record) this.notFound(leaveRequestId);

    if (record.status !== LeaveRequestStatus.PENDING) {
      this.conflict(`This request is already ${record.status.toLowerCase()}.`);
    }

    const approval = record.approval as unknown as LeaveApproval | null;
    if (approval) {
      return this.decideStaged(tenantId, record, approval, dto, decidedByUserId);
    }

    // Nobody decides their own leave — a Team Lead's goes to HR or the
    // organization admin, the same rule as employee requests.
    if (this.dataScope && (await this.dataScope.actorEmployeeId(tenantId)) === record.employeeId) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        "You can't approve or reject your own leave. Another approver or the organization admin will decide it.",
        HttpStatus.FORBIDDEN,
      );
    }

    await record.update({
      status: dto.status,
      decisionNote: dto.decisionNote ?? null,
      decidedByUserId: decidedByUserId ?? null,
      decidedAt: new Date(),
    });

    const decided = await this.getOne(tenantId, leaveRequestId);
    await this.notifyLeaveDecision(tenantId, record.employeeId, decided, dto.status);
    return decided;
  }

  /**
   * Withdraw a request. Kept separate from delete so the record survives:
   * cancelled leave still shows in history, and its dates are released for
   * another request.
   */
  async cancel(
    tenantId: string,
    leaveRequestId: string,
  ): Promise<LeaveRequestRow> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);
    const record = await LeaveRequestModel.findOne({
      where: { id: leaveRequestId, tenantId, ...(await this.scopeWhere(tenantId)) },
    });
    if (!record) this.notFound(leaveRequestId);

    if (record.status === LeaveRequestStatus.CANCELLED) {
      return this.getOne(tenantId, leaveRequestId);
    }
    if (record.status === LeaveRequestStatus.REJECTED) {
      this.conflict('A rejected request cannot be cancelled.');
    }

    await record.update({ status: LeaveRequestStatus.CANCELLED });
    return this.getOne(tenantId, leaveRequestId);
  }

  async remove(
    tenantId: string,
    leaveRequestId: string,
  ): Promise<{ deleted: boolean; id: string }> {
    const LeaveRequestModel =
      await this.modelProvider.getLeaveRequestModel(tenantId);
    const deleted = await LeaveRequestModel.destroy({
      where: { id: leaveRequestId, tenantId, ...(await this.scopeWhere(tenantId)) },
    });
    if (!deleted) this.notFound(leaveRequestId);
    return { deleted: true, id: leaveRequestId };
  }

  /**
   * The staged decision. Approving a stage that is not the last does not grant
   * the leave: it moves the request to the next stage, or to HR, and tells
   * both sides. Only approving the last stage sets the request to APPROVED.
   * Rejecting at any stage ends it.
   */
  private async decideStaged(
    tenantId: string,
    record: any,
    approval: LeaveApproval,
    dto: DecideLeaveRequestDto,
    decidedByUserId?: string,
  ): Promise<LeaveRequestRow> {
    const actor = await this.actorFor(tenantId);
    if (actor.employeeId && actor.employeeId === record.employeeId) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        "You can't approve or reject your own leave. Another approver or the organization admin will decide it.",
        HttpStatus.FORBIDDEN,
      );
    }
    const { stages, index } = stagesOf(approval);
    if (!canActOnStage(stages[index], actor)) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `This leave request is ${approval.statusText.charAt(0).toLowerCase()}${approval.statusText.slice(1)}`,
        HttpStatus.FORBIDDEN,
      );
    }

    const actorLabel = approval.currentApproverName
      ? `${approval.currentApproverName}${approval.currentApproverTitle ? ` (${approval.currentApproverTitle})` : ''}`
      : (stages[index].title ?? 'HR');

    if (dto.status === LeaveRequestStatus.REJECTED) {
      await record.update({
        status: LeaveRequestStatus.REJECTED,
        decisionNote: dto.decisionNote ?? null,
        decidedByUserId: decidedByUserId ?? null,
        decidedAt: new Date(),
        approval: rejectApproval(approval, actorLabel),
      });
      const decided = await this.getOne(tenantId, record.id);
      await this.notifyPerson(
        tenantId,
        record.employeeId,
        'Leave Rejected',
        `${actorLabel} rejected your ${decided.leaveType?.name ?? 'leave'} request for ${decided.fromDate} to ${decided.toDate}.`,
      );
      return decided;
    }

    // Not the last stage: the request only moves on.
    if (index < stages.length - 1) {
      const nextApproval = advanceApproval(approval, actorLabel);
      await record.update({ approval: nextApproval });
      const moved = await this.getOne(tenantId, record.id);
      const typeName = moved.leaveType?.name ?? 'leave';
      const when = `${moved.fromDate} to ${moved.toDate}`;
      await this.notifyPerson(tenantId, record.employeeId, 'Leave update', `Your ${typeName} request for ${when}: ${nextApproval.statusText}`);
      if (nextApproval.currentApproverId) {
        await this.notifyPerson(
          tenantId,
          nextApproval.currentApproverId,
          'Leave request waiting',
          `${actorLabel} approved a ${typeName} request for ${when}. It is now waiting for your approval.`,
        );
      } else if (nextApproval.stage === 'WITH_HR' && !nextApproval.currentPermission) {
        await this.notifyHr(
          tenantId,
          [record.employeeId, actor.employeeId].filter((id): id is string => Boolean(id)),
          'Leave request waiting',
          `${actorLabel} approved a ${typeName} request for ${when}. It is now waiting for HR approval.`,
        );
      }
      return moved;
    }

    await record.update({
      status: LeaveRequestStatus.APPROVED,
      decisionNote: dto.decisionNote ?? null,
      decidedByUserId: decidedByUserId ?? null,
      decidedAt: new Date(),
      approval: completeApproval(approval, actorLabel),
    });
    const decided = await this.getOne(tenantId, record.id);
    await this.notifyPerson(
      tenantId,
      record.employeeId,
      'Leave Approved',
      `${actorLabel} approved your ${decided.leaveType?.name ?? 'leave'} request for ${decided.fromDate} to ${decided.toDate}.`,
    );
    return decided;
  }

  /** Inbox row for the employee portal Notifications tab. Failure must not undo the decision. */
  private async notifyLeaveDecision(
    tenantId: string,
    employeeId: string,
    leave: LeaveRequestRow,
    status: LeaveRequestStatus,
  ) {
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      const approved = status === LeaveRequestStatus.APPROVED;
      const typeName = leave.leaveType?.name ?? 'leave';
      await Notification.create({
        tenantId,
        employeeId,
        kind: EmployeeNotificationKind.LEAVE,
        title: approved ? 'Leave Approved' : 'Leave Rejected',
        body: `Your ${typeName} request for ${leave.fromDate} to ${leave.toDate} has been ${approved ? 'approved' : 'rejected'}.`,
        readAt: null,
      });
    } catch (error: any) {
      this.logger.warn(
        `Leave decision saved but the employee notification was not: ${error?.message ?? error}`,
      );
    }
  }
}
