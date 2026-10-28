import React from 'react';
import type { LinkJson } from '../../../../types/client';
import { Dialog } from '../../components/dialog';
import { Icons } from '../../components/icons';
import { Segmented } from '../../components/segmented';
import { Sheet } from '../../components/sheet';
import { IconButton, Tip } from '../../components/tip';
import { useToast } from '../../components/toast';
import { useApp } from '../../lib/context';
import {
  DESTINATION_CODES, SLUG_CODES, SLUG_REASON_CODE, errorCode, errorField, errorMessage, messageForCode,
} from '../../lib/errors';
import { hrefs, navigate } from '../../lib/router';
import { useAsync, useDebounced } from '../../lib/use-async';
import { Anatomy } from './anatomy';
import {
  applyDestination, buildCreate, buildPatch, composedOf, dirtyKey, draftFromLink, emptyDraft, type Draft,
} from './draft';
import {
  AdvancedGroup, FieldLabel, ParamsGroup, TagsField, UtmGroup, buildCatalog, type Patch,
} from './fields';
import { History } from './history';
import { HighlightContext, useFieldHighlight } from './highlight';
import { takePrefill } from './prefill';
import { Preview, useInspect } from './preview';

type SlugState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; slug: string }
  | { kind: 'bad'; code: string };

interface SaveError { code: string; message: string }

/** Route-level wrapper: loads the link in edit mode, then renders the form in a sheet. */
export function LinkFormScreen({ mode, id, from }: { mode: 'new' | 'edit'; id?: string; from?: 'detail' }) {
  const { client, config } = useApp();
  const loaded = useAsync<LinkJson | null>(() => (mode === 'edit' && id ? client.link(id) : Promise.resolve(null)), [client, mode, id]);
  // Opened from a link's detail page → go back there; otherwise the list.
  const close = React.useCallback(() => navigate(from === 'detail' && id ? hrefs.detail(id) : hrefs.list), [from, id]);
  const gone = React.useCallback(() => navigate(hrefs.list), []);

  if (mode === 'edit' && loaded.status !== 'ready') {
    return (
      <Sheet title="Edit link" onRequestClose={close} wide>
        <div className="sheet-body">
          {loaded.status === 'loading' && <div className="skeleton" style={{ height: 160 }} />}
          {loaded.status === 'error' && <p role="alert" className="form-error">{errorMessage(loaded.error)}</p>}
        </div>
      </Sheet>
    );
  }
  const link = loaded.status === 'ready' ? loaded.data : null;
  return <LinkForm key={link?.id ?? 'new'} initialLink={link} config={config} onClose={close} onGone={gone} closeAfterSave={from === 'detail'} />;
}

function LinkForm({ initialLink, config, onClose, onGone, closeAfterSave }: {
  initialLink: LinkJson | null;
  config: ReturnType<typeof useApp>['config'];
  onClose: () => void;
  /** The link no longer exists (deleted) — nowhere to go back to but the list. */
  onGone: () => void;
  /** Opened from the detail page: saving returns there instead of staying in the sheet. */
  closeAfterSave?: boolean;
}) {
  const { client, bumpLinks } = useApp();
  const toast = useToast();
  const editing = initialLink !== null;

  const [link, setLink] = React.useState<LinkJson | null>(initialLink);
  const [draft, setDraft] = React.useState<Draft>(() => {
    if (initialLink) return draftFromLink(initialLink, config, { keepSlug: true });
    const base = emptyDraft(config);
    const prefill = takePrefill();
    return prefill ? prefill(base) : base;
  });
  const [baseline, setBaseline] = React.useState(() => dirtyKey(draft));
  const [hlKey, setHlKey] = React.useState<string | null>(null);
  const [destError, setDestError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<SaveError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirm, setConfirm] = React.useState<null | 'discard' | 'rename' | 'archive'>(null);
  const [slugState, setSlugState] = React.useState<SlugState>({ kind: 'idle' });

  const patch: Patch = React.useCallback((p) => { setDraft((d) => ({ ...d, ...p })); setSaveError(null); }, []);
  const dirty = dirtyKey(draft) !== baseline;

  // Suggestions: fetched once per form open.
  const catalogLoad = useAsync(() => client.paramValues(), [client]);
  const tagsLoad = useAsync(() => client.tags(), [client]);
  const catalog = React.useMemo(
    () => buildCatalog(catalogLoad.status === 'ready' ? catalogLoad.data : []),
    [catalogLoad.status, catalogLoad.data],
  );

  // Auto slug.
  const [autoNonce, setAutoNonce] = React.useState(0);
  React.useEffect(() => {
    if (editing) return;
    let live = true;
    client.generateSlug().then((slug) => { if (live) setDraft((d) => ({ ...d, autoSlug: slug })); }).catch(() => {});
    return () => { live = false; };
  }, [client, editing, autoNonce]);

  // Custom slug availability.
  const typedSlug = draft.slug.trim();
  const debouncedSlug = useDebounced(typedSlug, 300);
  const slugChanged = editing ? typedSlug !== link?.slug : true;
  const customActive = editing || draft.slugMode === 'custom';
  React.useEffect(() => {
    if (!customActive || !debouncedSlug || (editing && debouncedSlug === link?.slug)) { setSlugState({ kind: 'idle' }); return; }
    let live = true;
    setSlugState({ kind: 'checking' });
    client.checkSlug(debouncedSlug, editing && link ? { linkId: link.id } : {}).then(
      (r) => { if (live) setSlugState(r.available ? { kind: 'ok', slug: r.slug } : { kind: 'bad', code: SLUG_REASON_CODE[r.reason ?? 'invalid'] }); },
      () => { if (live) setSlugState({ kind: 'idle' }); },
    );
    return () => { live = false; };
  }, [client, customActive, debouncedSlug, editing, link]);
  // Typing again invalidates the last verdict immediately.
  React.useEffect(() => { if (customActive && typedSlug !== debouncedSlug) setSlugState({ kind: 'checking' }); }, [customActive, typedSlug, debouncedSlug]);

  const composed = composedOf(draft);
  const inspect = useInspect(client, composed);

  const shownSlug = !customActive
    ? draft.autoSlug
    : slugState.kind === 'ok' ? slugState.slug : typedSlug;
  const shortUrl = shownSlug ? `${config.publicBaseUrl}/${shownSlug}` : null;

  const slugLocked = editing && link !== null && (
    config.slug.rename === 'never' || (config.slug.rename === 'untilClicked' && link.clicks > 0)
  );

  // ----- destination -----
  const commitDestination = (text: string) => {
    const { draft: next, error } = applyDestination(draft, text);
    setDraft(next);
    setDestError(error ? messageForCode(error) : null);
    setSaveError(null);
  };
  const onDestChange = (text: string) => {
    setSaveError(null);
    setDestError(null);
    // A query or fragment is split on paste/blur/Enter, never mid-keystroke.
    setDraft((d) => (/[?#]/.test(text)
      ? { ...d, destText: text, baseUrl: '' }
      : { ...applyDestination(d, text).draft, destText: text }));
  };

  // ----- save -----
  const destReady = Boolean(composed);
  const slugOk = !customActive || (editing && !slugChanged) || slugState.kind === 'ok' || slugLocked;
  const canSave = destReady && !saving && slugOk;

  const doSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      // A stale preview describes a different URL — never store it.
      const og = inspect.stale ? undefined : inspect.result?.og;
      const saved = editing && link
        ? await client.updateLink(link.id, buildPatch(draft, link, config, og))
        : await client.createLink(buildCreate(draft, config, og));
      bumpLinks();
      toast('Link saved', { copy: saved.shortUrl });
      if (editing && closeAfterSave) {
        onClose();
      } else if (editing) {
        setLink(saved);
        const next = draftFromLink(saved, config, { keepSlug: true });
        setDraft(next);
        setBaseline(dirtyKey(next));
      } else {
        onClose();
      }
    } catch (err) {
      const code = errorCode(err) ?? 'internal_error';
      setSaveError({ code, message: errorMessage(err) });
      if (code === 'slug_taken' && !editing && draft.slugMode === 'auto') setAutoNonce((n) => n + 1);
      if (code === 'validation') {
        const field = errorField(err);
        if (field) window.setTimeout(() => document.getElementById(`f-${field.replace(/\./g, '-')}`)?.focus(), 0);
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!canSave) return;
    if (editing && config.slug.rename === 'always' && slugChanged && typedSlug && !slugLocked) { setConfirm('rename'); return; }
    void doSave();
  };

  const requestClose = React.useCallback(() => {
    if (dirty) setConfirm('discard'); else onClose();
  }, [dirty, onClose]);

  const archive = async () => {
    setConfirm(null);
    if (!link) return;
    try {
      if (link.archived) await client.unarchiveLink(link.id); else await client.archiveLink(link.id);
      bumpLinks();
      onClose();
    } catch (err) {
      setSaveError({ code: errorCode(err) ?? 'internal_error', message: errorMessage(err) });
    }
  };

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };

  // ----- derived error placement -----
  const slugErrorText = saveError && SLUG_CODES.has(saveError.code) ? saveError.message : null;
  const destErrorText = destError ?? (saveError && DESTINATION_CODES.has(saveError.code) ? saveError.message : null);
  const bannerText = saveError && !SLUG_CODES.has(saveError.code) && !DESTINATION_CODES.has(saveError.code) ? saveError.message : null;

  const destHl = useFieldHighlight('dest');
  const og = inspect.result?.og;
  const originalSlug = link?.slug ?? '';

  return (
    <Sheet title={editing ? 'Edit link' : 'New link'} onRequestClose={requestClose} wide>
      <HighlightContext.Provider value={{ key: hlKey, set: setHlKey }}>
        <form
          className="lf"
          noValidate
          onSubmit={(e) => { e.preventDefault(); save(); }}
          onKeyDown={onKeyDown}
        >
          <div className="sheet-body">
            {bannerText && <p role="alert" className="form-error banner"><Icons.Warning className="icon" /> {bannerText}</p>}
            <div className="lf-grid">
              <div className="lf-main">
                {/* 1. Destination */}
                <div className={'field' + (destHl.hl ? ' hl' : '')} {...destHl.handlers}>
                  <FieldLabel htmlFor="f-dest">Destination</FieldLabel>
                  <input
                    id="f-dest"
                    className={'input' + (destErrorText ? ' invalid' : '')}
                    type="text"
                    inputMode="url"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://example.com/page"
                    value={draft.destText}
                    aria-invalid={Boolean(destErrorText)}
                    aria-describedby={destErrorText ? 'f-dest-error' : undefined}
                    onChange={(e) => onDestChange(e.target.value)}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text');
                      if (!text.trim()) return;
                      e.preventDefault();
                      commitDestination(text);
                    }}
                    onBlur={() => draft.destText.trim() && commitDestination(draft.destText)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); commitDestination(draft.destText); } }}
                  />
                  {destErrorText && <p id="f-dest-error" role="alert" className="form-error">{destErrorText}</p>}
                </div>

                {/* 2. Short link */}
                <div className="field">
                  <div className="field-label">
                    <label htmlFor={editing ? 'f-slug' : 'f-slug-seg'}>Short link</label>
                    {!editing && <Tip label="Auto picks a short random ending. Custom lets you choose it." focusable><Icons.Info className="icon info-ico" /></Tip>}
                  </div>
                  {!editing && (
                    <Segmented
                      id="f-slug-seg"
                      label="Short link ending"
                      value={draft.slugMode}
                      onChange={(v) => patch({ slugMode: v })}
                      options={[{ value: 'auto', label: 'Auto' }, { value: 'custom', label: 'Custom' }]}
                    />
                  )}
                  {!customActive && (
                    <div className="slug-auto">
                      <span className="mono slug-prefix">{config.publicBaseUrl}/</span>
                      <strong className="mono" data-testid="auto-slug">{draft.autoSlug || '…'}</strong>
                      <IconButton icon={<Icons.Refresh />} label="Pick another random ending" small onClick={() => setAutoNonce((n) => n + 1)} />
                    </div>
                  )}
                  {customActive && (
                    <>
                      <div className={'slug-input' + (slugLocked ? ' locked' : '')}>
                        <span className="mono slug-prefix">{config.publicBaseUrl}/</span>
                        <input
                          id="f-slug"
                          className="input mono"
                          autoComplete="off"
                          spellCheck={false}
                          value={draft.slug}
                          readOnly={slugLocked}
                          aria-invalid={Boolean(slugErrorText) || slugState.kind === 'bad'}
                          aria-describedby="f-slug-status"
                          onChange={(e) => patch({ slug: e.target.value })}
                        />
                        {slugLocked && (
                          <Tip
                            label={config.slug.rename === 'never' ? "Short links can't be renamed." : 'Locked after the first click so printed links keep working.'}
                            focusable
                          >
                            <Icons.Lock className="icon" />
                          </Tip>
                        )}
                      </div>
                      <div id="f-slug-status" className="slug-status" aria-live="polite">
                        {slugState.kind === 'ok' && (
                          <span className="ok"><Icons.Check className="icon" /> Available{slugState.slug !== typedSlug ? <> · will be saved as <code>{slugState.slug}</code></> : null}</span>
                        )}
                        {slugState.kind === 'bad' && <span className="bad" role="alert">{messageForCode(slugState.code)}</span>}
                        {slugErrorText && slugState.kind !== 'bad' && <span className="bad" role="alert">{slugErrorText}</span>}
                      </div>
                      {editing && !slugLocked && slugChanged && typedSlug && config.slug.rename === 'alias' && (
                        <p className="field-hint calm" role="note">The old link (<code>…/{originalSlug}</code>) will keep working.</p>
                      )}
                      {editing && !slugLocked && slugChanged && typedSlug && config.slug.rename === 'always' && (
                        <p className="field-hint warn-hint" role="note">Anyone using <code>…/{originalSlug}</code> will get a &lsquo;not found&rsquo; page.</p>
                      )}
                    </>
                  )}
                </div>

                {/* 3. UTM */}
                <UtmGroup draft={draft} patch={patch} catalog={catalog.byKey} />

                {/* 4. Extra parameters */}
                <ParamsGroup draft={draft} patch={patch} catalog={catalog.byKey} keys={catalog.keys} />

                {/* 5. Title, notes, tags */}
                <div className="field">
                  <FieldLabel htmlFor="f-title">Title</FieldLabel>
                  <input id="f-title" className="input" placeholder={og?.title ?? ''} value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
                </div>
                <div className="field">
                  <FieldLabel htmlFor="f-notes">Notes</FieldLabel>
                  <textarea id="f-notes" className="textarea" rows={3} value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} />
                </div>
                <TagsField draft={draft} patch={patch} suggestions={tagsLoad.status === 'ready' ? tagsLoad.data.map((t) => t.tag) : []} />

                {/* 6. Advanced */}
                <AdvancedGroup draft={draft} patch={patch} config={config} />
              </div>

              {composed && (
                <aside className="lf-side" aria-label="Live preview">
                  <Anatomy draft={draft} config={config} slug={shownSlug} onClearHash={() => patch({ hash: '' })} />
                  <Preview
                    draft={draft}
                    composedUrl={composed}
                    inspect={inspect}
                    shortUrl={shortUrl}
                    slugName={shownSlug}
                    onUseFinalUrl={commitDestination}
                  />
                </aside>
              )}
            </div>
            {editing && link && <History link={link} onDeleted={() => { bumpLinks(); toast('Link deleted'); onGone(); }} />}
          </div>

          <footer className="sheet-foot">
            {editing && link && (
              <button type="button" className="btn btn-ghost" onClick={() => (dirty ? setConfirm('archive') : void archive())}>
                {link.archived ? 'Unarchive' : 'Archive'}
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn" onClick={requestClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!canSave}>Save</button>
          </footer>
        </form>
      </HighlightContext.Provider>

      {confirm === 'discard' && (
        <Dialog title="Discard changes?" confirmLabel="Discard" cancelLabel="Keep editing" tone="danger" onConfirm={() => { setConfirm(null); onClose(); }} onCancel={() => setConfirm(null)}>
          <p>Your changes haven&apos;t been saved.</p>
        </Dialog>
      )}
      {confirm === 'archive' && (
        <Dialog title="Discard changes?" confirmLabel={link?.archived ? 'Discard and unarchive' : 'Discard and archive'} cancelLabel="Keep editing" tone="danger" onConfirm={() => void archive()} onCancel={() => setConfirm(null)}>
          <p>Your changes haven&apos;t been saved.</p>
        </Dialog>
      )}
      {confirm === 'rename' && (
        <Dialog title="Change the short link?" confirmLabel="Change it" tone="danger" onConfirm={() => { setConfirm(null); void doSave(); }} onCancel={() => setConfirm(null)}>
          <p>Anyone using <code>…/{originalSlug}</code> will get a &lsquo;not found&rsquo; page.</p>
        </Dialog>
      )}
    </Sheet>
  );
}
