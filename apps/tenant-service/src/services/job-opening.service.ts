import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, literal } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  CreateJobOpeningDto,
  UpdateJobOpeningDto,
  UpdateJobOpeningStatusDto,
  GetJobOpeningsQueryDto,
  ExportJobOpeningsQueryDto,
  JobOpeningStatus,
  JobOpeningStatusFilter,
  JobOpeningSortableField,
  RecruitmentActivityType,
  EXPORT_MAX_ROWS,
  ExportResult,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { RecruitmentActivityService } from './recruitment-activity.service';

/** Flattened row for the Job Openings table. */
export interface JobOpeningRow {
  id: string;
  requisitionCode: string;
  title: string;
  department: { id: string; name: string } | null;
  designation: { id: string; name: string } | null;
  employmentType: string;
  location: string | null;
  openings: number;
  description: string | null;
  skills: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  /** The Applications column — a live COUNT, never a stored counter. */
  applicationsCount: number;
  status: JobOpeningStatus;
  postedOn: string;
  closingDate: string | null;
  hiringManager: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Job requisitions behind the Recruitment screen's Job Openings table.
 *
 * The Applications count on every row is a correlated COUNT over `candidates`
 * rather than a column on job_openings, so it cannot drift from the pipeline
 * it summarises. It is exposed as a sortable, selectable attribute so the
 * database still does the paging — computing it in Node would mean loading
 * every requisition to sort one page.
 */
@Injectable()
export class JobOpeningService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly activityService: RecruitmentActivityService,
  ) {}

  // ==========================================
  // Helpers
  // ==========================================

  private notFound(jobOpeningId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Job opening '${jobOpeningId}' not found in this organization.`,
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

  private toDateOnly(value: string | Date): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return value.slice(0, 10);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Single-quote a value for embedding in a raw SQL fragment. Only used for
   * the search term below, where the ILIKE comparison sits inside a
   * `literal` and cannot be expressed as a bind parameter.
   */
  private quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  /**
   * Correlated subquery for the Applications column. Referenced by both the
   * select list and the ORDER BY, so the two can never disagree.
   */
  private applicationsCountLiteral() {
    return literal(
      '(SELECT COUNT(*) FROM "candidates" AS "c" WHERE "c"."jobOpeningId" = "JobOpening"."id")',
    );
  }

  /**
   * Next requisition code for this tenant, derived from the highest existing
   * numeric suffix rather than a row count: counting would reissue a code
   * after a delete, and the code is unique per tenant, so the insert would
   * fail on a collision instead of just looking odd.
   */
  private async nextRequisitionCode(tenantId: string): Promise<string> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const rows = (await JobOpeningModel.findAll({
      where: { tenantId, requisitionCode: { [Op.iLike]: 'JOB-%' } },
      attributes: ['requisitionCode'],
      raw: true,
    })) as unknown as { requisitionCode: string }[];

    let highest = 1000;
    for (const row of rows) {
      const parsed = Number.parseInt(row.requisitionCode.slice(4), 10);
      if (Number.isFinite(parsed) && parsed > highest) highest = parsed;
    }
    return `JOB-${highest + 1}`;
  }

  private async validateDepartment(
    tenantId: string,
    departmentId: string,
  ): Promise<void> {
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const exists = await DepartmentModel.findOne({
      where: { id: departmentId, tenantId },
      attributes: ['id'],
    });
    if (!exists) {
      this.badRequest(
        `Department '${departmentId}' does not exist in this organization.`,
      );
    }
  }

  private async validateDesignation(
    tenantId: string,
    designationId: string,
  ): Promise<void> {
    const DesignationModel =
      await this.modelProvider.getDesignationModel(tenantId);
    const exists = await DesignationModel.findOne({
      where: { id: designationId, tenantId },
      attributes: ['id'],
    });
    if (!exists) {
      this.badRequest(
        `Designation '${designationId}' does not exist in this organization.`,
      );
    }
  }

  private async validateEmployee(
    tenantId: string,
    employeeId: string,
    label: string,
  ): Promise<void> {
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
    const exists = await EmployeeModel.findOne({
      where: { id: employeeId, tenantId },
      attributes: ['id'],
    });
    if (!exists) {
      this.badRequest(
        `${label} '${employeeId}' does not exist in this organization.`,
      );
    }
  }

  /** DECIMAL comes back from Postgres as a string; the client wants a number. */
  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toRow(record: any): JobOpeningRow {
    const department = record.department;
    const designation = record.designation;
    const hiringManager = record.hiringManager;

    return {
      id: record.id,
      requisitionCode: record.requisitionCode,
      title: record.title,
      department: department
        ? { id: department.id, name: department.name }
        : null,
      designation: designation
        ? { id: designation.id, name: designation.title }
        : null,
      employmentType: record.employmentType,
      location: record.location ?? null,
      openings: Number(record.openings),
      description: record.description ?? null,
      skills: Array.isArray(record.skills) ? record.skills : [],
      salaryMin: this.toNumberOrNull(record.salaryMin),
      salaryMax: this.toNumberOrNull(record.salaryMax),
      // The alias is absent on writes that do not re-select it, so fall back
      // to 0 rather than emitting NaN.
      applicationsCount: Number(
        record.get?.('applicationsCount') ?? record.applicationsCount ?? 0,
      ),
      status: record.status,
      postedOn: this.toDateOnly(record.postedOn),
      closingDate: record.closingDate
        ? this.toDateOnly(record.closingDate)
        : null,
      hiringManager: hiringManager
        ? {
            id: hiringManager.id,
            name: [hiringManager.firstName, hiringManager.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

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
        as: 'hiringManager',
        attributes: ['id', 'firstName', 'lastName'],
        required: false,
      },
    ];
  }

  private buildWhere(tenantId: string, query: GetJobOpeningsQueryDto): any {
    const where: any = { tenantId };

    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.employmentType) where.employmentType = query.employmentType;
    if (query.status && query.status !== JobOpeningStatusFilter.ALL) {
      where.status = query.status;
    }

    if (query.search?.trim()) {
      const term = this.quote(`%${query.search.trim()}%`);
      where[Op.and] = [
        literal(
          `("JobOpening"."title" ILIKE ${term}` +
            ` OR "JobOpening"."location" ILIKE ${term}` +
            ` OR "JobOpening"."requisitionCode" ILIKE ${term})`,
        ),
      ];
    }

    return where;
  }

  private buildOrder(
    sortBy: JobOpeningSortableField = 'postedOn',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): any[] {
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    switch (sortBy) {
      case 'department':
        return [[literal(`"department"."name" ${dir}`)]];
      default:
        return [[sortBy, dir]];
    }
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(tenantId: string, query: GetJobOpeningsQueryDto) {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    const { rows, count } = await JobOpeningModel.findAndCountAll({
      where: this.buildWhere(tenantId, query),
      include: await this.buildInclude(tenantId),
      attributes: {
        include: [[this.applicationsCountLiteral(), 'applicationsCount']],
      },
      order: this.buildOrder(query.sortBy, query.sortOrder),
      limit,
      offset: (page - 1) * limit,
      // The include is one-to-one on all three associations, but Sequelize
      // still needs this to keep findAndCountAll's COUNT from multiplying
      // rows once a joined table is referenced in the ORDER BY.
      distinct: true,
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

  async getOne(tenantId: string, jobOpeningId: string): Promise<JobOpeningRow> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const record = await JobOpeningModel.findOne({
      where: { id: jobOpeningId, tenantId },
      include: await this.buildInclude(tenantId),
      attributes: {
        include: [[this.applicationsCountLiteral(), 'applicationsCount']],
      },
    });

    if (!record) this.notFound(jobOpeningId);
    return this.toRow(record);
  }

  async export(
    tenantId: string,
    query: ExportJobOpeningsQueryDto,
  ): Promise<ExportResult<JobOpeningRow>> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const where = this.buildWhere(tenantId, query);
    const include = await this.buildInclude(tenantId);

    const totalMatched = await JobOpeningModel.count({
      where,
      include,
      distinct: true,
    });

    const rows = await JobOpeningModel.findAll({
      where,
      include,
      attributes: {
        include: [[this.applicationsCountLiteral(), 'applicationsCount']],
      },
      order: this.buildOrder(query.sortBy, query.sortOrder),
      limit: EXPORT_MAX_ROWS,
      subQuery: false,
    });

    return {
      rows: (rows as any[]).map((row) => this.toRow(row)),
      totalMatched,
      truncated: totalMatched > rows.length,
      limit: EXPORT_MAX_ROWS,
    };
  }

  // ==========================================
  // Writes
  // ==========================================

  async create(
    tenantId: string,
    dto: CreateJobOpeningDto,
    actorUserId?: string,
  ): Promise<JobOpeningRow> {
    await this.validateDepartment(tenantId, dto.departmentId);
    if (dto.designationId) {
      await this.validateDesignation(tenantId, dto.designationId);
    }
    if (dto.hiringManagerEmployeeId) {
      await this.validateEmployee(
        tenantId,
        dto.hiringManagerEmployeeId,
        'Hiring manager',
      );
    }

    const postedOn = dto.postedOn
      ? this.toDateOnly(dto.postedOn)
      : this.today();
    const closingDate = dto.closingDate
      ? this.toDateOnly(dto.closingDate)
      : null;

    if (closingDate && closingDate < postedOn) {
      this.badRequest('Closing date cannot fall before the posting date.');
    }
    if (
      dto.salaryMin !== undefined &&
      dto.salaryMax !== undefined &&
      dto.salaryMin > dto.salaryMax
    ) {
      this.badRequest('Minimum salary cannot exceed maximum salary.');
    }

    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const created: any = await JobOpeningModel.create({
      tenantId,
      requisitionCode: await this.nextRequisitionCode(tenantId),
      title: dto.title,
      departmentId: dto.departmentId,
      designationId: dto.designationId ?? null,
      employmentType: dto.employmentType,
      location: dto.location ?? null,
      openings: dto.openings ?? 1,
      description: dto.description ?? null,
      skills: dto.skills ?? null,
      salaryMin: dto.salaryMin ?? null,
      salaryMax: dto.salaryMax ?? null,
      postedOn,
      closingDate,
      status: dto.status ?? JobOpeningStatus.ACTIVE,
      hiringManagerEmployeeId: dto.hiringManagerEmployeeId ?? null,
      createdByUserId: actorUserId ?? null,
    });

    await this.activityService.record(tenantId, {
      type: RecruitmentActivityType.JOB_OPENING_CREATED,
      title: 'New job opening created',
      description: `${dto.title} (${created.requisitionCode}) was opened`,
      jobOpeningId: created.id,
      actorUserId: actorUserId ?? null,
      metadata: { status: created.status, openings: created.openings },
    });

    return this.getOne(tenantId, created.id);
  }

  async update(
    tenantId: string,
    jobOpeningId: string,
    dto: UpdateJobOpeningDto,
  ): Promise<JobOpeningRow> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const record: any = await JobOpeningModel.findOne({
      where: { id: jobOpeningId, tenantId },
    });
    if (!record) this.notFound(jobOpeningId);

    if (dto.departmentId) {
      await this.validateDepartment(tenantId, dto.departmentId);
    }
    if (dto.designationId) {
      await this.validateDesignation(tenantId, dto.designationId);
    }
    if (dto.hiringManagerEmployeeId) {
      await this.validateEmployee(
        tenantId,
        dto.hiringManagerEmployeeId,
        'Hiring manager',
      );
    }

    // Validate the *resulting* window, not just the supplied fields — editing
    // only the closing date still has to be checked against the stored
    // posting date.
    const postedOn = dto.postedOn
      ? this.toDateOnly(dto.postedOn)
      : this.toDateOnly(record.postedOn);
    const closingDate =
      dto.closingDate !== undefined
        ? dto.closingDate
          ? this.toDateOnly(dto.closingDate)
          : null
        : record.closingDate
          ? this.toDateOnly(record.closingDate)
          : null;

    if (closingDate && closingDate < postedOn) {
      this.badRequest('Closing date cannot fall before the posting date.');
    }

    const salaryMin =
      dto.salaryMin !== undefined
        ? dto.salaryMin
        : this.toNumberOrNull(record.salaryMin);
    const salaryMax =
      dto.salaryMax !== undefined
        ? dto.salaryMax
        : this.toNumberOrNull(record.salaryMax);
    if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) {
      this.badRequest('Minimum salary cannot exceed maximum salary.');
    }

    await record.update({
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.departmentId !== undefined
        ? { departmentId: dto.departmentId }
        : {}),
      ...(dto.designationId !== undefined
        ? { designationId: dto.designationId }
        : {}),
      ...(dto.employmentType !== undefined
        ? { employmentType: dto.employmentType }
        : {}),
      ...(dto.location !== undefined ? { location: dto.location } : {}),
      ...(dto.openings !== undefined ? { openings: dto.openings } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.skills !== undefined ? { skills: dto.skills } : {}),
      ...(dto.salaryMin !== undefined ? { salaryMin: dto.salaryMin } : {}),
      ...(dto.salaryMax !== undefined ? { salaryMax: dto.salaryMax } : {}),
      ...(dto.postedOn !== undefined ? { postedOn } : {}),
      ...(dto.closingDate !== undefined ? { closingDate } : {}),
      ...(dto.hiringManagerEmployeeId !== undefined
        ? { hiringManagerEmployeeId: dto.hiringManagerEmployeeId }
        : {}),
    });

    return this.getOne(tenantId, jobOpeningId);
  }

  async updateStatus(
    tenantId: string,
    jobOpeningId: string,
    dto: UpdateJobOpeningStatusDto,
    actorUserId?: string,
  ): Promise<JobOpeningRow> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const record: any = await JobOpeningModel.findOne({
      where: { id: jobOpeningId, tenantId },
    });
    if (!record) this.notFound(jobOpeningId);

    const previousStatus = record.status;
    if (previousStatus === dto.status) {
      return this.getOne(tenantId, jobOpeningId);
    }

    await record.update({ status: dto.status });

    await this.activityService.record(tenantId, {
      type: RecruitmentActivityType.JOB_OPENING_STATUS_CHANGED,
      title: 'Job opening status updated',
      description: `${record.title} moved from ${previousStatus} to ${dto.status}`,
      jobOpeningId: record.id,
      actorUserId: actorUserId ?? null,
      metadata: { from: previousStatus, to: dto.status },
    });

    return this.getOne(tenantId, jobOpeningId);
  }

  /**
   * Delete a requisition. Refused while applications reference it: the
   * candidates carry a real FK, so the delete would fail at the database
   * anyway, and a requisition that has been applied to is history worth
   * keeping. Closing it is the intended way to take a posting down.
   */
  async remove(tenantId: string, jobOpeningId: string): Promise<void> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const record: any = await JobOpeningModel.findOne({
      where: { id: jobOpeningId, tenantId },
    });
    if (!record) this.notFound(jobOpeningId);

    const applications = await CandidateModel.count({
      where: { tenantId, jobOpeningId },
    });
    if (applications > 0) {
      this.conflict(
        `Cannot delete '${record.title}': ${applications} application(s) reference it. Set its status to CLOSED instead.`,
      );
    }

    await record.destroy();
  }
}
