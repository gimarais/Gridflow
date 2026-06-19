import { memo, useCallback, useMemo, useState } from 'react';
import { store, useStore } from '../store';
import { Cell } from '../cells/Cells';
import { ColumnHeader } from './ColumnHeader';
import { Menu, MenuItem } from './Menu';
import { StatusBadge } from './RowDetailPanel';
import { criticalPath } from '../../shared/workflowCore';
import type { ColumnDef, Row } from '../../shared/types';

export function Grid() {
  const snapshot = useStore((s) => s.snapshot);
  const focusedCell = useStore((s) => s.focusedCell);
  const selectedRowIds = useStore((s) => s.selectedRowIds);
  const expandedRowId = useStore((s) => s.expandedRowId);
  const statusFilter = useStore((s) => s.statusFilter);
  const isWorkflow = snapshot.kind === 'workflow';

  const visibleRows = statusFilter === 'all'
    ? snapshot.rows
    : snapshot.rows.filter((r) => (r.work?.status ?? 'pending') === statusFilter);

  // Highlight the duration bottleneck once at least two rows have run durations,
  // so a single finished row doesn't trivially "win" the path.
  const criticalSet = useMemo(() => {
    if (!isWorkflow) return new Set<string>();
    const cp = criticalPath(snapshot);
    return cp.rowIds.length > 1 ? new Set(cp.rowIds) : new Set<string>();
  }, [snapshot, isWorkflow]);

  const [rowMenu, setRowMenu] = useState<{ anchor: { top: number; left: number }; rowId: string } | null>(null);
  const [fanOutRowId, setFanOutRowId] = useState<string | null>(null);

  // Stable across renders: reads fresh state at call time so memoized rows
  // don't re-render just because the handler identity changed.
  const moveFocus = useCallback(
    (rowId: string, colId: string, direction: 'next' | 'prev' | 'up' | 'down') => {
      const state = store.getState();
      const filter = state.statusFilter;
      const rows = filter === 'all'
        ? state.snapshot.rows
        : state.snapshot.rows.filter((r) => (r.work?.status ?? 'pending') === filter);
      const columns = state.snapshot.columns;
      const rIdx = rows.findIndex((r) => r.id === rowId);
      const cIdx = columns.findIndex((c) => c.id === colId);
      if (rIdx < 0 || cIdx < 0) return;
      let nextR = rIdx;
      let nextC = cIdx;
      let addedRow = false;
      switch (direction) {
        case 'next':
          if (cIdx < columns.length - 1) nextC = cIdx + 1;
          else if (rIdx < rows.length - 1) { nextR = rIdx + 1; nextC = 0; }
          break;
        case 'prev':
          if (cIdx > 0) nextC = cIdx - 1;
          else if (rIdx > 0) { nextR = rIdx - 1; nextC = columns.length - 1; }
          break;
        case 'down':
          if (rIdx < rows.length - 1) {
            nextR = rIdx + 1;
          } else if (filter === 'all') {
            store.addRow();
            nextR = rIdx + 1;
            addedRow = true;
          }
          break;
        case 'up':
          if (rIdx > 0) nextR = rIdx - 1;
          break;
      }
      // When a row was just added, read fresh state to pick it up.
      const nextRow = addedRow ? store.getState().snapshot.rows[nextR] : rows[nextR];
      const nextCol = columns[nextC];
      if (!nextRow || !nextCol) return;
      store.focusCell(nextRow.id, nextCol.id);
    },
    [],
  );

  const openRowMenu = useCallback((rowId: string, anchor: { top: number; left: number }) => {
    setRowMenu({ anchor, rowId });
  }, []);

  if (snapshot.columns.length === 0) {
    return (
      <div className="empty-state">
        <div>This grid has no columns yet.</div>
        <button className="btn primary" onClick={() => store.addColumn()}>Add a column</button>
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <table className="grid">
        <colgroup>
          <col style={{ width: 32 }} />
          {isWorkflow && <col style={{ width: 108 }} />}
          {isWorkflow && <col style={{ width: 132 }} />}
          {snapshot.columns.map((c) => (
            <col key={c.id} style={{ width: c.width ?? 200 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="row-handle" style={{ position: 'sticky', left: 0, zIndex: 3 }}>#</th>
            {isWorkflow && <th className="status-col-head">Status</th>}
            {isWorkflow && <th className="status-col-head">Agent</th>}
            {snapshot.columns.map((col, i) => (
              <th key={col.id}>
                <ColumnHeader column={col} index={i} total={snapshot.columns.length} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, ri) => (
            <GridRow
              key={row.id}
              row={row}
              rowIndex={ri}
              columns={snapshot.columns}
              isWorkflow={isWorkflow}
              isSelected={selectedRowIds.includes(row.id)}
              isExpanded={expandedRowId === row.id}
              focusedColId={focusedCell?.rowId === row.id ? focusedCell.colId : null}
              selectedCount={selectedRowIds.length}
              onCriticalPath={criticalSet.has(row.id)}
              onMoveFocus={moveFocus}
              onOpenMenu={openRowMenu}
            />
          ))}
          <tr>
            <td className="row-handle">+</td>
            <td colSpan={snapshot.columns.length + (isWorkflow ? 2 : 0)} style={{ padding: 0 }}>
              <button
                className="btn"
                style={{ width: '100%', justifyContent: 'flex-start', borderRadius: 0, padding: '6px 12px' }}
                onClick={() => store.addRow()}
              >
                + Add row
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {rowMenu && (
        <Menu
          anchor={rowMenu.anchor}
          onClose={() => setRowMenu(null)}
          items={buildRowMenu(
            rowMenu.rowId,
            snapshot.rows.findIndex((r) => r.id === rowMenu.rowId),
            snapshot.rows.length,
            selectedRowIds,
            isWorkflow,
            () => setFanOutRowId(rowMenu.rowId),
          )}
        />
      )}
      {fanOutRowId && <FanOutModal rowId={fanOutRowId} onClose={() => setFanOutRowId(null)} />}
    </div>
  );
}

/** Modal to fan one template row out into N rows, one per pasted list item. */
function FanOutModal({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const items = text.split('\n').map((l) => l.trim()).filter(Boolean);
  function go() {
    if (!items.length) return;
    store.fanOutRow(rowId, items);
    onClose();
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Fan out over a list</h3>
        <label>
          One item per line. <code>{'{{item}}'}</code> in this row&apos;s cells and prompt is replaced per item —
          creating one parallel task each.
        </label>
        <textarea
          rows={10}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          placeholder={'src/auth.ts\nsrc/api.ts\nsrc/db.ts'}
        />
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={!items.length}>
            Create {items.length || ''} {items.length === 1 ? 'row' : 'rows'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface GridRowProps {
  row: Row;
  rowIndex: number;
  columns: ColumnDef[];
  isWorkflow: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  /** Column id of the focused cell when this row holds focus; null otherwise. */
  focusedColId: string | null;
  selectedCount: number;
  /** True when this row sits on the workflow's critical (slowest) path. */
  onCriticalPath: boolean;
  onMoveFocus: (rowId: string, colId: string, d: 'next' | 'prev' | 'up' | 'down') => void;
  onOpenMenu: (rowId: string, anchor: { top: number; left: number }) => void;
}

/**
 * One <tr>, memoized: an edit in one row re-renders only that row instead of
 * every cell in the table. Rows are immutable in the store, so identity
 * comparison on `row` is sufficient.
 */
const GridRow = memo(function GridRow({
  row,
  rowIndex,
  columns,
  isWorkflow,
  isSelected,
  isExpanded,
  focusedColId,
  selectedCount,
  onCriticalPath,
  onMoveFocus,
  onOpenMenu,
}: GridRowProps) {
  const deleteTargets = () => {
    const selected = store.getState().selectedRowIds;
    return selected.length > 1 && selected.includes(row.id) ? selected : [row.id];
  };
  const trClass = [isExpanded ? 'row-expanded' : '', onCriticalPath ? 'row-critical' : ''].filter(Boolean).join(' ') || undefined;
  return (
    <tr className={trClass}>
      <td
        className={`row-handle${isSelected ? ' selected' : ''}`}
        style={{ position: 'sticky', left: 0, zIndex: 1 }}
        onClick={(e) => store.toggleSelectRow(row.id, e.metaKey || e.ctrlKey || e.shiftKey)}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu(row.id, { top: e.clientY, left: e.clientX });
        }}
        title={onCriticalPath ? 'On the critical path — the workflow\'s duration bottleneck' : 'Click to select • right-click for more'}
      >
        {onCriticalPath && <span className="critical-marker" aria-hidden title="Critical path" />}
        <span className="row-num">{rowIndex + 1}</span>
        <button
          className="row-delete-btn"
          title={selectedCount > 1 && isSelected ? `Delete ${selectedCount} rows` : 'Delete row'}
          onClick={(e) => {
            e.stopPropagation();
            store.deleteRows(deleteTargets());
          }}
        >
          ×
        </button>
      </td>
      {isWorkflow && (
        <td className="status-cell">
          <StatusBadge row={row} onClick={() => store.expandRow(row.id)} />
        </td>
      )}
      {isWorkflow && (
        <td className="agent-cell" onClick={() => store.expandRow(row.id)} title="Assigned agent — click to edit">
          {row.work?.role === 'verifier' && <span className="verifier-badge" title="Verifier row — evaluates the workflow">✔ verifier</span>}
          {row.work?.assignedAgent
            ? <span className="agent-chip">{row.work.assignedAgent}</span>
            : <span className="agent-unassigned">unassigned</span>}
          {row.work?.dependsOn && row.work.dependsOn.length > 0 && (
            <span className="dep-badge" title={`Waits for ${row.work.dependsOn.length} task(s)`}>
              ⛓ {row.work.dependsOn.length}
            </span>
          )}
        </td>
      )}
      {columns.map((col) => (
        <td key={col.id}>
          <Cell
            column={col}
            rowId={row.id}
            value={row.cells[col.id] ?? null}
            focused={focusedColId === col.id}
            onFocus={() => store.focusCell(row.id, col.id)}
            onBlur={() => {/* keep focus model lightweight: don't auto-clear */}}
            onMoveFocus={(d) => onMoveFocus(row.id, col.id, d)}
          />
        </td>
      ))}
    </tr>
  );
});

function buildRowMenu(
  rowId: string,
  index: number,
  total: number,
  selected: string[],
  isWorkflow: boolean,
  onFanOut: () => void,
): MenuItem[] {
  return [
    ...(isWorkflow
      ? [{ label: 'Open work-item detail', onClick: () => store.expandRow(rowId) }, { separator: true } as MenuItem]
      : []),
    { label: 'Insert row below', onClick: () => store.addRow(rowId) },
    { label: 'Duplicate row', onClick: () => store.duplicateRow(rowId) },
    ...(isWorkflow ? [{ label: 'Fan out over a list…', onClick: onFanOut }] : []),
    { separator: true },
    { label: 'Move up', onClick: () => store.moveRow(rowId, -1), disabled: index === 0 },
    { label: 'Move down', onClick: () => store.moveRow(rowId, 1), disabled: index === total - 1 },
    { separator: true },
    {
      label: selected.length > 1 ? `Delete ${selected.length} rows` : 'Delete row',
      danger: true,
      onClick: () => store.deleteRows(selected.length > 1 && selected.includes(rowId) ? selected : [rowId]),
    },
  ];
}
