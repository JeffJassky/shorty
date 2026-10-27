import React from 'react';
import { Icons } from './icons';
import { CopyButton } from './copy-button';

interface ToastItem { id: number; message: string; copy?: string }
type Show = (message: string, opts?: { copy?: string }) => void;

const ToastContext = React.createContext<Show>(() => {});
export const useToast = (): Show => React.useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = React.useState<ToastItem | null>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const seq = React.useRef(0);
  const show = React.useCallback<Show>((message, opts) => {
    window.clearTimeout(timer.current);
    setItem({ id: ++seq.current, message, copy: opts?.copy });
    timer.current = window.setTimeout(() => setItem(null), 6000);
  }, []);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {item && (
          <div className="toast" key={item.id}>
            <Icons.CheckCircle className="icon toast-ok" />
            <span>{item.message}</span>
            {item.copy && <CopyButton text={item.copy} label="Copy link" />}
            <button type="button" className="icon-btn2 sm" aria-label="Dismiss" onClick={() => setItem(null)}>
              <Icons.X />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
