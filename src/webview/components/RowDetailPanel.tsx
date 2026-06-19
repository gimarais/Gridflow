import { useEffect, useState } from 'react';
import { store, useStore } from '../store';
import {
  ColumnDef,
  ExecutionRun,
  FileRef,
  FileRefKind,
  FileVerification,
  Row,
  WORK_ITEM_STATUSES,
  WorkItem,
  WorkItemStatus,
} from '../../shared/types';
import { TERMINAL_STATUSES, fileRiskWarnings, wouldCreateCycle } from '../../shared/workflowCore';

/** Human-readable label + theme color hint for each status. */
const STATUS_META: Record<WorkItemStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--vscode-descriptionForeground, #888)' },
  queued: { label: 'Queued', color: 'var(--vscode-charts-blue, #3794ff)' },
  running: { label: 'Running', color: 'var(--vscode-charts-yellow, #cca700)' },
  blocked: { label: 'Blocked', color: 'var(--vscode-charts-orange, #d18616)' },
  done: { label: 'Done', color: 'var(--vscode-charts-green, #89d185)' },
  failed: { label: 'Failed', color: 'var(--vscode-errorForeground, #f48771)' },
  cancelled: { label: 'Cancelled', color: 'var(--vscode-descriptionForeground, #888)' },
};

export function statusMeta(status: WorkItemStatus) {
  return STATUS_META[status] ?? STATUS_META.pending;
}

const FILE_KINDS: FileRefKind[] = ['source', 'terminal', 'test', 'log', 'screenshot', 'other'];

/** Re-renders on an interval while `active` — used for live elapsed time on running rows. */
export function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active]);
  return now;
}

export function RowDetailPanel() {
  const expandedRowId = useStore((s) => s.expandedRowId);
  const snapshot = useStore((s) => s.snapshot);

  if (!expandedRowId) return null;
  const row = snapshot.rows.find((r) => r.id === expandedRowId);
  if (!row) return null;

  const rowIndex = snapshot.rows.findIndex((r) => r.id === row.id);
  const titleCol = snapshot.columns.find((c) => c.type === 'text') ?? snapshot.columns[0];
  const title = (titleCol && String(row.cells[titleCol.id] ?? '')) || `Row ${rowIndex + 1}`;
  const work: WorkItem = row.work ?? { status: 'pending' };

  // Pre-action gate: only meaningful for a row that hasn't completed yet.
  const riskWarnings = TERMINAL_STATUSES.has(work.status) ? [] : fileRiskWarnings(snapshot, row.id);

  return (
    <div className="detail-drawer" role="complementary" aria-label="Work item detail">
      <DetailHeader title={title} index={rowIndex} work={work} rowId={row.id} />
      <div className="detail-body">
        {riskWarnings.length > 0 && (
          <div className="risk-banner" role="alert">
            <span className="risk-icon" aria-hidden>⚠</span>
            <div>
              {riskWarnings.map((w, i) => (
                <div key={i} className="risk-line">{w}</div>
              ))}
            </div>
          </div>
        )}
        <SummaryStrip work={work} />
        <CoreFields rowId={row.id} work={work} />
        <DependenciesSection rowId={row.id} work={work} allRows={snapshot.rows} columns={snapshot.columns} />
        <FilesTouchedSection work={work} />
        <FilesSection rowId={row.id} work={work} />
        <HistorySection work={work} />
      </div>
    </div>
  );
}

function DetailHeader({ title, index, work, rowId }: { title: string; index: number; work: WorkItem; rowId: string }) {
  const meta = statusMeta(work.status);
  const isTerminal = TERMINAL_STATUSES.has(work.status);
  return (
    <div className="detail-header">
      <span className="status-dot" style={{ background: meta.color }} aria-hidden />
      <div className="detail-title" title={title}>
        <span className="detail-row-num">#{index + 1}</span> {title || 'Untitled work item'}
      </div>
      {isTerminal && (
        <button
          className="btn requeue-btn"
          title="Reset this task to pending (history is preserved) so the next orchestration pass re-runs it"
          onClick={() => store.updateWork(rowId, { status: 'pending' })}
        >
          ↻ Re-queue
        </button>
      )}
      <button
        className="btn icon detail-delete-btn"
        title="Delete row"
        onClick={() => { store.deleteRows([rowId]); store.collapseDetail(); }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M6 2v1H3v1h10V3h-3V2H6zM4 5v8a1 1 0 001 1h6a1 1 0 001-1V5H4zm2 1h1v6H6V6zm3 0h1v6H9V6z"/>
        </svg>
      </button>
      <button className="btn icon" title="Close" onClick={() => store.collapseDetail()}>
        ✕
      </button>
    </div>
  );
}

/** The headline transparency view: files / tools / sub-agents / tokens / duration at a glance. */
function SummaryStrip({ work }: { work: WorkItem }) {
  const last = work.history?.[work.history.length - 1];
  const agg = aggregateFiles(work);
  const toolCalls = work.history?.reduce((n, r) => n + (r.provenance?.toolCalls?.length ?? 0), 0) ?? 0;
  const subAgents = new Set<string>();
  for (const r of work.history ?? []) for (const a of r.provenance?.subAgents ?? []) subAgents.add(a);
  const tokens = work.usage?.totalTokens ?? sumTokens(work);

  // Live duration: closed runs sum as-is; an open running run ticks every second.
  const isRunning = work.status === 'running';
  const now = useNow(1000, isRunning);
  let duration = work.history?.reduce((n, r) => n + (r.durationMs ?? 0), 0) ?? 0;
  if (isRunning) {
    const open = (work.history ?? []).find((r) => r.startedAt && !r.finishedAt);
    if (open?.startedAt) {
      const elapsed = now - Date.parse(open.startedAt);
      if (Number.isFinite(elapsed) && elapsed > 0) duration += elapsed;
    }
  }

  const readVerified = agg.read.filter((f) => f.verification === 'verified').length;
  const modVerified = agg.modified.filter((f) => f.verification === 'verified').length;

  const stats: { label: string; value: string; title?: string }[] = [
    {
      label: 'Files read',
      value: String(agg.read.length),
      title: readVerified ? `${readVerified} of ${agg.read.length} verified by GridFlow` : undefined,
    },
    {
      label: 'Files modified',
      value: String(agg.modified.length),
      title: modVerified ? `${modVerified} of ${agg.modified.length} verified by GridFlow (mtime in run window)` : undefined,
    },
    { label: 'Tool calls', value: String(toolCalls) },
    { label: 'Sub-agents', value: String(subAgents.size) },
    {
      label: 'Tokens (est.)',
      value: tokens ? formatNumber(tokens) : '—',
      title: 'Estimated token usage reported by the agent. Best-effort — no assistant exposes exact counts to a tool, so treat this as an estimate, not a bill.',
    },
    { label: isRunning ? 'Duration (live)' : 'Duration', value: duration ? formatDuration(duration) : '—' },
  ];

  return (
    <div className="summary-grid summary-grid-6">
      {stats.map((s) => (
        <div key={s.label} className="summary-stat" title={s.title}>
          <div className="summary-value">{s.value}</div>
          <div className="summary-label">{s.label}</div>
        </div>
      ))}
      {!last && (
        <div className="summary-empty">
          No runs reported yet. As the assigned agent runs this task it reports duration, files touched, and tool calls back here.
        </div>
      )}
    </div>
  );
}

/**
 * Text input that keeps a local draft and commits on blur (or Cmd/Ctrl+Enter
 * for textareas) — committing per keystroke would post the full snapshot to
 * the host and trigger a debounced sidecar write on every character.
 */
function DraftInput({ value, placeholder, onCommit }: { value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  return (
    <input
      className="input"
      value={draft}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function DraftTextArea({ value, rows, placeholder, onCommit }: { value: string; rows: number; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  return (
    <textarea
      className="input textarea"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}

function CoreFields({ rowId, work }: { rowId: string; work: WorkItem }) {
  return (
    <section className="detail-section">
      <div className="field-row">
        <label className="field narrow">
          <span className="field-label">Status</span>
          <select
            className="input"
            value={work.status}
            onChange={(e) => store.updateWork(rowId, { status: e.target.value as WorkItemStatus })}
          >
            {WORK_ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>{statusMeta(s).label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Assigned agent</span>
          <DraftInput
            value={work.assignedAgent ?? ''}
            placeholder="e.g. Explore, general-purpose"
            onCommit={(v) => store.updateWork(rowId, { assignedAgent: v })}
          />
        </label>
        <label className="field">
          <span className="field-label">Model</span>
          <DraftInput
            value={work.model ?? ''}
            placeholder="e.g. claude-opus-4-8"
            onCommit={(v) => store.updateWork(rowId, { model: v })}
          />
        </label>
        <label className="field narrow">
          <span className="field-label">Role</span>
          <select
            className="input"
            value={work.role ?? 'task'}
            title="A 'verifier' row evaluates the workflow's outputs — GridFlow Pro can auto-verify and replan from it"
            onChange={(e) => store.updateWork(rowId, { role: e.target.value === 'verifier' ? 'verifier' : undefined })}
          >
            <option value="task">Task</option>
            <option value="verifier">Verifier</option>
          </select>
        </label>
      </div>
      <label className="field block">
        <span className="field-label">Inputs / prompt</span>
        <DraftTextArea
          rows={3}
          value={work.inputs ?? ''}
          placeholder="What the agent is given to work with"
          onCommit={(v) => store.updateWork(rowId, { inputs: v })}
        />
      </label>
      <label className="field block">
        <span className="field-label">Outputs / result</span>
        <DraftTextArea
          rows={3}
          value={work.outputs ?? ''}
          placeholder="The result the agent produced (or report back via the protocol)"
          onCommit={(v) => store.updateWork(rowId, { outputs: v })}
        />
      </label>
    </section>
  );
}

/** Shows and edits the DAG edges for this row: which tasks must finish before it can run. */
function DependenciesSection({ rowId, work, allRows, columns }: { rowId: string; work: WorkItem; allRows: Row[]; columns: ColumnDef[] }) {
  const deps = work.dependsOn ?? [];
  const titleCol = columns.find((c) => c.type === 'text') ?? columns[0];
  const indexById = new Map(allRows.map((r, i) => [r.id, i]));
  const labelFor = (r: Row) =>
    (titleCol && String(r.cells[titleCol.id] ?? '')) || `Row ${(indexById.get(r.id) ?? 0) + 1}`;

  // Cycle-safe candidates: exclude self, existing deps, and rows whose addition
  // would close a dependency cycle.
  const depGraph = new Map<string, string[]>(
    allRows.map((r) => [r.id, r.id === rowId ? [...deps] : [...(r.work?.dependsOn ?? [])]]),
  );
  const candidates = allRows.filter(
    (r) => r.id !== rowId && !deps.includes(r.id) && !wouldCreateCycle(depGraph, rowId, r.id),
  );

  const addDep = (id: string) => {
    if (!id) return;
    store.updateWork(rowId, { dependsOn: [...deps, id] });
  };
  const removeDep = (id: string) => {
    const next = deps.filter((d) => d !== id);
    store.updateWork(rowId, { dependsOn: next.length ? next : undefined });
  };

  const allDone = deps.every((d) => allRows.find((r) => r.id === d)?.work?.status === 'done');
  return (
    <section className="detail-section">
      <h4 className="section-title">
        Dependencies{' '}
        {deps.length > 0 && (allDone ? <span className="dep-ready">ready</span> : <span className="dep-waiting">waiting</span>)}
      </h4>
      {deps.length === 0 && (
        <div className="muted small">None — this task can run in parallel with other independent tasks.</div>
      )}
      <ul className="dep-list">
        {deps.map((d) => {
          const dep = allRows.find((r) => r.id === d);
          const status = dep?.work?.status ?? 'pending';
          const meta = statusMeta(status);
          const idx = indexById.get(d);
          // Edge-state propagation: a done dependency's output flows into this
          // row's inputs, so show a short preview of what it produced.
          const depOutput = status === 'done' ? dep?.work?.outputs : undefined;
          return (
            <li key={d} className="dep-item">
              <span className="status-dot" style={{ background: meta.color }} aria-hidden />
              <span className="dep-num">#{idx != null ? idx + 1 : '?'}</span>
              <span
                className="file-path dep-link"
                onClick={() => dep && store.expandRow(dep.id)}
                title={dep ? 'Open this task' : 'Row no longer exists'}
              >
                {dep ? labelFor(dep) || 'Untitled' : `${d} (deleted)`}
              </span>
              <span className="muted small">{meta.label}</span>
              <button className="btn icon" title="Remove dependency" onClick={() => removeDep(d)}>✕</button>
              {depOutput && (
                <div className="dep-output" title={depOutput}>↳ {depOutput.slice(0, 140)}{depOutput.length > 140 ? '…' : ''}</div>
              )}
            </li>
          );
        })}
      </ul>
      {candidates.length > 0 && (
        <select className="input dep-add" value="" onChange={(e) => addDep(e.target.value)}>
          <option value="">+ Add dependency…</option>
          {candidates.map((r) => (
            <option key={r.id} value={r.id}>
              #{(indexById.get(r.id) ?? 0) + 1} {labelFor(r)}
            </option>
          ))}
        </select>
      )}
    </section>
  );
}

function VerificationTag({ verification }: { verification?: FileVerification }) {
  if (!verification) return null;
  const meta = {
    verified: { text: '✓', cls: 'tag-verified', title: 'Verified by GridFlow (file exists; modifications checked against the run window)' },
    unverified: { text: '?', cls: 'tag-unverified', title: 'Reported by the agent but GridFlow could not confirm the change' },
    missing: { text: '✗', cls: 'tag-missing', title: 'Reported by the agent but the file was not found' },
  }[verification];
  return <span className={`tag tag-verification ${meta.cls}`} title={meta.title}>{meta.text}</span>;
}

/** The extensive list of files the agent actually read / wrote, aggregated across runs. */
function FilesTouchedSection({ work }: { work: WorkItem }) {
  const agg = aggregateFiles(work);
  if (agg.read.length === 0 && agg.modified.length === 0) {
    return (
      <section className="detail-section">
        <h4 className="section-title">Files touched</h4>
        <div className="muted small">
          None reported yet. The agent reports files it reads and writes via updateRow as it works.
        </div>
      </section>
    );
  }
  return (
    <section className="detail-section">
      <h4 className="section-title">Files touched</h4>
      {agg.modified.length > 0 && <FileGroup label="Modified / created" files={agg.modified} change="modified" />}
      {agg.read.length > 0 && <FileGroup label="Read" files={agg.read} change="read" />}
    </section>
  );
}

function FileGroup({ label, files, change }: { label: string; files: FileRef[]; change: 'read' | 'modified' }) {
  return (
    <div className="prov-block">
      <div className="prov-label">
        {label} ({files.length})
      </div>
      <ul className="file-list compact">
        {files.map((f, i) => (
          <li key={`${f.path}-${i}`} className="file-item">
            <span className={`tag tag-change tag-${change}`}>{change === 'modified' ? 'write' : 'read'}</span>
            <VerificationTag verification={f.verification} />
            <span className="file-path" title={f.path}>{f.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesSection({ rowId, work }: { rowId: string; work: WorkItem }) {
  const [path, setPath] = useState('');
  const [kind, setKind] = useState<FileRefKind>('source');
  const files = work.files ?? [];

  const add = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    store.updateWork(rowId, { files: [...files, { path: trimmed, kind }] });
    setPath('');
  };

  const remove = (i: number) => {
    store.updateWork(rowId, { files: files.filter((_, idx) => idx !== i) });
  };

  return (
    <section className="detail-section">
      <h4 className="section-title">Attachments &amp; evidence</h4>
      {files.length === 0 && <div className="muted small">No manual attachments. (Files the agent touched appear under “Files touched” above.)</div>}
      <ul className="file-list">
        {files.map((f, i) => (
          <li key={`${f.path}-${i}`} className="file-item">
            <span className={`tag tag-${f.kind ?? 'other'}`}>{f.kind ?? 'file'}</span>
            {f.change && <span className={`tag tag-change tag-${f.change}`}>{f.change}</span>}
            <span className="file-path" title={f.path}>
              {f.path}
            </span>
            <button className="btn icon" title="Remove" onClick={() => remove(i)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="file-add">
        <select className="input narrow" value={kind} onChange={(e) => setKind(e.target.value as FileRefKind)}>
          {FILE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={path}
          placeholder="path/to/file or evidence"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn" onClick={add} disabled={!path.trim()}>
          Attach
        </button>
      </div>
    </section>
  );
}

function HistorySection({ work }: { work: WorkItem }) {
  const history = work.history ?? [];
  return (
    <section className="detail-section">
      <h4 className="section-title">Execution history</h4>
      {history.length === 0 && (
        <div className="muted small">
          No runs yet. Replay and re-run land here once a row has been executed.
        </div>
      )}
      <ol className="run-list">
        {history.map((run, i) => (
          <RunRow key={run.id} run={run} index={i} />
        ))}
      </ol>
    </section>
  );
}

/** Always-visible metrics for a run, so duration/tokens/cost are surfaced even when partial. */
function RunMetrics({ run }: { run: ExecutionRun }) {
  const u = run.usage;
  const inTok = u?.inputTokens;
  const outTok = u?.outputTokens;
  const totalTok = u?.totalTokens ?? ((inTok ?? 0) + (outTok ?? 0) || undefined);
  const tokenText = inTok != null || outTok != null
    ? `${formatNumber(inTok ?? 0)} → ${formatNumber(outTok ?? 0)}`
    : totalTok != null ? formatNumber(totalTok) : '—';
  const stats: { label: string; value: string }[] = [
    { label: 'Status', value: statusMeta(run.status).label },
    { label: 'Duration', value: run.durationMs != null ? formatDuration(run.durationMs) : '—' },
    { label: 'Tokens (in→out, est.)', value: tokenText },
    { label: 'Cost (est.)', value: u?.costUsd ? `$${u.costUsd.toFixed(4)}` : '—' },
    { label: 'Tool calls', value: String(run.provenance?.toolCalls?.length ?? 0) },
    { label: 'Files', value: String((run.provenance?.filesRead?.length ?? 0) + (run.provenance?.filesModified?.length ?? 0)) },
  ];
  return (
    <div className="run-metrics">
      {stats.map((s) => (
        <div key={s.label} className="run-metric">
          <span className="run-metric-label">{s.label}</span>
          <span className="run-metric-value">{s.value}</span>
        </div>
      ))}
    </div>
  );
}

function RunRow({ run, index }: { run: ExecutionRun; index: number }) {
  const [open, setOpen] = useState(false);
  const meta = statusMeta(run.status);
  const p = run.provenance;
  return (
    <li className="run-item">
      <button className="run-head" onClick={() => setOpen((v) => !v)}>
        <span className="status-dot" style={{ background: meta.color }} aria-hidden />
        <span className="run-title">Run {index + 1}</span>
        <span className="muted small">{run.agent ?? 'agent'}{run.model ? ` · ${run.model}` : ''}</span>
        <span className="spacer" />
        <span className="muted small">{run.durationMs != null ? formatDuration(run.durationMs) : '—'}</span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="run-detail">
          <RunMetrics run={run} />
          {run.summary && <div className="run-summary">{run.summary}</div>}
          {run.resolvedInputs && <ResolvedInputsBlock resolved={run.resolvedInputs} />}
          {p?.prompt && <ProvenanceBlock label="Prompt" text={p.prompt} />}
          {p?.context && <ProvenanceBlock label="Context" text={p.context} />}
          {!!p?.filesRead?.length && <FileRefList label="Files read" files={p.filesRead} />}
          {!!p?.filesModified?.length && <FileRefList label="Files modified" files={p.filesModified} />}
          {!!p?.toolCalls?.length && (
            <div className="prov-block">
              <div className="prov-label">Tool calls ({p.toolCalls.length})</div>
              <ul className="tool-list">
                {p.toolCalls.map((t, i) => (
                  <li key={i} className="muted small">
                    {t.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!run.logs?.length && (
            <div className="prov-block">
              <div className="prov-label">Logs</div>
              <pre className="log-block">
                {run.logs.map((l) => `${l.level ?? 'info'}: ${l.message}`).join('\n')}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The exact inputs the engine captured for this run — what a replay re-runs with. */
function ResolvedInputsBlock({ resolved }: { resolved: NonNullable<ExecutionRun['resolvedInputs']> }) {
  const deps = resolved.dependencyOutputs ?? [];
  if (!resolved.inputs && deps.length === 0) return null;
  return (
    <div className="prov-block">
      <div className="prov-label" title="Captured by GridFlow when this run started — replaying re-runs the node with exactly these inputs">
        Resolved inputs (captured for replay)
      </div>
      {resolved.inputs && <pre className="log-block">{resolved.inputs}</pre>}
      {deps.length > 0 && (
        <ul className="file-list compact">
          {deps.map((d, i) => (
            <li key={`${d.rowId}-${i}`} className="muted small">
              <span className="tag">dep</span>{' '}
              {d.title ?? d.rowId}{d.outputs ? `: ${d.outputs.slice(0, 120)}${d.outputs.length > 120 ? '…' : ''}` : ' (no output)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProvenanceBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="prov-block">
      <div className="prov-label">{label}</div>
      <pre className="log-block">{text}</pre>
    </div>
  );
}

function FileRefList({ label, files }: { label: string; files: FileRef[] }) {
  return (
    <div className="prov-block">
      <div className="prov-label">
        {label} ({files.length})
      </div>
      <ul className="file-list compact">
        {files.map((f, i) => (
          <li key={`${f.path}-${i}`} className="file-item">
            <VerificationTag verification={f.verification} />
            <span className="muted small file-path" title={f.path}>{f.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------- helpers -------------------------------- */

/**
 * De-duplicated file refs read and modified across every run. Later runs win
 * so the verification label always reflects the most recent check.
 */
function aggregateFiles(work: WorkItem): { read: FileRef[]; modified: FileRef[] } {
  const read = new Map<string, FileRef>();
  const modified = new Map<string, FileRef>();
  for (const r of work.history ?? []) {
    for (const f of r.provenance?.filesRead ?? []) if (f.path) read.set(f.path, f);
    for (const f of r.provenance?.filesModified ?? []) if (f.path) modified.set(f.path, f);
  }
  // A file that was both read and written counts as modified only.
  for (const p of modified.keys()) read.delete(p);
  return { read: [...read.values()], modified: [...modified.values()] };
}

function sumTokens(work: WorkItem): number {
  return (work.history ?? []).reduce(
    (n, r) => n + (r.usage?.totalTokens ?? (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)),
    0,
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

/** Small status badge used in the grid's workflow status column. */
export function StatusBadge({ row, onClick }: { row: Row; onClick: () => void }) {
  const status = row.work?.status ?? 'pending';
  const meta = statusMeta(status);
  return (
    <button className="status-badge" onClick={onClick} title="Open work-item detail">
      <span className="status-dot" style={{ background: meta.color }} aria-hidden />
      {meta.label}
    </button>
  );
}
