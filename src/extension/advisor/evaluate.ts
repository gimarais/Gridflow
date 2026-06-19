/**
 * Model advisor — pure scoring (no vscode), unit-tested.
 *
 * Builds a per-model performance profile from the workflow's own execution
 * history (success rate, average cost, average duration) and recommends a model
 * for a row. The recommendation improves as more runs accumulate — a genuine
 * data-network effect.
 */
import { GridSnapshot } from '../../shared/types';

export interface ModelScore {
  model: string;
  runs: number;
  failures: number;
  successRate: number; // 0..1
  avgCostUsd?: number;
  avgDurationMs?: number;
}

export function scoreModels(snapshot: GridSnapshot): ModelScore[] {
  const agg = new Map<string, { runs: number; failures: number; cost: number; costN: number; dur: number; durN: number }>();
  for (const r of snapshot.rows) {
    for (const run of r.work?.history ?? []) {
      const model = run.model ?? r.work?.model;
      if (!model) continue;
      const a = agg.get(model) ?? { runs: 0, failures: 0, cost: 0, costN: 0, dur: 0, durN: 0 };
      a.runs += 1;
      if (run.status === 'failed') a.failures += 1;
      if (run.usage?.costUsd != null) { a.cost += run.usage.costUsd; a.costN += 1; }
      if (run.durationMs != null) { a.dur += run.durationMs; a.durN += 1; }
      agg.set(model, a);
    }
  }
  return [...agg.entries()].map(([model, a]) => ({
    model,
    runs: a.runs,
    failures: a.failures,
    successRate: a.runs ? (a.runs - a.failures) / a.runs : 0,
    avgCostUsd: a.costN ? a.cost / a.costN : undefined,
    avgDurationMs: a.durN ? a.dur / a.durN : undefined,
  }));
}

export interface ModelSuggestion {
  model: string;
  reason: string;
}

/**
 * Suggest a model for a row: the historical best performer (highest success
 * rate, then cheaper, then faster). Returns undefined when there's no history
 * or the row is already assigned the top performer.
 */
export function suggestModel(snapshot: GridSnapshot, rowId: string): ModelSuggestion | undefined {
  const scores = scoreModels(snapshot).filter((s) => s.runs >= 1);
  if (scores.length === 0) return undefined;
  scores.sort(
    (a, b) =>
      b.successRate - a.successRate ||
      (a.avgCostUsd ?? Infinity) - (b.avgCostUsd ?? Infinity) ||
      (a.avgDurationMs ?? Infinity) - (b.avgDurationMs ?? Infinity),
  );
  const best = scores[0];
  const current = snapshot.rows.find((r) => r.id === rowId)?.work?.model;
  if (current && current === best.model) return undefined;
  const parts = [`${Math.round(best.successRate * 100)}% success over ${best.runs} run${best.runs > 1 ? 's' : ''}`];
  if (best.avgCostUsd != null) parts.push(`~$${best.avgCostUsd.toFixed(4)}/run`);
  return { model: best.model, reason: parts.join(' · ') };
}
