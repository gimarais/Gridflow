/**
 * Sanitization for everything that crosses a trust boundary into GridFlow:
 * workflow sidecar files read from the workspace (a cloned repo may contain a
 * hostile or hand-mangled `.gridflow/*.json`), workspace template files, and
 * MCP/LM-tool payloads from agents. Keep this file free of `vscode` imports —
 * it is shared by the extension host, the webview bundle, and the CLI.
 */
import {
  ColumnDef,
  ColumnType,
  DependencyOutput,
  ExecutionRun,
  FileRef,
  GridSnapshot,
  LogEntry,
  Provenance,
  ResolvedInputs,
  Row,
  RowData,
  TokenUsage,
  ToolCallRecord,
  WORK_ITEM_STATUSES,
  WorkItem,
  WorkItemStatus,
  makeId,
} from './types';

/* Size caps. Generous for real use, small enough that a malicious or runaway
 * agent cannot balloon the sidecar file or freeze the webview. */
export const MAX_CELL_CHARS = 200_000;
export const MAX_TEXT_CHARS = 1_000_000; // inputs / outputs / prompt / context
export const MAX_SHORT_CHARS = 2_000; // names, summaries, notes, paths
export const MAX_FILE_REFS = 500; // per list, per run
export const MAX_TOOL_CALLS = 200; // per run
export const MAX_LOGS = 500; // per run
export const MAX_RUNS = 100; // history entries per row
export const MAX_ROWS = 5_000;
export const MAX_COLUMNS = 100;
export const MAX_OPTIONS = 200;

const COLUMN_TYPES: ColumnType[] = ['text', 'select', 'number', 'boolean'];
const STATUS_SET = new Set<string>(WORK_ITEM_STATUSES);

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function asString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? truncate(v, max) : undefined;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function sanitizeStatus(v: unknown, fallback: WorkItemStatus = 'pending'): WorkItemStatus {
  return typeof v === 'string' && STATUS_SET.has(v) ? (v as WorkItemStatus) : fallback;
}

export function isValidStatus(v: unknown): v is WorkItemStatus {
  return typeof v === 'string' && STATUS_SET.has(v);
}

export function sanitizeUsage(v: unknown): TokenUsage | undefined {
  if (!isObject(v)) return undefined;
  const usage: TokenUsage = {
    inputTokens: asFiniteNumber(v.inputTokens),
    outputTokens: asFiniteNumber(v.outputTokens),
    totalTokens: asFiniteNumber(v.totalTokens),
    costUsd: asFiniteNumber(v.costUsd),
  };
  return usage.inputTokens ?? usage.outputTokens ?? usage.totalTokens ?? usage.costUsd
    ? usage
    : undefined;
}

const FILE_REF_KINDS = new Set(['source', 'terminal', 'test', 'log', 'screenshot', 'other']);
const FILE_CHANGES = new Set(['read', 'modified', 'created', 'deleted']);
const VERIFICATIONS = new Set(['verified', 'unverified', 'missing']);

export function sanitizeFileRefs(v: unknown, max = MAX_FILE_REFS): FileRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FileRef[] = [];
  for (const item of v.slice(0, max)) {
    // Agents sometimes report bare path strings instead of {path} objects.
    if (typeof item === 'string') {
      out.push({ path: truncate(item, MAX_SHORT_CHARS) });
      continue;
    }
    if (!isObject(item)) continue;
    const path = asString(item.path, MAX_SHORT_CHARS);
    if (!path) continue;
    const ref: FileRef = { path };
    if (typeof item.kind === 'string' && FILE_REF_KINDS.has(item.kind)) ref.kind = item.kind as FileRef['kind'];
    if (typeof item.change === 'string' && FILE_CHANGES.has(item.change)) ref.change = item.change as FileRef['change'];
    if (typeof item.verification === 'string' && VERIFICATIONS.has(item.verification)) {
      ref.verification = item.verification as FileRef['verification'];
    }
    const note = asString(item.note, MAX_SHORT_CHARS);
    if (note) ref.note = note;
    out.push(ref);
  }
  return out.length ? out : undefined;
}

export function sanitizeProvenance(v: unknown): Provenance | undefined {
  if (!isObject(v)) return undefined;
  const toolCalls: ToolCallRecord[] = [];
  if (Array.isArray(v.toolCalls)) {
    for (const item of v.toolCalls.slice(0, MAX_TOOL_CALLS)) {
      if (typeof item === 'string') {
        toolCalls.push({ name: truncate(item, MAX_SHORT_CHARS) });
        continue;
      }
      if (!isObject(item)) continue;
      const name = asString(item.name, MAX_SHORT_CHARS);
      if (!name) continue;
      toolCalls.push({
        name,
        input: asString(item.input, MAX_SHORT_CHARS),
        output: asString(item.output, MAX_SHORT_CHARS),
        at: asString(item.at, 64),
      });
    }
  }
  const subAgents = Array.isArray(v.subAgents)
    ? v.subAgents.filter((s): s is string => typeof s === 'string').map((s) => truncate(s, MAX_SHORT_CHARS)).slice(0, 100)
    : undefined;
  const p: Provenance = {
    prompt: asString(v.prompt, MAX_TEXT_CHARS),
    context: asString(v.context, MAX_TEXT_CHARS),
    filesRead: sanitizeFileRefs(v.filesRead),
    filesModified: sanitizeFileRefs(v.filesModified),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    subAgents: subAgents?.length ? subAgents : undefined,
  };
  return p.prompt || p.context || p.filesRead || p.filesModified || p.toolCalls || p.subAgents
    ? p
    : undefined;
}

export function sanitizeLogs(v: unknown): LogEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const levels = new Set(['debug', 'info', 'warn', 'error']);
  const out: LogEntry[] = [];
  for (const item of v.slice(0, MAX_LOGS)) {
    if (!isObject(item)) continue;
    const message = asString(item.message, MAX_SHORT_CHARS * 5);
    if (!message) continue;
    out.push({
      at: asString(item.at, 64) ?? new Date().toISOString(),
      level: typeof item.level === 'string' && levels.has(item.level) ? (item.level as LogEntry['level']) : undefined,
      message,
    });
  }
  return out.length ? out : undefined;
}

function sanitizeResolvedInputs(v: unknown): ResolvedInputs | undefined {
  if (!isObject(v)) return undefined;
  const depOut = Array.isArray(v.dependencyOutputs)
    ? v.dependencyOutputs
        .filter(isObject)
        .map((d): DependencyOutput | undefined => {
          const rowId = asString(d.rowId, 64);
          if (!rowId) return undefined;
          return {
            rowId,
            title: asString(d.title, MAX_SHORT_CHARS),
            outputs: asString(d.outputs, MAX_TEXT_CHARS),
          };
        })
        .filter((d): d is DependencyOutput => !!d)
        .slice(0, MAX_FILE_REFS)
    : undefined;
  const inputs = asString(v.inputs, MAX_TEXT_CHARS);
  if (!inputs && !depOut?.length) return undefined;
  return { inputs, dependencyOutputs: depOut?.length ? depOut : undefined };
}

function sanitizeRun(v: unknown): ExecutionRun | undefined {
  if (!isObject(v)) return undefined;
  return {
    id: asString(v.id, 64) ?? makeId('run'),
    status: sanitizeStatus(v.status),
    agent: asString(v.agent, MAX_SHORT_CHARS),
    model: asString(v.model, MAX_SHORT_CHARS),
    startedAt: asString(v.startedAt, 64),
    finishedAt: asString(v.finishedAt, 64),
    durationMs: asFiniteNumber(v.durationMs),
    provenance: sanitizeProvenance(v.provenance),
    usage: sanitizeUsage(v.usage),
    logs: sanitizeLogs(v.logs),
    summary: asString(v.summary, MAX_SHORT_CHARS),
    resolvedInputs: sanitizeResolvedInputs(v.resolvedInputs),
  };
}

export function sanitizeWorkItem(v: unknown): WorkItem | undefined {
  if (!isObject(v)) return undefined;
  const dependsOn = Array.isArray(v.dependsOn)
    ? v.dependsOn.filter((d): d is string => typeof d === 'string').map((d) => truncate(d, 64))
    : undefined;
  const history = Array.isArray(v.history)
    ? v.history.slice(-MAX_RUNS).map(sanitizeRun).filter((r): r is ExecutionRun => !!r)
    : undefined;
  return {
    status: sanitizeStatus(v.status),
    role: v.role === 'verifier' ? 'verifier' : undefined,
    assignedAgent: asString(v.assignedAgent, MAX_SHORT_CHARS),
    model: asString(v.model, MAX_SHORT_CHARS),
    inputs: asString(v.inputs, MAX_TEXT_CHARS),
    outputs: asString(v.outputs, MAX_TEXT_CHARS),
    dependsOn: dependsOn?.length ? dependsOn : undefined,
    files: sanitizeFileRefs(v.files),
    usage: sanitizeUsage(v.usage),
    history: history?.length ? history : undefined,
    updatedAt: asString(v.updatedAt, 64),
  };
}

function sanitizeCellValue(v: unknown): string | number | boolean | null {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return truncate(v, MAX_CELL_CHARS);
  return '';
}

function sanitizeColumn(v: unknown, index: number): ColumnDef | undefined {
  if (!isObject(v)) return undefined;
  const name = asString(v.name, MAX_SHORT_CHARS) || `Column ${index + 1}`;
  const type = typeof v.type === 'string' && COLUMN_TYPES.includes(v.type as ColumnType)
    ? (v.type as ColumnType)
    : 'text';
  const col: ColumnDef = { id: asString(v.id, 64) ?? makeId('col'), name, type };
  if (type === 'select') {
    col.options = Array.isArray(v.options)
      ? v.options.filter((o): o is string => typeof o === 'string').map((o) => truncate(o, MAX_SHORT_CHARS)).slice(0, MAX_OPTIONS)
      : [];
  }
  const placeholder = asString(v.placeholder, MAX_SHORT_CHARS);
  if (placeholder) col.placeholder = placeholder;
  const width = asFiniteNumber(v.width);
  if (width && width > 0) col.width = Math.min(width, 4000);
  return col;
}

function sanitizeRow(v: unknown, columns: ColumnDef[], workflow: boolean): Row | undefined {
  if (!isObject(v)) return undefined;
  const cells: RowData = {};
  const rawCells = isObject(v.cells) ? v.cells : {};
  for (const col of columns) {
    cells[col.id] = sanitizeCellValue(rawCells[col.id]);
  }
  const row: Row = { id: asString(v.id, 64) ?? makeId('row'), cells };
  if (workflow) {
    row.work = sanitizeWorkItem(v.work) ?? { status: 'pending' };
  }
  return row;
}

/**
 * Validate and clamp an untrusted GridSnapshot-shaped value. Returns undefined
 * when the input is not even snapshot-shaped (caller treats the file as absent
 * or corrupt) — never throws.
 */
export function sanitizeSnapshot(raw: unknown): GridSnapshot | undefined {
  if (!isObject(raw)) return undefined;
  if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return undefined;

  const kind = raw.kind === 'workflow' ? 'workflow' : raw.kind === 'data' ? 'data' : undefined;
  const columns = raw.columns
    .slice(0, MAX_COLUMNS)
    .map((c, i) => sanitizeColumn(c, i))
    .filter((c): c is ColumnDef => !!c);
  // Drop duplicate column ids — they break cell addressing and React keys.
  const seen = new Set<string>();
  const dedupedColumns = columns.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  const seenRows = new Set<string>();
  const rows = raw.rows
    .slice(0, MAX_ROWS)
    .map((r) => sanitizeRow(r, dedupedColumns, kind === 'workflow'))
    .filter((r): r is Row => !!r)
    .filter((r) => (seenRows.has(r.id) ? false : (seenRows.add(r.id), true)));

  const snapshot: GridSnapshot = { columns: dedupedColumns, rows };
  const title = asString(raw.title, MAX_SHORT_CHARS);
  if (title) snapshot.title = title;
  const instructions = asString(raw.instructions, MAX_SHORT_CHARS * 5);
  if (instructions) snapshot.instructions = instructions;
  if (kind) snapshot.kind = kind;
  if (isObject(raw.budget)) {
    const maxTokens = asFiniteNumber(raw.budget.maxTokens);
    const maxCostUsd = asFiniteNumber(raw.budget.maxCostUsd);
    const budget: { maxTokens?: number; maxCostUsd?: number } = {};
    if (maxTokens != null && maxTokens > 0) budget.maxTokens = maxTokens;
    if (maxCostUsd != null && maxCostUsd > 0) budget.maxCostUsd = maxCostUsd;
    if (budget.maxTokens != null || budget.maxCostUsd != null) snapshot.budget = budget;
  }
  return snapshot;
}
