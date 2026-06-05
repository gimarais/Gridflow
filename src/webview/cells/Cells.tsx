import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ColumnDef, CellValue } from '../../shared/types';
import { store } from '../store';
import { post } from '../vscode';

interface CellProps {
  column: ColumnDef;
  rowId: string;
  value: CellValue;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onMoveFocus: (direction: 'next' | 'prev' | 'up' | 'down') => void;
}

export function Cell(props: CellProps) {
  switch (props.column.type) {
    case 'select':
      return <SelectCell {...props} />;
    case 'number':
      return <NumberCell {...props} />;
    case 'boolean':
      return <BooleanCell {...props} />;
    default:
      return <TextCell {...props} />;
  }
}

/* ----------------------------- Text ----------------------------- */

function TextCell({ column, rowId, value, focused, onFocus, onBlur, onMoveFocus }: CellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Refs for stable closure inside the file-picker result listener.
  const draftRef = useRef(draft);
  const rowIdRef = useRef(rowId);
  const columnIdRef = useRef(column.id);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { rowIdRef.current = rowId; }, [rowId]);
  useEffect(() => { columnIdRef.current = column.id; }, [column.id]);

  const waitingForPicker = useRef(false);
  const hashInsertPos = useRef(-1);

  // Listen for the native file-picker result from the extension host.
  useEffect(() => {
    const handler = (e: Event) => {
      const { token } = (e as CustomEvent<{ token: string | null }>).detail;
      if (!waitingForPicker.current) return;
      waitingForPicker.current = false;
      const pos = hashInsertPos.current;
      hashInsertPos.current = -1;
      if (token !== null && pos >= 0) {
        const cur = draftRef.current;
        const newDraft = cur.slice(0, pos) + token + ' ' + cur.slice(pos);
        draftRef.current = newDraft;
        setDraft(newDraft);
        store.setCell(rowIdRef.current, columnIdRef.current, newDraft);
      }
      // Re-focus the textarea after the picker closes.
      setTimeout(() => textRef.current?.focus(), 50);
    };
    window.addEventListener('gridflow:file-picker-result', handler);
    return () => window.removeEventListener('gridflow:file-picker-result', handler);
  }, []);

  useEffect(() => {
    if (!editing) {
      setDraft(value == null ? '' : String(value));
    }
  }, [value, editing]);

  useLayoutEffect(() => {
    if (editing && textRef.current) {
      const ta = textRef.current;
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
    }
  }, [editing, draft]);

  const startEdit = useCallback(() => {
    setEditing(true);
    setDraft(value == null ? '' : String(value));
    setTimeout(() => {
      const ta = textRef.current;
      if (ta) {
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
      }
    }, 0);
  }, [value]);

  const commit = useCallback(() => {
    if (draftRef.current !== (value == null ? '' : String(value))) {
      store.setCell(rowId, column.id, draftRef.current);
    }
    setEditing(false);
  }, [value, rowId, column.id]);

  const cancel = useCallback(() => {
    setDraft(value == null ? '' : String(value));
    setEditing(false);
  }, [value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === '#') {
      // Open native VS Code file picker instead of showing a webview popover.
      const ta = e.currentTarget;
      const pos = ta.selectionStart ?? draft.length;
      const charBefore = pos > 0 ? draft[pos - 1] : '';
      if (pos === 0 || /\s/.test(charBefore)) {
        e.preventDefault();
        hashInsertPos.current = pos;
        waitingForPicker.current = true;
        post({ type: 'openFilePicker' });
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      commit();
      onMoveFocus('down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit();
      onMoveFocus(e.shiftKey ? 'prev' : 'next');
    }
  }

  if (editing) {
    return (
      <div className="cell cell-editing">
        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setTimeout(() => {
              if (!waitingForPicker.current && document.activeElement !== textRef.current) commit();
            }, 0);
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={column.placeholder}
        />
      </div>
    );
  }

  const display = value == null || value === '' ? column.placeholder ?? '' : String(value);
  const isEmpty = value == null || value === '';
  return (
    <div
      className={`cell${focused ? ' focused' : ''}${isEmpty && column.placeholder ? ' empty' : ''}`}
      tabIndex={0}
      onClick={() => {
        onFocus();
        startEdit();
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          startEdit();
        } else if (e.key === '#' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // '#' at position 0 (empty cell) should trigger the file picker immediately.
          e.preventDefault();
          startEdit();
          setTimeout(() => {
            hashInsertPos.current = 0;
            waitingForPicker.current = true;
            post({ type: 'openFilePicker' });
          }, 0);
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          startEdit();
          setTimeout(() => {
            if (textRef.current) {
              textRef.current.value = e.key;
              setDraft(e.key);
            }
          }, 0);
        } else {
          handleArrowKeys(e, onMoveFocus);
        }
      }}
    >
      {display}
    </div>
  );
}

/* ----------------------------- Select ----------------------------- */

function SelectCell({ column, rowId, value, focused, onFocus, onBlur, onMoveFocus }: CellProps) {
  const opts = column.options ?? [];
  return (
    <div
      className={`cell${focused ? ' focused' : ''}`}
      onClick={onFocus}
      onKeyDown={(e) => handleArrowKeys(e, onMoveFocus)}
    >
      <select
        value={value == null ? '' : String(value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(e) => store.setCell(rowId, column.id, e.target.value)}
      >
        <option value="">—</option>
        {opts.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

/* ----------------------------- Number ----------------------------- */

function NumberCell({ column, rowId, value, focused, onFocus, onBlur, onMoveFocus }: CellProps) {
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  useEffect(() => {
    setDraft(value == null ? '' : String(value));
  }, [value]);
  return (
    <div
      className={`cell${focused ? ' focused' : ''}`}
      onClick={onFocus}
      onKeyDown={(e) => handleArrowKeys(e, onMoveFocus)}
    >
      <input
        type="number"
        value={draft}
        placeholder={column.placeholder}
        onFocus={onFocus}
        onBlur={(e) => {
          onBlur();
          const v = e.target.value.trim();
          const n = v === '' ? null : Number(v);
          store.setCell(rowId, column.id, Number.isFinite(n) ? n : null);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            onMoveFocus('down');
          } else if (e.key === 'Tab') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            onMoveFocus(e.shiftKey ? 'prev' : 'next');
          }
        }}
      />
    </div>
  );
}

/* ----------------------------- Boolean ----------------------------- */

function BooleanCell({ column, rowId, value, focused, onFocus, onMoveFocus }: CellProps) {
  return (
    <div
      className={`cell${focused ? ' focused' : ''}`}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault();
          store.setCell(rowId, column.id, !value);
        } else {
          handleArrowKeys(e, onMoveFocus);
        }
      }}
      tabIndex={0}
    >
      <div className="checkbox">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => store.setCell(rowId, column.id, e.target.checked)}
          aria-label={column.name}
        />
      </div>
    </div>
  );
}

/* ----------------------------- helpers ----------------------------- */

function handleArrowKeys(
  e: React.KeyboardEvent,
  onMoveFocus: (d: 'next' | 'prev' | 'up' | 'down') => void,
) {
  switch (e.key) {
    case 'ArrowRight':
      e.preventDefault();
      onMoveFocus('next');
      break;
    case 'ArrowLeft':
      e.preventDefault();
      onMoveFocus('prev');
      break;
    case 'ArrowDown':
      e.preventDefault();
      onMoveFocus('down');
      break;
    case 'ArrowUp':
      e.preventDefault();
      onMoveFocus('up');
      break;
  }
}
