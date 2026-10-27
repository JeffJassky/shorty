import React from 'react';
import type { HistoryEntry } from '../../../../types/index';
import type { Json } from '../../../../types/client';
import type { LinkJson } from '../../../../types/client';
import { Dialog } from '../../components/dialog';
import { Icons } from '../../components/icons';
import { Menu } from '../../components/menu';
import { useApp } from '../../lib/context';
import { dateOnly, daysAgo, diffMiddle, fmtDateTime, fmtNumber } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import { useAsync } from '../../lib/use-async';

type Entry = Json<HistoryEntry>;

function Diff({ from, to }: { from: string; to: string }) {
  const d = diffMiddle(from, to);
  return (
    <div className="hist-diff">
      <div className="hist-url"><span className="muted">{d.head}</span>{d.aMid && <del>{d.aMid}</del>}<span className="muted">{d.tail}</span></div>
      <div className="hist-arrow" aria-hidden="true"><Icons.Down className="icon" /></div>
      <div className="hist-url"><span className="muted">{d.head}</span>{d.bMid && <ins>{d.bMid}</ins>}<span className="muted">{d.tail}</span></div>
    </div>
  );
}

/** Timeline under the form: created, destination changes, renames — with clicks per revision. */
export function History({ link, onDeleted }: { link: LinkJson; onDeleted: () => void }) {
  const { client, config } = useApp();
  const [confirming, setConfirming] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const history = useAsync(() => client.history(link.id), [client, link.id, link.rev, link.slug]);
  const revisions = useAsync(async () => {
    if (!config.clicksEnabled) return new Map<string, number>();
    const created = new Date(link.createdAt);
    const earliest = daysAgo(399);
    const from = created > earliest ? created : earliest;
    const stats = await client.stats({ linkId: link.id, from: dateOnly(from), to: dateOnly(new Date()), top: 50 });
    return new Map(stats.breakdowns.revision.map((b) => [b.key, b.humans]));
  }, [client, link.id, link.rev, config.clicksEnabled]);

  const remove = async () => {
    try {
      await client.deleteLink(link.id);
      setConfirming(false);
      onDeleted();
    } catch (err) {
      setDeleteError(errorMessage(err));
    }
  };

  const clicksFor = (rev: number): number | null => (
    revisions.status === 'ready' && config.clicksEnabled ? revisions.data.get(String(rev)) ?? 0 : null
  );

  return (
    <section className="history" aria-label="History">
      <div className="history-head">
        <h3>History</h3>
        <Menu
          label="More"
          items={[{ label: 'Delete', icon: <Icons.Trash />, tone: 'danger', onSelect: () => { setTyped(''); setDeleteError(null); setConfirming(true); } }]}
        />
      </div>
      {history.status === 'loading' && <div className="skeleton" style={{ height: 48 }} />}
      {history.status === 'error' && <p role="alert" className="form-error">{errorMessage(history.error)}</p>}
      {history.status === 'ready' && (
        <ol className="timeline">
          {[...history.data].reverse().map((e, i) => (
            <li key={`${e.kind}-${e.at}-${i}`}>
              <div className="tl-head">
                <strong>{e.kind === 'created' ? 'Created' : e.kind === 'destination' ? 'Destination changed' : 'Renamed'}</strong>
                <span className="muted text-xs">{fmtDateTime(e.at)}{e.by?.name ? ` · ${e.by.name}` : ''}</span>
              </div>
              {e.kind === 'created' && <code className="tl-url">{e.destination}</code>}
              {e.kind === 'destination' && <Diff from={e.previous} to={e.destination} />}
              {e.kind === 'slug' && <div className="tl-url"><code>{e.from}</code> → <code>{e.to}</code></div>}
              {(e.kind === 'created' || e.kind === 'destination') && clicksFor(e.rev) !== null && (
                <span className="muted text-xs tabular">{fmtNumber(clicksFor(e.rev) ?? 0)} clicks</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {confirming && (
        <Dialog
          title="Delete this link?"
          tone="danger"
          confirmLabel="Delete"
          confirmDisabled={typed !== link.slug}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        >
          <p>This permanently deletes the link, its history and its stats. Type <code>{link.slug}</code> to confirm.</p>
          <input className="input" aria-label="Type the short link ending to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          {deleteError && <p role="alert" className="form-error">{deleteError}</p>}
        </Dialog>
      )}
    </section>
  );
}
