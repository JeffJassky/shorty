import React from 'react';

/**
 * Hovering or focusing an anatomy segment highlights its field, and the other
 * way round. Keys: `dest`, `utm:<field>`, `param:<rowId>`, `hash`.
 */
export interface Highlight { key: string | null; set: (key: string | null) => void }
export const HighlightContext = React.createContext<Highlight>({ key: null, set: () => {} });
export const useHighlight = (): Highlight => React.useContext(HighlightContext);

/** Spread onto a field wrapper: hover/focus sets the key, and `hl` tells it to light up. */
export function useFieldHighlight(key: string): {
  hl: boolean;
  handlers: { onMouseEnter: () => void; onMouseLeave: () => void; onFocus: () => void; onBlur: () => void };
} {
  const h = useHighlight();
  return {
    hl: h.key === key,
    handlers: {
      onMouseEnter: () => h.set(key),
      onMouseLeave: () => h.set(null),
      onFocus: () => h.set(key),
      onBlur: () => h.set(null),
    },
  };
}

export const fieldDomId = (key: string): string => {
  if (key === 'dest') return 'f-dest';
  if (key.startsWith('utm:')) return `f-utm-${key.slice(4)}`;
  if (key.startsWith('param:')) return `f-param-${key.slice(6)}-value`;
  return 'f-dest';
};
