import type { ShortyClient } from '../../../types/client';
import { dateOnly, daysAgo } from './format';

/**
 * 30-day sparkline data, fetched lazily per visible row: at most 6 requests in
 * flight, cached for the session (spec §1).
 */
const MAX_IN_FLIGHT = 6;
const cache = new Map<string, Promise<number[]>>();
const queue: Array<() => void> = [];
let inFlight = 0;

function pump(): void {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    inFlight++;
    queue.shift()!();
  }
}

export function loadSpark(client: ShortyClient, linkId: string): Promise<number[]> {
  const hit = cache.get(linkId);
  if (hit) return hit;
  const p = new Promise<number[]>((resolve) => {
    queue.push(() => {
      client
        .stats({ linkId, from: dateOnly(daysAgo(29)), to: dateOnly(new Date()), interval: 'day' })
        .then((s) => resolve(s.series.map((pt) => pt.humans.clicks)), () => { cache.delete(linkId); resolve([]); })
        .finally(() => { inFlight--; pump(); });
    });
  });
  cache.set(linkId, p);
  pump();
  return p;
}
