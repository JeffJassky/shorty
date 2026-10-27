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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

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
    const key = safeDecode(eq < 0 ? piece : piece.slice(0, eq));
    if (!key) continue;
    const encodedKey = encodeURIComponent(key);
    const value = eq < 0 ? '' : safeDecode(piece.slice(eq + 1));
    parts.push({ key, value, encoded: eq < 0 ? encodedKey : `${encodedKey}=${encodeURIComponent(value)}` });
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
    return !replaced.has(safeDecode(eq < 0 ? piece : piece.slice(0, eq)));
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

  function headers(res: Response, cache: boolean): void {
    if (ctx.redirect.noindex) res.setHeader('X-Robots-Tag', 'noindex');
    if (cache) res.setHeader('Cache-Control', CACHE_CONTROL);
  }

  function redirectTo(res: Response, status: number, location: string): void {
    headers(res, status === 302 || status === 307);
    res.status(status);
    res.location(location);
    res.end();
  }

  function answer(res: Response, status: number, type: string, body: string, cache = false): void {
    headers(res, cache);
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

  async function handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Read before next(): leaving the mount restores req.url, and with it req.path.
    const path = req.path;
    const key = keyOf(path);
    if (key === null) return next();

    let doc: LinkDoc | null;
    try {
      doc = (await Link.findOne({ keys: key }).lean()) as LinkDoc | null;
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
      if (mode === 'notFound') answer(res, 404, 'text/plain', 'Not Found');
      else redirectTo(res, 302, mode);
      track(sent(res), () => clicks.recordMiss(path, req, at));
      return;
    }

    if (isExpired(doc, at)) {
      const mode = doc.expiredUrl || ctx.redirect.onExpired;
      if (mode === 'page') answer(res, 410, 'text/html; charset=utf-8', EXPIRED_PAGE);
      else if (mode === 'notFound') answer(res, 404, 'text/plain', 'Not Found');
      else redirectTo(res, 302, mode);
      return;
    }

    const incoming = parseQuery(req.url);
    const forward = doc.redirect?.forwardQuery ?? ctx.redirect.forwardQuery;
    const location = forward ? forwardQuery(doc.destination, incoming) : doc.destination;
    const ua = req.get('user-agent') ?? '';

    if (isCrawler(ua) && doc.social && (doc.social.title || doc.social.description || doc.social.image)) {
      answer(res, 200, 'text/html; charset=utf-8', socialCard(doc.social, location), true);
    } else {
      redirectTo(res, doc.redirect?.status ?? ctx.redirect.status, location);
    }

    if (!ctx.clicks.enabled) return;
    const input = {
      doc,
      req,
      at,
      bot: isBotHit(req.method, ua),
      ua,
      qr: incoming.some((p) => p.key === 'qr' && p.value === '1'),
      queryKeys: [...new Set(incoming.map((p) => p.key).filter((k) => k !== 'qr'))],
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
