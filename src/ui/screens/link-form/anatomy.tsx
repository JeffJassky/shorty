import React from 'react';
import { utmKey } from '../../../shared/url';
import { isPermanent, FORM_UTM, type Draft } from './draft';
import { composedOf } from './draft';
import { CopyButton } from '../../components/copy-button';
import { Icons } from '../../components/icons';
import { Tip } from '../../components/tip';
import { fieldDomId, useHighlight } from './highlight';
import type { UiRuntimeConfig } from '../../../../types/index';

type Kind = 'origin' | 'path' | 'utm' | 'custom' | 'hash';

function Seg({ k, kind, children, title, onRemove }: {
  k: string;
  kind: Kind;
  children: React.ReactNode;
  title?: string;
  onRemove?: () => void;
}) {
  const h = useHighlight();
  const focusField = () => document.getElementById(fieldDomId(k))?.focus();
  return (
    <span className="anat-seg-wrap">
      <button
        type="button"
        className={`anat-seg ${kind}` + (h.key === k ? ' hl' : '')}
        title={title}
        onMouseEnter={() => h.set(k)}
        onMouseLeave={() => h.set(null)}
        onFocus={() => h.set(k)}
        onBlur={() => h.set(null)}
        onClick={focusField}
      >
        {children}
      </button>
      {onRemove && (
        <button type="button" className="anat-x" aria-label="Remove fragment" onClick={onRemove}>
          <Icons.X />
        </button>
      )}
    </span>
  );
}

/** The short URL, then the final URL broken into coloured segments (spec §2.3). */
export function Anatomy({
  draft, config, slug, onClearHash,
}: {
  draft: Draft;
  config: UiRuntimeConfig;
  slug: string;
  onClearHash: () => void;
}) {
  const composed = composedOf(draft);
  if (!composed) return null;

  let origin = draft.baseUrl;
  let path = '';
  try {
    const u = new URL(draft.baseUrl);
    origin = u.origin;
    path = u.pathname;
  } catch { /* baseUrl was validated by parseUrl */ }

  const query: Array<{ k: string; kind: 'utm' | 'custom'; text: string }> = [];
  for (const f of FORM_UTM) {
    const v = draft.utm[f].trim();
    if (v) query.push({ k: `utm:${f}`, kind: 'utm', text: `${utmKey(f)}=${v}` });
  }
  for (const p of draft.params) {
    if (p.key.trim()) query.push({ k: `param:${p.id}`, kind: 'custom', text: p.value === '' ? p.key.trim() : `${p.key.trim()}=${p.value}` });
  }

  return (
    <section className="card anatomy" aria-label="Link anatomy">
      <div className="anat-short">
        <span className="anat-muted">{config.publicBaseUrl}/</span>
        <strong>{slug || '…'}</strong>
      </div>
      <div className="anat-arrow" aria-hidden="true">
        <Icons.Down className="icon" />
        <span>{isPermanent(draft.status) ? 'permanent' : 'temporary'}</span>
      </div>
      <div className="anat-final">
        <Seg k="dest" kind="origin">{origin}</Seg>
        <Seg k="dest" kind="path">{path}</Seg>
        {query.map((q, i) => (
          <React.Fragment key={q.k}>
            <span className="anat-sep" aria-hidden="true">{i === 0 ? '?' : '&'}</span>
            <Seg k={q.k} kind={q.kind}>{q.text}</Seg>
          </React.Fragment>
        ))}
        {draft.hash && (
          <>
            <span className="anat-sep" aria-hidden="true">#</span>
            <Seg k="hash" kind="hash" onRemove={onClearHash}>{draft.hash}</Seg>
          </>
        )}
        {draft.forwardQuery && (
          <Tip label="Parameters on the short link are passed along.">
            <span className="anat-tail">+ ?…</span>
          </Tip>
        )}
        <CopyButton text={composed} label="Copy final URL" />
      </div>
    </section>
  );
}
