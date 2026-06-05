import { useStore } from './store';
import { Toolbar } from './components/Toolbar';
import { Grid } from './components/Grid';
import { RowDetailPanel } from './components/RowDetailPanel';
import { TemplateManagerApp } from './TemplateManager';

export function App() {
  const initialized = useStore((s) => s.initialized);
  const mode = useStore((s) => s.mode);
  const snapshot = useStore((s) => s.snapshot);
  const pendingChat = useStore((s) => s.pendingChatInvocation);

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
