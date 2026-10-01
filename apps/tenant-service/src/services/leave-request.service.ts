import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, fn, col, literal } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
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
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';

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
}

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
      where: { id: leaveRequestId, tenantId, ...(await this.scopeWhere(tenantId)) },
      include: await this.buildInclude(tenantId),
    });
    if (!record) this.notFound(leaveRequestId);
    return this.toRow(record);
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
      // Filing something already decided still records who decided it, so the
      // row is not left looking like it approved itself.
      decidedByUserId: decided ? (appliedByUserId ?? null) : null,
      decidedAt: decided ? new Date() : null,
      appliedByUserId: appliedByUserId ?? null,
    } as any);

    return this.getOne(tenantId, created.id);
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
      where: { id: leaveRequestId, tenantId, ...(await this.scopeWhere(tenantId)) },
    });
    if (!record) this.notFound(leaveRequestId);

    if (record.status !== LeaveRequestStatus.PENDING) {
      this.conflict(`This request is already ${record.status.toLowerCase()}.`);
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
