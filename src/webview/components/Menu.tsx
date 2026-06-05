import { useEffect, useRef } from 'react';

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  section?: string;
  disabled?: boolean;
}

interface Props {
  anchor: { top: number; left: number };
  items: MenuItem[];
  onClose: () => void;
}

export function Menu({ anchor, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return (
    <div className="menu" style={{ top: anchor.top, left: anchor.left }} ref={ref}>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-separator" />;
        if (it.section) return <div key={i} className="menu-section">{it.section}</div>;
        return (
          <div
            key={i}
            className={`menu-item${it.danger ? ' danger' : ''}`}
            style={it.disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </div>
        );
      })}
    </div>
  );
}
