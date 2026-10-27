import React from 'react';

export interface SegOption<T extends string> { value: T; label: string; disabled?: boolean }

/** Radio-group segmented control (`.seg`). Arrow keys move the selection. */
export function Segmented<T extends string>({
  value, onChange, options, label, id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  label: string;
  id?: string;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const enabled = options.map((o, idx) => (o.disabled ? -1 : idx)).filter((idx) => idx >= 0);
    const next = enabled[(enabled.indexOf(i) + dir + enabled.length) % enabled.length];
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label} id={id}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          className={'seg-item' + (o.value === value ? ' active' : '')}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
