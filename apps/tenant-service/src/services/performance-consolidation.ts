/**
 * Putting several evaluators' evaluations together. Pure, so the arithmetic
 * can be checked on its own.
 *
 * Each evaluator has a weight (their share of the final rating, in percent) and
 * scores each competency 0 to 5. A competency's consolidated score is the
 * weighted average over the evaluators who scored it, so someone who did not
 * score a competency neither raises nor lowers it. The final rating is the
 * weighted average of the evaluators' own ratings, over those who have one.
 */

export const METRIC_KEYS = ['professionalism', 'communication', 'qualityOfWork', 'teamwork', 'leadership'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface EvaluatorResult {
  weight: number;
  rating: number | null;
  metrics: Record<MetricKey, number | null>;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const weightedAverage = (pairs: { weight: number; value: number | null }[]): number | null => {
  const used = pairs.filter((pair): pair is { weight: number; value: number } => pair.value !== null && pair.weight > 0);
  const weights = used.reduce((sum, pair) => sum + pair.weight, 0);
  if (!weights) return null;
  return round2(used.reduce((sum, pair) => sum + pair.weight * pair.value, 0) / weights);
};

export const consolidate = (results: EvaluatorResult[]): { rating: number | null; metrics: Record<MetricKey, number | null> } => {
  const metrics = {} as Record<MetricKey, number | null>;
  for (const key of METRIC_KEYS) metrics[key] = weightedAverage(results.map((result) => ({ weight: result.weight, value: result.metrics[key] })));
  return { rating: weightedAverage(results.map((result) => ({ weight: result.weight, value: result.rating }))), metrics };
};

/**
 * Splits `total` percent across items in proportion to their weights, in whole
 * numbers that add up to exactly `total` (largest remainder). Used to scale
 * several roles' KPIs into one plan that adds up to 100.
 */
export const scaleWeights = (weights: number[], total: number): number[] => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || !sum) return weights.map(() => 0);
  const exact = weights.map((weight) => (weight / sum) * total);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] += 1;
    left -= 1;
  }
  return floors;
};

/** Whole-number shares of 100 for `count` parts, the first parts taking any remainder. */
export const equalShares = (count: number): number[] => scaleWeights(Array.from({ length: count }, () => 1), 100);
