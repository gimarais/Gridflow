import * as vscode from 'vscode';
import { GridPanel } from './gridPanel';
import { TemplateService } from './templates';
import { GridSnapshot, Provenance, emptyWorkItem, makeId } from '../shared/types';
import {
  applyRowUpdate,
  buildColumns,
  buildFanOut,
  buildRows,
  dispatchPlan,
  emptyCells,
  isWorkflowComplete,
  prepareReplay,
  readyRowIds,
  riskyRows,
  staleRowIds,
  workflowToText,
  FanOutItem,
  WorkflowColumnInput,
  WorkflowRowInput,
  UpdateRowInput,
  WorkflowStats,
  workflowStats,
} from '../shared/workflowCore';
import { ModelRate } from '../shared/modelPricing';
import { VerificationSummary } from '../shared/provenanceCore';
import { verifyRowProvenance } from './provenanceVerifier';
import { recordRowUpdate } from './compliance';
import { evaluateStop } from './verify';
import { loadWorkflow, saveWorkflow, slugify, withWorkflowLock } from './workflowStore';

const SUBMIT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour to fill in a workflow

export { workflowToText };
export type { WorkflowColumnInput, WorkflowRowInput, UpdateRowInput };

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

export interface ReplayRowInput {
  workflowId: string;
  rowId: string;
  promptOverride?: string;
}

export interface FanOutInput {
  workflowId: string;
  template: WorkflowRowInput;
  items: FanOutItem[];
}

export interface GetWorkflowInput {
  workflowId: string;
}

interface PanelRecord {
  panel: GridPanel;
  /**
   * Sync an orchestrator-written snapshot into the panel's debounced-save
   * closure, so a pending stale save can never overwrite a newer agent write.
   */
  acceptExternalSnapshot: (s: GridSnapshot) => void;
}

/**
 * Shared workflow engine — sub-agent orchestration, used identically by the MCP server
 * (Claude) and the VS Code language-model tools (Copilot). The protocol semantics live
 * in src/shared/workflowCore.ts; this class adds what only the extension host can do:
 * panels, sidecar persistence (serialized through a per-slug lock), and provenance
 * verification against the real filesystem.
 */
export class WorkflowOrchestrator {
  private openPanels = new Map<string, PanelRecord>();

  /** Fired when an updateRow transition completes the last open row of a workflow. */
  onWorkflowComplete?: (slug: string, snapshot: GridSnapshot, stats: WorkflowStats) => void;

  /** Fired whenever a workflow snapshot changes (for status bar updates, etc). */
  onSnapshotChanged?: (slug: string, snapshot: GridSnapshot) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly templates: TemplateService,
  ) {}

  /* ── open ──────────────────────────────────────────────────────────── */

  async openWorkflow(input: OpenWorkflowInput, opts: { blocking: boolean }): Promise<string> {
    if (!vscode.workspace.workspaceFolders?.length) {
      throw new Error('No workspace folder is open. Open a folder in VS Code first.');
    }

    const slug = slugify(input.name);
    const title = input.title ?? input.name;

    const snapshot = await withWorkflowLock(slug, async () => {
      let snap = await loadWorkflow(slug);
      if (!snap) {
        snap = this.buildSnapshot(title, input);
        await saveWorkflow(slug, snap);
        return snap;
      }
      // Existing workflow: append any new rows the agent supplied this time.
      let changed = false;
      if (input.rows?.length) {
        const built = buildRows(snap.columns, input.rows, snap.rows);
        snap = { ...snap, rows: [...snap.rows, ...built.rows] };
        changed = true;
      }
      if (input.instructions && !snap.instructions) {
        snap = { ...snap, instructions: input.instructions };
        changed = true;
      }
      if (changed) await saveWorkflow(slug, snap);
      return snap;
    });

    const existing = this.openPanels.get(slug);
    if (existing) {
      this.pushSnapshot(slug, snapshot);
      return workflowToText(slug, snapshot, 'reopened');
    }

    if (!opts.blocking) {
      this.createPanel(slug, snapshot);
      this.onSnapshotChanged?.(slug, snapshot);
      return workflowToText(slug, snapshot, 'opened');
    }

    // Blocking: open, wait for the user to submit, keep the panel open afterwards.
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let latestSnapshot = snapshot;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(workflowToText(slug, latestSnapshot, 'timeout'));
      }, SUBMIT_TIMEOUT_MS);

      const record = this.createPanel(slug, snapshot, {
        onSubmit: (submitted) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          latestSnapshot = submitted;
          record.panel.setPendingChatInvocation(false);
          void withWorkflowLock(slug, () => saveWorkflow(slug, submitted));
          resolve(workflowToText(slug, submitted, 'submitted'));
          // Panel intentionally stays open for live updates.
        },
        onSnapshot: (s) => { latestSnapshot = s; },
      });

      record.panel.setPendingChatInvocation(true);
      record.panel.panel.onDidDispose(() => {
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
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);

      const built = buildRows(snapshot.columns, input.rows, snapshot.rows);
      const updated: GridSnapshot = { ...snapshot, rows: [...snapshot.rows, ...built.rows] };
      await saveWorkflow(slug, updated);
      this.pushSnapshot(slug, updated);
      return annotate(workflowToText(slug, updated, 'rows-added'), {
        droppedDependencies: built.droppedDependencies.length ? built.droppedDependencies : undefined,
      });
    });
  }

  /* ── fan-out a template row over a list (the map primitive) ────────── */

  async fanOut(input: FanOutInput): Promise<string> {
    const slug = slugify(input.workflowId);
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);
      const built = buildFanOut(snapshot.columns, input.template ?? {}, input.items ?? [], snapshot.rows);
      const updated: GridSnapshot = { ...snapshot, rows: [...snapshot.rows, ...built.rows] };
      await saveWorkflow(slug, updated);
      this.pushSnapshot(slug, updated);
      return annotate(workflowToText(slug, updated, 'rows-added'), {
        fanOutCount: built.rows.length,
        droppedDependencies: built.droppedDependencies.length ? built.droppedDependencies : undefined,
      });
    });
  }

  /* ── update a row (the live reporting path) ────────────────────────── */

  async updateRow(input: UpdateRowInput): Promise<string> {
    const slug = slugify(input.workflowId);
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);
      const row = snapshot.rows.find((r) => r.id === input.rowId);
      if (!row) throw new Error(`Row "${input.rowId}" not found in workflow "${slug}".`);

      const wasComplete = isWorkflowComplete(snapshot);

      // Verify agent-reported file claims against the filesystem before recording.
      let effectiveInput = input;
      let verification: VerificationSummary | undefined;
      if (input.provenance) {
        const openRun = (row.work?.history ?? []).find((r) => r.startedAt && !r.finishedAt);
        const verified = await verifyRowProvenance(input.provenance as Provenance, {
          runStart: input.startedAt ?? openRun?.startedAt,
          runEnd: input.finishedAt ?? new Date().toISOString(),
        });
        verification = verified.summary;
        effectiveInput = { ...input, provenance: verified.provenance as UpdateRowInput['provenance'] };
      }

      const result = applyRowUpdate(snapshot, effectiveInput, {
        pricingOverrides: pricingOverrides(),
      });

      await saveWorkflow(slug, result.snapshot);
      this.pushSnapshot(slug, result.snapshot);

      // Append a tamper-evident record to the workflow's audit chain.
      try {
        const provenanceVerified = verification
          ? verification.filesRead.missing === 0 && verification.filesModified.missing === 0
          : undefined;
        await recordRowUpdate({
          slug,
          rowId: input.rowId,
          status: result.work.status,
          agent: result.work.assignedAgent,
          model: result.work.model,
          costUsd: result.totalCostUsd || undefined,
          totalTokens: result.totalTokens || undefined,
          provenanceVerified,
          at: new Date().toISOString(),
          snapshot: result.snapshot,
        });
      } catch (e) {
        console.error('GridFlow: audit chain record failed', e);
      }

      if (!wasComplete && isWorkflowComplete(result.snapshot)) {
        this.onWorkflowComplete?.(slug, result.snapshot, workflowStats(result.snapshot));
      }

      const stale = staleRowIds(result.snapshot);
      const plan = dispatchPlan(result.snapshot);
      // Stop-condition signal (completeness/verification/budget).
      const stop = evaluateStop(result.snapshot);
      return JSON.stringify({
        ok: true,
        workflowId: slug,
        rowId: input.rowId,
        status: result.work.status,
        runsTotal: result.runsTotal,
        durationMs: result.totalDurationMs || undefined,
        totalTokens: result.totalTokens || undefined,
        totalCostUsd: result.totalCostUsd || undefined,
        /** GridFlow's filesystem cross-check of the provenance you reported. */
        verification,
        droppedDependencies: result.droppedDependencies.length ? result.droppedDependencies : undefined,
        readyRowIds: plan.readyRowIds,
        readyRows: plan.readyRows,
        /** When true, the workflow's budget is spent — stop dispatching until the user raises the cap. */
        budgetExceeded: plan.budgetExceeded || undefined,
        budget: result.snapshot.budget ? plan.budget : undefined,
        staleRowIds: stale.length ? stale : undefined,
        riskyRows: riskyRows(result.snapshot).length ? riskyRows(result.snapshot) : undefined,
        /** Stop-condition recommendation (completeness/verification/budget). */
        stop: stop.stop || undefined,
        stopReason: stop.reason,
      }, null, 2);
    });
  }

  /* ── replay a single node (cheap failure recovery) ─────────────────── */

  async replayRow(input: ReplayRowInput): Promise<string> {
    const slug = slugify(input.workflowId);
    return withWorkflowLock(slug, async () => {
      const snapshot = await loadWorkflow(slug);
      if (!snapshot) throw new Error(`Workflow "${slug}" not found. Call gridflow_openWorkflow first.`);
      const { snapshot: next, resolvedInputs } = prepareReplay(snapshot, input.rowId, {
        promptOverride: input.promptOverride,
      });
      await saveWorkflow(slug, next);
      this.pushSnapshot(slug, next);
      return JSON.stringify({
        ok: true,
        workflowId: slug,
        rowId: input.rowId,
        status: 'pending',
        /** Re-dispatch the sub-agent with these exact inputs (own prompt + each dependency's outputs). */
        resolvedInputs,
        readyRowIds: readyRowIds(next),
      }, null, 2);
    });
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
    const columns = buildColumns(input.columns);
    const rows = input.rows?.length
      ? buildRows(columns, input.rows).rows
      : [{ id: makeId('row'), cells: emptyCells(columns), work: emptyWorkItem() }];
    return { title, instructions: input.instructions, kind: 'workflow', columns, rows };
  }

  /** Push an orchestrator-written snapshot to the open panel (if any) and notify listeners (status bar, tree view). */
  private pushSnapshot(slug: string, snapshot: GridSnapshot): void {
    this.onSnapshotChanged?.(slug, snapshot);
    const record = this.openPanels.get(slug);
    if (!record) return;
    record.acceptExternalSnapshot(snapshot);
    record.panel.setSnapshot(snapshot);
  }

  private createPanel(
    slug: string,
    snapshot: GridSnapshot,
    hooks?: { onSubmit?: (s: GridSnapshot) => void; onSnapshot?: (s: GridSnapshot) => void },
  ): PanelRecord {
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let latest = snapshot;

    const cancelPendingSave = () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    };

    const panel = GridPanel.create(this.context, this.templates, {
      mode: 'workflow',
      title: snapshot.title ?? slug,
      initialSnapshot: snapshot,
      // Every update is recorded in a tamper-evident chain → show the audit indicator.
      auditChain: true,
      onSendToChat: hooks?.onSubmit ? (s) => hooks.onSubmit!(s) : undefined,
      onSnapshotChanged: (s) => {
        latest = s;
        hooks?.onSnapshot?.(s);
        this.onSnapshotChanged?.(slug, s);
        cancelPendingSave();
        saveTimer = setTimeout(() => {
          saveTimer = undefined;
          withWorkflowLock(slug, () => saveWorkflow(slug, latest))
            .catch((e) => console.error('GridFlow: workflow save failed', e));
        }, 250);
      },
    });

    const record: PanelRecord = {
      panel,
      acceptExternalSnapshot: (s) => {
        // The orchestrator just persisted `s`; drop any pending save of an
        // older snapshot so it can't clobber the agent's write.
        latest = s;
        cancelPendingSave();
      },
    };

    this.openPanels.set(slug, record);
    panel.panel.onDidDispose(() => {
      if (saveTimer) {
        cancelPendingSave();
        void withWorkflowLock(slug, () => saveWorkflow(slug, latest));
      }
      if (this.openPanels.get(slug) === record) this.openPanels.delete(slug);
    });
    return record;
  }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function pricingOverrides(): Record<string, ModelRate> | undefined {
  const raw = vscode.workspace.getConfiguration('gridflow').get<Record<string, unknown>>('modelPricing');
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, ModelRate> = {};
  for (const [model, rate] of Object.entries(raw)) {
    if (
      rate && typeof rate === 'object' &&
      typeof (rate as ModelRate).inputPerMTok === 'number' &&
      typeof (rate as ModelRate).outputPerMTok === 'number'
    ) {
      out[model] = rate as ModelRate;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Merge extra fields into an already-serialized workflowToText JSON payload. */
function annotate(json: string, extra: Record<string, unknown>): string {
  const defined = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
  if (!Object.keys(defined).length) return json;
  try {
    return JSON.stringify({ ...JSON.parse(json), ...defined }, null, 2);
  } catch {
    return json;
  }
}
