import React from 'react';
import type { ParamKeyStat } from '../../../../types/index';
import type { Json } from '../../../../types/client';
import { Combobox, type ComboOption } from '../../components/combobox';
import { Disclosure } from '../../components/disclosure';
import { Icons } from '../../components/icons';
import { Tip, IconButton } from '../../components/tip';
import { FORM_UTM, isPermanent, newRowId, type Draft, type FormUtmField } from './draft';
import { useFieldHighlight } from './highlight';
import type { RedirectStatus, UiRuntimeConfig } from '../../../../types/index';

export type Patch = (p: Partial<Draft>) => void;

/** `key → suggested values` from `client.paramValues()`. */
export type Catalog = Map<string, ComboOption[]>;

export function buildCatalog(items: Array<Json<ParamKeyStat>>): { byKey: Catalog; keys: ComboOption[] } {
  const byKey: Catalog = new Map();
  const keys: ComboOption[] = [];
  for (const it of items) {
    byKey.set(it.key, it.values.map((v) => ({ value: v.value, count: v.count })));
    if (!it.key.startsWith('utm_')) keys.push({ value: it.key, count: it.count });
  }
  return { byKey, keys };
}

export function FieldLabel({ htmlFor, children, tip }: { htmlFor: string; children: React.ReactNode; tip?: string }) {
  return (
    <div className="field-label">
      <label htmlFor={htmlFor}>{children}</label>
      {tip && (
        <>
          <Tip label={tip} focusable><Icons.Info className="icon info-ico" /></Tip>
          <span id={`${htmlFor}-tip`} className="sr-only">{tip}</span>
        </>
      )}
    </div>
  );
}

const UTM_TIPS: Record<FormUtmField, string> = {
  source: 'Where the traffic comes from, e.g. instagram or newsletter.',
  medium: 'The kind of channel, e.g. social, email, cpc.',
  campaign: 'The campaign or promotion name, e.g. spring_sale.',
  term: 'Paid-search keyword, if any.',
  content: 'Tells apart links in the same campaign, e.g. header_button.',
};
const UTM_LABELS: Record<FormUtmField, string> = {
  source: 'Source', medium: 'Medium', campaign: 'Campaign', term: 'Term', content: 'Content',
};

function UtmField({ field, draft, patch, catalog }: { field: FormUtmField; draft: Draft; patch: Patch; catalog: Catalog }) {
  const id = `f-utm-${field}`;
  const { hl, handlers } = useFieldHighlight(`utm:${field}`);
  return (
    <div className={'field' + (hl ? ' hl' : '')} {...handlers}>
      <FieldLabel htmlFor={id} tip={UTM_TIPS[field]}>{UTM_LABELS[field]}</FieldLabel>
      <Combobox
        id={id}
        value={draft.utm[field]}
        onChange={(v) => patch({ utm: { ...draft.utm, [field]: v } })}
        options={catalog.get(`utm_${field}`) ?? []}
        describedBy={`${id}-tip`}
      />
    </div>
  );
}

export function UtmGroup({ draft, patch, catalog }: { draft: Draft; patch: Patch; catalog: Catalog }) {
  const any = FORM_UTM.some((f) => draft.utm[f].trim());
  const [opened, setOpened] = React.useState(any);
  const [moreOpened, setMoreOpened] = React.useState(Boolean(draft.utm.term || draft.utm.content));
  // A pasted URL fills the fields: open for it, but never close under the user's cursor.
  React.useEffect(() => { if (any) setOpened(true); }, [any]);
  React.useEffect(() => { if (draft.utm.term || draft.utm.content) setMoreOpened(true); }, [draft.utm.term, draft.utm.content]);
  return (
    <Disclosure title="Campaign tracking (UTM)" summary="Add campaign tags" open={opened} onOpenChange={setOpened} id="utm-group">
      <div className="grid-2">
        <UtmField field="source" draft={draft} patch={patch} catalog={catalog} />
        <UtmField field="medium" draft={draft} patch={patch} catalog={catalog} />
        <UtmField field="campaign" draft={draft} patch={patch} catalog={catalog} />
      </div>
      <Disclosure title="More" open={moreOpened} onOpenChange={setMoreOpened}>
        <div className="grid-2">
          <UtmField field="term" draft={draft} patch={patch} catalog={catalog} />
          <UtmField field="content" draft={draft} patch={patch} catalog={catalog} />
        </div>
      </Disclosure>
    </Disclosure>
  );
}

function ParamRowView({
  row, index, count, keys, catalog, patchRow, remove, move, onDragStart, onDropOn,
}: {
  row: Draft['params'][number];
  index: number;
  count: number;
  keys: ComboOption[];
  catalog: Catalog;
  patchRow: (id: string, p: Partial<Draft['params'][number]>) => void;
  remove: (id: string) => void;
  move: (id: string, delta: -1 | 1) => void;
  onDragStart: (id: string) => void;
  onDropOn: (id: string) => void;
}) {
  const { hl, handlers } = useFieldHighlight(`param:${row.id}`);
  const onKey = (e: React.KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(row.id, e.key === 'ArrowUp' ? -1 : 1);
  };
  return (
    <div
      className={'param-row' + (hl ? ' hl' : '')}
      role="group"
      aria-label={`Parameter ${index + 1} of ${count}`}
      onKeyDown={onKey}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDropOn(row.id); }}
      {...handlers}
    >
      <button
        type="button"
        id={`param-handle-${row.id}`}
        className="icon-btn2 sm grip"
        draggable
        aria-label="Reorder (Alt + arrow keys)"
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(row.id); }}
      >
        <Icons.Grip />
      </button>
      <Combobox
        id={`f-param-${row.id}-key`}
        label="Parameter name"
        placeholder="name"
        value={row.key}
        onChange={(v) => patchRow(row.id, { key: v })}
        options={keys}
      />
      <Combobox
        id={`f-param-${row.id}-value`}
        label="Parameter value"
        placeholder="value"
        value={row.value}
        onChange={(v) => patchRow(row.id, { value: v })}
        options={catalog.get(row.key.trim()) ?? []}
      />
      <IconButton icon={<Icons.X />} label="Remove parameter" small onClick={() => remove(row.id)} />
    </div>
  );
}

export function ParamsGroup({ draft, patch, catalog, keys }: { draft: Draft; patch: Patch; catalog: Catalog; keys: ComboOption[] }) {
  const dragging = React.useRef<string | null>(null);
  const [refocus, setRefocus] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!refocus) return;
    document.getElementById(`param-handle-${refocus}`)?.focus();
    setRefocus(null);
  }, [refocus]);

  const patchRow = (id: string, p: Partial<Draft['params'][number]>) =>
    patch({ params: draft.params.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= draft.params.length || from === to) return;
    const next = [...draft.params];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    patch({ params: next });
  };
  const move = (id: string, delta: -1 | 1) => {
    const i = draft.params.findIndex((r) => r.id === id);
    reorder(i, i + delta);
    setRefocus(id);
  };
  const add = () => {
    const id = newRowId();
    patch({ params: [...draft.params, { id, key: '', value: '' }] });
    window.setTimeout(() => document.getElementById(`f-param-${id}-key`)?.focus(), 0);
  };

  return (
    <div className="field params">
      <div className="field-label">
        <span>Extra parameters</span>
        <Tip label="Anything else to add to the destination URL." focusable><Icons.Info className="icon info-ico" /></Tip>
      </div>
      {draft.params.map((row, i) => (
        <ParamRowView
          key={row.id}
          row={row}
          index={i}
          count={draft.params.length}
          keys={keys}
          catalog={catalog}
          patchRow={patchRow}
          remove={(id) => patch({ params: draft.params.filter((r) => r.id !== id) })}
          move={move}
          onDragStart={(id) => { dragging.current = id; }}
          onDropOn={(id) => {
            const from = draft.params.findIndex((r) => r.id === dragging.current);
            reorder(from, draft.params.findIndex((r) => r.id === id));
            dragging.current = null;
          }}
        />
      ))}
      <div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={add}><Icons.Plus /> Add parameter</button>
      </div>
    </div>
  );
}

export function TagsField({ draft, patch, suggestions }: { draft: Draft; patch: Patch; suggestions: string[] }) {
  const [text, setText] = React.useState('');
  const listId = React.useId();
  const commit = (raw: string) => {
    const tag = raw.trim().replace(/,$/, '').trim();
    if (tag && !draft.tags.includes(tag)) patch({ tags: [...draft.tags, tag] });
    setText('');
  };
  return (
    <div className="field">
      <FieldLabel htmlFor="f-tags">Tags</FieldLabel>
      <div className="chips">
        {draft.tags.map((t) => (
          <span key={t} className="chip">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => patch({ tags: draft.tags.filter((x) => x !== t) })}><Icons.X /></button>
          </span>
        ))}
        <input
          id="f-tags"
          className="chip-input"
          list={listId}
          value={text}
          autoComplete="off"
          onChange={(e) => {
            if (e.target.value.endsWith(',')) commit(e.target.value); else setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) { e.preventDefault(); commit(text); }
            else if (e.key === 'Backspace' && !text && draft.tags.length) patch({ tags: draft.tags.slice(0, -1) });
          }}
          onBlur={() => text.trim() && commit(text)}
        />
        <datalist id={listId}>
          {suggestions.filter((s) => !draft.tags.includes(s)).map((s) => <option key={s} value={s} />)}
        </datalist>
      </div>
    </div>
  );
}

const TEMP_CODES: RedirectStatus[] = [302, 307];
const PERM_CODES: RedirectStatus[] = [301, 308];

export function AdvancedGroup({ draft, patch, config }: { draft: Draft; patch: Patch; config: UiRuntimeConfig }) {
  const permanent = isPermanent(draft.status);
  const codes = permanent ? PERM_CODES : TEMP_CODES;
  return (
    <Disclosure title="Advanced" storageKey="advanced-open" id="advanced">
      <fieldset className="field radios">
        <legend className="field-label">
          <span>Redirect type</span>
          <Tip label="Temporary (302) lets you change the destination later. Permanent (301) is cached by browsers." focusable><Icons.Info className="icon info-ico" /></Tip>
        </legend>
        <label className="radio">
          <input type="radio" name="redirect-type" checked={!permanent} onChange={() => patch({ status: isPermanent(config.redirect.status) ? 302 : config.redirect.status })} />
          Temporary (recommended)
        </label>
        <label className="radio">
          <input type="radio" name="redirect-type" checked={permanent} onChange={() => patch({ status: isPermanent(config.redirect.status) ? config.redirect.status : 301 })} />
          Permanent
        </label>
        {permanent && (
          <p className="field-hint warn-hint" role="note">
            Browsers remember permanent redirects — later edits may not reach people who already clicked.
          </p>
        )}
        {config.redirect.status !== 302 && (
          <select className="select select-sm" aria-label="Status code" value={draft.status} onChange={(e) => patch({ status: Number(e.target.value) as RedirectStatus })}>
            {codes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </fieldset>

      <div className="field">
        <label className="switch-row">
          <input type="checkbox" role="switch" checked={draft.forwardQuery} onChange={(e) => patch({ forwardQuery: e.target.checked })} />
          <span>Pass along extra URL parameters</span>
          <Tip label="If someone opens the short link with ?ref=x, it's added to the destination." focusable><Icons.Info className="icon info-ico" /></Tip>
        </label>
      </div>

      <div className="grid-2">
        <div className="field">
          <FieldLabel htmlFor="f-expiresAt">Expires</FieldLabel>
          <input id="f-expiresAt" type="datetime-local" className="input" value={draft.expiresAt} onChange={(e) => patch({ expiresAt: e.target.value })} />
        </div>
        <div className="field">
          <FieldLabel htmlFor="f-maxClicks" tip="Counts people, not bots.">Stop after N clicks</FieldLabel>
          <input id="f-maxClicks" type="number" min={1} step={1} className="input" value={draft.maxClicks} onChange={(e) => patch({ maxClicks: e.target.value })} aria-describedby="f-maxClicks-tip" />
        </div>
      </div>
      <div className="field">
        <FieldLabel htmlFor="f-expiredUrl">Then send people to</FieldLabel>
        <input id="f-expiredUrl" type="url" className="input" value={draft.expiredUrl} onChange={(e) => patch({ expiredUrl: e.target.value })} />
      </div>

      <fieldset className="field social-group">
        <legend className="field-label">
          <span>Custom social card</span>
          <Tip label="Shown when the link is shared on social apps. People who click still go to the destination." focusable><Icons.Info className="icon info-ico" /></Tip>
        </legend>
        <div className="field">
          <div className="field-label"><label htmlFor="f-social-title">Title</label><span className="counter">{draft.socialTitle.length}/120</span></div>
          <input id="f-social-title" className="input" maxLength={120} value={draft.socialTitle} onChange={(e) => patch({ socialTitle: e.target.value })} />
        </div>
        <div className="field">
          <div className="field-label"><label htmlFor="f-social-description">Description</label><span className="counter">{draft.socialDescription.length}/240</span></div>
          <textarea id="f-social-description" className="textarea" rows={2} maxLength={240} value={draft.socialDescription} onChange={(e) => patch({ socialDescription: e.target.value })} />
        </div>
        <div className="field">
          <FieldLabel htmlFor="f-social-image">Image URL</FieldLabel>
          <input id="f-social-image" type="url" className="input" value={draft.socialImage} onChange={(e) => patch({ socialImage: e.target.value })} aria-describedby="f-social-image-hint" />
          <span id="f-social-image-hint" className="field-hint">1200 × 630 works best</span>
        </div>
      </fieldset>
    </Disclosure>
  );
}
