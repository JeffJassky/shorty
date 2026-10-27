import React from 'react';
import type { Json } from '../../../types/client';
import type { Stats } from '../../../types/index';
import { resolveRange, type RangeState, type ResolvedRange } from './analytics';
import { useApp } from './context';
import { useAsync } from './use-async';

/** Stats for the picked range (one link, or all links when `linkId` is omitted). */
export function useRangeStats(linkId: string | undefined, range: RangeState) {
  const { client } = useApp();
  // Memoised: presets resolve to "now", which must not change on every render.
  const resolved = React.useMemo(() => resolveRange(range), [range.key, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const r: ResolvedRange | null = 'range' in resolved ? resolved.range : null;
  const state = useAsync<Json<Stats> | null>(
    () => (r ? client.stats({ ...(linkId ? { linkId } : {}), from: r.from, to: r.to, interval: r.interval, top: 10 }) : Promise.resolve(null)),
    [client, linkId, r?.from, r?.to, r?.interval],
  );
  return { state, range: r, error: 'error' in resolved ? resolved.error : null };
}
