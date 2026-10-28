import type { Draft } from './draft';

/**
 * A one-shot hand-off from "paste anywhere", the empty state and Duplicate to
 * the form that opens next. Consumed (and cleared) by the form on mount.
 */
type Prefill = (base: Draft) => Draft;
let pending: Prefill | null = null;

export const setPrefill = (fn: Prefill | null): void => { pending = fn; };

export function takePrefill(): Prefill | null {
  const fn = pending;
  pending = null;
  return fn;
}
