import React from 'react';
import type { Breakdown } from '../../../types/index';
import {
  breakdownLabel, countFor, fmtDay, type BotsMode, type BreakdownKind, type Interval,
} from '../lib/analytics';
import { fmtNumber } from '../lib/format';

/**
 * Hand-rolled SVG charts, ported from telemetry's atoms (StatTile, TimeSeries,
 * BreakdownTable). No chart dependency; tokens only, so both themes work.
 */

export function StatTile({ label, value, meta }: { label: React.ReactNode; value: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {meta ? <div className="kpi-meta">{meta}</div> : null}
    </div>
  );
}

/** Width of the element, tracked so chart text stays a readable size at 375px. */
function useWidth(fallback: number): [React.RefObject<HTMLDivElement>, number] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(fallback);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const next = Math.round(el.getBoundingClientRect().width); if (next > 0) setW(next); };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface SeriesPoint { date: string; humans: number; bots: number }
export interface ChartMarker { date: string; label: string }

/**
 * Clicks over time. Humans are the line (and wash); bots are a muted band
 * stacked above it when shown separately, or summed into the line when
 * included. Markers are vertical ticks (destination changes).
 */
export function TimeSeries({
  points, mode, interval, markers = [], height = 200,
}: {
  points: SeriesPoint[];
  mode: BotsMode;
  interval: Interval;
  markers?: ChartMarker[];
  height?: number;
}) {
  const [wrap, W] = useWidth(720);
  const H = height;
  const pad = { l: 8, r: 8, t: 14, b: 22 };
  const n = points.length;
  if (!n) return <div className="empty-note">No data in range</div>;

  const line = points.map((p) => countFor(mode, p.humans, p.bots));
  const top = points.map((p, i) => (mode === 'separate' ? line[i] + p.bots : line[i]));
  const max = Math.max(...top, 1);
  // Same semantics as the KPI tiles: Hide / Show separately count people only
  // (bots are stated apart), Include sums them.
  const lineTotal = line.reduce((a, b) => a + b, 0);
  const botTotal = points.reduce((a, p) => a + p.bots, 0);
  const total = lineTotal + (mode === 'separate' ? botTotal : 0);
  const x = (i: number) => pad.l + (n === 1 ? 0.5 : i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const base = H - pad.b;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const step = n > 1 ? (W - pad.l - pad.r) / (n - 1) : W - pad.l - pad.r;

  const wantTicks = W < 520 ? 3 : 5;
  const ticks = [...new Set(Array.from({ length: Math.min(wantTicks, n) }, (_, k) => Math.round((k * (n - 1)) / Math.max(Math.min(wantTicks, n) - 1, 1))))];

  // A marker belongs to the last bucket that starts on or before its date.
  const marks = markers.flatMap((m) => {
    let idx = -1;
    for (let i = 0; i < n; i++) if (points[i].date <= m.date) idx = i;
    return idx >= 0 ? [{ idx, label: m.label }] : [];
  });

  const summary = `${fmtNumber(lineTotal)} ${lineTotal === 1 ? 'click' : 'clicks'}${mode === 'separate' ? `, ${fmtNumber(botTotal)} ${botTotal === 1 ? 'bot' : 'bots'}` : ''}, ${fmtDay(points[0].date, interval)} to ${fmtDay(points[n - 1].date, interval)}`;

  return (
    <div ref={wrap} className="chart-wrap">
      {mode === 'separate' && (
        <div className="chart-legend" aria-hidden="true">
          <span><i className="swatch humans" /> People</span>
          <span><i className="swatch bots" /> Bots</span>
        </div>
      )}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={summary} data-testid="timeseries">
        <g className="chart-grid">
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} />)}
          <line className="chart-base" x1={pad.l} x2={W - pad.r} y1={base} y2={base} />
        </g>
        {mode === 'separate' && (
          <path
            className="chart-bots"
            data-testid="bot-band"
            d={`${path(top)}${line.map((v, i) => `L${x(n - 1 - i).toFixed(1)},${y(line[n - 1 - i]).toFixed(1)}`).join('')}Z`}
          />
        )}
        {n > 1 && <path className="chart-area" d={`${path(line)}L${x(n - 1)},${base}L${x(0)},${base}Z`} />}
        <path className="chart-line" d={path(line)} />
        {marks.map((m, i) => (
          <g key={`${m.idx}-${i}`} className="chart-marker" data-testid="revision-marker">
            <line x1={x(m.idx)} x2={x(m.idx)} y1={pad.t} y2={base} />
            <line className="hit" x1={x(m.idx)} x2={x(m.idx)} y1={pad.t} y2={base} />
            <path d={`M${x(m.idx) - 4},${pad.t - 2}h8l-4,6z`} />
            <title>{m.label}</title>
          </g>
        ))}
        {points.map((p, i) => (
          <g key={p.date} className="chart-hit">
            <rect x={x(i) - step / 2} y={pad.t} width={Math.max(step, 1)} height={base - pad.t} />
            <circle className="chart-dot" cx={x(i)} cy={y(line[i])} r="3.5" />
            <title>
              {`${fmtDay(p.date, interval)} · ${fmtNumber(line[i])} clicks${mode === 'separate' && p.bots ? ` · ${fmtNumber(p.bots)} bots` : ''}`}
            </title>
          </g>
        ))}
        <g className="chart-axis">
          {ticks.map((i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}>
              {fmtDay(points[i].date, interval)}
            </text>
          ))}
          <text x={pad.l} y={pad.t - 3}>{fmtNumber(max)}</text>
        </g>
      </svg>
      {total === 0 && <p className="chart-empty muted">No clicks in this range</p>}
    </div>
  );
}

/** One "top N" card: label, bar, count. */
export function BreakdownCard({
  title, kind, rows, mode, empty = 'No data in this range', note,
}: {
  title: string;
  kind: BreakdownKind;
  rows: Breakdown[];
  mode: BotsMode;
  empty?: string;
  note?: React.ReactNode;
}) {
  const shown = rows
    .map((r) => ({ ...r, value: countFor(mode, r.humans, r.bots) }))
    .filter((r) => r.value > 0 || (mode === 'separate' && r.bots > 0))
    .sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...shown.map((r) => r.value));
  return (
    <section className="card breakdown" aria-label={title}>
      <div className="card-head"><h3 className="card-title">{title}</h3></div>
      <div className="card-body">
        {shown.length === 0
          ? <p className="muted bd-empty">{empty}</p>
          : (
            <ul className="bd-list">
              {shown.map((r) => (
                <li key={r.key} className="bd-row">
                  <div className="bd-bar" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} aria-hidden="true" />
                  <span className="bd-label" title={r.key}>{breakdownLabel(kind, r.key)}</span>
                  {mode === 'separate' && r.bots > 0 && <span className="bd-bots muted text-xs">+{fmtNumber(r.bots)} bots</span>}
                  <span className="bd-count tabular">{fmtNumber(r.value)}</span>
                </li>
              ))}
            </ul>
          )}
        {note}
      </div>
    </section>
  );
}

/** Ranked table whose rows go somewhere (top links, top campaigns). */
export function RankTable<T>({
  rows, columns, onRow, empty,
}: {
  rows: T[];
  columns: Array<{ key: string; label: string; num?: boolean; render: (r: T) => React.ReactNode }>;
  onRow?: (r: T) => void;
  empty: string;
}) {
  if (!rows.length) return <p className="muted bd-empty">{empty}</p>;
  return (
    <table className="table rank-table">
      <thead>
        <tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={i}
            onClick={onRow ? (e) => { if (!(e.target as HTMLElement).closest('a')) onRow(r); } : undefined}
          >
            {columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render(r)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
