import React from 'react';
import type { LinkJson } from '../../../types/client';
import type { LinksQuery } from '../../../types/index';
import { Dialog } from '../components/dialog';
import { Icons } from '../components/icons';
import { Menu } from '../components/menu';
import { CopyButton } from '../components/copy-button';
import { Tip } from '../components/tip';
import { useToast } from '../components/toast';
import { copyText } from '../lib/clipboard';
import { useApp } from '../lib/context';
import { errorMessage, messageForCode } from '../lib/errors';
import { fmtNumber, hostAndPath } from '../lib/format';
import { hrefs, navigate } from '../lib/router';
import { loadSpark } from '../lib/spark';
import { store, useDebounced } from '../lib/use-async';
import { applyDestination, draftFromLink, parseDestination } from './link-form/draft';
import { setPrefill } from './link-form/prefill';
import { QrPanel } from './link-form/qr';

type Sort = NonNullable<LinksQuery['sort']>;

function Spark({ link }: { link: LinkJson }) {
  const { client } = useApp();
  const ref = React.useRef<HTMLDivElement>(null);
  const [points, setPoints] = React.useState<number[] | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const start = () => { void loadSpark(client, link.id).then((p) => { if (live) setPoints(p); }); };
    if (typeof IntersectionObserver === 'undefined') { start(); return () => { live = false; }; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [client, link.id]);

  let path = '';
  if (points && points.length > 1) {
    const max = Math.max(1, ...points);
    const step = 100 / (points.length - 1);
    path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(28 - (v / max) * 24).toFixed(2)}`).join(' ');
  }
  return (
    <div ref={ref} className="spark-cell" aria-hidden="true">
      <svg className="spark" viewBox="0 0 100 32" preserveAspectRatio="none">
        {path
          ? <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          : <line x1="0" y1="28" x2="100" y2="28" stroke="var(--border-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}

function UtmChips({ link }: { link: LinkJson }) {
  const pick = (fields: readonly ('source' | 'medium' | 'campaign' | 'term' | 'content' | 'id')[]) =>
    fields.map((f) => link.utm[f]).filter((v): v is string => Boolean(v));
  const shown = pick(['source', 'medium', 'campaign']);
  const others = pick(['term', 'content', 'id']);
  const vals = [...shown, ...others];
  if (!vals.length) return <span className="subtle">—</span>;
  const rest = others.length;
  return (
    <span className="chips-inline">
      {shown.map((v, i) => <span key={`${i}-${v}`} className="tag">{v}</span>)}
      {rest > 0 && <Tip label={vals.join(' · ')}><span className="tag more">+{rest}</span></Tip>}
    </span>
  );
}

function Row({ link, onArchive, onQr, onDuplicate }: {
  link: LinkJson;
  onArchive: (l: LinkJson) => void;
  onQr: (l: LinkJson) => void;
  onDuplicate: (l: LinkJson) => void;
}) {
  const { config } = useApp();
  const toast = useToast();
  const dest = hostAndPath(link.destination);
  const title = link.title || `${dest.host}${dest.path}`;
  return (
    <li className={'link-row' + (link.archived ? ' archived' : '')}>
      <div className="cell cell-main">
        <span className="fav" aria-hidden="true">
          {link.og?.favicon
            ? <img src={link.og.favicon} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            : <Icons.Globe className="icon" />}
        </span>
        <div className="main-text">
          <div className="title-line">
            <a className="link-title" href={hrefs.edit(link.id)} title={title}>{title}</a>
            {link.archived && <span className="pill neutral">Archived</span>}
          </div>
          <div className="short-line">
            <code className="short-url">{link.shortUrl}</code>
            <CopyButton text={link.shortUrl} label="Copy short link" />
          </div>
        </div>
      </div>
      <div className="cell cell-dest">
        <Tip label={link.destination} className="block">
          <span className="dest-text"><strong>{dest.host}</strong><span className="muted">{dest.path}</span></span>
        </Tip>
      </div>
      <div className="cell cell-utm"><UtmChips link={link} /></div>
      {config.clicksEnabled && <div className="cell cell-spark"><Spark link={link} /></div>}
      {config.clicksEnabled && (
        <div className="cell cell-clicks tabular">
          <strong>{fmtNumber(link.clicks)}</strong>
          {link.botClicks > 0 && <span className="muted text-xs"> +{fmtNumber(link.botClicks)} bots</span>}
        </div>
      )}
      <div className="cell cell-actions">
        <Menu
          label={`Actions for ${title}`}
          className="kebab"
          items={[
            { label: 'Copy', icon: <Icons.Copy />, onSelect: () => { void copyText(link.shortUrl).then((ok) => ok && toast('Copied')); } },
            { label: 'QR code', icon: <Icons.QrCode />, onSelect: () => onQr(link) },
            { label: 'Duplicate', icon: <Icons.Copy />, onSelect: () => onDuplicate(link) },
            { label: 'Edit', icon: <Icons.Edit />, onSelect: () => navigate(hrefs.edit(link.id)) },
            { label: link.archived ? 'Unarchive' : 'Archive', icon: <Icons.Archive />, onSelect: () => onArchive(link) },
          ]}
        />
      </div>
    </li>
  );
}

export function LinksScreen({ active }: { active: boolean }) {
  const { client, config, linksVersion, bumpLinks } = useApp();
  const toast = useToast();
  const [q, setQ] = React.useState('');
  const dq = useDebounced(q.trim(), 250);
  const [tag, setTag] = React.useState('');
  const [sort, setSort] = React.useState<Sort>('newest');
  const [showArchived, setShowArchived] = React.useState(false);
  const [items, setItems] = React.useState<LinkJson[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [qrFor, setQrFor] = React.useState<LinkJson | null>(null);
  const [tags, setTags] = React.useState<Array<{ tag: string; count: number }>>([]);
  const [hint, setHint] = React.useState(() => store.get('paste-hint') !== 'dismissed');
  const reqId = React.useRef(0);

  const query: LinksQuery = React.useMemo(() => ({
    ...(dq ? { q: dq } : {}),
    ...(tag ? { tag } : {}),
    sort,
    ...(showArchived ? { archived: 'all' as const } : {}),
  }), [dq, tag, sort, showArchived]);

  React.useEffect(() => {
    const id = ++reqId.current;
    setError(null);
    client.links(query).then(
      (page) => { if (id === reqId.current) { setItems(page.items); setCursor(page.nextCursor); } },
      (err: unknown) => { if (id === reqId.current) { setError(errorMessage(err)); setItems((cur) => cur ?? []); } },
    );
  }, [client, query, linksVersion]);

  React.useEffect(() => { client.tags().then(setTags, () => {}); }, [client, linksVersion]);

  const loadMore = React.useCallback(() => {
    if (!cursor || loadingMore) return;
    const id = reqId.current;
    setLoadingMore(true);
    client.links({ ...query, cursor }).then(
      (page) => {
        if (id !== reqId.current) return;
        setItems((cur) => [...(cur ?? []), ...page.items.filter((l) => !(cur ?? []).some((c) => c.id === l.id))]);
        setCursor(page.nextCursor);
      },
      (err: unknown) => setError(errorMessage(err)),
    ).finally(() => setLoadingMore(false));
  }, [client, cursor, loadingMore, query]);

  const sentinel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) loadMore(); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  // Paste anywhere (outside inputs) starts a link.
  React.useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input,textarea,select,[contenteditable="true"]'))) return;
      const text = e.clipboardData?.getData('text')?.trim();
      if (!text || !parseDestination(text).ok) return;
      e.preventDefault();
      store.set('paste-hint', 'dismissed');
      setHint(false);
      setPrefill((base) => applyDestination(base, text).draft);
      navigate(hrefs.new);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [active]);

  const archive = async (l: LinkJson) => {
    try {
      if (l.archived) await client.unarchiveLink(l.id); else await client.archiveLink(l.id);
      bumpLinks();
    } catch (err) { toast(errorMessage(err)); }
  };
  const duplicate = (l: LinkJson) => {
    setPrefill((base) => ({ ...draftFromLink(l, config, { keepSlug: false }), autoSlug: base.autoSlug }));
    navigate(hrefs.new);
  };

  const filtering = Boolean(dq || tag || showArchived);
  const firstRun = items !== null && items.length === 0 && !filtering && !error;

  return (
    <div className="links">
      {!firstRun && (
        <div className="filter-bar links-filters">
          <div className="search-box">
            <Icons.Search className="icon" />
            <input
              id="links-search"
              className="input"
              type="search"
              placeholder="Search links"
              aria-label="Search links"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="select" aria-label="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
          </select>
          <select className="select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="newest">Newest</option>
            <option value="clicks">Most clicked</option>
            <option value="lastClicked">Last clicked</option>
          </select>
          <label className="switch-row">
            <input type="checkbox" role="switch" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <span>Show archived</span>
          </label>
        </div>
      )}

      {hint && !firstRun && items !== null && (
        <p className="paste-hint" role="note">
          Tip: paste a URL anywhere to start a link.
          <button type="button" className="icon-btn2 sm" aria-label="Dismiss tip" onClick={() => { store.set('paste-hint', 'dismissed'); setHint(false); }}><Icons.X /></button>
        </p>
      )}

      {error && <p role="alert" className="form-error">{error}</p>}

      {items === null && (
        <ul className="link-list" aria-busy="true">
          {[0, 1, 2].map((i) => <li key={i} className="link-row skeleton-row"><div className="skeleton" style={{ height: 40, width: '100%' }} /></li>)}
        </ul>
      )}

      {firstRun && <FirstRun />}

      {items !== null && items.length === 0 && filtering && <p className="muted empty-filter">No links match.</p>}

      {items !== null && items.length > 0 && (
        <>
          <div className={'card list-card' + (config.clicksEnabled ? '' : ' no-clicks')}>
            <div className="link-head" aria-hidden="true">
              <span>Link</span><span>Destination</span><span>Campaign</span>
              {config.clicksEnabled && <><span>30 days</span><span className="num">Clicks</span></>}
              <span />
            </div>
            <ul className="link-list">
              {items.map((l) => <Row key={l.id} link={l} onArchive={archive} onQr={setQrFor} onDuplicate={duplicate} />)}
            </ul>
          </div>
          <div ref={sentinel} />
          {cursor && (
            <div className="load-more">
              <button type="button" className="btn" disabled={loadingMore} onClick={loadMore}>Load more</button>
            </div>
          )}
        </>
      )}

      {qrFor && (
        <Dialog title="QR code" cancelLabel="Close" hideConfirm onCancel={() => setQrFor(null)}>
          <QrPanel shortUrl={qrFor.shortUrl} name={qrFor.slug.replace(/\//g, '-')} />
        </Dialog>
      )}
    </div>
  );
}

function FirstRun() {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseDestination(text.trim());
    if (!parsed.ok) { setError(parsed.code); return; }
    setPrefill((base) => applyDestination(base, text.trim()).draft);
    navigate(hrefs.new);
  };
  return (
    <div className="card first-run">
      <h2>Make your first short link</h2>
      <p className="muted">Shorten a URL, add campaign tags, and see who clicks.</p>
      <form onSubmit={go} className="first-run-form" noValidate>
        <input
          className="input"
          type="text"
          inputMode="url"
          aria-label="Destination URL"
          placeholder="https://example.com/page"
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary">Create</button>
      </form>
      {error && <p role="alert" className="form-error">{messageForCode(error)}</p>}
    </div>
  );
}
