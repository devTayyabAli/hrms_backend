import { Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  GetRecruitmentActivityQueryDto,
  RecruitmentActivityType,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

/** One rendered row of the Recent Activities panel. */
export interface RecruitmentActivityRow {
  id: string;
  type: RecruitmentActivityType;
  title: string;
  description: string | null;
  candidateId: string | null;
  jobOpeningId: string | null;
  interviewId: string | null;
  actorUserId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  /** Pre-formatted for the panel, e.g. "2 hours ago". */
  timeAgo: string;
}

export interface RecordActivityInput {
  type: RecruitmentActivityType;
  title: string;
  description?: string | null;
  candidateId?: string | null;
  jobOpeningId?: string | null;
  interviewId?: string | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes and reads the Recent Activities feed.
 *
 * Every write goes through {@link record}, which never throws: the feed is a
 * secondary record of something that already happened, so a failure to append
 * to it must not roll back or mask the candidate move, interview or
 * requisition change that produced it. The same reasoning as the audit hooks
 * in TenantModelProviderService — the business operation is already done by
 * the time we get here.
 */
@Injectable()
export class RecruitmentActivityService {
  private readonly logger = new Logger(RecruitmentActivityService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  /**
   * Append one entry. Swallows and logs its own failures — see the class
   * comment for why this is deliberate rather than an oversight.
   */
  async record(tenantId: string, input: RecordActivityInput): Promise<void> {
    try {
      const ActivityModel =
        await this.modelProvider.getRecruitmentActivityModel(tenantId);
      await ActivityModel.create({
        tenantId,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        candidateId: input.candidateId ?? null,
        jobOpeningId: input.jobOpeningId ?? null,
        interviewId: input.interviewId ?? null,
        actorUserId: input.actorUserId ?? null,
        metadata: input.metadata ?? null,
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to record recruitment activity '${input.type}' for tenant ${tenantId}: ${err.message}`,
      );
    }
  }

  private formatTimeAgo(date: Date): string {
    const diffMs = Date.now() - new Date(date).getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }

  async getFeed(
    tenantId: string,
    query: GetRecruitmentActivityQueryDto,
  ): Promise<RecruitmentActivityRow[]> {
    const ActivityModel =
      await this.modelProvider.getRecruitmentActivityModel(tenantId);

    const where: any = { tenantId };
    if (query.type) where.type = query.type;

    const rows = await ActivityModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: query.limit && query.limit > 0 ? query.limit : 10,
    });

    return (rows as any[]).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      description: row.description ?? null,
      candidateId: row.candidateId ?? null,
      jobOpeningId: row.jobOpeningId ?? null,
      interviewId: row.interviewId ?? null,
      actorUserId: row.actorUserId ?? null,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
      timeAgo: this.formatTimeAgo(row.createdAt),
    }));
  }

  /**
   * Count of feed entries of the given types since an instant. Used by the
   * hiring-goal widget to report activity inside the goal window.
   */
  async countSince(
    tenantId: string,
    types: RecruitmentActivityType[],
    since: Date,
  ): Promise<number> {
    const ActivityModel =
      await this.modelProvider.getRecruitmentActivityModel(tenantId);
    return ActivityModel.count({
      where: {
        tenantId,
        type: { [Op.in]: types },
        createdAt: { [Op.gte]: since },
      },
    });
  }
}
