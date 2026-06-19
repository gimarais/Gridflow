/**
 * Pure workflow engine — the heart of GridFlow's sub-agent orchestration.
 * Everything here is side-effect free and `vscode`-free so the same logic is
 * shared by the extension host (MCP server + Copilot LM tools), the webview,
 * and the standalone CLI (`gridflow watch|serve|report`). This boundary is
 * also the future open-core seam: persistence and UI live with each surface,
 * the protocol semantics live here.
 */
import {
  ColumnDef,
  ColumnType,
  DependencyOutput,
  ExecutionRun,
  GridSnapshot,
  LogEntry,
  Provenance,
  ResolvedInputs,
  Row,
  RowData,
  TokenUsage,
  WORK_ITEM_STATUSES,
  WorkItem,
  WorkItemStatus,
  emptyWorkItem,
  makeId,
} from './types';
import {
  MAX_SHORT_CHARS,
  MAX_TEXT_CHARS,
  isValidStatus,
  sanitizeLogs,
  sanitizeProvenance,
  sanitizeUsage,
  truncate,
} from './sanitize';
import { ModelRate, estimateCostUsd } from './modelPricing';

export const TERMINAL_STATUSES = new Set<WorkItemStatus>(['done', 'failed', 'cancelled']);

/** Running rows untouched for this long are reported as stale (agent likely died). */
export const STALE_RUNNING_MS = 30 * 60 * 1000;

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'workflow'
  );
}

export function elapsedMs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function emptyCells(columns: ColumnDef[]): RowData {
  const cells: RowData = {};
  for (const col of columns) cells[col.id] = col.type === 'boolean' ? false : col.type === 'number' ? null : '';
  return cells;
}

/* ── inputs ──────────────────────────────────────────────────────────── */

export interface WorkflowColumnInput {
  name: string;
  type?: ColumnType;
  options?: string[];
}

/**
 * A row the agent wants in the workflow. Any key NOT in the reserved set is
 * treated as a cell value keyed by column name (e.g. {"Task": "Research"}).
 * Reserved keys configure the sub-agent: which agent runs it, deps, etc.
 */
export type WorkflowRowInput = Record<string, unknown> & {
  agent?: string;
  model?: string;
  /** 0-based indices into THIS rows array (or existing row ids) that must finish first. */
  dependsOn?: Array<number | string>;
  inputs?: string;
  status?: WorkItemStatus;
};

export interface UpdateRowInput {
  workflowId: string;
  rowId: string;
  status?: WorkItemStatus;
  agent?: string;
  model?: string;
  inputs?: string;
  outputs?: string;
  summary?: string;
  dependsOn?: string[];
  startedAt?: string;
  finishedAt?: string;
  provenance?: {
    prompt?: string;
    context?: string;
    filesRead?: Array<{ path: string; note?: string }>;
    filesModified?: Array<{ path: string; change?: 'modified' | 'created' | 'deleted'; note?: string }>;
    toolCalls?: Array<{ name: string; input?: string; output?: string }>;
    subAgents?: string[];
  };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
  logs?: Array<{ message: string; level?: 'debug' | 'info' | 'warn' | 'error'; at?: string }>;
}

/* ── columns & rows ──────────────────────────────────────────────────── */

export function buildColumns(cols?: WorkflowColumnInput[]): ColumnDef[] {
  if (cols?.length) {
    return cols.map((c) => ({
      id: makeId('col'),
      name: c.name,
      type: c.type ?? 'text',
      options: c.type === 'select' ? c.options ?? [] : undefined,
    }));
  }
  // Minimal fallback when the agent provides no columns. The agent is expected
  // to design columns matching the user's request; this is just a sane default.
  return [
    { id: makeId('col'), name: 'Task', type: 'text' },
    { id: makeId('col'), name: 'Objective', type: 'text' },
  ];
}

export interface BuildRowsResult {
  rows: Row[];
  /** Human-readable notes for dependency edges that were dropped (unknown id / cycle). */
  droppedDependencies: string[];
}

export function buildRows(
  columns: ColumnDef[],
  rowInputs: WorkflowRowInput[],
  existingRows: Row[] = [],
): BuildRowsResult {
  // Pre-generate ids so dependsOn-by-index (within this batch) resolves to real ids.
  const ids = rowInputs.map(() => makeId('row'));
  const existingIds = new Set(existingRows.map((r) => r.id));
  const dropped: string[] = [];

  // Dependency graph of accepted edges (existing rows + new rows as they're built),
  // used to reject any edge that would close a cycle.
  const depGraph = new Map<string, string[]>();
  for (const r of existingRows) depGraph.set(r.id, [...(r.work?.dependsOn ?? [])]);
  for (const id of ids) depGraph.set(id, []);

  const rows = rowInputs.map((ri, i) => {
    const cells: RowData = {};
    for (const col of columns) {
      const raw = ri[col.name];
      cells[col.id] = raw === undefined || raw === null
        ? col.type === 'boolean' ? false : col.type === 'number' ? null : ''
        : (raw as RowData[string]);
    }
    const work = emptyWorkItem();
    if (typeof ri.agent === 'string') work.assignedAgent = ri.agent;
    if (typeof ri.model === 'string') work.model = ri.model;
    if (typeof ri.inputs === 'string') work.inputs = ri.inputs;
    if (Array.isArray(ri.dependsOn)) {
      const accepted: string[] = [];
      for (const d of ri.dependsOn) {
        // A dependency may be a 0-based index into this batch, OR (for addRows)
        // an existing row id string. Resolve both.
        let depId: string | undefined;
        if (typeof d === 'number') depId = ids[d];
        else if (typeof d === 'string') depId = existingIds.has(d) || ids.includes(d) ? d : undefined;
        if (!depId) {
          dropped.push(`row ${i}: unknown dependency "${String(d)}"`);
          continue;
        }
        if (depId === ids[i] || wouldCreateCycle(depGraph, ids[i], depId)) {
          dropped.push(`row ${i}: dependency on "${String(d)}" would create a cycle`);
          continue;
        }
        accepted.push(depId);
        depGraph.get(ids[i])!.push(depId);
      }
      if (accepted.length) work.dependsOn = accepted;
    }
    return { id: ids[i], cells, work };
  });

  return { rows, droppedDependencies: dropped };
}

/* ── fan-out / map (G6) ──────────────────────────────────────────────── */

export type FanOutItem = string | Record<string, unknown>;

/**
 * Substitute `{{item}}` (whole item) and `{{key}}` (object field) placeholders
 * in a template string against one fan-out item. Used to expand one template
 * row into N parallel rows.
 */
export function fanOutSubstitute(value: string, item: FanOutItem): string {
  if (typeof item === 'string') {
    return value.replace(/\{\{\s*(?:item|\.)\s*\}\}/g, item);
  }
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === 'item' || key === '.') return JSON.stringify(item);
    const v = (item as Record<string, unknown>)[key];
    return v == null ? '' : String(v);
  });
}

function substituteTemplate(template: WorkflowRowInput, item: FanOutItem): WorkflowRowInput {
  const out: WorkflowRowInput = {};
  for (const [k, v] of Object.entries(template)) {
    out[k] = typeof v === 'string' ? fanOutSubstitute(v, item) : v;
  }
  return out;
}

/**
 * Expand one template row into N parallel rows — the map / fan-out primitive.
 * Each item produces an independent row (no barrier between them), so the items
 * stream through downstream stages independently. The template's `dependsOn`
 * (typically existing parent row ids) is applied to every generated row.
 */
export function buildFanOut(
  columns: ColumnDef[],
  template: WorkflowRowInput,
  items: FanOutItem[],
  existingRows: Row[] = [],
): BuildRowsResult {
  const rowInputs = items.map((item) => substituteTemplate(template, item));
  return buildRows(columns, rowInputs, existingRows);
}

/* ── DAG helpers ─────────────────────────────────────────────────────── */

/** True if adding the edge `from → dep` would close a cycle (dep can already reach from). */
export function wouldCreateCycle(depGraph: Map<string, string[]>, from: string, dep: string): boolean {
  if (from === dep) return true;
  const stack = [dep];
  const visited = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of depGraph.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Rows that can never become ready: members of a dependency cycle and any row
 * downstream of one. Computed via Kahn's algorithm; dangling dependency ids
 * (rows that were deleted) are ignored rather than treated as blocking.
 */
export function deadlockedRowIds(rows: Row[]): string[] {
  const known = new Set(rows.map((r) => r.id));
  const remainingDeps = new Map<string, Set<string>>();
  for (const r of rows) {
    remainingDeps.set(r.id, new Set((r.work?.dependsOn ?? []).filter((d) => known.has(d))));
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (const [id, deps] of remainingDeps) {
      if (deps.size === 0) {
        remainingDeps.delete(id);
        for (const other of remainingDeps.values()) other.delete(id);
        progress = true;
      }
    }
  }
  return [...remainingDeps.keys()];
}

/** Rows that can start now: pending/queued with every (existing) dependency already done. */
export function readyRowIds(snapshot: GridSnapshot): string[] {
  const statusById = new Map(snapshot.rows.map((r) => [r.id, r.work?.status ?? 'pending']));
  return snapshot.rows
    .filter((r) => {
      const s = r.work?.status ?? 'pending';
      if (s !== 'pending' && s !== 'queued') return false;
      const deps = r.work?.dependsOn ?? [];
      // Dangling ids (dependency row was deleted) count as satisfied.
      return deps.every((d) => !statusById.has(d) || statusById.get(d) === 'done');
    })
    .map((r) => r.id);
}

/* ── edge-state propagation & single-node replay (G1 + G2) ───────────── */

function rowTitle(snapshot: GridSnapshot, row: Row): string | undefined {
  const titleCol = snapshot.columns.find((c) => c.type === 'text') ?? snapshot.columns[0];
  if (!titleCol) return undefined;
  const v = row.cells[titleCol.id];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * The exact inputs a row should run with: its own prompt plus a snapshot of
 * every dependency's current outputs. This is the "structured state passed
 * along DAG edges" the paper describes — GridFlow resolves it so the agent
 * wires parent outputs deterministically instead of reconstructing them.
 */
export function resolveRowInputs(snapshot: GridSnapshot, rowId: string): ResolvedInputs {
  const row = snapshot.rows.find((r) => r.id === rowId);
  if (!row) return {};
  const deps = row.work?.dependsOn ?? [];
  const dependencyOutputs: DependencyOutput[] = [];
  for (const d of deps) {
    const dep = snapshot.rows.find((r) => r.id === d);
    if (!dep) continue;
    dependencyOutputs.push({ rowId: d, title: rowTitle(snapshot, dep), outputs: dep.work?.outputs });
  }
  return {
    inputs: row.work?.inputs,
    dependencyOutputs: dependencyOutputs.length ? dependencyOutputs : undefined,
  };
}

export interface ReadyRowDetail extends ResolvedInputs {
  id: string;
}

/** Ready rows with their resolved inputs (own prompt + dependency outputs) attached. */
export function readyRowsDetail(snapshot: GridSnapshot): ReadyRowDetail[] {
  return readyRowIds(snapshot).map((id) => ({ id, ...resolveRowInputs(snapshot, id) }));
}

/* ── budget (G3-basic) ───────────────────────────────────────────────── */

export interface BudgetStatus {
  maxTokens?: number;
  maxCostUsd?: number;
  tokensUsed: number;
  costUsed: number;
  /** True once any configured cap is passed — dispatch should halt. */
  exceeded: boolean;
  remainingTokens?: number;
  remainingCostUsd?: number;
}

/** Aggregate (estimated) spend vs. the workflow's configured caps. */
export function budgetStatus(snapshot: GridSnapshot): BudgetStatus {
  const stats = workflowStats(snapshot);
  const b = snapshot.budget;
  const exceeded =
    !!b &&
    ((b.maxTokens != null && stats.totalTokens > b.maxTokens) ||
      (b.maxCostUsd != null && stats.totalCostUsd > b.maxCostUsd));
  return {
    maxTokens: b?.maxTokens,
    maxCostUsd: b?.maxCostUsd,
    tokensUsed: stats.totalTokens,
    costUsed: stats.totalCostUsd,
    exceeded,
    remainingTokens: b?.maxTokens != null ? Math.max(0, b.maxTokens - stats.totalTokens) : undefined,
    remainingCostUsd: b?.maxCostUsd != null ? Math.max(0, b.maxCostUsd - stats.totalCostUsd) : undefined,
  };
}

export interface DispatchPlan {
  readyRowIds: string[];
  readyRows: ReadyRowDetail[];
  budget: BudgetStatus;
  /** When true, ready rows are withheld because the budget is spent. */
  budgetExceeded: boolean;
}

/**
 * Rows the orchestrator may dispatch right now. Identical to `readyRowsDetail`
 * unless the workflow's budget is exceeded, in which case dispatch is halted
 * (empty) so a runaway loop can't keep spending.
 */
export function dispatchPlan(snapshot: GridSnapshot): DispatchPlan {
  const budget = budgetStatus(snapshot);
  if (budget.exceeded) {
    return { readyRowIds: [], readyRows: [], budget, budgetExceeded: true };
  }
  return { readyRowIds: readyRowIds(snapshot), readyRows: readyRowsDetail(snapshot), budget, budgetExceeded: false };
}

/* ── pre-action file-risk gate (G7-basic) ────────────────────────────── */

/** Files touched by a `failed` run anywhere in the workflow → how many times. */
export function failedFileHistory(snapshot: GridSnapshot): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of snapshot.rows) {
    for (const run of r.work?.history ?? []) {
      if (run.status !== 'failed') continue;
      const touched = [...(run.provenance?.filesModified ?? []), ...(run.provenance?.filesRead ?? [])];
      for (const f of touched) {
        if (f.path) m.set(f.path, (m.get(f.path) ?? 0) + 1);
      }
    }
  }
  return m;
}

/**
 * Deterministic pre-action gate: warn when a row is about to touch a file that
 * a prior failed run already stumbled on. Pure string matching against the
 * workflow's own history — instant, reproducible, zero API cost (ProjectMem's
 * precheck_file idea applied to the workflow's audit log).
 */
export function fileRiskWarnings(snapshot: GridSnapshot, rowId: string): string[] {
  const row = snapshot.rows.find((r) => r.id === rowId);
  if (!row) return [];
  const failed = failedFileHistory(snapshot);
  if (!failed.size) return [];
  const haystack = [
    row.work?.inputs ?? '',
    ...Object.values(row.cells).map((v) => (typeof v === 'string' ? v : '')),
  ].join('\n');
  const warnings: string[] = [];
  for (const [path, count] of failed) {
    if (haystack.includes(path)) {
      warnings.push(`${path} was touched by ${count} prior failed run${count > 1 ? 's' : ''} in this workflow`);
    }
  }
  return warnings;
}

export interface RowRisk {
  rowId: string;
  warnings: string[];
}

/** Ready rows that reference a previously-failed file — surfaced to the orchestrator. */
export function riskyRows(snapshot: GridSnapshot): RowRisk[] {
  return readyRowIds(snapshot)
    .map((rowId) => ({ rowId, warnings: fileRiskWarnings(snapshot, rowId) }))
    .filter((r) => r.warnings.length > 0);
}

export interface PrepareReplayResult {
  snapshot: GridSnapshot;
  /** The inputs the replayed node will run with — return these to the orchestrator. */
  resolvedInputs: ResolvedInputs;
}

/**
 * Reset a single node to `pending` so the next orchestration pass re-dispatches
 * just that node — without re-running any upstream. Execution history is
 * preserved; an optional prompt override edits the row's inputs. Pure.
 */
export function prepareReplay(
  snapshot: GridSnapshot,
  rowId: string,
  opts: { promptOverride?: string; nowIso?: string } = {},
): PrepareReplayResult {
  const rowIdx = snapshot.rows.findIndex((r) => r.id === rowId);
  if (rowIdx < 0) throw new Error(`Row "${rowId}" not found.`);
  const now = opts.nowIso ?? new Date().toISOString();
  const override = opts.promptOverride !== undefined ? truncate(opts.promptOverride, MAX_TEXT_CHARS) : undefined;
  const rows = snapshot.rows.map((r, i) => {
    if (i !== rowIdx) return r;
    const work = r.work ?? emptyWorkItem();
    return {
      ...r,
      work: { ...work, status: 'pending' as WorkItemStatus, inputs: override ?? work.inputs, updatedAt: now },
    };
  });
  const next: GridSnapshot = { ...snapshot, rows };
  const resolved = resolveRowInputs(next, rowId);
  return { snapshot: next, resolvedInputs: resolved };
}

/** Running rows whose last sign of life is older than `thresholdMs` — the agent likely died. */
export function staleRowIds(
  snapshot: GridSnapshot,
  nowMs = Date.now(),
  thresholdMs = STALE_RUNNING_MS,
): string[] {
  return snapshot.rows
    .filter((r) => {
      if (r.work?.status !== 'running') return false;
      const openRun = (r.work.history ?? []).find((run) => run.startedAt && !run.finishedAt);
      const lastSeen = Date.parse(r.work.updatedAt ?? openRun?.startedAt ?? '');
      return Number.isFinite(lastSeen) && nowMs - lastSeen > thresholdMs;
    })
    .map((r) => r.id);
}

/* ── run lifecycle (the updateRow semantics) ─────────────────────────── */

export interface ApplyRowUpdateOptions {
  nowIso?: string;
  /** User overrides for cost estimation (gridflow.modelPricing). */
  pricingOverrides?: Record<string, ModelRate>;
}

export interface ApplyRowUpdateResult {
  snapshot: GridSnapshot;
  work: WorkItem;
  runsTotal: number;
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  /** Dependency edges that were rejected (unknown row id / cycle). */
  droppedDependencies: string[];
}

/**
 * Apply one updateRow call to a snapshot. One ExecutionRun per execution (not
 * per call): a starting status opens/refreshes a run, a terminal status (or an
 * explicit finishedAt) finalizes it. GridFlow always computes durationMs
 * itself from the running→done gap — agent-reported durations are ignored,
 * since they're frequently inaccurate.
 * Pure — throws on unknown row/status, never mutates the input snapshot.
 */
export function applyRowUpdate(
  snapshot: GridSnapshot,
  input: UpdateRowInput,
  opts: ApplyRowUpdateOptions = {},
): ApplyRowUpdateResult {
  if (input.status !== undefined && !isValidStatus(input.status)) {
    throw new Error(
      `Invalid status "${String(input.status)}". Valid statuses: ${WORK_ITEM_STATUSES.join(', ')}.`,
    );
  }
  const rowIdx = snapshot.rows.findIndex((r) => r.id === input.rowId);
  if (rowIdx < 0) throw new Error(`Row "${input.rowId}" not found.`);

  const now = opts.nowIso ?? new Date().toISOString();
  const existing: WorkItem = snapshot.rows[rowIdx].work ?? emptyWorkItem();
  const history = [...(existing.history ?? [])];
  const isTerminal = input.status ? TERMINAL_STATUSES.has(input.status) : false;
  const isStarting = input.status === 'running' || input.status === 'queued';

  // Cap untrusted payload pieces before they reach the sidecar.
  const provenance = sanitizeProvenance(input.provenance);
  const usage = sanitizeUsage(input.usage);
  const logs = sanitizeLogs(input.logs);
  const inputs = input.inputs !== undefined ? truncate(input.inputs, MAX_TEXT_CHARS) : undefined;
  const outputs = input.outputs !== undefined ? truncate(input.outputs, MAX_TEXT_CHARS) : undefined;
  const summary = input.summary !== undefined ? truncate(input.summary, MAX_SHORT_CHARS) : undefined;

  // Find an open run (started, not yet finished) to update instead of duplicating.
  const openIdx = history.findIndex((r) => r.startedAt && !r.finishedAt);

  if (isStarting && openIdx < 0) {
    // Begin a new run; GridFlow timestamps the start so it can measure duration,
    // and captures the resolved inputs (own prompt + dependency outputs) so the
    // node can later be replayed deterministically.
    const resolved = resolveRowInputs(snapshot, input.rowId);
    history.push({
      id: makeId('run'),
      status: input.status!,
      agent: input.agent,
      model: input.model,
      startedAt: input.startedAt ?? now,
      provenance,
      usage,
      logs: logs as LogEntry[] | undefined,
      summary,
      resolvedInputs: {
        inputs: inputs ?? resolved.inputs,
        dependencyOutputs: resolved.dependencyOutputs,
      },
    });
  } else if (openIdx >= 0) {
    // Update / finalize the open run.
    const run = history[openIdx];
    const finishing = isTerminal || !!input.finishedAt;
    const finishedAt = finishing ? input.finishedAt ?? now : run.finishedAt;
    const durationMs = finishing
      ? elapsedMs(input.startedAt ?? run.startedAt, finishedAt)
      : run.durationMs;
    history[openIdx] = {
      ...run,
      status: input.status ?? run.status,
      agent: input.agent ?? run.agent,
      model: input.model ?? run.model,
      finishedAt,
      durationMs,
      summary: summary ?? run.summary ?? (outputs ? outputs.slice(0, 240) : undefined),
      provenance: mergeProvenance(run.provenance, provenance),
      usage: mergeUsage(run.usage, usage),
      logs: [...(run.logs ?? []), ...((logs as LogEntry[] | undefined) ?? [])],
    };
  } else {
    // No open run and not starting one: record a single completed run.
    const finishedAt = input.finishedAt ?? now;
    history.push({
      id: makeId('run'),
      status: input.status ?? existing.status,
      agent: input.agent,
      model: input.model,
      startedAt: input.startedAt ?? finishedAt,
      finishedAt,
      durationMs: elapsedMs(input.startedAt, finishedAt),
      summary: summary ?? (outputs ? outputs.slice(0, 240) : undefined),
      provenance,
      usage,
      logs: logs as LogEntry[] | undefined,
    });
  }

  // Cost accuracy: when an agent reports tokens but no cost, estimate it from
  // the model's pricing so the cockpit shows a (labeled) cost estimate.
  const lastIdx = openIdx >= 0 ? openIdx : history.length - 1;
  const touched = history[lastIdx];
  if (touched.usage && touched.usage.costUsd == null) {
    const estimated = estimateCostUsd(
      input.model ?? touched.model ?? existing.model,
      touched.usage,
      opts.pricingOverrides,
    );
    if (estimated != null) {
      history[lastIdx] = { ...touched, usage: { ...touched.usage, costUsd: estimated } };
    }
  }

  // Validate dependency changes: unknown ids and cycle-creating edges are dropped.
  const droppedDependencies: string[] = [];
  let dependsOn = existing.dependsOn;
  if (input.dependsOn) {
    const known = new Set(snapshot.rows.map((r) => r.id));
    const depGraph = new Map<string, string[]>(
      snapshot.rows.map((r) => [r.id, r.id === input.rowId ? [] : [...(r.work?.dependsOn ?? [])]]),
    );
    const accepted: string[] = [];
    for (const d of input.dependsOn) {
      if (!known.has(d)) {
        droppedDependencies.push(`unknown row id "${d}"`);
        continue;
      }
      if (d === input.rowId || wouldCreateCycle(depGraph, input.rowId, d)) {
        droppedDependencies.push(`dependency on "${d}" would create a cycle`);
        continue;
      }
      accepted.push(d);
      depGraph.get(input.rowId)!.push(d);
    }
    dependsOn = accepted;
  }

  // Aggregate across runs.
  const totalCost = history.reduce((n, r) => n + (r.usage?.costUsd ?? 0), 0);
  const totalTokens = history.reduce(
    (n, r) => n + (r.usage?.totalTokens ?? (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)),
    0,
  );
  const totalDuration = history.reduce((n, r) => n + (r.durationMs ?? 0), 0);

  const lastRun = history[history.length - 1];
  const updatedWork: WorkItem = {
    ...existing,
    status: input.status ?? lastRun?.status ?? existing.status,
    assignedAgent: input.agent ?? existing.assignedAgent,
    model: input.model ?? existing.model,
    inputs: inputs ?? existing.inputs,
    outputs: outputs ?? existing.outputs,
    dependsOn,
    // Files the agent touched live in run provenance (history); `files` stays for
    // manual attachments only, so the two lists don't duplicate in the UI.
    files: existing.files,
    usage: { costUsd: totalCost || undefined, totalTokens: totalTokens || undefined },
    history,
    updatedAt: now,
  };

  const updatedRows = snapshot.rows.map((r, i) => (i === rowIdx ? { ...r, work: updatedWork } : r));
  return {
    snapshot: { ...snapshot, rows: updatedRows },
    work: updatedWork,
    runsTotal: history.length,
    totalDurationMs: totalDuration,
    totalTokens,
    totalCostUsd: totalCost,
    droppedDependencies,
  };
}

/* ── merge helpers ───────────────────────────────────────────────────── */

export function mergeProvenance(a?: Provenance, b?: Provenance): Provenance | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    prompt: b.prompt ?? a.prompt,
    context: b.context ?? a.context,
    filesRead: [...(a.filesRead ?? []), ...(b.filesRead ?? [])],
    filesModified: [...(a.filesModified ?? []), ...(b.filesModified ?? [])],
    toolCalls: [...(a.toolCalls ?? []), ...(b.toolCalls ?? [])],
    subAgents: [...new Set([...(a.subAgents ?? []), ...(b.subAgents ?? [])])],
  };
}

export function mergeUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x ?? 0) + (y ?? 0) || undefined;
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    costUsd: sum(a.costUsd, b.costUsd),
  };
}

/* ── aggregate stats (summary bar, tree view, dashboard, report) ─────── */

export interface WorkflowStats {
  total: number;
  byStatus: Partial<Record<WorkItemStatus, number>>;
  done: number;
  failed: number;
  running: number;
  totalCostUsd: number;
  totalTokens: number;
  /** Sum of every run's duration, as if all runs happened one after another. */
  totalDurationMs: number;
  /** Actual time elapsed across the workflow — overlapping (parallel) runs aren't double-counted. */
  wallClockDurationMs: number;
}

/** A run still in progress (no finishedAt) counts up to `nowMs` instead of 0. */
function runDurationMs(run: ExecutionRun, nowMs: number): number {
  if (run.startedAt && !run.finishedAt) {
    const elapsed = nowMs - Date.parse(run.startedAt);
    return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  }
  return run.durationMs ?? 0;
}

/**
 * Sum of merged [start, end] run intervals, so time where sub-agents ran in
 * parallel is only counted once — i.e. how long the workflow actually took.
 */
function mergeRunIntervals(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  total += curEnd - curStart;
  return total;
}

export function workflowStats(snapshot: GridSnapshot, nowMs = Date.now()): WorkflowStats {
  const byStatus: Partial<Record<WorkItemStatus, number>> = {};
  let totalCostUsd = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;
  const intervals: Array<[number, number]> = [];
  for (const r of snapshot.rows) {
    const s = r.work?.status ?? 'pending';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    totalCostUsd += r.work?.usage?.costUsd ?? 0;
    totalTokens += r.work?.usage?.totalTokens ?? 0;
    for (const run of r.work?.history ?? []) {
      totalDurationMs += runDurationMs(run, nowMs);
      if (!run.startedAt) continue;
      const start = Date.parse(run.startedAt);
      const end = run.finishedAt ? Date.parse(run.finishedAt) : nowMs;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push([start, end]);
    }
  }
  return {
    total: snapshot.rows.length,
    byStatus,
    done: byStatus.done ?? 0,
    failed: byStatus.failed ?? 0,
    running: byStatus.running ?? 0,
    totalCostUsd,
    totalTokens,
    totalDurationMs,
    wallClockDurationMs: mergeRunIntervals(intervals),
  };
}

/** Every row reached done/failed/cancelled — the workflow is finished. */
export function isWorkflowComplete(snapshot: GridSnapshot): boolean {
  return (
    snapshot.rows.length > 0 &&
    snapshot.rows.every((r) => TERMINAL_STATUSES.has(r.work?.status ?? 'pending'))
  );
}

/* ── critical path (G9-basic) ────────────────────────────────────────── */

export interface CriticalPath {
  /** Row ids on the longest dependency chain, in dependency order. */
  rowIds: string[];
  /** Sum of those rows' run durations — the floor on wall-clock time. */
  durationMs: number;
}

/** A row's own weight: the total duration of its runs. */
function nodeDurationMs(row: Row): number {
  return (row.work?.history ?? []).reduce((n, run) => n + (run.durationMs ?? 0), 0);
}

/**
 * The longest dependency chain weighted by per-row duration — the bottleneck
 * that sets the floor on how fast the workflow can finish no matter how much
 * you parallelize. Cycle-safe (a `visiting` guard returns 0 for back-edges).
 */
export function criticalPath(snapshot: GridSnapshot): CriticalPath {
  const byId = new Map(snapshot.rows.map((r) => [r.id, r]));
  const memo = new Map<string, CriticalPath>();
  const visiting = new Set<string>();

  function best(id: string): CriticalPath {
    const cached = memo.get(id);
    if (cached) return cached;
    const row = byId.get(id);
    if (!row || visiting.has(id)) return { rowIds: [], durationMs: 0 };
    visiting.add(id);
    let bestDep: CriticalPath = { rowIds: [], durationMs: 0 };
    for (const d of row.work?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const c = best(d);
      if (c.durationMs > bestDep.durationMs) bestDep = c;
    }
    visiting.delete(id);
    const result: CriticalPath = {
      rowIds: [...bestDep.rowIds, id],
      durationMs: bestDep.durationMs + nodeDurationMs(row),
    };
    memo.set(id, result);
    return result;
  }

  let overall: CriticalPath = { rowIds: [], durationMs: 0 };
  for (const r of snapshot.rows) {
    const b = best(r.id);
    if (b.durationMs > overall.durationMs) overall = b;
  }
  return overall;
}

/* ── validation & execution plan (G10 — CI-native) ──────────────────── */

export interface WorkflowValidation {
  errors: string[];
  warnings: string[];
}

/**
 * Static checks suitable for a CI gate: errors block (a cycle deadlocks the
 * DAG), warnings advise (dangling deps, no budget, stale rows). Pure.
 */
export function validateWorkflow(snapshot: GridSnapshot): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const r of snapshot.rows) {
    if (ids.has(r.id)) errors.push(`duplicate row id "${r.id}"`);
    ids.add(r.id);
  }
  const titleCol = snapshot.columns.find((c) => c.type === 'text') ?? snapshot.columns[0];
  const label = (r: Row, i: number) => (titleCol && String(r.cells[titleCol.id] ?? '')) || `row ${i + 1}`;
  snapshot.rows.forEach((r, i) => {
    for (const d of r.work?.dependsOn ?? []) {
      if (!ids.has(d)) warnings.push(`"${label(r, i)}" depends on missing row "${d}"`);
    }
  });
  const dead = deadlockedRowIds(snapshot.rows);
  if (dead.length) errors.push(`dependency cycle — these rows can never run: ${dead.join(', ')}`);
  if (snapshot.kind === 'workflow' && !snapshot.budget) {
    warnings.push('no budget set — this workflow can run to unbounded cost (set `budget` to cap it)');
  }
  const stale = staleRowIds(snapshot);
  if (stale.length) warnings.push(`stale running rows (no update in 30+ min): ${stale.join(', ')}`);
  return { errors, warnings };
}

/**
 * Topological parallelism waves: wave 0 = rows with no satisfied-able deps,
 * wave N = rows whose deps all landed in earlier waves. Dangling deps are
 * treated as satisfied; rows in a cycle are omitted (they never schedule).
 */
export function executionWaves(snapshot: GridSnapshot): string[][] {
  const ids = new Set(snapshot.rows.map((r) => r.id));
  const remaining = new Map(
    snapshot.rows.map((r) => [r.id, new Set((r.work?.dependsOn ?? []).filter((d) => ids.has(d)))]),
  );
  const placed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size) {
    const wave: string[] = [];
    for (const [id, deps] of remaining) {
      if ([...deps].every((d) => placed.has(d))) wave.push(id);
    }
    if (!wave.length) break; // remaining rows are deadlocked
    for (const id of wave) remaining.delete(id);
    for (const id of wave) placed.add(id);
    waves.push(wave);
  }
  return waves;
}

/* ── serialization back to the agent ─────────────────────────────────── */

export function workflowToText(slug: string, snapshot: GridSnapshot, state: string): string {
  const plan = dispatchPlan(snapshot);
  const ready = new Set(plan.readyRowIds);
  const rows = snapshot.rows.map((r) => {
    const cells: Record<string, unknown> = {};
    for (const col of snapshot.columns) cells[col.name] = r.cells[col.id];
    const w = r.work;
    const durationMs = (w?.history ?? []).reduce((n, run) => n + (run.durationMs ?? 0), 0);
    return {
      id: r.id,
      cells,
      status: w?.status ?? 'pending',
      assignedAgent: w?.assignedAgent,
      model: w?.model,
      dependsOn: w?.dependsOn,
      ready: ready.has(r.id),
      inputs: w?.inputs,
      outputs: w?.outputs,
      runsTotal: w?.history?.length ?? 0,
      durationMs: durationMs || undefined,
      totalTokens: w?.usage?.totalTokens,
      costUsd: w?.usage?.costUsd,
      updatedAt: w?.updatedAt,
    };
  });
  const stale = staleRowIds(snapshot);
  const deadlocked = deadlockedRowIds(snapshot.rows);
  const risky = riskyRows(snapshot);
  const cp = criticalPath(snapshot);
  return JSON.stringify(
    {
      workflowId: slug,
      state, // 'submitted' | 'opened' | 'current' | 'timeout' | 'reopened' | 'rows-added'
      title: snapshot.title,
      columns: snapshot.columns.map((c) => ({ name: c.name, type: c.type })),
      rows,
      /** Rows you can dispatch to sub-agents right now (deps satisfied). Run these in parallel. */
      readyRowIds: plan.readyRowIds,
      /** Ready rows with their resolved inputs (own prompt + each dependency's outputs) — wire these into the sub-agent prompt. */
      readyRows: plan.readyRows,
      /** Set when the workflow's token/cost budget is spent — dispatch is halted; readyRowIds is empty until the cap is raised. */
      budgetExceeded: plan.budgetExceeded || undefined,
      budget: snapshot.budget ? plan.budget : undefined,
      /** Rows stuck in `running` with no update for 30+ min — consider re-dispatching or marking failed. */
      staleRowIds: stale.length ? stale : undefined,
      /** Rows that can never run because of a dependency cycle — fix dependsOn. */
      deadlockedRowIds: deadlocked.length ? deadlocked : undefined,
      /** Ready rows about to touch a file a prior failed run stumbled on — proceed with extra care. */
      riskyRows: risky.length ? risky : undefined,
      /** Longest dependency chain by duration — the bottleneck that bounds wall-clock time. */
      criticalPath: cp.rowIds.length ? cp : undefined,
    },
    null,
    2,
  );
}

/* ── markdown audit report ───────────────────────────────────────────── */

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtCost(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(4)}` : '—';
}

function verificationBadge(v?: string): string {
  return v === 'verified' ? ' ✓' : v === 'missing' ? ' ✗ (missing)' : v === 'unverified' ? ' ?' : '';
}

/**
 * Render a workflow as a markdown audit report — summary table plus per-row
 * provenance. Suitable for PR descriptions and audit trails.
 */
export function workflowToMarkdown(slug: string, snapshot: GridSnapshot): string {
  const stats = workflowStats(snapshot);
  const titleCol = snapshot.columns.find((c) => c.type === 'text') ?? snapshot.columns[0];
  const lines: string[] = [];

  lines.push(`# Workflow report: ${snapshot.title ?? slug}`);
  lines.push('');
  lines.push(
    `**${stats.done}/${stats.total} done**` +
      (stats.failed ? ` · ${stats.failed} failed` : '') +
      (stats.running ? ` · ${stats.running} running` : '') +
      ` · tokens (est.): ${stats.totalTokens ? stats.totalTokens.toLocaleString() : '—'}` +
      ` · cost (est.): ${fmtCost(stats.totalCostUsd)}` +
      ` · wall-clock: ${fmtDuration(stats.wallClockDurationMs)}` +
      ` · agent time: ${fmtDuration(stats.totalDurationMs)}`,
  );
  lines.push('');
  lines.push('| # | Task | Status | Agent | Model | Runs | Duration | Tokens (est.) | Cost (est.) |');
  lines.push('|---|------|--------|-------|-------|------|----------|---------------|-------------|');
  snapshot.rows.forEach((r, i) => {
    const w = r.work;
    const task = titleCol ? String(r.cells[titleCol.id] ?? '') : '';
    const duration = (w?.history ?? []).reduce((n, run) => n + (run.durationMs ?? 0), 0);
    lines.push(
      `| ${i + 1} | ${escapeMd(task) || '—'} | ${w?.status ?? 'pending'} | ${escapeMd(w?.assignedAgent ?? '—')} | ` +
        `${escapeMd(w?.model ?? '—')} | ${w?.history?.length ?? 0} | ${fmtDuration(duration)} | ` +
        `${w?.usage?.totalTokens ? w.usage.totalTokens.toLocaleString() : '—'} | ${fmtCost(w?.usage?.costUsd ?? 0)} |`,
    );
  });

  snapshot.rows.forEach((r, i) => {
    const w = r.work;
    if (!w) return;
    const task = titleCol ? String(r.cells[titleCol.id] ?? '') : '';
    lines.push('');
    lines.push(`## ${i + 1}. ${task || 'Untitled'} — ${w.status}`);
    if (w.dependsOn?.length) {
      const indexById = new Map(snapshot.rows.map((row, idx) => [row.id, idx + 1]));
      lines.push(`Depends on: ${w.dependsOn.map((d) => `#${indexById.get(d) ?? '?'}`).join(', ')}`);
    }
    if (w.outputs) {
      lines.push('');
      lines.push('**Output:**');
      lines.push('');
      lines.push(truncate(w.outputs, 4000));
    }
    const read = new Map<string, string | undefined>();
    const modified = new Map<string, string | undefined>();
    for (const run of w.history ?? []) {
      for (const f of run.provenance?.filesRead ?? []) if (!read.has(f.path)) read.set(f.path, f.verification);
      for (const f of run.provenance?.filesModified ?? []) if (!modified.has(f.path)) modified.set(f.path, f.verification);
    }
    for (const p of modified.keys()) read.delete(p);
    if (modified.size) {
      lines.push('');
      lines.push(`**Files modified (${modified.size}):**`);
      for (const [p, v] of modified) lines.push(`- \`${p}\`${verificationBadge(v)}`);
    }
    if (read.size) {
      lines.push('');
      lines.push(`**Files read (${read.size}):**`);
      for (const [p, v] of read) lines.push(`- \`${p}\`${verificationBadge(v)}`);
    }
  });

  lines.push('');
  lines.push(`---`);
  lines.push(
    `_Generated by GridFlow on ${new Date().toISOString()} · ✓ verified by GridFlow · ? reported by agent, unverified · ✗ reported but not found_`,
  );
  lines.push('');
  return lines.join('\n');
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
