/**
 * Types shared between the extension host and the webview.
 * Keep this file free of `vscode` imports and DOM types — it gets bundled into both sides.
 */

export type ColumnType = 'text' | 'select' | 'number' | 'boolean';

export interface ColumnDef {
  id: string;
  name: string;
  type: ColumnType;
  options?: string[];
  placeholder?: string;
  width?: number;
}

export type CellValue = string | number | boolean | null;

export type RowData = Record<string, CellValue>;

export interface Row {
  id: string;
  cells: RowData;
  /**
   * Work-item metadata. Present only in `workflow` grids, where each row is a
   * first-class unit of agent work. Plain data / CSV grids leave this undefined,
   * so CSV serialization never has to account for it.
   */
  work?: WorkItem;
}

/** A grid is either plain tabular `data` or an AI `workflow` of work items. */
export type GridKind = 'data' | 'workflow';

/**
 * Optional spend ceiling for a workflow. When the aggregate (estimated) tokens
 * or cost exceed the cap, GridFlow stops surfacing rows for dispatch so a
 * runaway orchestration can't burn the budget. Estimates are best-effort.
 */
export interface WorkflowBudget {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface GridSnapshot {
  title?: string;
  instructions?: string;
  /** Defaults to 'data' when omitted (back-compat with existing CSV/standalone grids). */
  kind?: GridKind;
  /** Workflow-mode only: an optional spend ceiling that halts dispatch when exceeded. */
  budget?: WorkflowBudget;
  columns: ColumnDef[];
  rows: Row[];
}

/* ------------------------------------------------------------------ */
/* Work items: rows as first-class units of AI work                   */
/* ------------------------------------------------------------------ */

/** Lifecycle of a single work item / execution run. */
export type WorkItemStatus =
  | 'pending' // defined but not started
  | 'queued' // handed to an agent, not yet running
  | 'running' // an agent is actively working
  | 'blocked' // waiting on input / a dependency
  | 'done' // completed successfully
  | 'failed' // completed with an error
  | 'cancelled'; // abandoned by the user

export const WORK_ITEM_STATUSES: WorkItemStatus[] = [
  'pending',
  'queued',
  'running',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

/** What a file was used for, so a row can act as an evidence container. */
export type FileRefKind = 'source' | 'terminal' | 'test' | 'log' | 'screenshot' | 'other';

/** How a file was touched during a run (drives the provenance read/modified lists). */
export type FileChange = 'read' | 'modified' | 'created' | 'deleted';

/**
 * GridFlow's own audit of an agent-reported file claim:
 * - `verified` — GridFlow confirmed it (file exists; for modifications, mtime
 *   falls inside the run window; for deletions, the file is gone).
 * - `unverified` — the file exists but the claim couldn't be confirmed.
 * - `missing` — the agent reported a path that doesn't exist.
 */
export type FileVerification = 'verified' | 'unverified' | 'missing';

export interface FileRef {
  path: string;
  kind?: FileRefKind;
  change?: FileChange;
  /** Optional short note (e.g. "added auth middleware"). */
  note?: string;
  /** Set by GridFlow's provenance verifier — never by the agent. */
  verification?: FileVerification;
}

export interface ToolCallRecord {
  name: string;
  /** Serialized input arguments (may be truncated by the reporter). */
  input?: string;
  /** Serialized result (may be truncated). */
  output?: string;
  /** ISO timestamp. */
  at?: string;
}

export interface LogEntry {
  /** ISO timestamp. */
  at: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** Token + cost accounting for a run or the aggregate work item. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

/**
 * "How did it arrive at that answer?" — the auditable trail an external agent
 * reports back to GridFlow for a single execution.
 */
export interface Provenance {
  /** The exact prompt the agent was given. */
  prompt?: string;
  /** Context supplied alongside the prompt (resolved #refs, prior rows, etc.). */
  context?: string;
  filesRead?: FileRef[];
  filesModified?: FileRef[];
  toolCalls?: ToolCallRecord[];
  /** Names/ids of sub-agents this run spawned. */
  subAgents?: string[];
}

/** A dependency's output, captured as input context for a downstream run. */
export interface DependencyOutput {
  rowId: string;
  /** Human-readable title of the dependency row (its first text cell). */
  title?: string;
  /** The dependency's outputs at the moment this run started. */
  outputs?: string;
}

/**
 * The exact inputs a run was given, captured by the engine when the run opens.
 * This is what makes deterministic single-node replay possible: a failed node
 * can be re-dispatched with these inputs without re-running its upstream.
 */
export interface ResolvedInputs {
  /** The row's own inputs/prompt at the time the run started. */
  inputs?: string;
  /** Snapshot of each dependency's outputs at the time the run started. */
  dependencyOutputs?: DependencyOutput[];
}

/** One execution of a work item — the unit of replay and history. */
export interface ExecutionRun {
  id: string;
  status: WorkItemStatus;
  /** Agent that performed this run (e.g. "claude", "Explore"). */
  agent?: string;
  /** Model used (e.g. "claude-opus-4-8"). */
  model?: string;
  /** ISO timestamps. */
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  provenance?: Provenance;
  usage?: TokenUsage;
  logs?: LogEntry[];
  /** One-line outcome summary. */
  summary?: string;
  /**
   * The inputs this run was dispatched with — captured by GridFlow at run-open,
   * never reported by the agent. Enables replaying this exact node.
   */
  resolvedInputs?: ResolvedInputs;
}

/**
 * Everything a workflow row tracks. Human-authored fields (status, assignedAgent,
 * inputs) are edited in the UI; the rest are populated by whatever agent claims the
 * row and reports back through the cockpit protocol.
 */
/** A row is either ordinary work or an evaluation step that checks other rows. */
export type WorkItemRole = 'task' | 'verifier';

export interface WorkItem {
  status: WorkItemStatus;
  /** 'verifier' rows evaluate the workflow's outputs (drives pro auto-verification). Defaults to 'task'. */
  role?: WorkItemRole;
  /** Agent/sub-agent assigned to do the work (e.g. "Explore", "claude-code"). */
  assignedAgent?: string;
  /** Preferred model for this work item. */
  model?: string;
  /** Free-form / structured inputs handed to the agent. */
  inputs?: string;
  /** The result the agent produced. */
  outputs?: string;
  /**
   * Row ids this item depends on. A row is ready to run once every dependency is
   * `done`. Rows with no (incomplete) dependencies can run in parallel — this is what
   * turns the grid into a sub-agent orchestration DAG rather than a flat to-do list.
   */
  dependsOn?: string[];
  /** Evidence attached to the row: source files, logs, screenshots, test output. */
  files?: FileRef[];
  /** Aggregate token/cost accounting across runs. */
  usage?: TokenUsage;
  /** Execution history — most recent run last. Enables replay. */
  history?: ExecutionRun[];
  /** ISO timestamp of the last update. */
  updatedAt?: string;
}

export interface TemplateDef {
  id: string;
  name: string;
  description?: string;
  scope: 'builtin' | 'workspace' | 'global';
  /** 'workflow' templates open as AI work-item grids; defaults to 'data'. */
  kind?: GridKind;
  /** True when a built-in template has been hidden by the user. */
  hidden?: boolean;
  columns: ColumnDef[];
  /** Optional starter rows (without ids — webview will assign). */
  seedRows?: RowData[];
}

/* ------------------------------------------------------------------ */
/* Message protocol: webview ↔ extension                              */
/* ------------------------------------------------------------------ */

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'requestState' }
  | { type: 'updateState'; snapshot: GridSnapshot }
  | { type: 'requestTemplates' }
  | { type: 'applyTemplate'; templateId: string }
  | { type: 'saveTemplate'; name: string; description?: string; scope: 'workspace' | 'global'; columns: ColumnDef[]; seedRows?: RowData[] }
  | { type: 'deleteTemplate'; templateId: string }
  | { type: 'renameTemplate'; id: string; name: string; description?: string }
  | { type: 'openTemplateInGrid'; templateId: string }
  | { type: 'openTemplateManager' }
  | { type: 'hideBuiltin'; id: string }
  | { type: 'showBuiltin'; id: string }
  | { type: 'importCsvFile' }
  | { type: 'importCsvText'; text: string }
  | { type: 'exportCsv'; snapshot: GridSnapshot }
  | { type: 'exportWorkflowReport'; snapshot: GridSnapshot }
  | { type: 'openFilePicker' }
  | { type: 'sendToChat'; snapshot: GridSnapshot }
  | { type: 'showError'; message: string }
  | { type: 'showInfo'; message: string };

export type HostToWebview =
  | { type: 'init'; snapshot: GridSnapshot; mode: GridMode; canSendToChat: boolean; auditChain?: boolean }
  | { type: 'setSnapshot'; snapshot: GridSnapshot }
  | { type: 'templates'; templates: TemplateDef[] }
  | { type: 'csvParsed'; columns: ColumnDef[]; rows: Row[] }
  | { type: 'filePickerResult'; token: string | null }
  | { type: 'pendingChatInvocation'; pending: boolean }
  | { type: 'themeChanged' };

export type GridMode = 'standalone' | 'csv-editor' | 'lm-tool' | 'template-manager' | 'workflow';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

export function makeId(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function emptyWorkItem(): WorkItem {
  return { status: 'pending', updatedAt: new Date().toISOString() };
}

export function emptyRow(columns: ColumnDef[], kind: GridKind = 'data'): Row {
  const cells: RowData = {};
  for (const col of columns) {
    cells[col.id] = col.type === 'boolean' ? false : col.type === 'number' ? null : '';
  }
  const row: Row = { id: makeId('row'), cells };
  if (kind === 'workflow') row.work = emptyWorkItem();
  return row;
}
