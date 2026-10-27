import React from 'react';
import { Icons } from './icons';
import { store } from '../lib/use-async';

/** Collapsible group. `storageKey` remembers the open state per viewer. */
export function Disclosure({
  title, summary, defaultOpen = false, storageKey, children, id, open: controlled, onOpenChange,
}: {
  /** Controlled mode: the parent owns the open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  /** One-line text shown beside the title while collapsed. */
  summary?: string;
  defaultOpen?: boolean;
  storageKey?: string;
  children: React.ReactNode;
  id?: string;
}) {
  const [inner, setOpen] = React.useState(() => {
    if (storageKey) {
      const v = store.get(storageKey);
      if (v === '1') return true;
      if (v === '0') return false;
    }
    return defaultOpen;
  });
  const open = controlled ?? inner;
  const panelId = React.useId();
  const toggle = () => {
    const next = !open;
    if (storageKey) store.set(storageKey, next ? '1' : '0');
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <section className={'disclosure' + (open ? ' open' : '')} id={id}>
      <button type="button" className="disclosure-head" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        <Icons.Chevron className="icon disclosure-chev" />
        <span className="disclosure-title">{title}</span>
        {!open && summary && <span className="disclosure-summary">{summary}</span>}
      </button>
      <div id={panelId} className="disclosure-body" hidden={!open}>{children}</div>
    </section>
  );
}
