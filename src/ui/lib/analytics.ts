import React from 'react';
import type { Breakdown } from '../../../types/index';
import { daysAgo } from './format';
import { store } from './use-async';

/** The server rejects ranges over 400 inclusive days (`range_too_large`). */
export const MAX_RANGE_DAYS = 400;

export type RangeKey = '7d' | '30d' | '90d' | '12m' | 'custom';
export type Interval = 'day' | 'week' | 'month';

export const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '12m', label: '12 months' },
  { value: 'custom', label: 'Custom' },
];

/** Days covered by each preset, ending today. 12 months is 365 days, safely under the cap. */
const PRESET_DAYS: Record<Exclude<RangeKey, 'custom'>, number> = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };

export interface RangeState {
  key: RangeKey;
  /** Only used when `key === 'custom'`. `YYYY-MM-DD`. */
  from: string;
  to: string;
}

export const DEFAULT_RANGE: RangeState = { key: '30d', from: '', to: '' };

/** Inclusive day count between two `YYYY-MM-DD` strings; NaN when either is invalid. */
export function dayCount(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** day ≤ 90 days, week ≤ 12 months (365), month beyond. */
export function intervalFor(days: number): Interval {
  if (days <= 90) return 'day';
  if (days <= 365) return 'week';
  return 'month';
}

export interface ResolvedRange {
  from: string;
  to: string;
  days: number;
  interval: Interval;
}

/** `null` + a sentence when a custom range can't be sent. */
export function resolveRange(r: RangeState): { range: ResolvedRange } | { error: string } {
  let from: string;
  let to: string;
  if (r.key === 'custom') {
    from = r.from;
    to = r.to;
    if (!from || !to) return { error: 'Pick a start and end date.' };
    if (Number.isNaN(dayCount(from, to))) return { error: 'Pick a start and end date.' };
    if (from > to) return { error: 'The start date comes after the end date.' };
    if (dayCount(from, to) > MAX_RANGE_DAYS) return { error: `Pick a range of ${MAX_RANGE_DAYS} days or fewer.` };
  } else {
    const days = PRESET_DAYS[r.key];
    // Instants, not local dates: the server turns them into calendar days in
    // `clicks.timezone`, so "today" is the server's today, not this browser's.
    to = new Date().toISOString();
    from = daysAgo(days - 1).toISOString();
    return { range: { from, to, days, interval: intervalFor(days) } };
  }
  const days = dayCount(from, to);
  return { range: { from, to, days, interval: intervalFor(days) } };
}

// ── Bots: Hide / Show separately / Include — per viewer ──────────────────────

export type BotsMode = 'hide' | 'separate' | 'include';
export const BOTS_OPTIONS: Array<{ value: BotsMode; label: string }> = [
  { value: 'hide', label: 'Hide' },
  { value: 'separate', label: 'Show separately' },
  { value: 'include', label: 'Include' },
];

export function useBotsMode(): [BotsMode, (m: BotsMode) => void] {
  const [mode, setMode] = React.useState<BotsMode>(() => {
    const saved = store.get('bots');
    return saved === 'separate' || saved === 'include' ? saved : 'hide';
  });
  const set = React.useCallback((m: BotsMode) => { setMode(m); store.set('bots', m); }, []);
  return [mode, set];
}

/** The number a row/tile shows under the current bots mode. */
export const countFor = (mode: BotsMode, humans: number, bots: number): number =>
  mode === 'include' ? humans + bots : humans;

// ── Labels ───────────────────────────────────────────────────────────────────

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export type BreakdownKind = 'referrer' | 'country' | 'device' | 'browser' | 'os' | 'source';

/** Server keys (`(direct)`, `qr`, ISO country codes) → plain words. */
export function breakdownLabel(kind: BreakdownKind, key: string): string {
  if (key === '(direct)') return 'Direct';
  if (key === '(unknown)') return 'Unknown';
  if (kind === 'source') return key === 'qr' ? 'QR code' : 'Link';
  if (kind === 'device') return cap(key);
  if (kind === 'country' && /^[A-Za-z]{2}$/.test(key)) {
    try { return regionNames?.of(key.toUpperCase()) ?? key; } catch { return key; }
  }
  return key;
}

export const sumRows = (rows: Breakdown[], mode: BotsMode): number =>
  rows.reduce((n, r) => n + countFor(mode, r.humans, r.bots), 0);

/** `YYYY-MM-DD` → local Date (no timezone shift). */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function fmtDay(day: string, interval: Interval): string {
  const d = parseDay(day);
  if (interval === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
