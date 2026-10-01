import { HttpStatus, Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  TenantException,
  TenantErrorCode,
  ScheduleInterviewDto,
  UpdateInterviewDto,
  RescheduleInterviewDto,
  SubmitInterviewFeedbackDto,
  CancelInterviewDto,
  GetInterviewsQueryDto,
  GetUpcomingInterviewsQueryDto,
  InterviewMode,
  InterviewOutcome,
  InterviewStatus,
  CandidateStage,
  candidateStageRank,
  RecruitmentActivityType,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { RecruitmentActivityService } from './recruitment-activity.service';

/** Flattened row for the interview list and the Upcoming Interviews panel. */
export interface InterviewRow {
  id: string;
  candidate: {
    id: string;
    name: string;
    email: string;
    stage: CandidateStage;
  } | null;
  jobOpening: { id: string; title: string } | null;
  scheduledAt: Date;
  /** Derived from scheduledAt + durationMinutes so the two cannot disagree. */
  endsAt: Date;
  durationMinutes: number;
  mode: InterviewMode;
  status: InterviewStatus;
  round: number;
  interviewer: { id: string; name: string } | null;
  meetingLink: string | null;
  location: string | null;
  outcome: InterviewOutcome;
  rating: number | null;
  feedback: string | null;
  notes: string | null;
  completedAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Interview scheduling behind the Upcoming Interviews panel and the
 * "Interviews Scheduled" KPI.
 *
 * Scheduling an interview also advances the candidate to the INTERVIEW stage
 * when they are behind it: the two are the same act from the admin's point of
 * view, and leaving the candidate in Screening with an interview on the
 * calendar is the kind of drift the pipeline board makes immediately visible.
 * The move is applied directly to the model rather than through
 * CandidateService to avoid a circular provider graph (CandidateService
 * already owns the reverse direction), and it only ever moves forward.
 */
@Injectable()
export class InterviewService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly activityService: RecruitmentActivityService,
  ) {}

  // ==========================================
  // Helpers
  // ==========================================

  private notFound(interviewId: string): never {
    throw new TenantException(
      TenantErrorCode.INVALID_TENANT_CONTEXT,
      `Interview '${interviewId}' not found in this organization.`,
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

  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toRow(record: any): InterviewRow {
    const candidate = record.candidate;
    const interviewer = record.interviewer;
    const scheduledAt = new Date(record.scheduledAt);
    const durationMinutes = Number(record.durationMinutes);

    return {
      id: record.id,
      candidate: candidate
        ? {
            id: candidate.id,
            name:
              [candidate.firstName, candidate.lastName]
                .filter(Boolean)
                .join(' ') || candidate.email,
            email: candidate.email,
            stage: candidate.stage,
          }
        : null,
      jobOpening: candidate?.jobOpening
        ? { id: candidate.jobOpening.id, title: candidate.jobOpening.title }
        : null,
      scheduledAt,
      endsAt: new Date(scheduledAt.getTime() + durationMinutes * 60_000),
      durationMinutes,
      mode: record.mode,
      status: record.status,
      round: Number(record.round),
      interviewer: interviewer
        ? {
            id: interviewer.id,
            name: [interviewer.firstName, interviewer.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : null,
      meetingLink: record.meetingLink ?? null,
      location: record.location ?? null,
      outcome: record.outcome,
      rating: this.toNumberOrNull(record.rating),
      feedback: record.feedback ?? null,
      notes: record.notes ?? null,
      completedAt: record.completedAt ?? null,
      cancellationReason: record.cancellationReason ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async buildInclude(tenantId: string) {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);
    const EmployeeModel = await this.modelProvider.getEmployeeModel(tenantId);

    return [
      {
        model: CandidateModel,
        as: 'candidate',
        attributes: ['id', 'firstName', 'lastName', 'email', 'stage'],
        required: false,
        include: [
          {
            model: JobOpeningModel,
            as: 'jobOpening',
            attributes: ['id', 'title'],
            required: false,
          },
        ],
      },
      {
        model: EmployeeModel,
        as: 'interviewer',
        attributes: ['id', 'firstName', 'lastName'],
        required: false,
      },
    ];
  }

  /**
   * Validate the mode-specific detail. An ONLINE interview with no link and
   * an IN_OFFICE one with no location are both rows the Upcoming Interviews
   * card cannot render into anything an interviewer can act on.
   */
  private validateModeDetails(
    mode: InterviewMode,
    meetingLink: string | null,
    location: string | null,
  ): void {
    if (mode === InterviewMode.ONLINE && !meetingLink?.trim()) {
      this.badRequest('An online interview requires a meeting link.');
    }
    if (mode === InterviewMode.IN_OFFICE && !location?.trim()) {
      this.badRequest('An in-office interview requires a location.');
    }
  }

  /**
   * Refuse a second live interview for the same candidate in an overlapping
   * window. Two interviewers independently booking the same person is a real
   * scheduling mistake, and the candidate cannot attend both.
   */
  private async assertNoOverlap(
    tenantId: string,
    candidateId: string,
    scheduledAt: Date,
    durationMinutes: number,
    excludeInterviewId?: string,
  ): Promise<void> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const endsAt = new Date(scheduledAt.getTime() + durationMinutes * 60_000);

    const candidates = (await InterviewModel.findAll({
      where: {
        tenantId,
        candidateId,
        status: InterviewStatus.SCHEDULED,
        ...(excludeInterviewId ? { id: { [Op.ne]: excludeInterviewId } } : {}),
        // Pre-filter in SQL to interviews starting within a day either side,
        // then do the exact overlap test below. An interval predicate on
        // (start + duration) cannot use the index on scheduledAt.
        scheduledAt: {
          [Op.gte]: new Date(scheduledAt.getTime() - 86_400_000),
          [Op.lte]: new Date(endsAt.getTime() + 86_400_000),
        },
      },
      attributes: ['id', 'scheduledAt', 'durationMinutes'],
    })) as any[];

    for (const existing of candidates) {
      const existingStart = new Date(existing.scheduledAt).getTime();
      const existingEnd =
        existingStart + Number(existing.durationMinutes) * 60_000;
      // Half-open intervals: an interview ending exactly when the next begins
      // is back-to-back, not a clash.
      if (
        scheduledAt.getTime() < existingEnd &&
        endsAt.getTime() > existingStart
      ) {
        this.conflict(
          'This candidate already has an interview scheduled in that time window.',
        );
      }
    }
  }

  private async loadCandidate(tenantId: string, candidateId: string) {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);

    const candidate: any = await CandidateModel.findOne({
      where: { id: candidateId, tenantId },
      include: [
        {
          model: JobOpeningModel,
          as: 'jobOpening',
          attributes: ['id', 'title'],
          required: false,
        },
      ],
    });
    if (!candidate) {
      this.badRequest(
        `Candidate '${candidateId}' does not exist in this organization.`,
      );
    }
    return candidate;
  }

  private candidateName(candidate: any): string {
    return (
      [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') ||
      candidate.email
    );
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(tenantId: string, query: GetInterviewsQueryDto) {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;

    const where: any = { tenantId };
    if (query.candidateId) where.candidateId = query.candidateId;
    if (query.jobOpeningId) where.jobOpeningId = query.jobOpeningId;
    if (query.status) where.status = query.status;
    if (query.mode) where.mode = query.mode;
    if (query.from) where.scheduledAt = { [Op.gte]: new Date(query.from) };
    if (query.to) {
      where.scheduledAt = {
        ...(where.scheduledAt ?? {}),
        [Op.lte]: new Date(query.to),
      };
    }

    const { rows, count } = await InterviewModel.findAndCountAll({
      where,
      include: await this.buildInclude(tenantId),
      order: [['scheduledAt', 'DESC']],
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

  async getOne(tenantId: string, interviewId: string): Promise<InterviewRow> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const record = await InterviewModel.findOne({
      where: { id: interviewId, tenantId },
      include: await this.buildInclude(tenantId),
    });
    if (!record) this.notFound(interviewId);
    return this.toRow(record);
  }

  /**
   * The Upcoming Interviews panel: the next N still-scheduled interviews
   * inside the window, soonest first. Anything already started is excluded —
   * "upcoming" is about what has not happened yet, and a SCHEDULED interview
   * from last week is stale data rather than a plan.
   */
  async getUpcoming(
    tenantId: string,
    query: GetUpcomingInterviewsQueryDto,
  ): Promise<InterviewRow[]> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);

    const now = new Date();
    const withinDays =
      query.withinDays && query.withinDays > 0 ? query.withinDays : 14;
    const until = new Date(now.getTime() + withinDays * 86_400_000);

    const rows = await InterviewModel.findAll({
      where: {
        tenantId,
        status: InterviewStatus.SCHEDULED,
        scheduledAt: { [Op.gte]: now, [Op.lte]: until },
      },
      include: await this.buildInclude(tenantId),
      order: [['scheduledAt', 'ASC']],
      limit: query.limit && query.limit > 0 ? query.limit : 5,
      subQuery: false,
    });

    return (rows as any[]).map((row) => this.toRow(row));
  }

  // ==========================================
  // Writes
  // ==========================================

  async schedule(
    tenantId: string,
    dto: ScheduleInterviewDto,
    actorUserId?: string,
  ): Promise<InterviewRow> {
    const candidate = await this.loadCandidate(tenantId, dto.candidateId);

    if (candidate.stage === CandidateStage.REJECTED) {
      this.conflict(
        'This candidate has been rejected. Move them back into the pipeline before scheduling an interview.',
      );
    }

    const meetingLink = dto.meetingLink ?? null;
    const location = dto.location ?? null;
    this.validateModeDetails(dto.mode, meetingLink, location);

    const scheduledAt = new Date(dto.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime())) {
      this.badRequest('Interview start time is not a valid instant.');
    }
    const durationMinutes = dto.durationMinutes ?? 60;

    await this.assertNoOverlap(
      tenantId,
      dto.candidateId,
      scheduledAt,
      durationMinutes,
    );

    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const created: any = await InterviewModel.create({
      tenantId,
      candidateId: dto.candidateId,
      // Denormalized from the candidate so the panel and requisition filter
      // need no extra join — see the Interview model.
      jobOpeningId: candidate.jobOpeningId,
      scheduledAt,
      durationMinutes,
      mode: dto.mode,
      status: InterviewStatus.SCHEDULED,
      round: dto.round ?? 1,
      interviewerEmployeeId: dto.interviewerEmployeeId ?? null,
      meetingLink,
      location,
      outcome: InterviewOutcome.PENDING,
      notes: dto.notes ?? null,
      scheduledByUserId: actorUserId ?? null,
    });

    await this.advanceCandidateToInterview(tenantId, candidate, actorUserId);

    await this.activityService.record(tenantId, {
      type: RecruitmentActivityType.INTERVIEW_SCHEDULED,
      title: 'Interview scheduled',
      description: `${this.candidateName(candidate)} — round ${created.round} for ${
        candidate.jobOpening?.title ?? 'the role'
      }`,
      candidateId: candidate.id,
      jobOpeningId: candidate.jobOpeningId,
      interviewId: created.id,
      actorUserId: actorUserId ?? null,
      metadata: { mode: created.mode, scheduledAt: created.scheduledAt },
    });

    return this.getOne(tenantId, created.id);
  }

  /**
   * Move the candidate up to INTERVIEW if they are behind it. Only ever
   * forward — scheduling a follow-up round for someone already at OFFER must
   * not drag them back down the funnel.
   */
  private async advanceCandidateToInterview(
    tenantId: string,
    candidate: any,
    actorUserId?: string,
  ): Promise<void> {
    const interviewRank = candidateStageRank(CandidateStage.INTERVIEW);
    if (Number(candidate.furthestStageRank) >= interviewRank) return;

    const history = Array.isArray(candidate.stageHistory)
      ? candidate.stageHistory
      : [];

    await candidate.update({
      stage: CandidateStage.INTERVIEW,
      furthestStageRank: interviewRank,
      stageHistory: [
        ...history,
        {
          stage: CandidateStage.INTERVIEW,
          at: new Date().toISOString(),
          byUserId: actorUserId ?? null,
          note: 'Advanced automatically when an interview was scheduled',
        },
      ],
    });
  }

  async update(
    tenantId: string,
    interviewId: string,
    dto: UpdateInterviewDto,
  ): Promise<InterviewRow> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const record: any = await InterviewModel.findOne({
      where: { id: interviewId, tenantId },
    });
    if (!record) this.notFound(interviewId);

    // Validate the resulting combination, not just the supplied fields:
    // switching mode to ONLINE without supplying a link has to be caught
    // against the stored link.
    const mode = dto.mode ?? record.mode;
    const meetingLink =
      dto.meetingLink !== undefined ? dto.meetingLink : record.meetingLink;
    const location =
      dto.location !== undefined ? dto.location : record.location;
    this.validateModeDetails(mode, meetingLink, location);

    await record.update({
      ...(dto.mode !== undefined ? { mode: dto.mode } : {}),
      ...(dto.interviewerEmployeeId !== undefined
        ? { interviewerEmployeeId: dto.interviewerEmployeeId }
        : {}),
      ...(dto.meetingLink !== undefined
        ? { meetingLink: dto.meetingLink }
        : {}),
      ...(dto.location !== undefined ? { location: dto.location } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    });

    return this.getOne(tenantId, interviewId);
  }

  async reschedule(
    tenantId: string,
    interviewId: string,
    dto: RescheduleInterviewDto,
    actorUserId?: string,
  ): Promise<InterviewRow> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const record: any = await InterviewModel.findOne({
      where: { id: interviewId, tenantId },
    });
    if (!record) this.notFound(interviewId);

    if (record.status !== InterviewStatus.SCHEDULED) {
      this.conflict(
        `Only a scheduled interview can be rescheduled; this one is ${record.status}.`,
      );
    }

    const scheduledAt = new Date(dto.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime())) {
      this.badRequest('Interview start time is not a valid instant.');
    }
    const durationMinutes =
      dto.durationMinutes ?? Number(record.durationMinutes);

    await this.assertNoOverlap(
      tenantId,
      record.candidateId,
      scheduledAt,
      durationMinutes,
      interviewId,
    );

    const previousAt = record.scheduledAt;
    await record.update({ scheduledAt, durationMinutes });

    await this.activityService.record(tenantId, {
      type: RecruitmentActivityType.INTERVIEW_RESCHEDULED,
      title: 'Interview rescheduled',
      description: dto.reason ?? 'Interview moved to a new time',
      candidateId: record.candidateId,
      jobOpeningId: record.jobOpeningId,
      interviewId: record.id,
      actorUserId: actorUserId ?? null,
      metadata: {
        from: previousAt,
        to: scheduledAt,
        reason: dto.reason ?? null,
      },
    });

    return this.getOne(tenantId, interviewId);
  }

  /**
   * Record the interviewer's verdict. Completing an interview does not itself
   * move the candidate: an ADVANCE recommendation is an input to that
   * decision, not the decision, and the pipeline move stays an explicit act
   * on the board so the funnel reflects what a human decided.
   */
  async submitFeedback(
    tenantId: string,
    interviewId: string,
    dto: SubmitInterviewFeedbackDto,
    actorUserId?: string,
  ): Promise<InterviewRow> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const record: any = await InterviewModel.findOne({
      where: { id: interviewId, tenantId },
    });
    if (!record) this.notFound(interviewId);

    if (record.status === InterviewStatus.CANCELLED) {
      this.conflict('A cancelled interview cannot take feedback.');
    }

    await record.update({
      status: InterviewStatus.COMPLETED,
      outcome: dto.outcome,
      ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
      ...(dto.feedback !== undefined ? { feedback: dto.feedback } : {}),
      completedAt: new Date(),
    });

    if (dto.rating !== undefined) {
      await this.refreshCandidateRating(tenantId, record.candidateId);
    }

    await this.activityService.record(tenantId, {
      type: RecruitmentActivityType.INTERVIEW_COMPLETED,
      title: 'Interview completed',
      description: `Outcome recorded as ${dto.outcome}`,
      candidateId: record.candidateId,
      jobOpeningId: record.jobOpeningId,
      interviewId: record.id,
      actorUserId: actorUserId ?? null,
      metadata: { outcome: dto.outcome, rating: dto.rating ?? null },
    });

    return this.getOne(tenantId, interviewId);
  }

  /**
   * Recompute the candidate's aggregate rating as the mean of their rated
   * interviews, so the pipeline card's score reflects every round rather than
   * whichever one happened to be submitted last.
   */
  private async refreshCandidateRating(
    tenantId: string,
    candidateId: string,
  ): Promise<void> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const rated = (await InterviewModel.findAll({
      where: { tenantId, candidateId, rating: { [Op.ne]: null } },
      attributes: ['rating'],
      raw: true,
    })) as unknown as { rating: string }[];

    if (rated.length === 0) return;

    const sum = rated.reduce((acc, row) => acc + Number(row.rating), 0);
    const mean = Math.round((sum / rated.length) * 100) / 100;

    await CandidateModel.update(
      { rating: mean },
      { where: { id: candidateId, tenantId } },
    );
  }

  async cancel(
    tenantId: string,
    interviewId: string,
    dto: CancelInterviewDto,
    actorUserId?: string,
  ): Promise<InterviewRow> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const record: any = await InterviewModel.findOne({
      where: { id: interviewId, tenantId },
    });
    if (!record) this.notFound(interviewId);

    if (record.status === InterviewStatus.COMPLETED) {
      this.conflict('A completed interview cannot be cancelled.');
    }
    if (record.status === InterviewStatus.CANCELLED) {
      return this.getOne(tenantId, interviewId);
    }

    await record.update({
      status: InterviewStatus.CANCELLED,
      cancellationReason: dto.reason ?? null,
      completedAt: new Date(),
    });

    await this.activityService.record(tenantId, {
      type: RecruitmentActivityType.INTERVIEW_CANCELLED,
      title: 'Interview cancelled',
      description: dto.reason ?? 'Interview cancelled',
      candidateId: record.candidateId,
      jobOpeningId: record.jobOpeningId,
      interviewId: record.id,
      actorUserId: actorUserId ?? null,
      metadata: { reason: dto.reason ?? null },
    });

    return this.getOne(tenantId, interviewId);
  }

  async remove(tenantId: string, interviewId: string): Promise<void> {
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);
    const record: any = await InterviewModel.findOne({
      where: { id: interviewId, tenantId },
    });
    if (!record) this.notFound(interviewId);
    await record.destroy();
  }
}
