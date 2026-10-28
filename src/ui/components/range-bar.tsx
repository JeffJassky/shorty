import React from 'react';
import { BOTS_OPTIONS, RANGE_OPTIONS, type BotsMode, type RangeKey, type RangeState } from '../lib/analytics';
import { Segmented } from './segmented';
import { Tip } from './tip';
import { Icons } from './icons';

/** Range picker + Bots control, shared by link detail and the overview. */
export function RangeBar({
  range, onRange, bots, onBots, error,
}: {
  range: RangeState;
  onRange: (r: RangeState) => void;
  bots: BotsMode;
  onBots: (m: BotsMode) => void;
  error?: string | null;
}) {
  return (
    <div className="range-bar">
      <div className="range-controls">
        <Segmented<RangeKey>
          label="Date range"
          value={range.key}
          options={RANGE_OPTIONS}
          onChange={(key) => onRange({ ...range, key })}
        />
        {range.key === 'custom' && (
          <span className="range-custom">
            <input
              type="date"
              className="input"
              aria-label="From date"
              value={range.from}
              max={range.to || undefined}
              onChange={(e) => onRange({ ...range, from: e.target.value })}
            />
            <span className="muted">to</span>
            <input
              type="date"
              className="input"
              aria-label="To date"
              value={range.to}
              min={range.from || undefined}
              onChange={(e) => onRange({ ...range, to: e.target.value })}
            />
          </span>
        )}
      </div>
      <div className="range-bots">
        <span className="field-label">
          <span id="bots-label">Bots</span>
          <Tip label="Bots are automated visitors like search crawlers and link previewers." focusable>
            <Icons.Info className="icon info-ico" />
          </Tip>
        </span>
        <Segmented<BotsMode> label="Bots" value={bots} options={BOTS_OPTIONS} onChange={onBots} />
      </div>
      {error && <p role="alert" className="form-error range-error">{error}</p>}
    </div>
  );
}
