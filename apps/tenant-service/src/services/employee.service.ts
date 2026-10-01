import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op, fn, col, where as sequelizeWhere, literal } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  EmployeeStatus,
  EmployeeStatusFilter,
  EmployeeSortableField,
  EMPLOYEE_PROFILE_FIELDS,
  EmployeeProfileField,
  CreateEmployeeDto,
  UpdateEmployeeDto,
  EXPORT_MAX_ROWS,
  ExportResult,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';
import { SubscriptionLimitService } from './subscription-limit.service';
import { EmployeeInvitationService } from './employee-invitation.service';

/** Flattened employee shape the Employees screen renders directly. */
export interface EmployeeRow {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  /** Pre-joined display name so the table needs no client-side concat. */
  name: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  department: { id: string; name: string } | null;
  designation: { id: string; title: string } | null;
  reportingManager: { id: string; name: string } | null;
  status: EmployeeStatus;
  joiningDate: string | null;
  exitDate: string | null;
  userId: string | null;
  // No salary or bank fields: anyone with employee access reads these rows
  // (a department manager included). Pay is served by the payroll routes,
  // behind payroll permissions.
  /** Personal, contact and employment details — null until filled in. */
  profile: Record<EmployeeProfileField, string | null>;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetEmployeesQuery {
  page?: number;
  limit?: number;
  search?: string;
  departmentId?: string;
  designationId?: string;
  status?: EmployeeStatusFilter;
  sortBy?: EmployeeSortableField;
  sortOrder?: 'ASC' | 'DESC';
}

/**
 * The date's own calendar day, for comparing against a DATEONLY column.
 *
 * Every month boundary here is built with `new Date(year, month, 1)`, which
 * is local midnight. In any zone ahead of UTC that instant is still the
 * previous day in UTC, so formatting it via `toISOString()` would move the
 * boundary back a day and count the last day of the previous month as part
 * of this one.
 */
const localDateOnly = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

export interface EmployeeStats {
  totalEmployees: number;
  active: number;
  onLeave: number;
  resigned: number;
  inactive: number;
  /**
   * The "New (Month)" card — how many people actually started this calendar
   * month. `growth` below is a percentage, which cannot answer "how many".
   */
  newThisMonth: number;
  /** Percent change vs. the previous calendar month, by joining date. */
  growth: {
    totalEmployees: number;
    active: number;
    onLeave: number;
    resigned: number;
  };
}

/**
 * Statuses that occupy a licensed seat. A RESIGNED employee is kept for
 * history and reporting but no longer counts against the plan's maxEmployees.
 */
const SEAT_CONSUMING_STATUSES = [
  EmployeeStatus.ACTIVE,
  EmployeeStatus.ON_LEAVE,
  EmployeeStatus.INACTIVE,
];

@Injectable()
export class EmployeeService {
  private readonly logger = new Logger(EmployeeService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly subscriptionLimitService: SubscriptionLimitService,
    private readonly employeeInvitationService: EmployeeInvitationService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  // ==========================================
  // Helpers
  // ==========================================

  /**
   * Narrows employee queries to the caller's team or department when their
   * role is scoped (see DataScopeService); `{}` for organization-wide callers.
   */
  private async scopeWhere(tenantId: string): Promise<Record<string, unknown>> {
    return this.dataScope ? this.dataScope.employeeWhere(tenantId, 'id') : {};
  }

  private async assertInScope(tenantId: string, employeeId: string): Promise<void> {
    if (this.dataScope && !(await this.dataScope.canSee(tenantId, employeeId))) this.notFound(employeeId);
  }

  private notFound(employeeId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Employee '${employeeId}' not found in this organization.`,
      HttpStatus.NOT_FOUND,
    );
  }

  private conflict(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.CONFLICT,
    );
  }

  private badRequest(message: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }

  private toRow(employee: any): EmployeeRow {
    const manager = employee.reportingManager;
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      firstName: employee.firstName,
      lastName: employee.lastName,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
      email: employee.email,
      phone: employee.phone ?? null,
      avatarUrl: employee.avatarUrl ?? null,
      department: employee.department
        ? { id: employee.department.id, name: employee.department.name }
        : null,
      designation: employee.designation
        ? { id: employee.designation.id, title: employee.designation.title }
        : null,
      reportingManager: manager
        ? {
            id: manager.id,
            name: [manager.firstName, manager.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : null,
      status: employee.status,
      joiningDate: employee.joiningDate ?? null,
      exitDate: employee.exitDate ?? null,
      userId: employee.userId ?? null,
      profile: Object.fromEntries(
        EMPLOYEE_PROFILE_FIELDS.map((field) => [field, employee[field] ?? null]),
      ) as EmployeeRow['profile'],
      createdAt: employee.createdAt,
      updatedAt: employee.updatedAt,
    };
  }

  /**
   * The profile fields present on a create/update DTO, trimmed, with blank
   * strings stored as null — so clearing a field in the form clears it here.
   */
  private profilePatch(dto: Partial<Record<EmployeeProfileField, unknown>>): Partial<Record<EmployeeProfileField, string | null>> {
    const patch: Partial<Record<EmployeeProfileField, string | null>> = {};
    for (const field of EMPLOYEE_PROFILE_FIELDS) {
      if (dto[field] === undefined) continue;
      const value = dto[field] === null ? '' : String(dto[field]).trim();
      patch[field] = value === '' ? null : value;
    }
    return patch;
  }

  /** Cross-field checks the DTO can't express on its own. */
  private async assertProfileValid(
    tenantId: string,
    profile: Partial<Record<EmployeeProfileField, string | null>>,
    joiningDate: string | null | undefined,
    employeeId?: string,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (profile.dateOfBirth && profile.dateOfBirth >= today) {
      this.badRequest('Date of birth must be in the past.');
    }
    if (profile.dateOfBirth && joiningDate && profile.dateOfBirth >= joiningDate) {
      this.badRequest('Date of birth must be before the joining date.');
    }
    for (const [field, label] of [
      ['probationEndDate', 'Probation end date'],
      ['contractEndDate', 'Contract end date'],
    ] as const) {
      const value = profile[field];
      if (value && joiningDate && value < joiningDate) {
        this.badRequest(`${label} can't be before the joining date.`);
      }
    }
    if (profile.nationalId) {
      const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
      const taken = await EmployeeModel.findOne({
        where: {
          tenantId,
          nationalId: profile.nationalId,
          ...(employeeId ? { id: { [Op.ne]: employeeId } } : {}),
        },
        attributes: ['id', 'employeeCode'],
      });
      if (taken) this.conflict(`National ID '${profile.nationalId}' is already on employee ${taken.employeeCode}.`);
    }
  }

  /** Eager-loads the three associations the table displays. */
  private async buildInclude(tenantId: string) {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const DesignationModel =
      await this.modelProvider.getDesignationModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

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
      {
        model: EmployeeModel,
        as: 'reportingManager',
        attributes: ['id', 'firstName', 'lastName'],
        required: false,
      },
    ];
  }

  private buildWhere(tenantId: string, query: GetEmployeesQuery) {
    const where: any = { tenantId };

    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.designationId) where.designationId = query.designationId;

    if (query.status && query.status !== EmployeeStatusFilter.ALL) {
      where.status = query.status;
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { firstName: { [Op.iLike]: term } },
        { lastName: { [Op.iLike]: term } },
        { email: { [Op.iLike]: term } },
        { employeeCode: { [Op.iLike]: term } },
        // Matches "Ayesha Khan" typed as one string, which none of the
        // single-column matches above would catch.
        sequelizeWhere(
          fn(
            'concat',
            col('Employee.firstName'),
            ' ',
            col('Employee.lastName'),
          ),
          { [Op.iLike]: term },
        ),
      ];
    }

    return where;
  }

  /**
   * Translate the API's sortBy into real ORDER BY terms. `name`, `department`
   * and `designation` are display concepts, not columns, so they map onto the
   * underlying column(s) — including across the eager-loaded associations.
   */
  private buildOrder(
    sortBy: EmployeeSortableField = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): any[] {
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    switch (sortBy) {
      case 'name':
        return [
          ['firstName', dir],
          ['lastName', dir],
        ];
      case 'department':
        // Sorting on an association column has to reference the aliased
        // join, and NULLS LAST keeps unassigned employees out of the way.
        return [[literal(`"department"."name" ${dir} NULLS LAST`)]];
      case 'designation':
        return [[literal(`"designation"."title" ${dir} NULLS LAST`)]];
      case 'joiningDate':
        return [[literal(`"Employee"."joiningDate" ${dir} NULLS LAST`)]];
      default:
        return [[sortBy, dir]];
    }
  }

  /**
   * Next sequential employee code (EMP001, EMP002, ...). Derived from the
   * highest existing numeric suffix rather than the row count, so codes stay
   * unique after employees are deleted.
   */
  async nextEmployeeCode(tenantId: string): Promise<string> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    // Ask the database for the single highest code instead of reading every
    // employee row and scanning them here. The old form transferred one row
    // per employee on every hire, and a tenant with 5,000 employees paid for
    // 5,000 rows to compute one integer.
    //
    // The MAX is over the numeric suffix, not over `employeeCode` itself: a
    // plain string comparison ranks 'EMP999' above 'EMP1000', so
    // MAX(employeeCode) would restart numbering at EMP1000 once a tenant
    // crossed 999 employees and collide with a code already issued.
    //
    // Rows whose code does not match the EMP<digits> shape (hand-entered ids
    // — `employeeCode` is caller-supplied when provided) are filtered out
    // rather than coerced, because the CAST below would otherwise fail on
    // them. The match is case-insensitive to preserve the behavior of the
    // /^EMP(\d+)$/i scan this replaces; SUBSTRING FROM 4 is still correct,
    // since the prefix is three characters whatever its case.
    const [row] = (await EmployeeModel.findAll({
      where: {
        tenantId,
        employeeCode: { [Op.iRegexp]: '^EMP[0-9]+$' },
      },
      attributes: [
        [
          literal(`MAX(CAST(SUBSTRING("employeeCode" FROM 4) AS INTEGER))`),
          'highest',
        ],
      ],
      raw: true,
    })) as unknown as Array<{ highest: number | string | null }>;

    const highest = Number(row?.highest ?? 0) || 0;
    return `EMP${String(highest + 1).padStart(3, '0')}`;
  }

  /** Rejects a department/designation/manager id that belongs to another tenant. */
  private async assertReferencesExist(
    tenantId: string,
    refs: {
      departmentId?: string | null;
      designationId?: string | null;
      reportingManagerId?: string | null;
    },
    selfId?: string,
  ): Promise<void> {
    if (refs.departmentId) {
      const DepartmentModel =
        await this.modelProvider.getDepartmentModel(tenantId);
      const found = await DepartmentModel.findOne({
        where: { id: refs.departmentId, tenantId },
      });
      if (!found) this.badRequest('Department not found in this organization.');
    }

    if (refs.designationId) {
      const DesignationModel =
        await this.modelProvider.getDesignationModel(tenantId);
      const found = await DesignationModel.findOne({
        where: { id: refs.designationId, tenantId },
      });
      if (!found)
        this.badRequest('Designation not found in this organization.');
    }

    if (refs.reportingManagerId) {
      if (selfId && refs.reportingManagerId === selfId) {
        this.badRequest('An employee cannot report to themselves.');
      }
      const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
      const found = await EmployeeModel.findOne({
        where: { id: refs.reportingManagerId, tenantId },
      });
      if (!found) {
        this.badRequest('Reporting manager not found in this organization.');
      }
    }
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(
    tenantId: string,
    query: GetEmployeesQuery,
  ): Promise<{
    data: EmployeeRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    const { rows, count } = await EmployeeModel.findAndCountAll({
      where: { ...this.buildWhere(tenantId, query), ...(await this.scopeWhere(tenantId)) },
      include: await this.buildInclude(tenantId),
      order: this.buildOrder(query.sortBy, query.sortOrder),
      offset: (page - 1) * limit,
      limit,
      // Every include is a belongsTo (one row each), so the join cannot
      // multiply results and DISTINCT would only cost a sort.
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

  /** Same filters as getAll, without pagination — backs the CSV export. */
  /**
   * Same filters as getAll, capped at EXPORT_MAX_ROWS rather than unbounded —
   * the whole set is held in memory and shipped in one RPC message, so a
   * large tenant's full history would risk both sides. Truncation is reported
   * instead of being applied silently.
   */
  async getAllForExport(
    tenantId: string,
    query: Omit<GetEmployeesQuery, 'page' | 'limit'>,
  ): Promise<ExportResult<EmployeeRow>> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const where = { ...this.buildWhere(tenantId, query), ...(await this.scopeWhere(tenantId)) };

    const { rows, count } = await EmployeeModel.findAndCountAll({
      where,
      include: await this.buildInclude(tenantId),
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

  async getOne(tenantId: string, employeeId: string): Promise<EmployeeRow> {
    await this.assertInScope(tenantId, employeeId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await EmployeeModel.findOne({
      where: { id: employeeId, tenantId },
      include: await this.buildInclude(tenantId),
    });
    if (!employee) this.notFound(employeeId);
    return this.toRow(employee);
  }

  /**
   * id/code/name triples for populating pickers (reporting manager,
   * department manager, attendance entry) without loading full rows.
   */
  async getDirectory(
    tenantId: string,
  ): Promise<{ id: string; employeeCode: string; name: string }[]> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = await EmployeeModel.findAll({
      where: { tenantId, status: { [Op.ne]: EmployeeStatus.RESIGNED } },
      attributes: ['id', 'employeeCode', 'firstName', 'lastName'],
      order: [
        ['firstName', 'ASC'],
        ['lastName', 'ASC'],
      ],
      raw: true,
    });
    return (rows as any[]).map((row) => ({
      id: row.id,
      employeeCode: row.employeeCode,
      name: [row.firstName, row.lastName].filter(Boolean).join(' '),
    }));
  }

  async getStats(tenantId: string): Promise<EmployeeStats> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    // One grouped query for the four status counts instead of four COUNTs.
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const scope = await this.scopeWhere(tenantId);

    const [grouped, newThisMonth] = await Promise.all([
      EmployeeModel.findAll({
        where: { tenantId, ...scope },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
      EmployeeModel.count({
        where: {
          tenantId,
          ...scope,
          joiningDate: { [Op.gte]: localDateOnly(monthStart) },
        },
      }),
    ]);

    const byStatus = new Map<string, number>();
    for (const row of grouped as any[]) {
      byStatus.set(row.status, Number(row.count));
    }

    const active = byStatus.get(EmployeeStatus.ACTIVE) ?? 0;
    const onLeave = byStatus.get(EmployeeStatus.ON_LEAVE) ?? 0;
    const resigned = byStatus.get(EmployeeStatus.RESIGNED) ?? 0;
    const inactive = byStatus.get(EmployeeStatus.INACTIVE) ?? 0;
    const totalEmployees = active + onLeave + resigned + inactive;

    return {
      totalEmployees,
      active,
      onLeave,
      resigned,
      inactive,
      newThisMonth,
      growth: await this.computeGrowth(tenantId),
    };
  }

  /**
   * Month-over-month change in joiners, per KPI card. Measured on joiningDate
   * (when someone actually started) rather than createdAt (when a record was
   * typed in), so backfilled data reports honestly.
   */
  private async computeGrowth(
    tenantId: string,
  ): Promise<EmployeeStats['growth']> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const toDateOnly = localDateOnly;
    const scope = await this.scopeWhere(tenantId);

    const countIn = async (from: Date, to: Date, status?: EmployeeStatus) => {
      const where: any = {
        tenantId,
        ...scope,
        joiningDate: { [Op.gte]: toDateOnly(from), [Op.lt]: toDateOnly(to) },
      };
      if (status) where.status = status;
      return EmployeeModel.count({ where });
    };

    const pct = (thisMonth: number, lastMonth: number) => {
      if (lastMonth === 0) return thisMonth > 0 ? 100 : 0;
      return Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10;
    };

    const [
      totalThis,
      totalPrev,
      activeThis,
      activePrev,
      leaveThis,
      leavePrev,
      resignedThis,
      resignedPrev,
    ] = await Promise.all([
      countIn(monthStart, now),
      countIn(prevMonthStart, monthStart),
      countIn(monthStart, now, EmployeeStatus.ACTIVE),
      countIn(prevMonthStart, monthStart, EmployeeStatus.ACTIVE),
      countIn(monthStart, now, EmployeeStatus.ON_LEAVE),
      countIn(prevMonthStart, monthStart, EmployeeStatus.ON_LEAVE),
      countIn(monthStart, now, EmployeeStatus.RESIGNED),
      countIn(prevMonthStart, monthStart, EmployeeStatus.RESIGNED),
    ]);

    return {
      totalEmployees: pct(totalThis, totalPrev),
      active: pct(activeThis, activePrev),
      onLeave: pct(leaveThis, leavePrev),
      resigned: pct(resignedThis, resignedPrev),
    };
  }

  /** Seat count used by SubscriptionLimitService — excludes RESIGNED. */
  async countSeats(tenantId: string): Promise<number> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    return EmployeeModel.count({
      where: { tenantId, status: { [Op.in]: SEAT_CONSUMING_STATUSES } },
    });
  }

  // ==========================================
  // Writes
  // ==========================================

  async create(tenantId: string, dto: CreateEmployeeDto): Promise<EmployeeRow> {
    // Plan seat limit is checked before anything is written.
    await this.subscriptionLimitService.checkEmployeeLimit(tenantId);

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    const email = dto.email.trim().toLowerCase();
    const emailTaken = await EmployeeModel.findOne({
      where: { tenantId, email },
    });
    if (emailTaken) {
      this.conflict(`An employee with email '${email}' already exists.`);
    }

    const employeeCode =
      dto.employeeCode?.trim() || (await this.nextEmployeeCode(tenantId));
    const codeTaken = await EmployeeModel.findOne({
      where: { tenantId, employeeCode },
    });
    if (codeTaken) {
      this.conflict(`Employee ID '${employeeCode}' is already in use.`);
    }

    await this.assertReferencesExist(tenantId, dto);
    const profile = this.profilePatch(dto);
    await this.assertProfileValid(tenantId, profile, dto.joiningDate);

    const created = await EmployeeModel.create({
      ...profile,
      tenantId,
      employeeCode,
      firstName: dto.firstName.trim(),
      lastName: dto.lastName.trim(),
      email,
      phone: dto.phone ?? null,
      departmentId: dto.departmentId ?? null,
      designationId: dto.designationId ?? null,
      reportingManagerId: dto.reportingManagerId ?? null,
      joiningDate: dto.joiningDate ?? null,
      status: dto.status ?? EmployeeStatus.ACTIVE,
      avatarUrl: dto.avatarUrl ?? null,
      userId: dto.userId ?? null,
    });

    this.logger.log(
      `Employee ${employeeCode} (${email}) created for tenant ${tenantId}`,
    );

    // Portal access is no longer granted automatically at hire — HR sends it
    // explicitly via the "Invite Employee" quick action
    // (`HrPortalController.invite` -> `EmployeeInvitationService.invite`),
    // which also guards against inviting someone who already has access.
    return this.getOne(tenantId, created.id);
  }

  async update(
    tenantId: string,
    employeeId: string,
    dto: UpdateEmployeeDto,
  ): Promise<EmployeeRow> {
    await this.assertInScope(tenantId, employeeId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await EmployeeModel.findOne({
      where: { id: employeeId, tenantId },
    });
    if (!employee) this.notFound(employeeId);

    const patch: any = {};

    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      if (email !== employee.email) {
        const taken = await EmployeeModel.findOne({
          where: { tenantId, email, id: { [Op.ne]: employeeId } },
        });
        if (taken) {
          this.conflict(`An employee with email '${email}' already exists.`);
        }
      }
      patch.email = email;
    }

    if (dto.employeeCode !== undefined) {
      const employeeCode = dto.employeeCode.trim();
      if (employeeCode !== employee.employeeCode) {
        const taken = await EmployeeModel.findOne({
          where: { tenantId, employeeCode, id: { [Op.ne]: employeeId } },
        });
        if (taken) {
          this.conflict(`Employee ID '${employeeCode}' is already in use.`);
        }
      }
      patch.employeeCode = employeeCode;
    }

    await this.assertReferencesExist(tenantId, dto, employeeId);

    if (dto.firstName !== undefined) patch.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) patch.lastName = dto.lastName.trim();
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.departmentId !== undefined) patch.departmentId = dto.departmentId;
    if (dto.designationId !== undefined)
      patch.designationId = dto.designationId;
    if (dto.reportingManagerId !== undefined) {
      patch.reportingManagerId = dto.reportingManagerId;
    }
    if (dto.joiningDate !== undefined) patch.joiningDate = dto.joiningDate;
    if (dto.avatarUrl !== undefined) patch.avatarUrl = dto.avatarUrl;
    if (dto.userId !== undefined) patch.userId = dto.userId;

    if (dto.status !== undefined) {
      Object.assign(
        patch,
        this.resolveStatusChange(dto.status, dto.exitDate, employee.exitDate),
      );
    } else if (dto.exitDate !== undefined) {
      patch.exitDate = dto.exitDate;
    }

    const profile = this.profilePatch(dto);
    await this.assertProfileValid(
      tenantId,
      { ...this.toRow(employee).profile, ...profile },
      patch.joiningDate ?? employee.joiningDate,
      employeeId,
    );
    Object.assign(patch, profile);

    const previousStatus = employee.status;
    await employee.update(patch);
    if (patch.status && patch.status !== previousStatus) {
      await this.syncPortalAccess(employee, previousStatus, patch.status);
    }
    return this.getOne(tenantId, employeeId);
  }

  /**
   * Portal access follows employment: moving someone to Inactive or Resigned
   * suspends their login, and bringing them back to Active or On Leave
   * restores it. Nothing changes for an employee who was never invited.
   */
  private async syncPortalAccess(
    employee: any,
    from: EmployeeStatus,
    to: EmployeeStatus,
  ): Promise<void> {
    const suspended = (status: EmployeeStatus) =>
      status === EmployeeStatus.INACTIVE || status === EmployeeStatus.RESIGNED;
    if (suspended(from) === suspended(to)) return;
    await this.employeeInvitationService.setLinkedAccountActive(
      employee.tenantId,
      employee.userId ?? null,
      employee.email,
      !suspended(to),
    );
  }

  async updateStatus(
    tenantId: string,
    employeeId: string,
    status: EmployeeStatus,
    exitDate?: string,
  ): Promise<EmployeeRow> {
    await this.assertInScope(tenantId, employeeId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await EmployeeModel.findOne({
      where: { id: employeeId, tenantId },
    });
    if (!employee) this.notFound(employeeId);

    const previousStatus = employee.status;
    await employee.update(
      this.resolveStatusChange(status, exitDate, employee.exitDate),
    );
    await this.syncPortalAccess(employee, previousStatus, status);
    return this.getOne(tenantId, employeeId);
  }

  /**
   * Keeps status and exitDate consistent: RESIGNED needs a last working day
   * (defaulting to today rather than silently leaving it blank), and any
   * other status clears a previously recorded exit date so a rehired or
   * corrected employee doesn't keep a stale one.
   */
  private resolveStatusChange(
    status: EmployeeStatus,
    exitDate: string | undefined,
    currentExitDate: string | null,
  ): { status: EmployeeStatus; exitDate: string | null } {
    if (status === EmployeeStatus.RESIGNED) {
      return {
        status,
        exitDate:
          exitDate ?? currentExitDate ?? new Date().toISOString().slice(0, 10),
      };
    }
    return { status, exitDate: null };
  }

  /**
   * Removes the employee and their attendance history. Attendance rows are
   * deleted explicitly rather than relying on an ON DELETE CASCADE, which
   * `sync()` does not configure for this FK — without it Postgres would
   * reject the delete outright.
   */
  async remove(
    tenantId: string,
    employeeId: string,
  ): Promise<{ message: string }> {
    await this.assertInScope(tenantId, employeeId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await EmployeeModel.findOne({
      where: { id: employeeId, tenantId },
    });
    if (!employee) this.notFound(employeeId);

    await this.assertNoPayrollHistory(tenantId, [employeeId]);
    await this.detachEmployeeReferences(tenantId, [employeeId]);
    const { userId, email, employeeCode } = employee;
    await employee.destroy();

    // Best-effort: never block the delete on user-service/auth-service being
    // unreachable — see `deactivateLinkedAccount`. Without this, deleting an
    // Employee whose invitation was activated leaves a live login with no
    // profile behind it (the exact orphan this closes).
    await this.employeeInvitationService.deactivateLinkedAccount(
      tenantId,
      userId,
      email,
    );

    return {
      message: `Employee '${employeeCode}' removed successfully.`,
    };
  }

  /**
   * Self-service avatar for a signed-in HR/Employee account (My Profile),
   * resolved by email since the caller only has its JWT claims, not its
   * Employee row's id. `null` when the email has no Employee row at all
   * (e.g. an Admin, who never gets one — Admin's avatar lives on
   * `Tenant.adminAvatarUrl` instead, handled separately).
   */
  async getAvatarByEmail(
    tenantId: string,
    email: string,
  ): Promise<{ avatarUrl: string | null }> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await EmployeeModel.findOne({
      where: { tenantId, email },
    });
    return { avatarUrl: employee?.avatarUrl ?? null };
  }

  async updateAvatarByEmail(
    tenantId: string,
    email: string,
    avatarUrl: string,
  ): Promise<{ avatarUrl: string | null }> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await EmployeeModel.findOne({
      where: { tenantId, email },
    });
    if (!employee) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'No employee record found for this account.',
        HttpStatus.NOT_FOUND,
      );
    }
    await employee.update({ avatarUrl });
    return { avatarUrl: employee.avatarUrl };
  }

  async bulkRemove(
    tenantId: string,
    employeeIds: string[],
  ): Promise<{ requested: number; deleted: number; notFound: string[] }> {
    const unique = [...new Set(employeeIds)];
    if (unique.length === 0) {
      this.badRequest('No employee ids supplied.');
    }

    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const found = await EmployeeModel.findAll({
      where: { tenantId, id: { [Op.in]: unique } },
      attributes: ['id', 'userId', 'email'],
      raw: true,
    });
    const foundIds = (found as any[]).map((row) => row.id);
    const notFound = unique.filter((id) => !foundIds.includes(id));

    if (foundIds.length > 0) {
      await this.assertNoPayrollHistory(tenantId, foundIds);
      await this.detachEmployeeReferences(tenantId, foundIds);
      await EmployeeModel.destroy({
        where: { tenantId, id: { [Op.in]: foundIds } },
      });

      // Best-effort, same as `remove` — see `deactivateLinkedAccount`.
      await Promise.all(
        (found as any[]).map((row) =>
          this.employeeInvitationService.deactivateLinkedAccount(
            tenantId,
            row.userId,
            row.email,
          ),
        ),
      );
    }

    return { requested: unique.length, deleted: foundIds.length, notFound };
  }

  /**
   * Payroll records are the org's financial history, so they are never
   * deleted as a side effect of removing an employee — a paid employee has to
   * be deactivated instead.
   */
  private async assertNoPayrollHistory(
    tenantId: string,
    employeeIds: string[],
  ): Promise<void> {
    const PayrollRecordModel =
      await this.modelProvider.getPayrollRecordModel(tenantId);
    const paid = await PayrollRecordModel.count({
      where: { tenantId, employeeId: { [Op.in]: employeeIds } },
    });
    if (paid > 0) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        employeeIds.length === 1
          ? 'This employee has payroll history and cannot be deleted. Deactivate them instead.'
          : 'One or more selected employees have payroll history and cannot be deleted. Deactivate them instead.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Clears every FK pointing at the employees about to be deleted — their
   * own rows (attendance, leave, invitations, documents, requests,
   * notifications, performance goals/reviews), direct reports'
   * reportingManagerId, and any department they head — so the delete doesn't fail on a constraint or
   * leave a department pointing at a row that no longer exists.
   *
   * Anything that gains a real FK to employees has to be detached here too,
   * or deleting an employee starts failing on a foreign key violation.
   */
  private async detachEmployeeReferences(
    tenantId: string,
    employeeIds: string[],
  ): Promise<void> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);

    // Every table with a NO ACTION FK to employees.employeeId, except
    // payroll_records — see assertNoPayrollHistory.
    const ownedModels = await Promise.all([
      this.modelProvider.getAttendanceRecordModel(tenantId),
      this.modelProvider.getLeaveRequestModel(tenantId),
      this.modelProvider.getEmployeeInvitationModel(tenantId),
      this.modelProvider.getEmployeeDocumentModel(tenantId),
      this.modelProvider.getEmployeeRequestModel(tenantId),
      this.modelProvider.getEmployeeNotificationModel(tenantId),
      this.modelProvider.getPerformanceGoalModel(tenantId),
      this.modelProvider.getPerformanceReviewModel(tenantId),
    ]);
    for (const Model of ownedModels as any[]) {
      await Model.destroy({
        where: { tenantId, employeeId: { [Op.in]: employeeIds } },
      });
    }
    await EmployeeModel.update(
      { reportingManagerId: null },
      { where: { tenantId, reportingManagerId: { [Op.in]: employeeIds } } },
    );
    await DepartmentModel.update(
      { managerId: null },
      { where: { tenantId, managerId: { [Op.in]: employeeIds } } },
    );
  }
}
