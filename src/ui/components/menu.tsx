import React from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './icons';
import { IconButton } from './tip';

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  tone?: 'danger';
  onSelect: () => void;
}

/** Kebab menu: portalled and fixed so list/card overflow never clips it. */
export function Menu({ label, items, className }: { label: string; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const btn = React.useRef<HTMLButtonElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const id = React.useId();

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) btn.current?.focus();
  }, []);

  React.useLayoutEffect(() => {
    if (!open || !btn.current || !list.current) return;
    const r = btn.current.getBoundingClientRect();
    const m = list.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
    const below = r.bottom + 4;
    const top = below + m.height > window.innerHeight - 8 ? Math.max(8, r.top - m.height - 4) : below;
    setPos({ left, top });
  }, [open]);

  // Focus only once the menu is visible — `visibility: hidden` cannot take focus.
  React.useEffect(() => {
    if (pos) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pos]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  const onKey = (e: React.KeyboardEvent) => {
    const nodes = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); nodes[(i + 1) % nodes.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nodes[(i - 1 + nodes.length) % nodes.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); nodes[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); nodes[nodes.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <>
      <IconButton
        ref={btn}
        icon={<Icons.Dots />}
        label={label}
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      />
      {open && createPortal(
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className="menu"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          onKeyDown={onKey}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={'menu-item' + (it.tone === 'danger' ? ' danger' : '')}
              onClick={() => { close(true); it.onSelect(); }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
