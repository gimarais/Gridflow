import { useState } from 'react';
import { store, useStore } from './store';
import { Toolbar } from './components/Toolbar';
import { Grid } from './components/Grid';
import { RowDetailPanel, useNow } from './components/RowDetailPanel';
import { TemplateManagerApp } from './TemplateManager';
import { budgetStatus, criticalPath, workflowStats } from '../shared/workflowCore';
import type { GridSnapshot } from '../shared/types';

export function App() {
  const initialized = useStore((s) => s.initialized);
  const mode = useStore((s) => s.mode);
  const snapshot = useStore((s) => s.snapshot);
  const pendingChat = useStore((s) => s.pendingChatInvocation);
  const auditChain = useStore((s) => s.auditChain);

  if (!initialized) {
    return <div className="empty-state">Loading…</div>;
  }

  if (mode === 'template-manager') {
    return <TemplateManagerApp />;
  }

  const isWorkflow = snapshot.kind === 'workflow' || mode === 'workflow';

  return (
    <div className="app">
      <Toolbar />
      {isWorkflow && snapshot.rows.length > 0 && <WorkflowSummaryBar snapshot={snapshot} auditChain={auditChain} />}
      {pendingChat && (
        <div className="waiting-bar">
          <span className="waiting-dot" aria-hidden />
          {isWorkflow ? (
            <span>
              An agent is waiting. Assign an agent &amp; inputs to each row in its detail drawer, then click{' '}
              <strong>Start Workflow ▸</strong> to hand it back so it can orchestrate.
            </span>
          ) : (
            <span>
              An agent is waiting for your input. Fill in the grid, then click <strong>Send to Chat ▸</strong>.
            </span>
          )}
        </div>
      )}
      {snapshot.instructions && (
        <div className="instructions-bar">{snapshot.instructions}</div>
      )}
      <div className="work-area">
        <Grid />
        <RowDetailPanel />
      </div>
      <StatusBar rowCount={snapshot.rows.length} colCount={snapshot.columns.length} />
    </div>
  );
}

/** The cockpit header: progress, running count, and est. totals at a glance. */
function WorkflowSummaryBar({ snapshot, auditChain }: { snapshot: GridSnapshot; auditChain: boolean }) {
  // Tick every second while anything is running so the durations below stay live —
  // GridFlow measures these itself rather than relying on agent-reported numbers.
  const isRunning = snapshot.rows.some((r) => r.work?.status === 'running');
  const now = useNow(1000, isRunning);
  const stats = workflowStats(snapshot, now);
  const cp = criticalPath(snapshot);
  const pct = stats.total ? Math.round((100 * stats.done) / stats.total) : 0;
  return (
    <div className="workflow-summary-bar" role="status">
      <div className="ws-progress" title={`${stats.done} of ${stats.total} tasks done`}>
        <div className="ws-progress-track">
          <div className="ws-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="ws-progress-label">{stats.done}/{stats.total} done</span>
      </div>
      {stats.running > 0 && <span className="ws-chip ws-running">{stats.running} running</span>}
      {stats.failed > 0 && <span className="ws-chip ws-failed">{stats.failed} failed</span>}
      {auditChain && (
        <span className="ws-chip ws-audit" title="Every update is recorded in a tamper-evident, hash-chained audit trail (IETF AAT)">
          🔒 audit chain
        </span>
      )}
      <BudgetControl snapshot={snapshot} />
      <span className="spacer" />
      <span className="ws-metric" title="Estimated tokens reported by agents across all rows">
        {stats.totalTokens ? `${stats.totalTokens.toLocaleString()} tok (est.)` : ''}
      </span>
      <span className="ws-metric" title="Estimated cost across all rows">
        {stats.totalCostUsd ? `$${stats.totalCostUsd.toFixed(4)} (est.)` : ''}
      </span>
      <span className="ws-metric" title="Actual time elapsed (parallel runs overlap, so this can be less than the agent time below)">
        {stats.wallClockDurationMs ? `${formatDuration(stats.wallClockDurationMs)} wall-clock` : ''}
      </span>
      <span className="ws-metric" title="Total agent time if every run happened one after another (sum of all runs)">
        {stats.totalDurationMs ? `Σ ${formatDuration(stats.totalDurationMs)} agent time` : ''}
      </span>
      <span className="ws-metric" title="Longest dependency chain by duration — the bottleneck that bounds how fast the workflow can finish">
        {cp.rowIds.length > 1 && cp.durationMs ? `▲ ${formatDuration(cp.durationMs)} critical path` : ''}
      </span>
    </div>
  );
}

/** Budget meter + inline editor: shows spend vs. cap and halts dispatch when exceeded. */
function BudgetControl({ snapshot }: { snapshot: GridSnapshot }) {
  const [editing, setEditing] = useState(false);
  const [cost, setCost] = useState(snapshot.budget?.maxCostUsd != null ? String(snapshot.budget.maxCostUsd) : '');
  const [tokens, setTokens] = useState(snapshot.budget?.maxTokens != null ? String(snapshot.budget.maxTokens) : '');
  const status = budgetStatus(snapshot);

  function save() {
    const c = parseFloat(cost);
    const t = parseFloat(tokens);
    store.setBudget({
      maxCostUsd: Number.isFinite(c) && c > 0 ? c : undefined,
      maxTokens: Number.isFinite(t) && t > 0 ? t : undefined,
    });
    setEditing(false);
  }
  function clear() {
    store.setBudget({});
    setCost('');
    setTokens('');
    setEditing(false);
  }

  if (editing) {
    return (
      <span className="ws-budget-edit">
        <span className="ws-budget-label">Budget</span>
        <input className="input" type="number" min="0" step="0.01" placeholder="$ cap" value={cost}
          onChange={(e) => setCost(e.target.value)} title="Max cost (USD)" />
        <input className="input" type="number" min="0" step="1000" placeholder="tok cap" value={tokens}
          onChange={(e) => setTokens(e.target.value)} title="Max tokens" />
        <button className="btn" onClick={save}>Save</button>
        <button className="btn secondary" onClick={clear}>Clear</button>
      </span>
    );
  }

  if (!snapshot.budget) {
    return <button className="btn ws-budget-add" title="Set a token/cost cap that halts dispatch when exceeded" onClick={() => setEditing(true)}>+ Budget</button>;
  }
  const parts: string[] = [];
  if (status.maxCostUsd != null) parts.push(`$${status.costUsed.toFixed(2)} / $${status.maxCostUsd.toFixed(2)}`);
  if (status.maxTokens != null) parts.push(`${status.tokensUsed.toLocaleString()} / ${status.maxTokens.toLocaleString()} tok`);
  return (
    <button
      className={`btn ws-budget-chip${status.exceeded ? ' ws-budget-exceeded' : ''}`}
      title={status.exceeded ? 'Budget spent — dispatch halted until you raise the cap' : 'Workflow budget — click to edit'}
      onClick={() => setEditing(true)}
    >
      {status.exceeded ? '⛔ ' : '◷ '}{parts.join(' · ')}
    </button>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function StatusBar({ rowCount, colCount }: { rowCount: number; colCount: number }) {
  return (
    <div className="status-bar">
      <span>
        {rowCount} {rowCount === 1 ? 'row' : 'rows'} · {colCount} {colCount === 1 ? 'column' : 'columns'}
      </span>
      <span className="spacer" />
      <span style={{ opacity: 0.7 }}>Tab/Enter to move · # in a cell to pick files</span>
    </div>
  );
}
