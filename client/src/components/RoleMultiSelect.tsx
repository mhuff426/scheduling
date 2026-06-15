import { useEffect, useRef, useState } from 'react';
import type { RoleTag } from '../../../shared/types.js';

interface Props {
  roles: RoleTag[];
  selected: string[];                 // selected role ids
  onChange: (next: string[]) => void;
  lockedIds?: string[];               // ids that are always selected / can't be removed
  placeholder?: string;
}

// A colorful multi-select combobox: selected roles render as pills inside the
// control; clicking it opens a dropdown of the remaining roles (type to
// filter); picking one adds a pill. Used for per-employee roles and for a
// shift type's allowed roles.
export default function RoleMultiSelect({ roles, selected, onChange, lockedIds = [], placeholder = 'Add roles…' }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close on a click outside the control.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const byId = (id: string) => roles.find((r) => r.id === id);
  const options = roles.filter(
    (r) => !selected.includes(r.id) && r.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  const add = (id: string) => { onChange([...selected, id]); setQuery(''); };
  const remove = (id: string) => { if (!lockedIds.includes(id)) onChange(selected.filter((x) => x !== id)); };

  return (
    <div className={`ms ${open ? 'ms-open' : ''}`} ref={ref}>
      <div className="ms-control" onClick={() => setOpen(true)}>
        {selected.map((id) => {
          const r = byId(id);
          if (!r) return null;
          const locked = lockedIds.includes(id);
          return (
            <span key={id} className={`ms-pill${locked ? ' ms-pill-locked' : ''}`}>
              {r.name}
              {!locked && (
                <button
                  type="button"
                  className="ms-pill-x"
                  title={`Remove ${r.name}`}
                  onClick={(e) => { e.stopPropagation(); remove(id); }}
                >×</button>
              )}
            </span>
          );
        })}
        <input
          className="ms-input"
          value={query}
          placeholder={selected.length === 0 ? placeholder : ''}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
        <span className="ms-caret" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>▾</span>
      </div>
      {open && (
        <div className="ms-menu">
          {options.length === 0 ? (
            <div className="ms-empty">No matching roles</div>
          ) : (
            options.map((r) => (
              <div key={r.id} className="ms-option" onClick={() => add(r.id)}>{r.name}</div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
