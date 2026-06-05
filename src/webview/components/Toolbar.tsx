import { useRef, useState } from 'react';
import { store, useStore } from '../store';
import { post } from '../vscode';
import { WORK_ITEM_STATUSES, WorkItemStatus } from '../../shared/types';
import { Menu, MenuItem } from './Menu';

export function Toolbar() {
  const snapshot = useStore((s) => s.snapshot);
  const templates = useStore((s) => s.templates);
  const canSendToChat = useStore((s) => s.canSendToChat);
  const selectedRowIds = useStore((s) => s.selectedRowIds);
  const mode = useStore((s) => s.mode);
  const pendingChat = useStore((s) => s.pendingChatInvocation);
  const statusFilter = useStore((s) => s.statusFilter);
  const isWorkflow = snapshot.kind === 'workflow' || mode === 'workflow';

  const statusCounts: Partial<Record<WorkItemStatus, number>> = {};
  if (isWorkflow) {
    for (const row of snapshot.rows) {
      const s = row.work?.status ?? 'pending';
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    }
  }
  // In workflow mode the submit button is only meaningful while an agent is waiting;
  // after "Start Workflow" the grid becomes a live dashboard the agent updates.
  const showSubmit = canSendToChat && (!isWorkflow || pendingChat);

  const [templatesMenu, setTemplatesMenu] = useState<{ top: number; left: number } | null>(null);
  const [importMenu, setImportMenu] = useState<{ top: number; left: number } | null>(null);
  const [saveModal, setSaveModal] = useState(false);
  const [pasteModal, setPasteModal] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  function openTemplatesMenu(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTemplatesMenu({ top: rect.bottom + 2, left: rect.left });
  }

  function openImportMenu(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setImportMenu({ top: rect.bottom + 2, left: rect.left });
  }

  const templateItems: MenuItem[] = [];
  const visibleBuiltins = templates.filter((x) => x.scope === 'builtin' && !x.hidden);
  if (visibleBuiltins.length > 0) {
    templateItems.push({ section: 'Built-in' });
    for (const t of visibleBuiltins) {
      templateItems.push({ label: t.name, onClick: () => post({ type: 'applyTemplate', templateId: t.id }) });
    }
  }
  const workspaceTpls = templates.filter((t) => t.scope === 'workspace');
  if (workspaceTpls.length > 0) {
    templateItems.push({ separator: true }, { section: 'Workspace' });
    for (const t of workspaceTpls) {
      templateItems.push({ label: t.name, onClick: () => post({ type: 'applyTemplate', templateId: t.id }) });
    }
  }
  const globalTpls = templates.filter((t) => t.scope === 'global');
  if (globalTpls.length > 0) {
    templateItems.push({ separator: true }, { section: 'Global' });
    for (const t of globalTpls) {
      templateItems.push({ label: t.name, onClick: () => post({ type: 'applyTemplate', templateId: t.id }) });
    }
  }
  templateItems.push({ separator: true });
  templateItems.push({ label: 'Save current as template…', onClick: () => setSaveModal(true) });
  templateItems.push({ label: 'Manage templates…', onClick: () => post({ type: 'openTemplateManager' }) });

  const importItems: MenuItem[] = [
    { label: 'Open CSV file…', onClick: () => post({ type: 'importCsvFile' }) },
    { label: 'Paste CSV text…', onClick: () => setPasteModal(true) },
    { separator: true },
    { label: 'Export to CSV…', onClick: () => post({ type: 'exportCsv', snapshot }) },
  ];

  return (
    <div className="toolbar">
      <input
        ref={titleInputRef}
        className="title"
        value={snapshot.title ?? ''}
        placeholder="Untitled"
        onChange={(e) => store.setTitle(e.target.value)}
        style={{
          background: 'transparent',
          border: '1px solid transparent',
          color: 'inherit',
          padding: '2px 6px',
          borderRadius: 2,
          fontSize: 13,
          fontWeight: 600,
        }}
      />
      <span className="separator" />
      <div className="group">
        <button className="btn" onClick={() => store.addRow()}>+ Row</button>
        <button className="btn" onClick={() => store.addColumn()}>+ Column</button>
      </div>
      <span className="separator" />
      <div className="group">
        <button className="btn" onClick={openTemplatesMenu}>Templates ▾</button>
        <button className="btn" onClick={openImportMenu}>CSV ▾</button>
      </div>
      {isWorkflow && snapshot.rows.length > 0 && (
        <>
          <span className="separator" />
          <div className="group">
            <button
              className={`btn filter-chip${statusFilter === 'all' ? ' active' : ''}`}
              onClick={() => store.setStatusFilter('all')}
            >
              All <span className="filter-count">{snapshot.rows.length}</span>
            </button>
            {WORK_ITEM_STATUSES.filter((s) => statusCounts[s]).map((s) => (
              <button
                key={s}
                className={`btn filter-chip${statusFilter === s ? ' active' : ''}`}
                onClick={() => store.setStatusFilter(s)}
              >
                {s} <span className="filter-count">{statusCounts[s]}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {selectedRowIds.length > 0 && (
        <>
          <span className="separator" />
          <span style={{ color: 'var(--gridflow-muted)', fontSize: 12 }}>
            {selectedRowIds.length} selected
          </span>
          <button
            className="btn"
            onClick={() => store.deleteRows(selectedRowIds)}
          >
            Delete
          </button>
        </>
      )}
      <span className="spacer" />
      {showSubmit && (
        <button
          className="btn primary"
          onClick={() => post({ type: 'sendToChat', snapshot })}
          title={isWorkflow
            ? 'Hand this workflow back to the agent so it can start orchestrating'
            : 'Send the grid back to the chat session'}
        >
          {isWorkflow ? 'Start Workflow ▸' : 'Send to Chat ▸'}
        </button>
      )}

      {templatesMenu && <Menu anchor={templatesMenu} items={templateItems} onClose={() => setTemplatesMenu(null)} />}
      {importMenu && <Menu anchor={importMenu} items={importItems} onClose={() => setImportMenu(null)} />}
      {saveModal && <SaveTemplateModal onClose={() => setSaveModal(false)} />}
      {pasteModal && <PasteCsvModal onClose={() => setPasteModal(false)} />}
    </div>
  );
}

function SaveTemplateModal({ onClose }: { onClose: () => void }) {
  const snapshot = useStore((s) => s.snapshot);
  const [name, setName] = useState(snapshot.title ?? '');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<'workspace' | 'global'>('workspace');
  const [includeRows, setIncludeRows] = useState(false);

  function save() {
    if (!name.trim()) return;
    post({
      type: 'saveTemplate',
      name: name.trim(),
      description: description.trim() || undefined,
      scope,
      columns: snapshot.columns,
      seedRows: includeRows ? snapshot.rows.map((r) => r.cells) : undefined,
    });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Save Template</h3>
        <label>Name</label>
        <input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        <label>Description (optional)</label>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        <label>Scope</label>
        <select value={scope} onChange={(e) => setScope(e.target.value as 'workspace' | 'global')}>
          <option value="workspace">This workspace (.vscode/gridflow.templates.json)</option>
          <option value="global">All workspaces (global)</option>
        </select>
        <label style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={includeRows}
            onChange={(e) => setIncludeRows(e.target.checked)}
          />{' '}
          Include current rows as seed
        </label>
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!name.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}

function PasteCsvModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  function go() {
    if (!text.trim()) return;
    post({ type: 'importCsvText', text });
    onClose();
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Paste CSV</h3>
        <label>Paste comma/semicolon/tab-separated data — first row is the header.</label>
        <textarea
          rows={12}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          placeholder={`agent,task,objective\nExplore,find auth code,locate middleware`}
        />
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={!text.trim()}>Import</button>
        </div>
      </div>
    </div>
  );
}
