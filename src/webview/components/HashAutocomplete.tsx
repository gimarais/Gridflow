import { useEffect, useMemo, useRef, useState } from 'react';
import type { HashCompletionItem } from '../../shared/types';
import { post } from '../vscode';

interface Position {
  top: number;
  left: number;
}

interface Props {
  /** Current value of the cell input. */
  value: string;
  /** Caret position inside `value`. */
  caret: number;
  /** Caret screen position used to anchor the popover. */
  anchor: Position | null;
  /** Called when the user accepts a completion. The hash query (incl. `#`) is replaced with `token`. */
  onApply: (newValue: string, newCaret: number) => void;
  /** The textarea / input element so we can intercept key events. */
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement>;
}

/**
 * Tracks the `#…` pattern at the caret. When active, fetches completion candidates
 * from the extension host and renders a small popover. Submits the chosen token
 * back into the cell value.
 */
export function HashAutocomplete({ value, caret, anchor, onApply, inputRef }: Props) {
  const hashInfo = useMemo(() => parseHashAtCaret(value, caret), [value, caret]);
  const [items, setItems] = useState<HashCompletionItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const requestSeqRef = useRef(0);

  // Fetch completions whenever the hash query changes.
  useEffect(() => {
    if (!hashInfo) {
      setItems([]);
      return;
    }
    const seq = ++requestSeqRef.current;
    post({ type: 'requestHashCompletions', query: hashInfo.query });
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        type: 'hashCompletions';
        query: string;
        items: HashCompletionItem[];
      };
      if (seq !== requestSeqRef.current) return;
      if (detail.query !== hashInfo.query) return;
      setItems(detail.items);
      setActiveIdx(0);
    };
    window.addEventListener('gridflow:hash-completions', handler);
    return () => window.removeEventListener('gridflow:hash-completions', handler);
  }, [hashInfo?.query]);

  // Keyboard handling — install on the input.
  useEffect(() => {
    if (!hashInfo) return;
    const el = inputRef.current;
    if (!el) return;
    const handler: EventListener = (raw) => {
      const e = raw as KeyboardEvent;
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        accept(items[activeIdx]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setItems([]);
      }
    };
    el.addEventListener('keydown', handler, true);
    return () => el.removeEventListener('keydown', handler, true);
  }, [items, activeIdx, hashInfo, inputRef]);

  function accept(item: HashCompletionItem) {
    if (!hashInfo) return;
    const before = value.slice(0, hashInfo.start);
    const after = value.slice(caret);
    const insertion = `${item.token} `;
    const newValue = `${before}${insertion}${after}`;
    const newCaret = before.length + insertion.length;
    onApply(newValue, newCaret);
    setItems([]);
  }

  if (!hashInfo || items.length === 0 || !anchor) return null;

  return (
    <div
      className="hash-popover"
      style={{ top: anchor.top, left: anchor.left }}
      onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
    >
      {items.map((item, i) => (
        <div
          key={item.token + i}
          className={`hash-item${i === activeIdx ? ' active' : ''}`}
          onClick={() => accept(item)}
          onMouseEnter={() => setActiveIdx(i)}
        >
          <div className="hash-item-label">
            <span className="hash-item-kind">{item.kind}</span>
            <span>{item.label}</span>
          </div>
          {item.detail && <div className="hash-item-detail">{item.detail}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * If the caret is inside a `#word` token (no whitespace between `#` and caret),
 * return the start index and query text. Otherwise null.
 */
function parseHashAtCaret(value: string, caret: number): { start: number; query: string } | null {
  if (caret < 1) return null;
  // Find the last '#' before caret that is preceded by whitespace or string start.
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === '#') {
      const prev = i === 0 ? ' ' : value[i - 1];
      if (/\s/.test(prev) || i === 0) {
        const query = value.slice(i + 1, caret);
        // Whitespace inside the query terminates it.
        if (/\s/.test(query)) return null;
        return { start: i, query };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}
