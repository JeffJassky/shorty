import React from 'react';
import type { LinkJson } from '../../../types/client';
import { Icons } from '../components/icons';
import { BreakdownCard, StatTile, TimeSeries, type ChartMarker } from '../components/charts';
import { CopyButton } from '../components/copy-button';
import { RangeBar } from '../components/range-bar';
import { Tip } from '../components/tip';
import { DEFAULT_RANGE, countFor, useBotsMode, type RangeState } from '../lib/analytics';
import { useApp } from '../lib/context';
import { errorMessage } from '../lib/errors';
import { dateOnly, fmtDateTime, fmtNumber, hostAndPath } from '../lib/format';
import { hrefs } from '../lib/router';
import { useAsync } from '../lib/use-async';
import { useRangeStats } from '../lib/use-stats';
import { relativeTime } from '../lib/analytics';

/** `#/links/:id` — one link's numbers (spec §3). */
export function LinkDetailScreen({ id }: { id: string }) {
  const { client, config, linksVersion } = useApp();
  const [range, setRange] = React.useState<RangeState>(DEFAULT_RANGE);
  const [bots, setBots] = useBotsMode();
  const loaded = useAsync<LinkJson>(() => client.link(id), [client, id, linksVersion]);
  const history = useAsync(() => client.history(id).catch(() => []), [client, id, linksVersion]);
  const { state, range: resolved, error } = useRangeStats(id, range);

  if (loaded.status === 'error') {
    return (
      <div className="detail">
        <a className="back-link" href={hrefs.list}><Icons.Chevron className="icon flip" /> All links</a>
        <p role="alert" className="form-error banner">{errorMessage(loaded.error)}</p>
      </div>
    );
  }
  const link = loaded.status === 'ready' ? loaded.data : null;
  const dest = link ? hostAndPath(link.destination) : null;
  const title = link ? link.title || `${dest!.host}${dest!.path}` : '';

  const markers: ChartMarker[] = history.status === 'ready'
    ? history.data.flatMap((h) => (h.kind === 'destination'
      ? [{ date: dateOnly(new Date(h.at)), label: `Destination changed · ${new Date(h.at).toLocaleDateString(undefined, { dateStyle: 'medium' })}` }]
      : []))
    : [];

  const stats = state.status === 'ready' ? state.data : null;
  const humans = stats?.totals.humans;
  const botTotals = stats?.totals.bots;

  return (
    <div className="detail">
      <a className="back-link" href={hrefs.list}><Icons.Chevron className="icon flip" /> All links</a>

      <header className="page-head detail-head">
        {link ? (
          <div className="detail-id">
            <h1 title={title}>{title}</h1>
            <div className="short-line">
              <code className="short-url">{link.shortUrl}</code>
              <CopyButton text={link.shortUrl} label="Copy short link" />
              {link.archived && <span className="pill neutral">Archived</span>}
            </div>
            <div className="detail-dest">
              <Icons.ArrowRight className="icon muted" />
              <Tip label={link.destination} className="block">
                <span className="dest-text"><strong>{dest!.host}</strong><span className="muted">{dest!.path}</span></span>
              </Tip>
            </div>
          </div>
        ) : <div className="skeleton" style={{ height: 64, flex: 1 }} />}
        <div className="right">
          {link && <a className="btn" href={hrefs.edit(link.id, 'detail')}><Icons.Edit /> Edit</a>}
        </div>
      </header>

      {!config.clicksEnabled && <p className="muted" role="note">Click recording is turned off, so there are no numbers to show.</p>}

      {config.clicksEnabled && (
        <>
          <RangeBar range={range} onRange={setRange} bots={bots} onBots={setBots} error={error} />

          {state.status === 'error' && <p role="alert" className="form-error banner">{errorMessage(state.error)}</p>}

          <div className="kpis">
            <StatTile
              label="Clicks"
              value={humans ? fmtNumber(countFor(bots, humans.clicks, botTotals!.clicks)) : <span className="skeleton kpi-sk" />}
              meta={bots === 'separate' && botTotals && botTotals.clicks > 0 ? `+${fmtNumber(botTotals.clicks)} bots` : undefined}
            />
            <StatTile
              label={<Tip label="First click from a visitor within an hour" focusable><span className="tip-label">Unique visitors</span></Tip>}
              value={humans ? fmtNumber(countFor(bots, humans.uniques, botTotals!.uniques)) : <span className="skeleton kpi-sk" />}
              meta={bots === 'separate' && botTotals && botTotals.uniques > 0 ? `+${fmtNumber(botTotals.uniques)} bots` : undefined}
            />
            <StatTile
              label={<Tip label="Clicks that came from this link's QR code." focusable><span className="tip-label">QR scans</span></Tip>}
              value={humans ? fmtNumber(humans.qr) : <span className="skeleton kpi-sk" />}
            />
            <StatTile
              label="Last click"
              value={link ? relativeTime(link.lastClickedAt) : <span className="skeleton kpi-sk" />}
              meta={link?.lastClickedAt ? fmtDateTime(link.lastClickedAt) : undefined}
            />
          </div>

          <section className="card chart-card" aria-label="Clicks over time">
            <div className="card-head">
              <h2 className="card-title">Clicks over time</h2>
              {resolved && <span className="card-sub">by {resolved.interval}</span>}
            </div>
            <div className="card-body">
              {stats && resolved
                ? (
                  <TimeSeries
                    points={stats.series.map((p) => ({ date: p.date, humans: p.humans.clicks, bots: p.bots.clicks }))}
                    mode={bots}
                    interval={stats.range.interval}
                    markers={markers}
                  />
                )
                : <div className="skeleton" style={{ height: 200 }} />}
            </div>
          </section>

          {stats && (
            <div className="bd-grid">
              <BreakdownCard title="Referrers" kind="referrer" rows={stats.breakdowns.referrer} mode={bots} note={<Truncated show={stats.breakdownsTruncated} />} />
              <BreakdownCard title="Countries" kind="country" rows={stats.breakdowns.country} mode={bots} />
              <BreakdownCard title="Devices" kind="device" rows={stats.breakdowns.device} mode={bots} />
              <BreakdownCard title="Browsers" kind="browser" rows={stats.breakdowns.browser} mode={bots} />
              <BreakdownCard title="Operating systems" kind="os" rows={stats.breakdowns.os} mode={bots} />
              <BreakdownCard title="QR vs link" kind="source" rows={stats.breakdowns.source} mode={bots} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Raw clicks age out; the daily totals don't (spec §3). */
export function Truncated({ show }: { show: boolean }) {
  if (!show) return null;
  return <p className="muted text-xs bd-note">Details older than the retention window aren't kept; totals are.</p>;
}
