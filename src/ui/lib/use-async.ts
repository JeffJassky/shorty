import React from 'react';

export type AsyncState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'ready'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: unknown };

/** `loading | ready | error` plus `reload`. Stale responses are dropped. */
export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList): AsyncState<T> & { reload: () => void } {
  const [state, setState] = React.useState<AsyncState<T>>({ status: 'loading' });
  const [tick, setTick] = React.useState(0);
  const fnRef = React.useRef(fn);
  fnRef.current = fn;

  React.useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    fnRef.current().then(
      (data) => { if (live) setState({ status: 'ready', data }); },
      (error: unknown) => { if (live) setState({ status: 'error', error }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = React.useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

/** Per-viewer convenience storage. Never throws; the UI works without it. */
export const store = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(`shorty:${key}`); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { window.localStorage.setItem(`shorty:${key}`, value); } catch { /* storage unavailable */ }
  },
};

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
