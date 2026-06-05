import { useCallback, useState } from 'react';
import { store, useStore } from '../store';
import { Cell } from '../cells/Cells';
import { ColumnHeader } from './ColumnHeader';
import { Menu, MenuItem } from './Menu';
import { StatusBadge } from './RowDetailPanel';

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

  const [rowMenu, setRowMenu] = useState<{ anchor: { top: number; left: number }; rowId: string } | null>(null);

  const moveFocus = useCallback(
    (rowId: string, colId: string, direction: 'next' | 'prev' | 'up' | 'down') => {
      const rIdx = visibleRows.findIndex((r) => r.id === rowId);
      const cIdx = snapshot.columns.findIndex((c) => c.id === colId);
      if (rIdx < 0 || cIdx < 0) return;
      let nextR = rIdx;
      let nextC = cIdx;
      let addedRow = false;
      switch (direction) {
        case 'next':
          if (cIdx < snapshot.columns.length - 1) nextC = cIdx + 1;
          else if (rIdx < visibleRows.length - 1) { nextR = rIdx + 1; nextC = 0; }
          break;
        case 'prev':
          if (cIdx > 0) nextC = cIdx - 1;
          else if (rIdx > 0) { nextR = rIdx - 1; nextC = snapshot.columns.length - 1; }
          break;
        case 'down':
          if (rIdx < visibleRows.length - 1) {
            nextR = rIdx + 1;
          } else if (statusFilter === 'all') {
            store.addRow();
            nextR = rIdx + 1;
            addedRow = true;
          }
          break;
        case 'up':
          if (rIdx > 0) nextR = rIdx - 1;
          break;
      }
      // When a row was just added, read fresh state to pick it up; otherwise use visibleRows.
      const nextRow = addedRow ? store.getState().snapshot.rows[nextR] : visibleRows[nextR];
      const nextCol = snapshot.columns[nextC];
      if (!nextRow || !nextCol) return;
      store.focusCell(nextRow.id, nextCol.id);
    },
    [snapshot.rows, snapshot.columns, statusFilter],
  );

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
          {visibleRows.map((row, ri) => {
            const isSelected = selectedRowIds.includes(row.id);
            const isExpanded = expandedRowId === row.id;
            return (
              <tr key={row.id} className={isExpanded ? 'row-expanded' : undefined}>
                <td
                  className={`row-handle${isSelected ? ' selected' : ''}`}
                  style={{ position: 'sticky', left: 0, zIndex: 1 }}
                  onClick={(e) => store.toggleSelectRow(row.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRowMenu({ anchor: { top: e.clientY, left: e.clientX }, rowId: row.id });
                  }}
                  title="Click to select • right-click for more"
                >
                  <span className="row-num">{ri + 1}</span>
                  <button
                    className="row-delete-btn"
                    title={selectedRowIds.length > 1 && selectedRowIds.includes(row.id) ? `Delete ${selectedRowIds.length} rows` : 'Delete row'}
                    onClick={(e) => {
                      e.stopPropagation();
                      store.deleteRows(
                        selectedRowIds.length > 1 && selectedRowIds.includes(row.id) ? selectedRowIds : [row.id],
                      );
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
                {snapshot.columns.map((col) => {
                  const focused = focusedCell?.rowId === row.id && focusedCell?.colId === col.id;
                  return (
                    <td key={col.id}>
                      <Cell
                        column={col}
                        rowId={row.id}
                        value={row.cells[col.id] ?? null}
                        focused={focused}
                        onFocus={() => store.focusCell(row.id, col.id)}
                        onBlur={() => {/* keep focus model lightweight: don't auto-clear */}}
                        onMoveFocus={(d) => moveFocus(row.id, col.id, d)}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
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
          items={buildRowMenu(rowMenu.rowId, snapshot.rows.findIndex((r) => r.id === rowMenu.rowId), snapshot.rows.length, selectedRowIds, isWorkflow)}
        />
      )}
    </div>
  );
}

function buildRowMenu(rowId: string, index: number, total: number, selected: string[], isWorkflow: boolean): MenuItem[] {
  return [
    ...(isWorkflow
      ? [{ label: 'Open work-item detail', onClick: () => store.expandRow(rowId) }, { separator: true } as MenuItem]
      : []),
    { label: 'Insert row below', onClick: () => store.addRow(rowId) },
    { label: 'Duplicate row', onClick: () => store.duplicateRow(rowId) },
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
