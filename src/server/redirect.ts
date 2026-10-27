import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import type { LinkDoc } from '../../types/index.js';
import type { ResolvedContext } from './config.js';
import type { Counters } from './counters.js';
import type { ClickService } from './clicks.js';
import type { SlugService } from './slug.js';
import { isBotHit, isCrawler } from './ua.js';

/**
 * The public redirect router (§7.5). `router.use` plus an explicit GET/HEAD
 * check — `router.get` would let Express auto-answer OPTIONS for every path.
 *
 * Order of business: is this even a slug (no DB if not) → one indexed lookup →
 * miss / expired / social card / redirect → response sent → click or miss
 * pipeline, tracked so `drain()` can wait for it.
 */

export interface RedirectService {
  router: Router;
  drain(): Promise<void>;
}

const CACHE_CONTROL = 'private, max-age=0';

interface IncomingPart {
  key: string;
  value: string;
  /** Re-encoded form, as it goes into the Location. */
  encoded: string;
}

/** Decoded text, or null when the escapes are malformed. */
function tryDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** Anything outside printable ASCII is percent-encoded (UTF-8); everything else is sent as built. */
function headerSafe(url: string): string {
  return url.replace(/[^\x21-\x7e]+/gu, (run) => encodeURIComponent(run).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));
}

const MAX_QUERY_KEYS = 20;
const MAX_QUERY_KEY_LENGTH = 64;

/** The incoming query as ordered parts; bare keys stay bare. */
function parseQuery(url: string): IncomingPart[] {
  const at = url.indexOf('?');
  if (at < 0) return [];
  const hash = url.indexOf('#', at);
  const raw = url.slice(at + 1, hash < 0 ? undefined : hash);
  const parts: IncomingPart[] = [];
  for (const piece of raw.split('&')) {
    if (!piece) continue;
    const eq = piece.indexOf('=');
    const rawKey = eq < 0 ? piece : piece.slice(0, eq);
    // A malformed key or value is forwarded as its raw text, untouched.
    const decodedKey = tryDecode(rawKey);
    const key = decodedKey ?? rawKey;
    if (!key) continue;
    const encodedKey = decodedKey === null ? rawKey : encodeURIComponent(key);
    if (eq < 0) {
      parts.push({ key, value: '', encoded: encodedKey });
      continue;
    }
    const rawValue = piece.slice(eq + 1);
    const decodedValue = tryDecode(rawValue);
    const value = decodedValue ?? rawValue;
    const encodedValue = decodedValue === null ? rawValue : encodeURIComponent(value);
    parts.push({ key, value, encoded: `${encodedKey}=${encodedValue}` });
  }
  return parts;
}

/**
 * Destination + incoming query. An incoming key replaces EVERY occurrence of
 * that key in the destination; repeated incoming keys all forward, in order;
 * the result goes before `#hash`; `qr` never forwards; an untouched
 * destination is returned byte for byte.
 */
export function forwardQuery(destination: string, incoming: IncomingPart[]): string {
  const forwarded = incoming.filter((p) => p.key !== 'qr');
  if (forwarded.length === 0) return destination;

  const hashAt = destination.indexOf('#');
  const hash = hashAt < 0 ? '' : destination.slice(hashAt);
  const head = hashAt < 0 ? destination : destination.slice(0, hashAt);
  const queryAt = head.indexOf('?');
  const base = queryAt < 0 ? head : head.slice(0, queryAt);
  const existing = queryAt < 0 ? [] : head.slice(queryAt + 1).split('&').filter(Boolean);

  const replaced = new Set(forwarded.map((p) => p.key));
  const kept = existing.filter((piece) => {
    const eq = piece.indexOf('=');
    const rawKey = eq < 0 ? piece : piece.slice(0, eq);
    return !replaced.has(tryDecode(rawKey) ?? rawKey);
  });
  const query = [...kept, ...forwarded.map((p) => p.encoded)].join('&');
  return `${base}?${query}${hash}`;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function socialCard(link: NonNullable<LinkDoc['social']>, location: string): string {
  const meta: string[] = [];
  const add = (name: string, value: string | undefined, attr: 'property' | 'name'): void => {
    if (value) meta.push(`<meta ${attr}="${name}" content="${escapeHtml(value)}">`);
  };
  add('og:title', link.title, 'property');
  add('og:description', link.description, 'property');
  add('og:image', link.image, 'property');
  add('twitter:card', link.image ? 'summary_large_image' : 'summary', 'name');
  add('twitter:title', link.title, 'name');
  add('twitter:description', link.description, 'name');
  add('twitter:image', link.image, 'name');
  const target = escapeHtml(location);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(link.title ?? '')}</title>${meta.join('')}`
    + `<meta http-equiv="refresh" content="0;url=${target}"></head><body><a href="${target}">${target}</a></body></html>`;
}

const EXPIRED_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>Link expired</title></head><body><h1>This link has expired</h1><p>It is no longer available.</p></body></html>';

export function createRedirect(
  ctx: ResolvedContext,
  slugs: SlugService,
  clicks: ClickService,
  counters: Counters,
): RedirectService {
  const { Link } = ctx.models;
  const inFlight = new Set<Promise<void>>();

  /** Run `task` after `ready` settles; `drain()` and `health().inFlight` see it from now. */
  function track(ready: Promise<void>, task: () => Promise<void>): void {
    if (counters.inFlight >= ctx.clicks.maxInFlight) {
      counters.dropped += 1;
      return;
    }
    counters.inFlight += 1;
    const run: Promise<void> = ready
      .then(task)
      .catch((err: unknown) => {
        counters.clickFailures += 1;
        ctx.logger.error?.({ err }, 'shorty: pipeline failed');
      })
      .finally(() => {
        counters.inFlight -= 1;
        inFlight.delete(run);
      });
    inFlight.add(run);
  }

  /** Resolves once our response is on the wire (or the client went away). */
  function sent(res: Response): Promise<void> {
    if (res.writableFinished || res.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      res.once('finish', resolve);
      res.once('close', resolve);
    });
  }

  const later = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

  function headers(res: Response, cache: boolean, vary = false): void {
    if (ctx.redirect.noindex) res.setHeader('X-Robots-Tag', 'noindex');
    if (cache) res.setHeader('Cache-Control', CACHE_CONTROL);
    if (vary) res.vary('User-Agent');
  }

  function redirectTo(res: Response, status: number, location: string, vary = false): void {
    headers(res, status === 302 || status === 307, vary);
    res.status(status);
    // Not res.location(): it re-encodes, and a malformed escape must forward verbatim.
    res.setHeader('Location', headerSafe(location));
    res.end();
  }

  function answer(res: Response, status: number, type: string, body: string, cache = false, vary = false): void {
    headers(res, cache, vary);
    res.status(status).type(type).send(body);
  }

  /** Decoded slug key, or null when the path can't be a slug (no DB hit then). */
  function keyOf(path: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (!decoded.startsWith('/') || decoded.includes('//')) return null;
    const candidate = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
    const { key, problem } = slugs.inspect(candidate.slice(1));
    return problem ? null : key;
  }

  /** One indexed lookup, bounded by `redirect.lookupTimeoutMs`; rejects at once if the connection isn't open. */
  function lookup(key: string): Promise<LinkDoc | null> {
    if (Link.db.readyState !== 1) return Promise.reject(new Error('shorty: database connection is not ready'));
    return new Promise<LinkDoc | null>((resolve, reject) => {
      const timeoutMs = ctx.redirect.lookupTimeoutMs;
      const timer = setTimeout(() => {
        reject(new Error(`shorty: link lookup timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(Link.findOne({ keys: key }).maxTimeMS(timeoutMs).lean().exec());
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      pending.then(
        (found) => { clearTimeout(timer); resolve(found as LinkDoc | null); },
        (err: unknown) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  async function handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Read before next(): leaving the mount restores req.url, and with it req.path.
    const path = req.path;
    const key = keyOf(path);
    if (key === null) return next();

    let doc: LinkDoc | null;
    try {
      doc = await lookup(key);
    } catch (err) {
      return next(err);
    }
    const at = ctx.now();

    if (!doc) {
      const mode = ctx.redirect.onMiss;
      if (mode === 'next') {
        // The response is the host's, not ours — don't wait for it.
        next();
        track(later(), () => clicks.recordMiss(path, req, at));
        return;
      }
      if (mode === 'notFound') answer(res, 404, 'text/plain', 'Not Found', true);
      else redirectTo(res, 302, mode);
      track(sent(res), () => clicks.recordMiss(path, req, at));
      return;
    }

    if (isExpired(doc, at)) {
      const mode = doc.expiredUrl || ctx.redirect.onExpired;
      if (mode === 'page') answer(res, 410, 'text/html; charset=utf-8', EXPIRED_PAGE, true);
      else if (mode === 'notFound') answer(res, 404, 'text/plain', 'Not Found', true);
      else redirectTo(res, 302, mode);
      return;
    }

    const incoming = parseQuery(req.url);
    const forward = doc.redirect?.forwardQuery ?? ctx.redirect.forwardQuery;
    const location = forward ? forwardQuery(doc.destination, incoming) : doc.destination;
    const ua = req.get('user-agent') ?? '';

    if (isCrawler(ua) && doc.social && (doc.social.title || doc.social.description || doc.social.image)) {
      answer(res, 200, 'text/html; charset=utf-8', socialCard(doc.social, location), true, true);
    } else {
      redirectTo(res, doc.redirect?.status ?? ctx.redirect.status, location, true);
    }

    if (!ctx.clicks.enabled) return;
    const input = {
      doc,
      req,
      at,
      bot: isBotHit(req.method, ua),
      ua,
      qr: incoming.some((p) => p.key === 'qr' && p.value === '1'),
      queryKeys: [...new Set(
        incoming.filter((p) => p.key !== 'qr').map((p) => p.key.slice(0, MAX_QUERY_KEY_LENGTH)),
      )].slice(0, MAX_QUERY_KEYS),
    };
    track(sent(res), () => clicks.record(input));
  }

  function isExpired(doc: LinkDoc, now: Date): boolean {
    if (doc.expiresAt && doc.expiresAt.getTime() <= now.getTime()) return true;
    return doc.maxClicks != null && doc.clicks >= doc.maxClicks;
  }

  const router = express.Router();
  router.use((req, res, next) => {
    handle(req, res, next).catch(next);
  });

  return {
    router,
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
