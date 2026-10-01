import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, fn, col, literal } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  CreateCandidateDto,
  UpdateCandidateDto,
  MoveCandidateStageDto,
  GetCandidatesQueryDto,
  GetCandidatePipelineQueryDto,
  ExportCandidatesQueryDto,
  CandidateStage,
  CandidateStageFilter,
  CandidateSortableField,
  CandidateSource,
  CANDIDATE_FUNNEL_STAGES,
  candidateStageRank,
  RecruitmentActivityType,
  EXPORT_MAX_ROWS,
  ExportResult,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { RecruitmentActivityService } from './recruitment-activity.service';
import { buildDefaultChecklist } from './onboarding-checklist';

/** Flattened row for the candidate table and the pipeline cards. */
export interface CandidateRow {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  jobOpening: {
    id: string;
    title: string;
    requisitionCode: string;
    department: { id: string; name: string } | null;
  } | null;
  source: CandidateSource;
  stage: CandidateStage;
  furthestStageRank: number;
  resumeUrl: string | null;
  linkedInUrl: string | null;
  expectedSalary: number | null;
  yearsOfExperience: number | null;
  rating: number | null;
  appliedAt: string;
  referredBy: { id: string; name: string } | null;
  notes: string | null;
  interviewsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CandidatePipelineColumn {
  stage: CandidateStage;
  /** Full count for this column's header, independent of `cards`. */
  total: number;
  cards: CandidateRow[];
}

/**
 * Applications and the Candidate Pipeline board.
 *
 * Stage moves go through {@link moveStage} rather than the generic update
 * path. A move is not a field edit: it has to raise `furthestStageRank`,
 * append to `stageHistory`, write the activity feed entry, and — on a move to
 * HIRED — hand the candidate to onboarding. Allowing `stage` through
 * {@link update} would give callers a way to bypass all four.
 */
@Injectable()
export class CandidateService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly activityService: RecruitmentActivityService,
  ) {}

  // ==========================================
  // Helpers
  // ==========================================

  private notFound(candidateId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Candidate '${candidateId}' not found in this organization.`,
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

  private quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private fullName(record: any): string {
    return (
      [record.firstName, record.lastName].filter(Boolean).join(' ') ||
      record.email
    );
  }

  private toRow(record: any): CandidateRow {
    const jobOpening = record.jobOpening;
    const referredBy = record.referredBy;

    return {
      id: record.id,
      name: this.fullName(record),
      firstName: record.firstName,
      lastName: record.lastName,
      email: record.email,
      phone: record.phone ?? null,
      jobOpening: jobOpening
        ? {
            id: jobOpening.id,
            title: jobOpening.title,
            requisitionCode: jobOpening.requisitionCode,
            department: jobOpening.department
              ? {
                  id: jobOpening.department.id,
                  name: jobOpening.department.name,
                }
              : null,
          }
        : null,
      source: record.source,
      stage: record.stage,
      furthestStageRank: Number(record.furthestStageRank),
      resumeUrl: record.resumeUrl ?? null,
      linkedInUrl: record.linkedInUrl ?? null,
      expectedSalary: this.toNumberOrNull(record.expectedSalary),
      yearsOfExperience: this.toNumberOrNull(record.yearsOfExperience),
      rating: this.toNumberOrNull(record.rating),
      appliedAt: this.toDateOnly(record.appliedAt),
      referredBy: referredBy
        ? {
            id: referredBy.id,
            name: [referredBy.firstName, referredBy.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : null,
      notes: record.notes ?? null,
      interviewsCount: Number(
        record.get?.('interviewsCount') ?? record.interviewsCount ?? 0,
      ),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private interviewsCountLiteral() {
    return literal(
      '(SELECT COUNT(*) FROM "interviews" AS "i" WHERE "i"."candidateId" = "Candidate"."id")',
    );
  }

  private async buildInclude(tenantId: string, departmentId?: string) {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);
    const DepartmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    return [
      {
        model: JobOpeningModel,
        as: 'jobOpening',
        attributes: ['id', 'title', 'requisitionCode', 'departmentId'],
        // A department filter has to narrow the join itself, otherwise
        // candidates on other requisitions come back with a null department.
        required: Boolean(departmentId),
        include: [
          {
            model: DepartmentModel,
            as: 'department',
            attributes: ['id', 'name'],
            required: Boolean(departmentId),
            where: departmentId ? { id: departmentId } : undefined,
          },
        ],
      },
      {
        model: EmployeeModel,
        as: 'referredBy',
        attributes: ['id', 'firstName', 'lastName'],
        required: false,
      },
    ];
  }

  private buildWhere(tenantId: string, query: GetCandidatesQueryDto): any {
    const where: any = { tenantId };

    if (query.jobOpeningId) where.jobOpeningId = query.jobOpeningId;
    if (query.source) where.source = query.source;
    if (query.stage && query.stage !== CandidateStageFilter.ALL) {
      where.stage = query.stage;
    }
    if (query.from) where.appliedAt = { [Op.gte]: this.toDateOnly(query.from) };
    if (query.to) {
      where.appliedAt = {
        ...(where.appliedAt ?? {}),
        [Op.lte]: this.toDateOnly(query.to),
      };
    }

    if (query.search?.trim()) {
      const term = this.quote(`%${query.search.trim()}%`);
      where[Op.and] = [
        literal(
          `(concat("Candidate"."firstName", ' ', "Candidate"."lastName") ILIKE ${term}` +
            ` OR "Candidate"."email" ILIKE ${term})`,
        ),
      ];
    }

    return where;
  }

  private buildOrder(
    sortBy: CandidateSortableField = 'appliedAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): any[] {
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    switch (sortBy) {
      case 'candidateName':
        return [
          [literal(`"Candidate"."firstName" ${dir}`)],
          [literal(`"Candidate"."lastName" ${dir}`)],
        ];
      default:
        return [[sortBy, dir]];
    }
  }

  private async validateJobOpening(
    tenantId: string,
    jobOpeningId: string,
  ): Promise<any> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);
    const record = await JobOpeningModel.findOne({
      where: { id: jobOpeningId, tenantId },
      attributes: ['id', 'title', 'requisitionCode', 'status'],
    });
    if (!record) {
      this.badRequest(
        `Job opening '${jobOpeningId}' does not exist in this organization.`,
      );
    }
    return record;
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(tenantId: string, query: GetCandidatesQueryDto) {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    const { rows, count } = await CandidateModel.findAndCountAll({
      where: this.buildWhere(tenantId, query),
      include: await this.buildInclude(tenantId, query.departmentId),
      attributes: {
        include: [[this.interviewsCountLiteral(), 'interviewsCount']],
      },
      order: this.buildOrder(query.sortBy, query.sortOrder),
      limit,
      offset: (page - 1) * limit,
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

  async getOne(tenantId: string, candidateId: string): Promise<CandidateRow> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const record = await CandidateModel.findOne({
      where: { id: candidateId, tenantId },
      include: await this.buildInclude(tenantId),
      attributes: {
        include: [[this.interviewsCountLiteral(), 'interviewsCount']],
      },
    });

    if (!record) this.notFound(candidateId);
    return this.toRow(record);
  }

  /**
   * The Candidate Pipeline kanban board.
   *
   * Column headers need the full stage total while the board only renders a
   * handful of cards each, so the two are fetched separately: one grouped
   * COUNT for every header, then one small windowed read per column. Loading
   * every candidate and slicing in Node would mean pulling the entire
   * pipeline to render twenty cards.
   *
   * REJECTED is not a column — see CandidateStage.
   */
  async getPipeline(
    tenantId: string,
    query: GetCandidatePipelineQueryDto,
  ): Promise<{ columns: CandidatePipelineColumn[]; total: number }> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const limitPerStage =
      query.limitPerStage && query.limitPerStage > 0 ? query.limitPerStage : 5;

    const baseWhere: any = { tenantId };
    if (query.jobOpeningId) baseWhere.jobOpeningId = query.jobOpeningId;

    const grouped = (await CandidateModel.findAll({
      where: baseWhere,
      attributes: ['stage', [fn('COUNT', col('id')), 'count']],
      group: ['stage'],
      raw: true,
    })) as unknown as { stage: CandidateStage; count: string }[];

    const totals = new Map<CandidateStage, number>();
    for (const row of grouped) totals.set(row.stage, Number(row.count));

    const include = await this.buildInclude(tenantId);

    const columns = await Promise.all(
      CANDIDATE_FUNNEL_STAGES.map(async (stage) => {
        const total = totals.get(stage) ?? 0;
        if (total === 0) {
          return { stage, total, cards: [] as CandidateRow[] };
        }
        const cards = await CandidateModel.findAll({
          where: { ...baseWhere, stage },
          include,
          attributes: {
            include: [[this.interviewsCountLiteral(), 'interviewsCount']],
          },
          order: [['updatedAt', 'DESC']],
          limit: limitPerStage,
          subQuery: false,
        });
        return {
          stage,
          total,
          cards: (cards as any[]).map((row) => this.toRow(row)),
        };
      }),
    );

    return {
      columns,
      // Board total counts only the funnel columns, so it matches the sum of
      // the headers rather than silently including rejected candidates.
      total: columns.reduce((sum, column) => sum + column.total, 0),
    };
  }

  async export(
    tenantId: string,
    query: ExportCandidatesQueryDto,
  ): Promise<ExportResult<CandidateRow>> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const where = this.buildWhere(tenantId, query);
    const include = await this.buildInclude(tenantId, query.departmentId);

    const totalMatched = await CandidateModel.count({
      where,
      include,
      distinct: true,
    });

    const rows = await CandidateModel.findAll({
      where,
      include,
      attributes: {
        include: [[this.interviewsCountLiteral(), 'interviewsCount']],
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
    dto: CreateCandidateDto,
    actorUserId?: string,
  ): Promise<CandidateRow> {
    const jobOpening = await this.validateJobOpening(
      tenantId,
      dto.jobOpeningId,
    );

    if (dto.referredByEmployeeId) {
      const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);
      const exists = await EmployeeModel.findOne({
        where: { id: dto.referredByEmployeeId, tenantId },
        attributes: ['id'],
      });
      if (!exists) {
        this.badRequest(
          `Referring employee '${dto.referredByEmployeeId}' does not exist in this organization.`,
        );
      }
    }

    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);
    const email = dto.email.trim().toLowerCase();

    const duplicate = await CandidateModel.findOne({
      where: { tenantId, jobOpeningId: dto.jobOpeningId, email },
      attributes: ['id'],
    });
    if (duplicate) {
      this.conflict(
        `${email} has already applied for ${jobOpening.title}. Update the existing application instead.`,
      );
    }

    const stage = dto.stage ?? CandidateStage.APPLIED;
    const appliedAt = dto.appliedAt
      ? this.toDateOnly(dto.appliedAt)
      : this.today();
    const now = new Date().toISOString();

    const created: any = await CandidateModel.create({
      tenantId,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email,
      phone: dto.phone ?? null,
      jobOpeningId: dto.jobOpeningId,
      source: dto.source,
      stage,
      // An application entered directly at a later stage (a sourced candidate
      // going straight to Screening) still has to start the funnel at that
      // rank, or it would never be counted as having reached it.
      furthestStageRank: Math.max(0, candidateStageRank(stage)),
      stageHistory: [
        { stage, at: now, byUserId: actorUserId ?? null, note: null },
      ],
      resumeUrl: dto.resumeUrl ?? null,
      linkedInUrl: dto.linkedInUrl ?? null,
      expectedSalary: dto.expectedSalary ?? null,
      yearsOfExperience: dto.yearsOfExperience ?? null,
      appliedAt,
      referredByEmployeeId: dto.referredByEmployeeId ?? null,
      notes: dto.notes ?? null,
    });

    await this.activityService.record(tenantId, {
      type: RecruitmentActivityType.APPLICATION_RECEIVED,
      title: 'New application received',
      description: `${this.fullName(created)} applied for ${jobOpening.title}`,
      candidateId: created.id,
      jobOpeningId: jobOpening.id,
      actorUserId: actorUserId ?? null,
      metadata: { source: created.source, stage: created.stage },
    });

    return this.getOne(tenantId, created.id);
  }

  async update(
    tenantId: string,
    candidateId: string,
    dto: UpdateCandidateDto,
  ): Promise<CandidateRow> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const record: any = await CandidateModel.findOne({
      where: { id: candidateId, tenantId },
    });
    if (!record) this.notFound(candidateId);

    // Changing the email has to respect the same one-application-per-person
    // rule the create path enforces.
    let email: string | undefined;
    if (dto.email !== undefined) {
      email = dto.email.trim().toLowerCase();
      if (email !== record.email) {
        const duplicate = await CandidateModel.findOne({
          where: {
            tenantId,
            jobOpeningId: record.jobOpeningId,
            email,
            id: { [Op.ne]: candidateId },
          },
          attributes: ['id'],
        });
        if (duplicate) {
          this.conflict(
            `${email} already has an application against this job opening.`,
          );
        }
      }
    }

    await record.update({
      ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.source !== undefined ? { source: dto.source } : {}),
      ...(dto.resumeUrl !== undefined ? { resumeUrl: dto.resumeUrl } : {}),
      ...(dto.linkedInUrl !== undefined
        ? { linkedInUrl: dto.linkedInUrl }
        : {}),
      ...(dto.expectedSalary !== undefined
        ? { expectedSalary: dto.expectedSalary }
        : {}),
      ...(dto.yearsOfExperience !== undefined
        ? { yearsOfExperience: dto.yearsOfExperience }
        : {}),
      ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    });

    return this.getOne(tenantId, candidateId);
  }

  /**
   * Move a candidate between pipeline columns.
   *
   * Returns the candidate plus, when the move was to HIRED, the id of the
   * onboarding record created for them — the Onboarding screen's New Hires
   * table is fed from exactly this transition, so the caller does not have to
   * make a second call to find it.
   */
  async moveStage(
    tenantId: string,
    candidateId: string,
    dto: MoveCandidateStageDto,
    actorUserId?: string,
  ): Promise<{ candidate: CandidateRow; newHireId: string | null }> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const record: any = await CandidateModel.findOne({
      where: { id: candidateId, tenantId },
      include: await this.buildInclude(tenantId),
    });
    if (!record) this.notFound(candidateId);

    const previousStage: CandidateStage = record.stage;
    if (previousStage === dto.stage) {
      return {
        candidate: await this.getOne(tenantId, candidateId),
        newHireId: null,
      };
    }

    // HIRED is terminal: re-entering the funnel from it would leave the
    // onboarding record it produced pointing at a candidate who is no longer
    // hired, and the "Hired" KPI double-counting them on the way back.
    if (previousStage === CandidateStage.HIRED) {
      this.conflict(
        'This candidate is already hired. Their onboarding record now owns the rest of the process.',
      );
    }

    const targetRank = candidateStageRank(dto.stage);
    const now = new Date().toISOString();
    const history = Array.isArray(record.stageHistory)
      ? record.stageHistory
      : [];

    await record.update({
      stage: dto.stage,
      // Monotonic — a rejection must not shrink the upper funnel. REJECTED
      // has rank -1, so Math.max leaves the stored rank untouched.
      furthestStageRank: Math.max(Number(record.furthestStageRank), targetRank),
      stageHistory: [
        ...history,
        {
          stage: dto.stage,
          at: now,
          byUserId: actorUserId ?? null,
          note: dto.note ?? null,
        },
      ],
    });

    let newHireId: string | null = null;
    if (dto.stage === CandidateStage.HIRED) {
      newHireId = await this.createOnboardingForHire(
        tenantId,
        record,
        actorUserId,
      );
    }

    await this.activityService.record(
      tenantId,
      this.describeMove(record, previousStage, dto, actorUserId),
    );

    return {
      candidate: await this.getOne(tenantId, candidateId),
      newHireId,
    };
  }

  /** Pick the feed entry wording that matches the transition. */
  private describeMove(
    record: any,
    previousStage: CandidateStage,
    dto: MoveCandidateStageDto,
    actorUserId?: string,
  ) {
    const name = this.fullName(record);
    const position = record.jobOpening?.title ?? 'the role';
    const base = {
      candidateId: record.id,
      jobOpeningId: record.jobOpeningId,
      actorUserId: actorUserId ?? null,
      metadata: {
        from: previousStage,
        to: dto.stage,
        note: dto.note ?? null,
      },
    };

    switch (dto.stage) {
      case CandidateStage.OFFER:
        return {
          ...base,
          type: RecruitmentActivityType.OFFER_EXTENDED,
          title: 'Offer extended',
          description: `${name} was offered ${position}`,
        };
      case CandidateStage.HIRED:
        return {
          ...base,
          type: RecruitmentActivityType.OFFER_ACCEPTED,
          title: 'Offer accepted',
          description: `${name} accepted the offer for ${position}`,
        };
      case CandidateStage.REJECTED:
        return {
          ...base,
          type: RecruitmentActivityType.CANDIDATE_REJECTED,
          title: 'Candidate rejected',
          description: `${name} was rejected at the ${previousStage} stage`,
        };
      default:
        return {
          ...base,
          type: RecruitmentActivityType.STAGE_CHANGED,
          title: `Candidate moved to ${dto.stage.toLowerCase()}`,
          description: `${name} moved to the ${dto.stage.toLowerCase()} stage for ${position}`,
        };
    }
  }

  /**
   * Open an onboarding record for a candidate who just reached HIRED, with
   * the default checklist seeded.
   *
   * Idempotent: a hire already carrying an onboarding record returns the
   * existing one rather than opening a second. Written directly against the
   * NewHire/OnboardingTask models instead of calling OnboardingService, so
   * recruitment does not depend on onboarding and onboarding does not depend
   * back on recruitment — the two services would otherwise form a circular
   * injection.
   */
  private async createOnboardingForHire(
    tenantId: string,
    candidate: any,
    actorUserId?: string,
  ): Promise<string> {
    const NewHireModel = await this.modelProvider.getNewHireModel(tenantId);

    const existing: any = await NewHireModel.findOne({
      where: { tenantId, candidateId: candidate.id },
      attributes: ['id'],
    });
    if (existing) return existing.id;

    // A hire's email is unique per tenant, so a rehire (or a second
    // application that also reached HIRED) would collide. Reuse that record
    // and attach this candidate to it rather than failing the stage move —
    // the move itself is already committed.
    const byEmail: any = await NewHireModel.findOne({
      where: { tenantId, email: candidate.email },
    });
    if (byEmail) {
      await byEmail.update({ candidateId: candidate.id });
      return byEmail.id;
    }

    const jobOpening = candidate.jobOpening;
    const created: any = await NewHireModel.create({
      tenantId,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      email: candidate.email,
      phone: candidate.phone ?? null,
      position: jobOpening?.title ?? 'New hire',
      departmentId: jobOpening?.departmentId ?? jobOpening?.department?.id,
      designationId: jobOpening?.designationId ?? null,
      // Joining date is unknown at offer-acceptance time; default to today so
      // the row is valid and visible, for an admin to correct.
      joiningDate: this.today(),
      candidateId: candidate.id,
      createdByUserId: actorUserId ?? null,
    });

    await this.seedDefaultChecklist(tenantId, created.id, created.joiningDate);
    return created.id;
  }

  /** Seed the shared default checklist — see ./onboarding-checklist. */
  private async seedDefaultChecklist(
    tenantId: string,
    newHireId: string,
    joiningDate: string,
  ): Promise<void> {
    const OnboardingTaskModel =
      await this.modelProvider.getOnboardingTaskModel(tenantId);
    await OnboardingTaskModel.bulkCreate(
      buildDefaultChecklist(tenantId, newHireId, joiningDate) as any[],
    );
  }

  /**
   * Delete an application. Its interviews carry a real FK, so they are
   * removed first — an interview without a candidate is not a record anyone
   * can act on. The activity feed is deliberately left intact: its rows hold
   * snapshots precisely so history survives the delete.
   */
  async remove(tenantId: string, candidateId: string): Promise<void> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);

    const record: any = await CandidateModel.findOne({
      where: { id: candidateId, tenantId },
    });
    if (!record) this.notFound(candidateId);

    await InterviewModel.destroy({ where: { tenantId, candidateId } });
    await record.destroy();
  }
}
