import React from 'react';
import { looseKey } from '../lib/format';

export interface ComboOption { value: string; count?: number }

const MAX_OPTIONS = 8;

/** Prefix matches first, then substring matches; typed text is never required to match. */
export function filterOptions(options: ComboOption[], typed: string): ComboOption[] {
  const q = typed.trim().toLowerCase();
  if (!q) return options.slice(0, MAX_OPTIONS);
  const prefix: ComboOption[] = [];
  const inner: ComboOption[] = [];
  for (const o of options) {
    const v = o.value.toLowerCase();
    if (v === q) continue;
    if (v.startsWith(q)) prefix.push(o);
    else if (v.includes(q)) inner.push(o);
  }
  return [...prefix, ...inner].slice(0, MAX_OPTIONS);
}

const plural = (n: number) => (n === 1 ? '1 link' : `${n} links`);

/** The existing option that differs from `typed` only by case/space/punctuation. */
export function nearDuplicate(options: ComboOption[], typed: string): ComboOption | undefined {
  const loose = looseKey(typed);
  if (!loose) return undefined;
  return options.find((o) => o.value !== typed && looseKey(o.value) === loose);
}

/**
 * WAI-ARIA combobox 1.2 (editable, list autocomplete). Free text is always
 * allowed; the list only suggests previously used values with their counts.
 * Under the field, a one-click lint when the text is a near-duplicate.
 */
export function Combobox({
  id, value, onChange, options, placeholder, describedBy, label, onFocus, onBlur, onKeyDown, lint = true,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  describedBy?: string;
  /** aria-label when no <label for> points at the input. */
  label?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  lint?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const listId = `${id}-list`;
  const matches = React.useMemo(() => filterOptions(options, value), [options, value]);
  const showList = open && matches.length > 0;
  const dup = lint ? nearDuplicate(options, value) : undefined;

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setActive(-1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.altKey) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!showList) { setOpen(true); setActive(0); } else setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showList) { setOpen(true); setActive(matches.length - 1); } else setActive((a) => (a <= 0 ? matches.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      if (showList && active >= 0) { e.preventDefault(); pick(matches[active].value); }
    } else if (e.key === 'Escape') {
      if (showList) { e.preventDefault(); setOpen(false); setActive(-1); }
    }
  };

  return (
    <div className="combo">
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-describedby={describedBy}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => { setOpen(true); onFocus?.(); }}
        onBlur={() => { setOpen(false); setActive(-1); onBlur?.(); }}
        onKeyDown={onKey}
      />
      {showList && (
        <ul id={listId} role="listbox" className="combo-list" aria-label={label}>
          {matches.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={'combo-opt' + (i === active ? ' active' : '')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
            >
              <span className="combo-val">{o.value}</span>
              {o.count !== undefined && <span className="combo-count">· {plural(o.count)}</span>}
            </li>
          ))}
        </ul>
      )}
      {dup && (
        <div className="combo-lint" role="status">
          <span>
            {dup.count === undefined ? 'An existing value is' : `${plural(dup.count)} ${dup.count === 1 ? 'uses' : 'use'}`}{' '}
            <code>{dup.value}</code> — use that instead?
          </span>
          <button type="button" className="btn btn-sm" onClick={() => pick(dup.value)}>Use {dup.value}</button>
        </div>
      )}
    </div>
  );
}
