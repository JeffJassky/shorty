import type { Param, UrlParts, Utm, UtmField } from '../../types/index.js';
import { ShortyError } from './errors.js';

/**
 * The destination as structured fields, and back. Pure — the server stores
 * what `composeUrl` returns, and the SPA runs the same two functions to split
 * a pasted URL into the form and to draw the anatomy panel. One implementation,
 * so the preview can never disagree with the redirect.
 */

/** Compose order, fixed. The form shows them in this order too. */
export const UTM_FIELDS: readonly UtmField[] = ['source', 'medium', 'campaign', 'term', 'content', 'id'];

export const utmKey = (field: UtmField): string => `utm_${field}`;

const FIELD_BY_KEY = new Map<string, UtmField>(UTM_FIELDS.map((f) => [utmKey(f), f]));

function decode(raw: string): string {
  // URLSearchParams semantics: `+` is a space. A malformed escape is kept
  // verbatim rather than thrown — a destination someone pasted is not ours to
  // reject over a stray `%`.
  const spaced = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

function httpUrl(input: string, code: 'invalid_url' | 'invalid_base_url'): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ShortyError(code);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ShortyError(code === 'invalid_url' ? 'unsupported_scheme' : code);
  }
  // `https://google.com@evil.com` reads as google and goes to evil. Nothing
  // legitimate needs credentials in a marketing link.
  if (url.username || url.password) throw new ShortyError(code);
  return url;
}

export function parseUrl(input: string): UrlParts {
  if (typeof input !== 'string') throw new ShortyError('invalid_url');
  const url = httpUrl(input.trim(), 'invalid_url');

  const utm: Utm = {};
  const params: Param[] = [];
  const search = url.search.startsWith('?') ? url.search.slice(1) : url.search;

  for (const part of search.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? '' : decode(part.slice(eq + 1));
    if (!key) continue;
    const field = FIELD_BY_KEY.get(key);
    // First non-empty occurrence fills the field; anything else stays a param
    // so a pasted URL never loses a byte of its query.
    if (field && value !== '' && utm[field] === undefined) {
      utm[field] = value;
    } else {
      params.push({ key, value });
    }
  }

  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  return {
    baseUrl: `${url.protocol}//${url.host}${url.pathname}`,
    utm,
    params,
    ...(hash ? { hash } : {}),
  };
}

export function composeUrl({ baseUrl, utm = {}, params = [], hash }: UrlParts): string {
  if (typeof baseUrl !== 'string' || /[?#]/.test(baseUrl)) throw new ShortyError('invalid_base_url');
  httpUrl(baseUrl, 'invalid_base_url');

  const enc = encodeURIComponent;
  const pieces: string[] = [];
  for (const field of UTM_FIELDS) {
    const value = utm[field];
    if (value !== undefined && value !== null && value !== '') pieces.push(`${enc(utmKey(field))}=${enc(value)}`);
  }
  for (const { key, value } of params) {
    if (!key) throw new ShortyError('invalid_param');
    pieces.push(value === '' || value === undefined || value === null ? enc(key) : `${enc(key)}=${enc(value)}`);
  }

  return `${baseUrl}${pieces.length ? `?${pieces.join('&')}` : ''}${hash ? `#${hash}` : ''}`;
}
