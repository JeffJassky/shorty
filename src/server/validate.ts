import type {
  LinkRedirectOverrides,
  OgData,
  Param,
  RedirectStatus,
  SocialCard,
  Utm,
  UtmField,
} from '../../types/index.js';
import { ShortyError } from '../shared/errors.js';
import { UTM_FIELDS } from '../shared/url.js';
import type { ResolvedContext } from './config.js';

/**
 * Input checks for link fields. Every one throws `ShortyError` and none touches
 * the database, so a write can validate EVERYTHING before it claims a slug —
 * a request that is going to fail never has anything to roll back.
 */

const bad = (field: string, why: string): ShortyError => new ShortyError('validation', undefined, { field, why });

const REDIRECT_STATUSES: readonly number[] = [301, 302, 307, 308];

function matches(rule: string | RegExp, hostname: string): boolean {
  if (typeof rule === 'string') return rule.toLowerCase() === hostname;
  rule.lastIndex = 0;
  return rule.test(hostname);
}

/** Host allow/block lists and the self-loop rule, on the composed destination. */
export function checkDestination(ctx: ResolvedContext, destination: string): void {
  const url = new URL(destination);
  const host = url.hostname.toLowerCase();
  const { allowedHosts, blockedHosts } = ctx.destinations;
  if (allowedHosts && !allowedHosts.some((r) => matches(r, host))) {
    throw new ShortyError('host_not_allowed', undefined, { host });
  }
  if (blockedHosts.some((r) => matches(r, host))) throw new ShortyError('host_blocked', undefined, { host });

  // Loop: publicBaseUrl itself (any query/fragment) or anything beneath it. The
  // host root above a mounted path is NOT a loop.
  const base = new URL(ctx.publicBaseUrl);
  if (url.protocol === base.protocol && url.host === base.host) {
    const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
    const path = url.pathname.toLowerCase();
    if (path === basePath || path === `${basePath}/` || path.startsWith(`${basePath}/`)) {
      throw new ShortyError('destination_loop', undefined, { host });
    }
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** `''` and `null` are "absent"; anything else must be a string. */
export function optionalText(value: unknown, field: string, max?: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw bad(field, 'must be a string');
  if (max !== undefined && value.length > max) throw bad(field, `at most ${max} characters`);
  return value;
}

export function optionalHttpUrl(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field);
  if (text === undefined) return undefined;
  if (!isHttpUrl(text)) throw bad(field, 'must be an absolute http(s) URL');
  return text;
}

export function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw bad(field, 'must be a date');
  return date;
}

export function optionalMaxClicks(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw bad('maxClicks', 'must be a positive integer');
  return value;
}

export function cleanTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad('tags', 'must be an array of strings');
  const out: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string') throw bad('tags', 'must be an array of strings');
    const trimmed = tag.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function cleanParams(value: unknown): Param[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ShortyError('invalid_param');
  return value.map((p: unknown) => {
    const { key, value: v } = (p ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || !key) throw new ShortyError('invalid_param');
    if (v !== undefined && v !== null && typeof v !== 'string') throw new ShortyError('invalid_param');
    return { key, value: v ?? '' };
  });
}

/** For create: drops empty fields. */
export function cleanUtm(value: unknown): Utm {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') throw bad('utm', 'must be an object');
  const out: Utm = {};
  for (const field of UTM_FIELDS) {
    const v = (value as Record<string, unknown>)[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') throw bad(`utm.${field}`, 'must be a string');
    out[field] = v;
  }
  return out;
}

/** For update: merge field-wise; `''` / `null` removes a field. */
export function mergeUtm(current: Utm, patch: unknown): Utm {
  if (patch === null || typeof patch !== 'object') throw bad('utm', 'must be an object');
  const out: Utm = { ...current };
  for (const field of UTM_FIELDS as readonly UtmField[]) {
    if (!(field in (patch as object))) continue;
    const v = (patch as Record<string, unknown>)[field];
    if (v === undefined) continue;
    if (v === null || v === '') delete out[field];
    else if (typeof v === 'string') out[field] = v;
    else throw bad(`utm.${field}`, 'must be a string');
  }
  return out;
}

export function cleanHash(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw bad('hash', 'must be a string');
  const hash = value.replace(/^#/, '');
  return hash || undefined;
}

/** Whole card, replaced as a unit. Returns undefined when nothing is left. */
export function cleanSocial(value: unknown): SocialCard | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw bad('social', 'must be an object');
  const v = value as Record<string, unknown>;
  const out: SocialCard = {};
  const title = optionalText(v.title, 'social.title', 120);
  const description = optionalText(v.description, 'social.description', 240);
  const image = optionalHttpUrl(v.image, 'social.image');
  if (title !== undefined) out.title = title;
  if (description !== undefined) out.description = description;
  if (image !== undefined) out.image = image;
  return Object.keys(out).length ? out : undefined;
}

/** Existing overrides, merged with a patch; `null` falls back to config. */
export function mergeRedirect(current: LinkRedirectOverrides, patch: unknown, partial: boolean): LinkRedirectOverrides {
  if (patch === null || typeof patch !== 'object') throw bad('redirect', 'must be an object');
  const out: LinkRedirectOverrides = partial ? { ...current } : {};
  const p = patch as Record<string, unknown>;
  if ('status' in p && p.status !== undefined) {
    if (p.status === null) delete out.status;
    else if (typeof p.status === 'number' && REDIRECT_STATUSES.includes(p.status)) out.status = p.status as RedirectStatus;
    else throw bad('redirect.status', 'must be 301, 302, 307 or 308');
  }
  if ('forwardQuery' in p && p.forwardQuery !== undefined) {
    if (p.forwardQuery === null) delete out.forwardQuery;
    else if (typeof p.forwardQuery === 'boolean') out.forwardQuery = p.forwardQuery;
    else throw bad('redirect.forwardQuery', 'must be a boolean');
  }
  return out;
}

const OG_FIELDS = ['title', 'description', 'image', 'siteName', 'favicon'] as const;

export function cleanOg(value: unknown): OgData | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw bad('og', 'must be an object');
  const out: OgData = {};
  for (const field of OG_FIELDS) {
    const v = (value as Record<string, unknown>)[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw bad(`og.${field}`, 'must be a string');
    out[field] = v;
  }
  return out;
}
