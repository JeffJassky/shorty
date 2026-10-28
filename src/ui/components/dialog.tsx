import React from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `root`; returns focus to the opener on unmount. */
export function useFocusTrap(root: React.RefObject<HTMLElement>, active = true): void {
  React.useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root.current) return;
      const nodes = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.current.contains(current))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (current === last || !root.current.contains(current))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [root, active]);
}

export function Dialog({
  title, children, confirmLabel, cancelLabel = 'Cancel', tone, onConfirm, onCancel, confirmDisabled, hideConfirm,
}: {
  title: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger';
  onConfirm?: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  hideConfirm?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useFocusTrap(ref);

  React.useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input,textarea,select');
    (first ?? ref.current?.querySelector<HTMLElement>('.dialog-actions .btn'))?.focus();
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return createPortal(
    <div className="scrim dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
          {!hideConfirm && (
            <button
              type="button"
              className={'btn ' + (tone === 'danger' ? 'btn-danger-solid' : 'btn-primary')}
              disabled={confirmDisabled}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
