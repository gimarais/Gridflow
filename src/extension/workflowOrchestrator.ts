import * as vscode from 'vscode';
import { GridPanel } from './gridPanel';
import { TemplateService } from './templates';
import {
  ColumnDef,
  ColumnType,
  GridSnapshot,
  LogEntry,
  Provenance,
  Row,
  RowData,
  TokenUsage,
  WorkItem,
  WorkItemStatus,
  emptyWorkItem,
  makeId,
} from '../shared/types';
import { loadWorkflow, saveWorkflow, slugify } from './workflowStore';

const SUBMIT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour to fill in a workflow

export interface WorkflowColumnInput {
  name: string;
  type?: ColumnType;
  options?: string[];
}

/**
 * A row the agent wants in the workflow. Any key NOT in RESERVED_ROW_KEYS is treated
 * as a cell value keyed by column name (e.g. {"Task": "Research the API"}). The reserved
 * keys configure the sub-agent: which agent runs it, what it depends on, etc.
 */
export type WorkflowRowInput = Record<string, unknown> & {
  agent?: string;
  model?: string;
  /** 0-based indices into THIS rows array (or existing row ids) that must finish first. */
  dependsOn?: Array<number | string>;
  inputs?: string;
  status?: WorkItemStatus;
};

export interface OpenWorkflowInput {
  name: string;
  title?: string;
  /** Agent-designed columns representing what the user asked for. */
  columns?: WorkflowColumnInput[];
  rows?: WorkflowRowInput[];
  instructions?: string;
}

export interface AddRowsInput {
  workflowId: string;
  rows: WorkflowRowInput[];
}

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
  durationMs?: number;
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

export interface GetWorkflowInput {
  workflowId: string;
}

/**
 * Shared workflow engine — sub-agent orchestration, used identically by the MCP server
 * (Claude) and the VS Code language-model tools (Copilot).
 *
 * The model: the calling agent designs the grid (columns + rows) to match the user's
 * request, opens it (blocking until the user assigns agents and clicks "Start Workflow"),
 * then spawns a sub-agent per row — respecting `dependsOn` so independent rows run in
 * parallel — and reports each run back via updateRow. GridFlow measures wall-clock
 * duration itself (the gap between the row going `running` and reaching a terminal state)
 * so runtimes always populate even when the agent can't report them.
 */
export class WorkflowOrchestrator {
  private openPanels = new Map<string, GridPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly templates: TemplateService,
  ) {}

  registerPanel(slug: string, panel: GridPanel): void {
    this.openPanels.set(slug, panel);
    panel.panel.onDidDispose(() => {
      if (this.openPanels.get(slug) === panel) this.openPanels.delete(slug);
    });
  }

  /* ── open ──────────────────────────────────────────────────────────── */

  async openWorkflow(input: OpenWorkflowInput, opts: { blocking: boolean }): Promise<string> {
    if (!vscode.workspace.workspaceFolders?.length) {
      throw new Error('No workspace folder is open. Open a folder in VS Code first.');
    }

    const slug = slugify(input.name);
    const title = input.title ?? input.name;

    let snapshot = await loadWorkflow(slug);
    if (!snapshot) {
      snapshot = this.buildSnapshot(title, input);
      await saveWorkflow(slug, snapshot);
    } else {
      // Existing workflow: append any new rows the agent supplied this time.
      if (input.rows?.length) {
        snapshot = { ...snapshot, rows: [...snapshot.rows, ...this.buildRows(snapshot.columns, input.rows, snapshot.rows.map((r) => r.id))] };
        await saveWorkflow(slug, snapshot);
      }
      if (input.instructions && !snapshot.instructions) {
        snapshot = { ...snapshot, instructions: input.instructions };
      }
    }

    const existingPanel = this.openPanels.get(slug);
    if (existingPanel) {
      existingPanel.setSnapshot(snapshot);
      return workflowToText(slug, snapshot, 'reopened');
    }

    if (!opts.blocking) {
      this.createPanel(slug, snapshot);
      return workflowToText(slug, snapshot, 'opened');
    }

    // Blocking: open, wait for the user to submit, keep the panel open afterwards.
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let latestSnapshot = snapshot!;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(workflowToText(slug, latestSnapshot, 'timeout'));
      }, SUBMIT_TIMEOUT_MS);

      const panel = this.createPanel(slug, snapshot!, {
        onSubmit: (submitted) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          latestSnapshot = submitted;
          panel.setPendingChatInvocation(false);
          void saveWorkflow(slug, submitted);
          resolve(workflowToText(slug, submitted, 'submitted'));
          // Panel intentionally stays open for live updates.
        },
        onSnapshot: (s) => { latestSnapshot = s; },
      });

      panel.setPendingChatInvocation(true);
      panel.panel.onDidDispose(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('cancelled'));
      });
    });
  }

  /* ── add rows dynamically ──────────────────────────────────────────── */

  async addRows(input: AddRowsInput): Promise<string> {
    const slug = slugify(input.workflowId);
    const snapshot = await loadWorkflow(slug);
    if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);

    const newRows = this.buildRows(snapshot.columns, input.rows, snapshot.rows.map((r) => r.id));
    const updated: GridSnapshot = { ...snapshot, rows: [...snapshot.rows, ...newRows] };
    await saveWorkflow(slug, updated);
    this.openPanels.get(slug)?.setSnapshot(updated);
    return workflowToText(slug, updated, 'rows-added');
  }

  /* ── update a row (the live reporting path) ────────────────────────── */

  async updateRow(input: UpdateRowInput): Promise<string> {
    const slug = slugify(input.workflowId);
    const snapshot = await loadWorkflow(slug);
    if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);

    const rowIdx = snapshot.rows.findIndex((r) => r.id === input.rowId);
    if (rowIdx < 0) throw new Error(`Row "${input.rowId}" not found in workflow "${slug}".`);

    const existing: WorkItem = snapshot.rows[rowIdx].work ?? emptyWorkItem();
    const history = [...(existing.history ?? [])];
    const now = new Date().toISOString();
    const isTerminal = input.status ? TERMINAL_STATUSES.has(input.status) : false;
    const isStarting = input.status === 'running' || input.status === 'queued';

    // Find an open run (started, not yet finished) to update instead of duplicating.
    const openIdx = history.findIndex((r) => r.startedAt && !r.finishedAt);

    if (isStarting && openIdx < 0) {
      // Begin a new run; GridFlow timestamps the start so it can measure duration.
      history.push({
        id: makeId('run'),
        status: input.status!,
        agent: input.agent,
        model: input.model,
        startedAt: input.startedAt ?? now,
        provenance: toProvenance(input.provenance),
        usage: input.usage,
        logs: input.logs as LogEntry[] | undefined,
        summary: input.summary,
      });
    } else if (openIdx >= 0) {
      // Update / finalize the open run.
      const run = history[openIdx];
      const finishing = isTerminal || (!!input.finishedAt) || (!!input.durationMs);
      const finishedAt = finishing ? (input.finishedAt ?? now) : run.finishedAt;
      const durationMs = finishing
        ? (input.durationMs ?? elapsedMs(input.startedAt ?? run.startedAt, finishedAt))
        : run.durationMs;
      history[openIdx] = {
        ...run,
        status: input.status ?? run.status,
        agent: input.agent ?? run.agent,
        model: input.model ?? run.model,
        finishedAt,
        durationMs,
        summary: input.summary ?? run.summary ?? (input.outputs ? input.outputs.slice(0, 240) : undefined),
        provenance: mergeProvenance(run.provenance, toProvenance(input.provenance)),
        usage: mergeUsage(run.usage, input.usage),
        logs: [...(run.logs ?? []), ...((input.logs as LogEntry[] | undefined) ?? [])],
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
        durationMs: input.durationMs ?? elapsedMs(input.startedAt, finishedAt),
        summary: input.summary ?? (input.outputs ? input.outputs.slice(0, 240) : undefined),
        provenance: toProvenance(input.provenance),
        usage: input.usage,
        logs: input.logs as LogEntry[] | undefined,
      });
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
      inputs: input.inputs ?? existing.inputs,
      outputs: input.outputs ?? existing.outputs,
      dependsOn: input.dependsOn ?? existing.dependsOn,
      // Files the agent touched live in run provenance (history); `files` stays for
      // manual attachments only, so the two lists don't duplicate in the UI.
      files: existing.files,
      usage: { costUsd: totalCost || undefined, totalTokens: totalTokens || undefined },
      history,
      updatedAt: now,
    };

    const updatedRows = snapshot.rows.map((r, i) => (i === rowIdx ? { ...r, work: updatedWork } : r));
    const updatedSnapshot: GridSnapshot = { ...snapshot, rows: updatedRows };

    await saveWorkflow(slug, updatedSnapshot);
    this.openPanels.get(slug)?.setSnapshot(updatedSnapshot);

    return JSON.stringify({
      ok: true,
      workflowId: slug,
      rowId: input.rowId,
      status: updatedWork.status,
      runsTotal: history.length,
      durationMs: totalDuration || undefined,
      totalTokens: totalTokens || undefined,
      totalCostUsd: totalCost || undefined,
      readyRowIds: readyRowIds(updatedSnapshot),
    }, null, 2);
  }

  /* ── read ──────────────────────────────────────────────────────────── */

  async getWorkflow(input: GetWorkflowInput): Promise<string> {
    const slug = slugify(input.workflowId);
    const snapshot = await loadWorkflow(slug);
    if (!snapshot) throw new Error(`Workflow "${slug}" not found.`);
    return workflowToText(slug, snapshot, 'current');
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  private buildSnapshot(title: string, input: OpenWorkflowInput): GridSnapshot {
    const columns = this.buildColumns(input.columns);
    const rows = input.rows?.length
      ? this.buildRows(columns, input.rows)
      : [{ id: makeId('row'), cells: emptyCells(columns), work: emptyWorkItem() }];
    return { title, instructions: input.instructions, kind: 'workflow', columns, rows };
  }

  private buildColumns(cols?: WorkflowColumnInput[]): ColumnDef[] {
    if (cols?.length) {
      return cols.map((c) => ({
        id: makeId('col'),
        name: c.name,
        type: c.type ?? 'text',
        options: c.type === 'select' ? c.options ?? [] : undefined,
      }));
    }
    // Minimal fallback when the agent provides no columns. The agent is expected to
    // design columns matching the user's request; this is just a sane default.
    return [
      { id: makeId('col'), name: 'Task', type: 'text' },
      { id: makeId('col'), name: 'Objective', type: 'text' },
    ];
  }

  private buildRows(columns: ColumnDef[], rowInputs: WorkflowRowInput[], existingIds: string[] = []): Row[] {
    // Pre-generate ids so dependsOn-by-index (within this batch) resolves to real ids.
    const ids = rowInputs.map(() => makeId('row'));
    return rowInputs.map((ri, i) => {
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
        // A dependency may be a 0-based index into this batch, OR (for addRows) an
        // existing row id string. Resolve both.
        work.dependsOn = ri.dependsOn
          .map((d) => {
            if (typeof d === 'number') return ids[d];
            if (typeof d === 'string') return existingIds.includes(d) ? d : undefined;
            return undefined;
          })
          .filter((x): x is string => !!x);
        if (work.dependsOn.length === 0) delete work.dependsOn;
      }
      return { id: ids[i], cells, work };
    });
  }

  private createPanel(
    slug: string,
    snapshot: GridSnapshot,
    hooks?: { onSubmit?: (s: GridSnapshot) => void; onSnapshot?: (s: GridSnapshot) => void },
  ): GridPanel {
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let latest = snapshot;

    const panel = GridPanel.create(this.context, this.templates, {
      mode: 'workflow',
      title: snapshot.title ?? slug,
      initialSnapshot: snapshot,
      onSendToChat: hooks?.onSubmit ? (s) => hooks.onSubmit!(s) : undefined,
      onSnapshotChanged: (s) => {
        latest = s;
        hooks?.onSnapshot?.(s);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(
          () => saveWorkflow(slug, latest).catch((e) => console.error('GridFlow: workflow save failed', e)),
          250,
        );
      },
    });

    this.openPanels.set(slug, panel);
    panel.panel.onDidDispose(() => {
      if (saveTimer) { clearTimeout(saveTimer); void saveWorkflow(slug, latest); }
      if (this.openPanels.get(slug) === panel) this.openPanels.delete(slug);
    });
    return panel;
  }
}

/* ── status helpers ──────────────────────────────────────────────────── */

const TERMINAL_STATUSES = new Set<WorkItemStatus>(['done', 'failed', 'cancelled']);

function elapsedMs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function toProvenance(p: UpdateRowInput['provenance']): Provenance | undefined {
  return p as Provenance | undefined;
}

function mergeProvenance(a?: Provenance, b?: Provenance): Provenance | undefined {
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

function mergeUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
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

function emptyCells(columns: ColumnDef[]): RowData {
  const cells: RowData = {};
  for (const col of columns) cells[col.id] = col.type === 'boolean' ? false : col.type === 'number' ? null : '';
  return cells;
}

/** Rows that can start now: pending/queued with every dependency already done. */
function readyRowIds(snapshot: GridSnapshot): string[] {
  const statusById = new Map(snapshot.rows.map((r) => [r.id, r.work?.status ?? 'pending']));
  return snapshot.rows
    .filter((r) => {
      const s = r.work?.status ?? 'pending';
      if (s !== 'pending' && s !== 'queued') return false;
      const deps = r.work?.dependsOn ?? [];
      return deps.every((d) => statusById.get(d) === 'done');
    })
    .map((r) => r.id);
}

/* ── serialization back to the agent ─────────────────────────────────── */

export function workflowToText(slug: string, snapshot: GridSnapshot, state: string): string {
  const ready = new Set(readyRowIds(snapshot));
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
  return JSON.stringify(
    {
      workflowId: slug,
      state, // 'submitted' | 'opened' | 'current' | 'timeout' | 'reopened' | 'rows-added'
      title: snapshot.title,
      columns: snapshot.columns.map((c) => ({ name: c.name, type: c.type })),
      rows,
      /** Rows you can dispatch to sub-agents right now (deps satisfied). Run these in parallel. */
      readyRowIds: rows.filter((r) => r.ready).map((r) => r.id),
    },
    null,
    2,
  );
}
