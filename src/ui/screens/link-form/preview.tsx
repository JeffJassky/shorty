import React from 'react';
import type { InspectResult } from '../../../../types/index';
import type { ShortyClient } from '../../../../types/client';
import { Icons } from '../../components/icons';
import { hostOf } from '../../lib/format';
import { useDebounced } from '../../lib/use-async';
import type { Draft } from './draft';
import { QrPanel } from './qr';
import { SocialCards } from './social-cards';

export interface InspectState {
  result: InspectResult | null;
  /** True while a request is out, or the destination changed and the debounce is pending. */
  stale: boolean;
}

/** `client.inspect` 600ms after the URL settles. Keeps the last result while the next loads. */
export function useInspect(client: ShortyClient, url: string | null): InspectState {
  const settled = useDebounced(url, 600);
  const [result, setResult] = React.useState<InspectResult | null>(null);
  const [loadedFor, setLoadedFor] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!settled) { setResult(null); setLoadedFor(null); return; }
    let live = true;
    client.inspect(settled).then(
      (r) => { if (live) { setResult(r); setLoadedFor(settled); } },
      () => { if (live) { setResult(null); setLoadedFor(settled); } },
    );
    return () => { live = false; };
  }, [client, settled]);

  return { result, stale: url !== null && loadedFor !== url };
}

type Tab = 'social' | 'destination' | 'qr';

function statusTone(status: number): 'green' | 'amber' | 'red' {
  if (status >= 400) return 'red';
  if (status >= 300) return 'amber';
  return 'green';
}

function Destination({ state, onUseFinalUrl }: { state: InspectState; onUseFinalUrl: (url: string) => void }) {
  const r = state.result;
  if (!r) return <p className="muted text-sm">{state.stale ? 'Checking…' : 'No response.'}</p>;
  const hasPrivate = r.warnings.some((w) => w.code === 'private_address');
  return (
    <div className="vstack" style={{ gap: 12 }}>
      {r.final && (
        <div className="dest-final">
          <span className={`pill ${statusTone(r.final.status)}`}>{r.final.status}</span>
          <code className="dest-url">{r.final.url}</code>
          <span className="muted text-xs tabular">{r.final.ms} ms</span>
        </div>
      )}
      {r.chain.length > 1 && (
        <ol className="chain" aria-label="Redirect chain">
          {r.chain.map((hop, i) => (
            <li key={`${i}-${hop.url}`}>
              <span className={`pill ${statusTone(hop.status)}`}>{hop.status}</span>
              <code>{hop.url}</code>
            </li>
          ))}
        </ol>
      )}
      {r.warnings.map((w, i) => (
        w.code === 'private_address' ? (
          <p key={`${w.code}-${i}`} className="muted text-sm">Preview isn&apos;t available for internal addresses.</p>
        ) : (
          <div key={`${w.code}-${i}`} className="card warn-row" role="note">
            <Icons.Warning className="icon warn-ico" />
            <span className="grow">{w.message}</span>
            {w.fix && (
              <button type="button" className="btn btn-sm" onClick={() => onUseFinalUrl(w.fix!.url)}>Use final URL</button>
            )}
          </div>
        )
      ))}
      {!r.final && !hasPrivate && r.warnings.length === 0 && <p className="muted text-sm">No response.</p>}
    </div>
  );
}

export function Preview({
  draft, composedUrl, inspect, shortUrl, slugName, onUseFinalUrl,
}: {
  draft: Draft;
  composedUrl: string;
  inspect: InspectState;
  /** Public short URL when the slug is known. */
  shortUrl: string | null;
  slugName: string;
  onUseFinalUrl: (url: string) => void;
}) {
  const [tab, setTab] = React.useState<Tab>('social');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'social', label: 'Social' },
    { id: 'destination', label: 'Destination' },
    { id: 'qr', label: 'QR' },
  ];
  React.useEffect(() => { if (!tabs.some((t) => t.id === tab)) setTab('social'); }, [tabs, tab]);

  const og = inspect.result?.og ?? {};
  const domain = hostOf(composedUrl);
  const card = {
    title: draft.socialTitle.trim() || og.title || domain,
    description: draft.socialDescription.trim() || og.description,
    image: draft.socialImage.trim() || og.image,
    domain,
    siteName: og.siteName,
    favicon: og.favicon,
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    setTab(next.id);
    document.getElementById(`pv-tab-${next.id}`)?.focus();
  };

  return (
    <section className="card preview" aria-label="Preview">
      <div className="tabs preview-tabs" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`pv-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="pv-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={'tab' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="pv-panel" role="tabpanel" aria-labelledby={`pv-tab-${tab}`} className={'preview-body' + (inspect.stale ? ' stale' : '')}>
        {tab === 'social' && <SocialCards data={card} />}
        {tab === 'destination' && <Destination state={inspect} onUseFinalUrl={onUseFinalUrl} />}
        {tab === 'qr' && shortUrl && <QrPanel shortUrl={shortUrl} name={slugName || 'qr'} />}
      </div>
    </section>
  );
}
