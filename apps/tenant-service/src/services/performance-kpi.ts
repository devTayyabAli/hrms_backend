import { HttpStatus, Logger } from '@nestjs/common';
import { KpiScoreDto, TenantErrorCode, TenantException } from '@app/common';
import type { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** The weighted average of the scored KPIs (each 0 to 5), or null when none is scored. */
export const weightedKpiScore = (kpis: { weight: number | string; score: number | string | null }[]): number | null => {
  const scored = kpis.map((kpi) => ({ weight: Number(kpi.weight) || 0, score: asNumber(kpi.score) })).filter((kpi): kpi is { weight: number; score: number } => kpi.score !== null && kpi.weight > 0);
  const weights = scored.reduce((sum, kpi) => sum + kpi.weight, 0);
  if (!weights) return null;
  return Math.round((scored.reduce((sum, kpi) => sum + kpi.weight * kpi.score, 0) / weights) * 100) / 100;
};

/**
 * Records what the reviewer wrote against each KPI (what was achieved, a score
 * 0 to 5, a comment) and returns the review's KPI score. Every KPI named must
 * belong to the review. Each change goes to the audit history with the review.
 */
export const applyKpiScores = async (
  modelProvider: TenantModelProviderService,
  logger: Logger,
  tenantId: string,
  review: { id: string },
  scores: KpiScoreDto[],
): Promise<number | null> => {
  const Kpi = await modelProvider.getReviewKpiModel(tenantId);
  const kpis = (await Kpi.findAll({ where: { tenantId, reviewId: review.id } })) as any[];
  const byId = new Map(kpis.map((row) => [row.id, row]));
  for (const entry of scores) {
    if (!byId.has(entry.kpiId)) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'One of the KPIs is not part of this review.', HttpStatus.BAD_REQUEST);
    }
  }
  for (const entry of scores) {
    const row = byId.get(entry.kpiId);
    const patch: Record<string, unknown> = {};
    const diff: Record<string, { from: unknown; to: unknown }> = { reviewId: { from: null, to: review.id } };
    if (entry.score !== undefined && asNumber(row.score) !== entry.score) {
      patch.score = entry.score;
      diff.score = { from: asNumber(row.score), to: entry.score };
    }
    if (entry.actual !== undefined && (row.actual ?? null) !== (entry.actual ?? null)) {
      patch.actual = entry.actual;
      diff.actual = { from: row.actual ?? null, to: entry.actual ?? null };
    }
    if (entry.comment !== undefined && (row.comment ?? null) !== (entry.comment ?? null)) {
      patch.comment = entry.comment;
      diff.comment = { from: row.comment ?? null, to: entry.comment ?? null };
    }
    if (!Object.keys(patch).length) continue;
    await row.update(patch);
    await writeAudit(modelProvider, logger, tenantId, 'review_kpis', row.id, 'UPDATE', diff);
  }
  return weightedKpiScore(kpis);
};
