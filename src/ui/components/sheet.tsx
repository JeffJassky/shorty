import React from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './dialog';
import { Icons } from './icons';

/**
 * Right-side sheet (≥ 900px) / full-screen (below). Esc and the scrim ask
 * `onRequestClose`, which the form answers with a dirty-confirm.
 */
export function Sheet({
  title, onRequestClose, children, wide,
}: {
  title: string;
  onRequestClose: () => void;
  children: React.ReactNode;
  /** Room for the live-panels column. */
  wide?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useFocusTrap(ref);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onRequestClose(); }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onRequestClose]);

  return createPortal(
    <div className="scrim sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onRequestClose(); }}>
      <div ref={ref} className={'sheet' + (wide ? ' sheet-wide' : '')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn2" aria-label="Close" onClick={onRequestClose}><Icons.X /></button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
