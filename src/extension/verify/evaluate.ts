/**
 * Verification & adaptive replanning — pure core (no vscode), unit-tested.
 *
 * VMAO (Plan-Execute-Verify-Replan): a workflow can carry `verifier` rows that
 * evaluate the work. This module scores completeness, decides whether the
 * orchestrator should stop dispatching, and — when a verifier reports a gap —
 * proposes a supplementary set of gap-filling task rows (the "replan").
 */
import { GridSnapshot, Row, WorkItemStatus } from '../../shared/types';
import { budgetStatus } from '../../shared/workflowCore';
import type { WorkflowRowInput } from '../../shared/workflowCore';

const TERMINAL = new Set<WorkItemStatus>(['done', 'failed', 'cancelled']);

function isVerifier(r: Row): boolean {
  return r.work?.role === 'verifier';
}
function titleColumnName(snapshot: GridSnapshot): string | undefined {
  const col = snapshot.columns.find((c) => c.type === 'text') ?? snapshot.columns[0];
  return col?.name;
}
function rowTitle(snapshot: GridSnapshot, r: Row): string {
  const col = snapshot.columns.find((c) => c.type === 'text') ?? snapshot.columns[0];
  return (col && String(r.cells[col.id] ?? '')) || 'untitled';
}

export interface CompletenessVerdict {
  tasksTotal: number;
  tasksDone: number;
  completeness: number; // 0..1 over non-verifier rows
  verifiersTotal: number;
  verifiersPassed: number;
  /** Titles/outputs of verifier rows that failed — the unmet criteria. */
  unmetCriteria: { rowId: string; title: string; detail?: string }[];
}

export function verifyCompleteness(snapshot: GridSnapshot): CompletenessVerdict {
  const tasks = snapshot.rows.filter((r) => !isVerifier(r));
  const verifiers = snapshot.rows.filter(isVerifier);
  const tasksDone = tasks.filter((r) => r.work?.status === 'done').length;
  const unmetCriteria = verifiers
    .filter((r) => r.work?.status === 'failed')
    .map((r) => ({ rowId: r.id, title: rowTitle(snapshot, r), detail: r.work?.outputs }));
  return {
    tasksTotal: tasks.length,
    tasksDone,
    completeness: tasks.length ? tasksDone / tasks.length : 0,
    verifiersTotal: verifiers.length,
    verifiersPassed: verifiers.filter((r) => r.work?.status === 'done').length,
    unmetCriteria,
  };
}

export interface StopConfig {
  /** Stop once this fraction of tasks is done (default 1.0 — all of them). */
  minCompleteness?: number;
}

/**
 * Should the orchestrator stop dispatching? Stops when the budget is spent, or
 * when completeness is met AND no verifier is reporting an unmet criterion.
 * A failed verifier does NOT stop — it signals "replan" instead.
 */
export function evaluateStopConditions(
  snapshot: GridSnapshot,
  config: StopConfig = {},
): { stop: boolean; reason?: string } {
  if (budgetStatus(snapshot).exceeded) {
    return { stop: true, reason: 'budget exhausted — stop and raise the cap to continue' };
  }
  const v = verifyCompleteness(snapshot);
  if (v.unmetCriteria.length > 0) {
    return { stop: false, reason: `${v.unmetCriteria.length} verification gap(s) — replan recommended` };
  }
  const threshold = config.minCompleteness ?? 1.0;
  if (v.tasksTotal > 0 && v.completeness >= threshold) {
    const allTerminal = snapshot.rows.every((r) => TERMINAL.has(r.work?.status ?? 'pending'));
    if (allTerminal) return { stop: true, reason: 'all tasks complete' + (v.verifiersTotal ? ' and verified' : '') };
  }
  return { stop: false };
}

/**
 * Propose gap-filling task rows for each failed verifier — the adaptive replan.
 * Returns WorkflowRowInput[] (keyed by column name) ready for buildRows.
 */
export function proposeReplan(snapshot: GridSnapshot): WorkflowRowInput[] {
  const titleKey = titleColumnName(snapshot);
  const verdict = verifyCompleteness(snapshot);
  return verdict.unmetCriteria.map((gap) => {
    const row: WorkflowRowInput = {
      inputs:
        `A verification step ("${gap.title}") reported an unmet criterion. ` +
        `Address it, then the verifier can be re-run.` +
        (gap.detail ? `\n\nVerifier findings:\n${gap.detail}` : ''),
    };
    if (titleKey) row[titleKey] = `Fix: ${gap.title}`;
    return row;
  });
}
