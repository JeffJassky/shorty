import type { LinkInput, LinkPatch, Param, RedirectStatus, UrlParts, Utm, UtmField } from '../../../../types/index';
import type { Json, LinkJson } from '../../../../types/client';
import type { OgData, UiRuntimeConfig } from '../../../../types/index';
import { composeUrl, parseUrl, UTM_FIELDS } from '../../../shared/url';
import { fromLocalInput, toLocalInput } from '../../lib/format';

/** The five UTM fields the form edits (`id` is kept as an ordinary parameter). */
export const FORM_UTM = ['source', 'medium', 'campaign', 'term', 'content'] as const;
export type FormUtmField = (typeof FORM_UTM)[number];

export interface ParamRow { id: string; key: string; value: string }

export interface Draft {
  /** What is in the destination box. Holds the base URL once it has been split. */
  destText: string;
  /** Valid base URL, or '' while the box is empty or invalid. */
  baseUrl: string;
  utm: Record<FormUtmField, string>;
  params: ParamRow[];
  hash: string;
  slugMode: 'auto' | 'custom';
  autoSlug: string;
  slug: string;
  title: string;
  notes: string;
  tags: string[];
  status: RedirectStatus;
  forwardQuery: boolean;
  expiresAt: string;
  maxClicks: string;
  expiredUrl: string;
  socialTitle: string;
  socialDescription: string;
  socialImage: string;
}

let rowSeq = 0;
export const newRowId = (): string => `p${++rowSeq}`;

export function emptyDraft(config: UiRuntimeConfig): Draft {
  return {
    destText: '',
    baseUrl: '',
    utm: { source: '', medium: '', campaign: '', term: '', content: '' },
    params: [],
    hash: '',
    slugMode: 'auto',
    autoSlug: '',
    slug: '',
    title: '',
    notes: '',
    tags: [],
    status: config.redirect.status,
    forwardQuery: config.redirect.forwardQuery,
    expiresAt: '',
    maxClicks: '',
    expiredUrl: '',
    socialTitle: '',
    socialDescription: '',
    socialImage: '',
  };
}

/** Fold `utm_id` into the params list — the form has no field for it, and nothing may be dropped. */
function foldParts(parts: UrlParts): { utm: Draft['utm']; params: ParamRow[]; extra: Param[] } {
  const utm = { source: '', medium: '', campaign: '', term: '', content: '' } as Draft['utm'];
  for (const f of FORM_UTM) utm[f] = parts.utm[f] ?? '';
  const extra: Param[] = parts.utm.id ? [{ key: 'utm_id', value: parts.utm.id }] : [];
  return { utm, params: [...extra, ...parts.params].map((p) => ({ id: newRowId(), key: p.key, value: p.value })), extra };
}

export function partsIntoDraft(base: Draft, parts: UrlParts): Draft {
  const { utm, params } = foldParts(parts);
  return { ...base, destText: parts.baseUrl, baseUrl: parts.baseUrl, utm, params, hash: parts.hash ?? '' };
}

export type Parsed = { ok: true; parts: UrlParts } | { ok: false; code: string };

export function parseDestination(text: string): Parsed {
  try {
    return { ok: true, parts: parseUrl(text) };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code ?? 'invalid_url' };
  }
}

/**
 * Apply a pasted/typed destination. A URL that carries a query or fragment
 * replaces the tracking fields; a bare URL only swaps the base and keeps
 * whatever was already filled in.
 */
export function applyDestination(draft: Draft, text: string): { draft: Draft; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { draft: { ...draft, destText: '', baseUrl: '' } };
  const parsed = parseDestination(trimmed);
  if (!parsed.ok) return { draft: { ...draft, destText: text, baseUrl: '' }, error: parsed.code };
  const { parts } = parsed;
  const hasTail = Boolean(parts.hash) || parts.params.length > 0 || Object.keys(parts.utm).length > 0;
  if (hasTail) return { draft: partsIntoDraft(draft, parts) };
  return { draft: { ...draft, destText: parts.baseUrl, baseUrl: parts.baseUrl } };
}

export function draftPartsOf(d: Draft): UrlParts | null {
  if (!d.baseUrl) return null;
  const utm: Utm = {};
  for (const f of FORM_UTM) if (d.utm[f].trim()) utm[f] = d.utm[f].trim();
  const params = d.params.filter((p) => p.key.trim()).map((p) => ({ key: p.key.trim(), value: p.value }));
  return { baseUrl: d.baseUrl, utm, params, ...(d.hash ? { hash: d.hash } : {}) };
}

export function composedOf(d: Draft): string | null {
  const parts = draftPartsOf(d);
  if (!parts) return null;
  try { return composeUrl(parts); } catch { return null; }
}

export function draftFromLink(link: LinkJson, config: UiRuntimeConfig, opts: { keepSlug: boolean }): Draft {
  const base = emptyDraft(config);
  const { utm, params } = foldParts({ baseUrl: link.baseUrl, utm: link.utm, params: link.params, hash: link.hash });
  return {
    ...base,
    destText: link.baseUrl,
    baseUrl: link.baseUrl,
    utm,
    params,
    hash: link.hash ?? '',
    slugMode: opts.keepSlug ? 'custom' : 'auto',
    slug: opts.keepSlug ? link.slug : '',
    title: link.title ?? '',
    notes: link.notes ?? '',
    tags: link.tags,
    status: link.redirect.status ?? config.redirect.status,
    forwardQuery: link.redirect.forwardQuery ?? config.redirect.forwardQuery,
    expiresAt: toLocalInput(link.expiresAt),
    maxClicks: link.maxClicks === undefined ? '' : String(link.maxClicks),
    expiredUrl: link.expiredUrl ?? '',
    socialTitle: link.social?.title ?? '',
    socialDescription: link.social?.description ?? '',
    socialImage: link.social?.image ?? '',
  };
}

export const isPermanent = (s: RedirectStatus): boolean => s === 301 || s === 308;

const nonEmptyOg = (og: OgData | undefined): OgData | undefined =>
  og && Object.values(og).some(Boolean) ? og : undefined;

function socialOf(d: Draft) {
  const social = {
    ...(d.socialTitle.trim() ? { title: d.socialTitle.trim() } : {}),
    ...(d.socialDescription.trim() ? { description: d.socialDescription.trim() } : {}),
    ...(d.socialImage.trim() ? { image: d.socialImage.trim() } : {}),
  };
  return Object.keys(social).length ? social : undefined;
}

function maxClicksOf(d: Draft): number | undefined {
  const n = Number.parseInt(d.maxClicks, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function buildCreate(d: Draft, config: UiRuntimeConfig, og: OgData | undefined): Json<LinkInput> {
  const parts = draftPartsOf(d);
  if (!parts) throw new Error('shorty: no destination');
  const redirect = {
    ...(d.status !== config.redirect.status ? { status: d.status } : {}),
    ...(d.forwardQuery !== config.redirect.forwardQuery ? { forwardQuery: d.forwardQuery } : {}),
  };
  const slug = d.slugMode === 'auto' ? d.autoSlug : d.slug.trim();
  return {
    ...parts,
    ...(slug ? { slug } : {}),
    ...(d.title.trim() ? { title: d.title.trim() } : {}),
    ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
    tags: d.tags,
    ...(Object.keys(redirect).length ? { redirect } : {}),
    ...(fromLocalInput(d.expiresAt) ? { expiresAt: fromLocalInput(d.expiresAt) } : {}),
    ...(maxClicksOf(d) ? { maxClicks: maxClicksOf(d) } : {}),
    ...(d.expiredUrl.trim() ? { expiredUrl: d.expiredUrl.trim() } : {}),
    ...(socialOf(d) ? { social: socialOf(d) } : {}),
    ...(nonEmptyOg(og) ? { og: nonEmptyOg(og) } : {}),
  };
}

/** A whole-form patch: cleared optional fields are sent as `null`. */
export function buildPatch(d: Draft, original: LinkJson, config: UiRuntimeConfig, og: OgData | undefined): Json<LinkPatch> {
  const parts = draftPartsOf(d);
  if (!parts) throw new Error('shorty: no destination');
  const utm: NonNullable<Json<LinkPatch>['utm']> = {};
  for (const f of UTM_FIELDS as readonly UtmField[]) utm[f] = parts.utm[f] ?? null;
  const slug = d.slug.trim();
  return {
    baseUrl: parts.baseUrl,
    utm,
    params: parts.params,
    hash: parts.hash ?? null,
    ...(slug && slug !== original.slug ? { slug } : {}),
    title: d.title.trim() || null,
    notes: d.notes.trim() || null,
    tags: d.tags,
    redirect: {
      status: d.status !== config.redirect.status ? d.status : null,
      forwardQuery: d.forwardQuery !== config.redirect.forwardQuery ? d.forwardQuery : null,
    },
    expiresAt: fromLocalInput(d.expiresAt) ?? null,
    maxClicks: maxClicksOf(d) ?? null,
    expiredUrl: d.expiredUrl.trim() || null,
    social: socialOf(d) ?? null,
    ...(nonEmptyOg(og) ? { og: nonEmptyOg(og) } : {}),
  };
}

/** Stable text of everything the user can edit, for the dirty check. */
export function dirtyKey(d: Draft): string {
  const { autoSlug: _autoSlug, params, ...rest } = d;
  return JSON.stringify({ ...rest, params: params.map(({ key, value }) => ({ key, value })) });
}
