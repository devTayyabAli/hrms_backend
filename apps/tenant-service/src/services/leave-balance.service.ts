import { Injectable, Optional } from '@nestjs/common';
import { Op, col, fn, where as sequelizeWhere } from 'sequelize';
import {
  EXPORT_MAX_ROWS,
  EmployeeStatus,
  ExportResult,
  LeaveBalanceSortableField,
  LeaveRequestStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { fiscalYear, fiscalYearStarting, roundDays } from './leave-fiscal-year';

/** One leave type — a column of the table. */
export interface LeaveBalanceColumn {
  id: string;
  name: string;
  isPaid: boolean;
  /** Days granted per year. The same for everyone: eligibility and carry-forward are not applied. */
  allocation: number;
}

/** One employee's position on one leave type. */
export interface LeaveBalanceEntry {
  leavePolicyId: string;
  name: string;
  allocation: number;
  /** Approved days in the fiscal year. */
  used: number;
  /** Days waiting for a decision. */
  pending: number;
  /** Allocation less approved days, never below zero. */
  remaining: number;
  /** Remaining less pending: what a new application can still draw on. */
  available: number;
}

export interface LeaveBalanceRow {
  employee: {
    id: string;
    employeeCode: string;
    name: string;
    email: string | null;
    avatarUrl: string | null;
  };
  department: { id: string; name: string } | null;
  /** One entry per active leave type, in the same order as `policies`. */
  balances: LeaveBalanceEntry[];
  totals: { allocation: number; used: number; pending: number; remaining: number; available: number };
}

export interface GetLeaveBalancesQuery {
  page?: number;
  limit?: number;
  search?: string;
  departmentId?: string;
  fiscalYear?: number;
  sortBy?: LeaveBalanceSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

/** People who can take leave: those still employed. Resigned and inactive staff are left out. */
const BALANCE_STATUSES = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

/** `%` and `_` typed into the search box mean themselves, not "anything". */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * Leave → Balances: every employee's balance on every active leave type, for
 * one fiscal year (April–March).
 *
 * Same arithmetic as the employee's own My Leave cards (`getLeaveSummary`):
 * allocation less approved days is `remaining`; pending requests are held
 * back in `available`. The difference is the shape of the work. That
 * summary runs per person; doing it once per row here would be N+1 queries
 * on a table, so this takes the page of employees first and then sums the
 * leave of just those people in a single grouped query.
 */
@Injectable()
export class LeaveBalanceService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  private yearOf(query: { fiscalYear?: number }) {
    return query.fiscalYear ? fiscalYearStarting(query.fiscalYear) : fiscalYear();
  }

  /** The leave types that become columns: active ones, by name. */
  private async activePolicies(tenantId: string): Promise<LeaveBalanceColumn[]> {
    const Policy = await this.modelProvider.getLeavePolicyModel(tenantId);
    const rows = await Policy.findAll({ where: { tenantId, isActive: true }, order: [['name', 'ASC']] });
    return (rows as any[]).map((policy) => ({
      id: policy.id,
      name: policy.name,
      isPaid: policy.isPaid !== false,
      allocation: Number(policy.annualAllocation ?? 0),
    }));
  }

  private async employeeWhere(tenantId: string, query: GetLeaveBalancesQuery) {
    const where: Record<string | symbol, unknown> = {
      tenantId,
      status: { [Op.in]: BALANCE_STATUSES },
      // A Team Lead or Department Manager sees their own people, as on every other table.
      ...(this.dataScope ? await this.dataScope.employeeWhere(tenantId, 'id') : {}),
    };
    if (query.departmentId) where.departmentId = query.departmentId;

    const term = query.search?.trim();
    if (term) {
      const like = `%${escapeLike(term)}%`;
      where[Op.and] = [
        {
          [Op.or]: [
            { firstName: { [Op.iLike]: like } },
            { lastName: { [Op.iLike]: like } },
            { email: { [Op.iLike]: like } },
            { employeeCode: { [Op.iLike]: like } },
            // "Ayesha Khan" typed as one string matches neither column alone.
            sequelizeWhere(fn('concat', col('Employee.firstName'), ' ', col('Employee.lastName')), {
              [Op.iLike]: like,
            }),
          ],
        },
      ];
    }
    return where;
  }

  private order(sortBy: LeaveBalanceSortableField = 'employeeName', sortOrder: 'ASC' | 'DESC' = 'ASC') {
    const direction = sortOrder === 'DESC' ? 'DESC' : 'ASC';
    // The name tiebreakers keep pages stable when many people share a department.
    if (sortBy === 'employeeCode') return [['employeeCode', direction]] as any[];
    if (sortBy === 'department') {
      return [[col('department.name'), direction], ['firstName', 'ASC'], ['lastName', 'ASC']] as any[];
    }
    return [['firstName', direction], ['lastName', direction]] as any[];
  }

  private async employeesPage(
    tenantId: string,
    query: GetLeaveBalancesQuery,
    paging: { offset?: number; limit: number },
  ) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    return Employee.findAndCountAll({
      where: await this.employeeWhere(tenantId, query),
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'email', 'avatarUrl', 'departmentId'],
      include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
      order: this.order(query.sortBy, query.sortOrder),
      offset: paging.offset,
      limit: paging.limit,
    });
  }

  /** Approved and pending days per employee and leave type, for exactly these people. */
  private async daysFor(
    tenantId: string,
    employeeIds: string[],
    year: { start: string; end: string },
  ): Promise<Map<string, { used: number; pending: number }>> {
    const days = new Map<string, { used: number; pending: number }>();
    if (!employeeIds.length) return days;

    const Leave = await this.modelProvider.getLeaveRequestModel(tenantId);
    const sums = (await Leave.findAll({
      where: {
        tenantId,
        employeeId: { [Op.in]: employeeIds },
        status: { [Op.in]: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.PENDING] },
        // A request belongs to the fiscal year it starts in, as on My Leave.
        fromDate: { [Op.between]: [year.start, year.end] },
      },
      attributes: ['employeeId', 'leavePolicyId', 'status', [fn('SUM', col('totalDays')), 'days']],
      group: ['employeeId', 'leavePolicyId', 'status'],
      raw: true,
    })) as unknown as { employeeId: string; leavePolicyId: string; status: string; days: string | number }[];

    for (const sum of sums) {
      const key = `${sum.employeeId}:${sum.leavePolicyId}`;
      const entry = days.get(key) ?? { used: 0, pending: 0 };
      if (sum.status === LeaveRequestStatus.APPROVED) entry.used += Number(sum.days ?? 0);
      else entry.pending += Number(sum.days ?? 0);
      days.set(key, entry);
    }
    return days;
  }

  private toRows(
    employees: any[],
    policies: LeaveBalanceColumn[],
    days: Map<string, { used: number; pending: number }>,
  ): LeaveBalanceRow[] {
    return employees.map((employee) => {
      const balances = policies.map((policy): LeaveBalanceEntry => {
        const taken = days.get(`${employee.id}:${policy.id}`);
        const used = roundDays(taken?.used ?? 0);
        const pending = roundDays(taken?.pending ?? 0);
        return {
          leavePolicyId: policy.id,
          name: policy.name,
          allocation: policy.allocation,
          used,
          pending,
          remaining: Math.max(0, roundDays(policy.allocation - used)),
          available: Math.max(0, roundDays(policy.allocation - used - pending)),
        };
      });
      const sum = (key: 'allocation' | 'used' | 'pending' | 'remaining' | 'available') =>
        roundDays(balances.reduce((total, balance) => total + balance[key], 0));

      return {
        employee: {
          id: employee.id,
          employeeCode: employee.employeeCode,
          name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
          email: employee.email ?? null,
          avatarUrl: employee.avatarUrl ?? null,
        },
        department: employee.department ? { id: employee.department.id, name: employee.department.name } : null,
        balances,
        totals: {
          allocation: sum('allocation'),
          used: sum('used'),
          pending: sum('pending'),
          remaining: sum('remaining'),
          available: sum('available'),
        },
      };
    });
  }

  async getAll(tenantId: string, query: GetLeaveBalancesQuery) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;
    const year = this.yearOf(query);

    const [policies, { rows, count }] = await Promise.all([
      this.activePolicies(tenantId),
      this.employeesPage(tenantId, query, { offset: (page - 1) * limit, limit }),
    ]);
    const days = await this.daysFor(
      tenantId,
      (rows as any[]).map((employee) => employee.id),
      year,
    );

    return {
      fiscalYear: year.label,
      fiscalYearStart: year.start,
      fiscalYearEnd: year.end,
      policies,
      data: this.toRows(rows as any[], policies, days),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /**
   * The same table without paging, capped at EXPORT_MAX_ROWS with the
   * truncation reported rather than hidden. Carries `policies` so the CSV can
   * give each leave type its own columns.
   */
  async getAllForExport(
    tenantId: string,
    query: Omit<GetLeaveBalancesQuery, 'page' | 'limit'>,
  ): Promise<ExportResult<LeaveBalanceRow> & { fiscalYear: string; policies: LeaveBalanceColumn[] }> {
    const year = this.yearOf(query);
    const [policies, { rows, count }] = await Promise.all([
      this.activePolicies(tenantId),
      this.employeesPage(tenantId, query, { limit: EXPORT_MAX_ROWS }),
    ]);
    const days = await this.daysFor(
      tenantId,
      (rows as any[]).map((employee) => employee.id),
      year,
    );

    return {
      fiscalYear: year.label,
      policies,
      rows: this.toRows(rows as any[], policies, days),
      totalMatched: count,
      truncated: count > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }
}
