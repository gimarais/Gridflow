import { useRef, useState } from 'react';
import type { ColumnDef, ColumnType } from '../../shared/types';
import { store } from '../store';
import { Menu, MenuItem } from './Menu';

interface Props {
  column: ColumnDef;
  index: number;
  total: number;
}


export function ColumnHeader({ column, index, total }: Props) {
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [optionsModal, setOptionsModal] = useState(false);
  const thRef = useRef<HTMLDivElement>(null);
  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  function openMenu(e: React.MouseEvent) {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    setMenu({ top: rect.bottom + 2, left: rect.left });
  }

  function changeType(t: ColumnType) {
    if (t === 'select') {
      store.setColumnType(column.id, t, column.options ?? []);
      setOptionsModal(true);
    } else {
      store.setColumnType(column.id, t);
    }
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = thRef.current?.parentElement?.getBoundingClientRect().width ?? 160;
    setIsResizing(true);
    function onMove(ev: MouseEvent) {
      if (resizeStartXRef.current == null || resizeStartWidthRef.current == null) return;
      const delta = ev.clientX - resizeStartXRef.current;
      const w = Math.max(60, resizeStartWidthRef.current + delta);
      store.resizeColumn(column.id, w);
    }
    function onUp() {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const menuItems: MenuItem[] = [
    { section: 'Type' },
    { label: 'Text', onClick: () => changeType('text') },
    { label: 'Select…', onClick: () => changeType('select') },
    { label: 'Number', onClick: () => changeType('number') },
    { label: 'Boolean', onClick: () => changeType('boolean') },
    { separator: true },
    { section: 'Position' },
    { label: 'Insert column right', onClick: () => store.addColumn(column.id) },
    { label: 'Move left', onClick: () => store.moveColumn(column.id, -1), disabled: index === 0 },
    { label: 'Move right', onClick: () => store.moveColumn(column.id, 1), disabled: index === total - 1 },
    { separator: true },
    {
      label: column.type === 'select' ? 'Edit options…' : 'Edit options… (select only)',
      onClick: () => column.type === 'select' && setOptionsModal(true),
      disabled: column.type !== 'select',
    },
    { separator: true },
    { label: 'Delete column', danger: true, onClick: () => store.deleteColumn(column.id), disabled: total <= 1 },
  ];

  return (
    <div className="col-header" ref={thRef}>
      <span className="col-header-name">
        <input
          value={column.name}
          onChange={(e) => store.renameColumn(column.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          aria-label="Column name"
        />
      </span>
      <button className="col-menu-btn" onClick={openMenu} aria-label="Column menu">⋯</button>
      <div className={`col-resizer${isResizing ? ' is-resizing' : ''}`} onMouseDown={startResize} />
      {menu && <Menu anchor={menu} items={menuItems} onClose={() => setMenu(null)} />}
      {optionsModal && (
        <SelectOptionsModal
          column={column}
          onClose={() => setOptionsModal(false)}
        />
      )}
    </div>
  );
}

function SelectOptionsModal({ column, onClose }: { column: ColumnDef; onClose: () => void }) {
  const [text, setText] = useState((column.options ?? []).join('\n'));
  function save() {
    const options = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    store.setSelectOptions(column.id, options);
    onClose();
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Options for "{column.name}"</h3>
        <label>One per line</label>
        <textarea
          rows={10}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
