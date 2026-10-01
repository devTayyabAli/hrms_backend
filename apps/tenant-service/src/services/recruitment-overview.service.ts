import { Injectable } from '@nestjs/common';
import { Op, fn, col } from 'sequelize';
import {
  GetApplicationSourcesQueryDto,
  GetHiringGoalQueryDto,
  CandidateSource,
  CandidateStage,
  CANDIDATE_FUNNEL_STAGES,
  SHORTLISTED_STAGES,
  JobOpeningStatus,
  InterviewStatus,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

export interface RecruitmentStats {
  totalOpenPositions: number;
  totalApplications: number;
  shortlistedCandidates: number;
  interviewsScheduled: number;
  hired: number;
  growth: {
    totalOpenPositions: number;
    totalApplications: number;
    shortlistedCandidates: number;
    interviewsScheduled: number;
    hired: number;
  };
}

export interface ApplicationSourceSlice {
  source: CandidateSource;
  count: number;
  percentage: number;
}

export interface FunnelStageRow {
  stage: CandidateStage;
  /** Candidates who ever reached this stage — see Candidate.furthestStageRank. */
  reached: number;
  /** Candidates sitting in this stage right now. */
  current: number;
  /** Share of the funnel's entry stage that reached here. */
  conversionFromStart: number;
  /** Share of the immediately preceding stage that reached here. */
  conversionFromPrevious: number;
}

export interface HiringGoalSummary {
  period: 'month' | 'quarter';
  periodStart: string;
  periodEnd: string;
  /** Seats across all open requisitions — the goal's denominator. */
  targetHires: number;
  hiredInPeriod: number;
  progressPercentage: number;
  openPositions: number;
  remaining: number;
}

/**
 * The Recruitment screen's KPI cards and charts.
 *
 * Every figure here is a SQL aggregate — a COUNT or a grouped COUNT — rather
 * than a findAll tallied in Node. The numbers summarise the whole pipeline, so
 * loading the rows to count them would mean reading every candidate a tenant
 * has ever had on each dashboard load.
 */
@Injectable()
export class RecruitmentOverviewService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private percentChange(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  }

  private toDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  /**
   * KPI cards.
   *
   * Month-over-month growth is counted on when each record was *created*, not
   * when its subject is dated: a card asking "how did this month go" is
   * asking about activity in the month, and an interview can be booked weeks
   * ahead, which would otherwise credit it to a month that has not started.
   *
   * "Total Open Positions" is the one exception — it is a point-in-time stock,
   * not a flow, so its growth compares requisitions opened in each month.
   */
  async getStats(tenantId: string): Promise<RecruitmentStats> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);
    const InterviewModel = await this.modelProvider.getInterviewModel(tenantId);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const inWindow = (from: Date, to: Date) => ({
      createdAt: { [Op.gte]: from, [Op.lt]: to },
    });

    const [
      totalOpenPositions,
      totalApplications,
      shortlistedCandidates,
      interviewsScheduled,
      hired,
      openedThisMonth,
      openedLastMonth,
      appliedThisMonth,
      appliedLastMonth,
      shortlistedThisMonth,
      shortlistedLastMonth,
      interviewsThisMonth,
      interviewsLastMonth,
      hiredThisMonth,
      hiredLastMonth,
    ] = await Promise.all([
      JobOpeningModel.count({
        where: { tenantId, status: JobOpeningStatus.ACTIVE },
      }),
      CandidateModel.count({ where: { tenantId } }),
      CandidateModel.count({
        where: { tenantId, stage: { [Op.in]: [...SHORTLISTED_STAGES] } },
      }),
      InterviewModel.count({
        where: { tenantId, status: InterviewStatus.SCHEDULED },
      }),
      CandidateModel.count({
        where: { tenantId, stage: CandidateStage.HIRED },
      }),

      JobOpeningModel.count({
        where: { tenantId, ...inWindow(monthStart, now) },
      }),
      JobOpeningModel.count({
        where: { tenantId, ...inWindow(prevMonthStart, monthStart) },
      }),
      CandidateModel.count({
        where: { tenantId, ...inWindow(monthStart, now) },
      }),
      CandidateModel.count({
        where: { tenantId, ...inWindow(prevMonthStart, monthStart) },
      }),
      CandidateModel.count({
        where: {
          tenantId,
          stage: { [Op.in]: [...SHORTLISTED_STAGES] },
          ...inWindow(monthStart, now),
        },
      }),
      CandidateModel.count({
        where: {
          tenantId,
          stage: { [Op.in]: [...SHORTLISTED_STAGES] },
          ...inWindow(prevMonthStart, monthStart),
        },
      }),
      InterviewModel.count({
        where: { tenantId, ...inWindow(monthStart, now) },
      }),
      InterviewModel.count({
        where: { tenantId, ...inWindow(prevMonthStart, monthStart) },
      }),
      CandidateModel.count({
        where: {
          tenantId,
          stage: CandidateStage.HIRED,
          ...inWindow(monthStart, now),
        },
      }),
      CandidateModel.count({
        where: {
          tenantId,
          stage: CandidateStage.HIRED,
          ...inWindow(prevMonthStart, monthStart),
        },
      }),
    ]);

    return {
      totalOpenPositions,
      totalApplications,
      shortlistedCandidates,
      interviewsScheduled,
      hired,
      growth: {
        totalOpenPositions: this.percentChange(
          openedThisMonth,
          openedLastMonth,
        ),
        totalApplications: this.percentChange(
          appliedThisMonth,
          appliedLastMonth,
        ),
        shortlistedCandidates: this.percentChange(
          shortlistedThisMonth,
          shortlistedLastMonth,
        ),
        interviewsScheduled: this.percentChange(
          interviewsThisMonth,
          interviewsLastMonth,
        ),
        hired: this.percentChange(hiredThisMonth, hiredLastMonth),
      },
    };
  }

  /**
   * The Application Sources donut. One grouped COUNT rather than a COUNT per
   * channel, and percentages are computed against the filtered total so the
   * slices always add to 100.
   */
  async getApplicationSources(
    tenantId: string,
    query: GetApplicationSourcesQueryDto,
  ): Promise<{ total: number; slices: ApplicationSourceSlice[] }> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const where: any = { tenantId };
    if (query.jobOpeningId) where.jobOpeningId = query.jobOpeningId;
    if (query.from) where.appliedAt = { [Op.gte]: query.from.slice(0, 10) };
    if (query.to) {
      where.appliedAt = {
        ...(where.appliedAt ?? {}),
        [Op.lte]: query.to.slice(0, 10),
      };
    }

    const grouped = (await CandidateModel.findAll({
      where,
      attributes: ['source', [fn('COUNT', col('id')), 'count']],
      group: ['source'],
      raw: true,
    })) as unknown as { source: CandidateSource; count: string }[];

    const counts = new Map<CandidateSource, number>();
    let total = 0;
    for (const row of grouped) {
      const count = Number(row.count);
      counts.set(row.source, count);
      total += count;
    }

    // Every enum member is emitted, including zeroes, so the donut's legend
    // has a stable set of entries instead of channels appearing and vanishing
    // between refreshes.
    const slices = Object.values(CandidateSource).map((source) => {
      const count = counts.get(source) ?? 0;
      return {
        source,
        count,
        percentage: total === 0 ? 0 : Math.round((count / total) * 1000) / 10,
      };
    });

    return { total, slices };
  }

  /**
   * The Recruitment Pipeline funnel.
   *
   * `reached` counts candidates whose `furthestStageRank` is at or past the
   * stage, which is what makes this a funnel rather than a snapshot: someone
   * rejected after their interview still counts toward "reached Interview".
   * Deriving it from the current stage would make every rejection shrink the
   * upper funnel and push conversion rates upward as candidates were turned
   * down.
   *
   * One grouped COUNT over the rank column feeds every row — the cumulative
   * totals are then a running sum from the deepest stage backwards.
   */
  async getFunnel(tenantId: string): Promise<{
    stages: FunnelStageRow[];
    totalEntered: number;
  }> {
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const [byRank, byStage] = await Promise.all([
      CandidateModel.findAll({
        where: { tenantId },
        attributes: ['furthestStageRank', [fn('COUNT', col('id')), 'count']],
        group: ['furthestStageRank'],
        raw: true,
      }) as unknown as Promise<{ furthestStageRank: number; count: string }[]>,
      CandidateModel.findAll({
        where: { tenantId },
        attributes: ['stage', [fn('COUNT', col('id')), 'count']],
        group: ['stage'],
        raw: true,
      }) as unknown as Promise<{ stage: CandidateStage; count: string }[]>,
    ]);

    const atRank = new Map<number, number>();
    for (const row of byRank) {
      atRank.set(Number(row.furthestStageRank), Number(row.count));
    }
    const currentByStage = new Map<CandidateStage, number>();
    for (const row of byStage) {
      currentByStage.set(row.stage, Number(row.count));
    }

    // Walk the funnel from the deepest stage back to the first, accumulating:
    // "reached stage N" is everyone whose furthest rank is N or greater.
    const reachedByRank: number[] = [];
    let running = 0;
    for (let rank = CANDIDATE_FUNNEL_STAGES.length - 1; rank >= 0; rank--) {
      running += atRank.get(rank) ?? 0;
      reachedByRank[rank] = running;
    }

    const totalEntered = reachedByRank[0] ?? 0;

    const stages = CANDIDATE_FUNNEL_STAGES.map((stage, rank) => {
      const reached = reachedByRank[rank] ?? 0;
      const previousReached =
        rank === 0 ? reached : (reachedByRank[rank - 1] ?? 0);
      return {
        stage,
        reached,
        current: currentByStage.get(stage) ?? 0,
        conversionFromStart:
          totalEntered === 0
            ? 0
            : Math.round((reached / totalEntered) * 1000) / 10,
        conversionFromPrevious:
          previousReached === 0
            ? 0
            : Math.round((reached / previousReached) * 1000) / 10,
      };
    });

    return { stages, totalEntered };
  }

  /**
   * The Top Hiring Goal widget: how much of the open headcount has been
   * filled inside the current period.
   *
   * The target is the sum of `openings` across still-open requisitions plus
   * the hires already made in the period. Without that second term, filling a
   * requisition (and closing it) would shrink the denominator and the widget
   * would report 100% the moment the last open role was closed, regardless of
   * how many seats there had been.
   */
  async getHiringGoal(
    tenantId: string,
    query: GetHiringGoalQueryDto,
  ): Promise<HiringGoalSummary> {
    const JobOpeningModel =
      await this.modelProvider.getJobOpeningModel(tenantId);
    const CandidateModel = await this.modelProvider.getCandidateModel(tenantId);

    const now = new Date();
    const quarterly = query.quarterly === true;

    const periodStart = quarterly
      ? new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = quarterly
      ? new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const openStatuses = [JobOpeningStatus.ACTIVE, JobOpeningStatus.ON_HOLD];

    const [openSeats, openPositions, hiredInPeriod] = await Promise.all([
      JobOpeningModel.sum('openings', {
        where: { tenantId, status: { [Op.in]: openStatuses } },
      }),
      JobOpeningModel.count({
        where: { tenantId, status: JobOpeningStatus.ACTIVE },
      }),
      CandidateModel.count({
        where: {
          tenantId,
          stage: CandidateStage.HIRED,
          updatedAt: { [Op.gte]: periodStart, [Op.lte]: periodEnd },
        },
      }),
    ]);

    // sum() returns null on an empty set rather than 0.
    const seats = Number(openSeats ?? 0);
    const targetHires = seats + hiredInPeriod;

    return {
      period: quarterly ? 'quarter' : 'month',
      periodStart: this.toDateOnly(periodStart),
      periodEnd: this.toDateOnly(periodEnd),
      targetHires,
      hiredInPeriod,
      progressPercentage:
        targetHires === 0
          ? 0
          : Math.round((hiredInPeriod / targetHires) * 1000) / 10,
      openPositions,
      remaining: Math.max(0, seats),
    };
  }
}
