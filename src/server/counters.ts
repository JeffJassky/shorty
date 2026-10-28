import type { ShortyHealth } from '../../types/index.js';

/**
 * The numbers `health()` reports. One mutable object per instance, created in
 * `createShorty` and handed to every module that has something to count — so
 * the click pipeline (PR 2) adds its own increments without touching the
 * modules that already count hook failures.
 */
export interface Counters {
  /** Click pipelines that failed after the redirect was sent. */
  clickFailures: number;
  /** Hooks AND `track` calls that threw or rejected. */
  hookFailures: number;
  misses: number;
  /** Click pipelines still running. */
  inFlight: number;
  /** Pipelines skipped at `clicks.maxInFlight`. Incremented by the redirect router. */
  dropped: number;
}

export function createCounters(): Counters {
  return { clickFailures: 0, hookFailures: 0, misses: 0, inFlight: 0, dropped: 0 };
}

export function snapshotHealth(counters: Counters, clicksEnabled: boolean): ShortyHealth {
  return {
    clickFailures: counters.clickFailures,
    hookFailures: counters.hookFailures,
    misses: counters.misses,
    inFlight: counters.inFlight,
    dropped: counters.dropped,
    clicksEnabled,
  };
}
