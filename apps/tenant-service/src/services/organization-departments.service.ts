import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, fn, col } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  EmployeeStatus,
  DepartmentStatusFilter,
  DepartmentSortableField,
  EXPORT_MAX_ROWS,
  ExportResult,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

/** Flattened row for the admin Departments table. */
export interface DepartmentRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  parentDepartmentId: string | null;
  /** Headcount excluding resigned employees. */
  employeeCount: number;
  manager: {
    id: string;
    employeeCode: string;
    name: string;
    avatarUrl: string | null;
  } | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetDepartmentsOverviewQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: DepartmentStatusFilter;
  sortBy?: DepartmentSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

export interface DepartmentStats {
  totalDepartments: number;
  activeDepartments: number;
  /** Employees assigned to any department (excludes resigned + unassigned). */
  totalEmployees: number;
  avgDepartmentSize: number;
  topDepartment: { id: string; name: string; employeeCount: number } | null;
  unassignedEmployees: number;
  /**
   * Percent change of each KPI against its value at the start of the current
   * calendar month. This is a stock comparison (how far the standing total
   * moved), not the flow comparison EmployeeService.growth uses (this month's
   * joiners vs. last month's): a card reading "8 departments, +14.3% this
   * month" means the organization went from 7 to 8, which is what the card
   * is asking. Counting only departments created this month against those
   * created last month would read 0% in every month where nothing was added
   * on either side — the common case for departments.
   */
  growth: {
    totalDepartments: number;
    totalEmployees: number;
    avgDepartmentSize: number;
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

/** Resigned employees stay on record but are not counted as headcount. */
const HEADCOUNT_STATUSES = [
  EmployeeStatus.ACTIVE,
  EmployeeStatus.ON_LEAVE,
  EmployeeStatus.INACTIVE,
];

/**
 * Read side of the admin Departments screen: KPI cards, the enriched table
 * (headcount + manager per row) and manager assignment.
 *
 * Create / update / delete deliberately live in OrganizationSetupService and
 * stay exposed at POST|PATCH|DELETE /organization/departments — the admin
 * screen's Add Department button and row actions reuse those rather than
 * introducing a second write path that could drift.
 */
@Injectable()
export class OrganizationDepartmentsService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private notFound(departmentId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Department '${departmentId}' not found in this organization.`,
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Headcount per department in one grouped query, so the table costs two
   * queries total rather than one per row.
   */
  private async countsByDepartment(
    tenantId: string,
  ): Promise<Map<string, number>> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const grouped = await EmployeeModel.findAll({
      where: { tenantId, status: { [Op.in]: HEADCOUNT_STATUSES } },
      attributes: ['departmentId', [fn('COUNT', col('id')), 'count']],
      group: ['departmentId'],
      raw: true,
    });

    const counts = new Map<string, number>();
    for (const row of grouped as any[]) {
      if (row.departmentId) counts.set(row.departmentId, Number(row.count));
    }
    return counts;
  }

  /** Managers for the given departments, fetched in one query. */
  private async managersFor(
    tenantId: string,
    managerIds: string[],
  ): Promise<Map<string, DepartmentRow['manager']>> {
    const unique = [...new Set(managerIds.filter(Boolean))];
    if (unique.length === 0) return new Map();

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = await EmployeeModel.findAll({
      where: { tenantId, id: { [Op.in]: unique } },
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl'],
      raw: true,
    });

    const managers = new Map<string, DepartmentRow['manager']>();
    for (const row of rows as any[]) {
      managers.set(row.id, {
        id: row.id,
        employeeCode: row.employeeCode,
        name: [row.firstName, row.lastName].filter(Boolean).join(' '),
        avatarUrl: row.avatarUrl ?? null,
      });
    }
    return managers;
  }

  private buildWhere(
    tenantId: string,
    query: GetDepartmentsOverviewQuery,
  ): any {
    const where: any = { tenantId };

    if (query.status && query.status !== DepartmentStatusFilter.ALL) {
      where.isActive = query.status === DepartmentStatusFilter.ACTIVE;
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { name: { [Op.iLike]: term } },
        { code: { [Op.iLike]: term } },
        { description: { [Op.iLike]: term } },
      ];
    }

    return where;
  }

  /**
   * The enriched Departments table.
   *
   * `employeeCount` is a derived value from another table, so sorting by it
   * cannot be pushed into the departments query. Only that one sort key
   * falls back to fetch-then-sort in memory; every other key is ordered and
   * paginated by the database.
   */
  async getOverview(
    tenantId: string,
    query: GetDepartmentsOverviewQuery,
  ): Promise<{
    data: DepartmentRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;
    const sortBy = query.sortBy ?? 'name';
    const sortOrder = query.sortOrder === 'DESC' ? 'DESC' : 'ASC';

    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const where = this.buildWhere(tenantId, query);
    const counts = await this.countsByDepartment(tenantId);

    if (sortBy === 'employeeCount') {
      const all = await DepartmentModel.findAll({ where });
      const enriched = await this.enrich(tenantId, all as any[], counts);
      enriched.sort((a, b) =>
        sortOrder === 'ASC'
          ? a.employeeCount - b.employeeCount
          : b.employeeCount - a.employeeCount,
      );
      const start = (page - 1) * limit;
      return {
        data: enriched.slice(start, start + limit),
        total: enriched.length,
        page,
        limit,
        totalPages: Math.ceil(enriched.length / limit) || 1,
      };
    }

    const { rows, count } = await DepartmentModel.findAndCountAll({
      where,
      order: [[sortBy, sortOrder]],
      offset: (page - 1) * limit,
      limit,
    });

    return {
      data: await this.enrich(tenantId, rows as any[], counts),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /**
   * Capped at EXPORT_MAX_ROWS for consistency with the employee and
   * attendance exports. Departments are the smallest of the three by far, so
   * the cap should never bite in practice — it is here so no export path can
   * issue an unbounded findAll.
   */
  async getAllForExport(
    tenantId: string,
    query: Omit<GetDepartmentsOverviewQuery, 'page' | 'limit'>,
  ): Promise<ExportResult<DepartmentRow>> {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const sortBy = query.sortBy ?? 'name';
    const sortOrder = query.sortOrder === 'DESC' ? 'DESC' : 'ASC';
    const counts = await this.countsByDepartment(tenantId);

    const { rows, count } = await DepartmentModel.findAndCountAll({
      where: this.buildWhere(tenantId, query),
      order:
        sortBy === 'employeeCount' ? [['name', 'ASC']] : [[sortBy, sortOrder]],
      limit: EXPORT_MAX_ROWS,
    });

    const enriched = await this.enrich(tenantId, rows as any[], counts);
    if (sortBy === 'employeeCount') {
      enriched.sort((a, b) =>
        sortOrder === 'ASC'
          ? a.employeeCount - b.employeeCount
          : b.employeeCount - a.employeeCount,
      );
    }

    return {
      rows: enriched,
      totalMatched: count,
      truncated: count > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  private async enrich(
    tenantId: string,
    departments: any[],
    counts: Map<string, number>,
  ): Promise<DepartmentRow[]> {
    const managers = await this.managersFor(
      tenantId,
      departments.map((dept) => dept.managerId).filter(Boolean),
    );

    return departments.map((dept) => ({
      id: dept.id,
      name: dept.name,
      code: dept.code ?? null,
      description: dept.description ?? null,
      parentDepartmentId: dept.parentDepartmentId ?? null,
      employeeCount: counts.get(dept.id) ?? 0,
      manager: dept.managerId ? (managers.get(dept.managerId) ?? null) : null,
      isActive: dept.isActive,
      createdAt: dept.createdAt,
      updatedAt: dept.updatedAt,
    }));
  }

  async getOne(tenantId: string, departmentId: string): Promise<DepartmentRow> {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const department = await DepartmentModel.findOne({
      where: { id: departmentId, tenantId },
    });
    if (!department) this.notFound(departmentId);

    const [row] = await this.enrich(
      tenantId,
      [department],
      await this.countsByDepartment(tenantId),
    );
    return row;
  }

  /** KPI cards: Total Departments, Total Employees, Avg Size, Top Department. */
  async getStats(tenantId: string): Promise<DepartmentStats> {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    const [totalDepartments, activeDepartments, counts, unassignedEmployees] =
      await Promise.all([
        DepartmentModel.count({ where: { tenantId } }),
        DepartmentModel.count({ where: { tenantId, isActive: true } }),
        this.countsByDepartment(tenantId),
        EmployeeModel.count({
          where: {
            tenantId,
            departmentId: null,
            status: { [Op.in]: HEADCOUNT_STATUSES },
          },
        }),
      ]);

    const assignedEmployees = [...counts.values()].reduce(
      (sum, count) => sum + count,
      0,
    );

    let topDepartment: DepartmentStats['topDepartment'] = null;
    if (counts.size > 0) {
      const [topId, topCount] = [...counts.entries()].reduce((best, entry) =>
        entry[1] > best[1] ? entry : best,
      );
      const department = await DepartmentModel.findOne({
        where: { id: topId, tenantId },
        attributes: ['id', 'name'],
      });
      if (department) {
        topDepartment = {
          id: department.id,
          name: department.name,
          employeeCount: topCount,
        };
      }
    }

    // Averaged across every department, including empty ones — an empty
    // department genuinely drags the average down, and excluding it would
    // overstate how evenly staffed the organization is.
    const avgDepartmentSize = this.average(assignedEmployees, totalDepartments);

    return {
      totalDepartments,
      activeDepartments,
      totalEmployees: assignedEmployees,
      avgDepartmentSize,
      topDepartment,
      unassignedEmployees,
      growth: await this.computeGrowth(tenantId, {
        totalDepartments,
        totalEmployees: assignedEmployees,
        avgDepartmentSize,
      }),
    };
  }

  /** Headcount per department, to one decimal place. */
  private average(employees: number, departments: number): number {
    if (departments === 0) return 0;
    return Math.round((employees / departments) * 10) / 10;
  }

  /**
   * Each KPI as it stood at 00:00 on the 1st of this month, compared against
   * where it stands now.
   *
   * Departments are aged on createdAt and employees on joiningDate — the same
   * choice EmployeeService makes, so a backfilled record counts from when the
   * person actually started rather than when someone typed them in. The
   * headcount filter is unavoidably approximate: status is only stored as its
   * current value, so somebody who joined in March and resigned yesterday is
   * missing from the March baseline too. That understates the baseline
   * slightly, never the current figure.
   */
  private async computeGrowth(
    tenantId: string,
    current: {
      totalDepartments: number;
      totalEmployees: number;
      avgDepartmentSize: number;
    },
  ): Promise<DepartmentStats['growth']> {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // joiningDate is a DATEONLY, so it is compared against a plain
    // 'YYYY-MM-01' string built from local parts. Going through
    // toISOString() would re-express local midnight in UTC and, east of
    // Greenwich, hand back the last day of the *previous* month.
    const monthStartDate = [
      monthStart.getFullYear(),
      String(monthStart.getMonth() + 1).padStart(2, '0'),
      '01',
    ].join('-');

    const [priorDepartments, priorEmployees] = await Promise.all([
      DepartmentModel.count({
        where: { tenantId, createdAt: { [Op.lt]: monthStart } },
      }),
      EmployeeModel.count({
        where: {
          tenantId,
          departmentId: { [Op.ne]: null },
          status: { [Op.in]: HEADCOUNT_STATUSES },
          joiningDate: { [Op.lt]: monthStartDate },
        },
      }),
    ]);

    return {
      totalDepartments: pct(current.totalDepartments, priorDepartments),
      totalEmployees: pct(current.totalEmployees, priorEmployees),
      avgDepartmentSize: pct(
        current.avgDepartmentSize,
        this.average(priorEmployees, priorDepartments),
      ),
    };
  }

  /**
   * Set or clear the department head. The manager must be an employee of the
   * same tenant; `managerId: null` clears the assignment.
   */
  async assignManager(
    tenantId: string,
    departmentId: string,
    managerId: string | null,
  ): Promise<DepartmentRow> {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const department = await DepartmentModel.findOne({
      where: { id: departmentId, tenantId },
    });
    if (!department) this.notFound(departmentId);

    if (managerId) {
      const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
      const manager = await EmployeeModel.findOne({
        where: { id: managerId, tenantId },
        attributes: ['id', 'status'],
      });
      if (!manager) {
        throw new TenantException(
          TenantErrorCode.INVALID_TENANT_CONTEXT,
          `Employee '${managerId}' not found in this organization.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (manager.status === EmployeeStatus.RESIGNED) {
        throw new TenantException(
          TenantErrorCode.INVALID_TENANT_CONTEXT,
          'A resigned employee cannot be assigned as department manager.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    await department.update({ managerId: managerId ?? null });
    return this.getOne(tenantId, departmentId);
  }
}
