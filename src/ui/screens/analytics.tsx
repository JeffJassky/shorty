import React from 'react';
import { BreakdownCard, RankTable, StatTile, TimeSeries } from '../components/charts';
import { RangeBar } from '../components/range-bar';
import { Tip } from '../components/tip';
import { DEFAULT_RANGE, countFor, useBotsMode, type RangeState } from '../lib/analytics';
import { useApp } from '../lib/context';
import { errorMessage } from '../lib/errors';
import { fmtNumber } from '../lib/format';
import { hrefs, navigate } from '../lib/router';
import { useRangeStats } from '../lib/use-stats';
import { Truncated } from './link-detail';

/** `#/analytics` — all links together (spec §3). */
export function AnalyticsScreen() {
  const { config } = useApp();
  const [range, setRange] = React.useState<RangeState>(DEFAULT_RANGE);
  const [bots, setBots] = useBotsMode();
  const { state, range: resolved, error } = useRangeStats(undefined, range);
  const stats = state.status === 'ready' ? state.data : null;
  const humans = stats?.totals.humans;
  const botTotals = stats?.totals.bots;

  const topLinks = (stats?.topLinks ?? [])
    .map((l) => ({ ...l, value: countFor(bots, l.humans, l.bots) }))
    .filter((l) => l.value > 0 || (bots === 'separate' && l.bots > 0))
    .sort((a, b) => b.value - a.value);
  const topCampaigns = (stats?.topCampaigns ?? [])
    .map((c) => ({ ...c, value: countFor(bots, c.humans, c.bots) }))
    .filter((c) => c.value > 0 || (bots === 'separate' && c.bots > 0))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="analytics">
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="page-desc">How all your links are doing.</p>
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
              label={<Tip label="Clicks that came from a link's QR code." focusable><span className="tip-label">QR scans</span></Tip>}
              value={humans ? fmtNumber(humans.qr) : <span className="skeleton kpi-sk" />}
            />
            {bots !== 'hide' && (
              <StatTile
                label={<Tip label="Bots are automated visitors like search crawlers and link previewers." focusable><span className="tip-label">Bot clicks</span></Tip>}
                value={botTotals ? fmtNumber(botTotals.clicks) : <span className="skeleton kpi-sk" />}
              />
            )}
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
                  />
                )
                : <div className="skeleton" style={{ height: 200 }} />}
            </div>
          </section>

          {stats && (
            <>
              <div className="bd-grid">
                <section className="card breakdown" aria-label="Top links">
                  <div className="card-head"><h3 className="card-title">Top links</h3></div>
                  <div className="card-body flush">
                    <RankTable
                      rows={topLinks}
                      empty="No clicks in this range"
                      onRow={(l) => navigate(hrefs.detail(l.linkId))}
                      columns={[
                        { key: 'slug', label: 'Link', render: (l) => <a className="rank-link" href={hrefs.detail(l.linkId)}>/{l.slug}</a> },
                        {
                          key: 'clicks',
                          label: 'Clicks',
                          num: true,
                          render: (l) => (
                            <>
                              {fmtNumber(l.value)}
                              {bots === 'separate' && l.bots > 0 && <span className="muted text-xs"> +{fmtNumber(l.bots)} bots</span>}
                            </>
                          ),
                        },
                      ]}
                    />
                  </div>
                </section>
                <section className="card breakdown" aria-label="Top campaigns">
                  <div className="card-head"><h3 className="card-title">Top campaigns</h3></div>
                  <div className="card-body flush">
                    <RankTable
                      rows={topCampaigns}
                      empty="No campaign tags in this range"
                      columns={[
                        { key: 'campaign', label: 'Campaign', render: (c) => c.campaign },
                        {
                          key: 'clicks',
                          label: 'Clicks',
                          num: true,
                          render: (c) => (
                            <>
                              {fmtNumber(c.value)}
                              {bots === 'separate' && c.bots > 0 && <span className="muted text-xs"> +{fmtNumber(c.bots)} bots</span>}
                            </>
                          ),
                        },
                      ]}
                    />
                  </div>
                </section>
                <BreakdownCard title="Referrers" kind="referrer" rows={stats.breakdowns.referrer} mode={bots} note={<Truncated show={stats.breakdownsTruncated} />} />
                <BreakdownCard title="Countries" kind="country" rows={stats.breakdowns.country} mode={bots} />
                <BreakdownCard title="Devices" kind="device" rows={stats.breakdowns.device} mode={bots} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
