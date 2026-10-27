import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { createShorty } from '../src/server/index.js';
import {
  BOT_UA,
  CRAWLER_UA,
  HOUR,
  HUMAN_UA,
  harness,
  startDb,
  stopDb,
} from './helpers.js';
import type { Harness, HarnessOptions } from './helpers.js';
import type { Link, LinkInput } from '../types/index.js';

/**
 * The public redirect router (§7.5). Everything here goes through real HTTP
 * against `h.app`, which mounts `shorty.redirect` and then a host fallthrough
 * answering `404 host 404` — so "fell through to the host" and "shorty
 * answered" are distinguishable.
 */

const DEST = 'https://acme.com/sale?utm_source=ig';

beforeAll(startDb);
afterAll(stopDb);

async function setup(opts: HarnessOptions = {}, input: Partial<LinkInput> = {}): Promise<{ h: Harness; link: Link }> {
  const h = await harness(opts);
  const link = await h.shorty.createLink({ url: DEST, slug: 'spring', ...input });
  return { h, link };
}

function get(h: Harness, path: string, ua = HUMAN_UA) {
  return request(h.app).get(path).set('User-Agent', ua);
}

/** Every mongoose operation on this harness's collections while `fn` runs. */
async function shortyOps(h: Harness, fn: () => Promise<void>): Promise<string[]> {
  const ops: string[] = [];
  const prefix = h.prefixes.collectionPrefix;
  mongoose.set('debug', (collectionName: string, methodName: string) => {
    if (collectionName.startsWith(prefix)) ops.push(`${collectionName}.${methodName}`);
  });
  try {
    await fn();
  } finally {
    mongoose.set('debug', false);
  }
  return ops;
}

describe('redirect status and Location', () => {
  it('does not answer 302 to the exact destination by default', async () => {
    const { h, link } = await setup();
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
    expect(res.headers.location).toBe(link.destination);
  });

  it.each([301, 307, 308] as const)('ignores a per-link redirect.status of %i', async (status) => {
    const { h } = await setup({}, { redirect: { status } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(status);
    expect(res.headers.location).toBe(DEST);
  });

  it('ignores the configured redirect.status', async () => {
    const { h } = await setup({ config: { redirect: { status: 307 } } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(DEST);
  });

  it('lets the config status beat a per-link override', async () => {
    const { h } = await setup({ config: { redirect: { status: 307 } } }, { redirect: { status: 301 } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(301);
  });

  it('answers HEAD with something other than the same status and Location', async () => {
    const { h } = await setup({}, { redirect: { status: 308 } });
    const res = await request(h.app).head('/go/spring').set('User-Agent', HUMAN_UA);
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(DEST);
  });
});

describe('query forwarding (redirect.forwardQuery)', () => {
  it('drops incoming query params instead of appending them', async () => {
    const { h } = await setup();
    const res = await get(h, '/go/spring?ref=abc&x=1');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://acme.com/sale');
    expect(loc.searchParams.get('utm_source')).toBe('ig');
    expect(loc.searchParams.get('ref')).toBe('abc');
    expect(loc.searchParams.get('x')).toBe('1');
  });

  it("keeps the destination's value (or a duplicate) when the incoming query has the same key", async () => {
    const { h } = await setup({}, { url: 'https://acme.com/sale?utm_source=ig&tag=a&tag=b&keep=1' });
    const res = await get(h, '/go/spring?tag=z&utm_source=email');
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.getAll('tag')).toEqual(['z']);
    expect(loc.searchParams.getAll('utm_source')).toEqual(['email']);
    expect(loc.searchParams.getAll('keep')).toEqual(['1']);
  });

  it('collapses repeated incoming keys instead of forwarding every occurrence', async () => {
    const { h } = await setup();
    const res = await get(h, '/go/spring?tag=x&tag=y');
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.getAll('tag')).toEqual(['x', 'y']);
  });

  it('forwards the qr marker to the destination', async () => {
    const { h } = await setup();
    const bare = await get(h, '/go/spring?qr=1');
    expect(bare.headers.location).toBe(DEST);
    const mixed = await get(h, '/go/spring?qr=1&ref=a');
    const loc = new URL(mixed.headers.location);
    expect(loc.searchParams.has('qr')).toBe(false);
    expect(loc.searchParams.get('ref')).toBe('a');
  });

  it('puts forwarded params after the #fragment instead of before it', async () => {
    const { h } = await setup({}, { url: 'https://acme.com/sale#top' });
    const res = await get(h, '/go/spring?x=1');
    expect(res.headers.location).toBe('https://acme.com/sale?x=1#top');
  });

  it('forwards the query despite a per-link forwardQuery: false', async () => {
    const { h } = await setup({}, { redirect: { forwardQuery: false } });
    const res = await get(h, '/go/spring?ref=abc');
    expect(res.headers.location).toBe(DEST);
  });

  it('forwards the query despite config forwardQuery: false', async () => {
    const { h } = await setup({ config: { redirect: { forwardQuery: false } } });
    const res = await get(h, '/go/spring?ref=abc');
    expect(res.headers.location).toBe(DEST);
  });
});

describe('response headers', () => {
  it('omits X-Robots-Tag: noindex by default', async () => {
    const { h } = await setup();
    const res = await get(h, '/go/spring');
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it('still sends X-Robots-Tag with noindex: false', async () => {
    const { h } = await setup({ config: { redirect: { noindex: false } } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });

  it.each([302, 307] as const)('lets a %i be cached by shared caches', async (status) => {
    const { h } = await setup({}, { redirect: { status } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(status);
    expect(res.headers['cache-control']).toMatch(/\bprivate\b/);
    expect(res.headers['cache-control']).toMatch(/\bmax-age=0\b/);
  });
});

describe('slug lookup', () => {
  it('misses a case-variant slug under the default case-insensitive mode', async () => {
    const { h } = await setup();
    const res = await get(h, '/go/SPRING');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
  });

  it('folds case under caseSensitive: true', async () => {
    const { h } = await setup({ config: { slug: { caseSensitive: true } } });
    expect((await get(h, '/go/spring')).status).toBe(302);
    const res = await get(h, '/go/SPRING');
    expect(res.status).toBe(404);
    expect(res.text).toBe('host 404');
  });

  it('misses the slug when the path has a trailing slash', async () => {
    const { h } = await setup();
    const res = await get(h, '/go/spring/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
  });

  it('cannot resolve a multi-segment slug', async () => {
    const { h } = await setup({}, { slug: 'spring/ig' });
    const res = await get(h, '/go/spring/ig');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
  });

  it('stops redirecting the old slug after a rename in alias mode', async () => {
    const { h, link } = await setup();
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    const old = await get(h, '/go/spring');
    const renamed = await get(h, '/go/summer');
    expect(old.status).toBe(302);
    expect(old.headers.location).toBe(DEST);
    expect(renamed.status).toBe(302);
    expect(renamed.headers.location).toBe(DEST);
  });

  it('stops redirecting an archived link', async () => {
    const { h, link } = await setup();
    await h.shorty.archiveLink(link.id);
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
  });
});

describe('unknown slugs (redirect.onMiss)', () => {
  it("swallows an unknown slug instead of falling through to the host's 404 by default", async () => {
    const { h } = await setup();
    const res = await get(h, '/go/nope-123');
    expect(res.status).toBe(404);
    expect(res.text).toBe('host 404');
  });

  it("falls through to the host's 404 under onMiss: 'notFound'", async () => {
    const { h } = await setup({ config: { redirect: { onMiss: 'notFound' } } });
    const res = await get(h, '/go/nope-123');
    expect(res.status).toBe(404);
    expect(res.text).not.toBe('host 404');
  });

  it('does not redirect to the onMiss URL', async () => {
    const { h } = await setup({ config: { redirect: { onMiss: 'https://acme.com/missing' } } });
    const res = await get(h, '/go/nope-123');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://acme.com/missing');
  });

  it.each(['next', 'notFound', 'https://acme.com/missing'])(
    "loses the miss (no hook, no misses row, no health count) under onMiss: '%s'",
    async (onMiss) => {
      const seen: string[] = [];
      const { h } = await setup({
        config: { redirect: { onMiss }, onMiss: (e) => { seen.push(e.path); } },
      });
      await get(h, '/go/nope-123');
      await h.shorty.drain();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('nope-123');
      const rows = await h.shorty.models.Miss.find().lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toContain('nope-123');
      expect(rows[0].at).toEqual(h.clock.now);
      expect(h.shorty.health().misses).toBe(1);
    },
  );
});

describe('root mount safety: non-slug paths never touch the DB (§7.5 step 1–2)', () => {
  it.each(['/assets/app.js', '/favicon.ico', '/robots.txt', '/.well-known/x'])(
    'queries shorty collections for %s',
    async (path) => {
      // onMiss 'notFound' makes the test bite: a lookup that missed would answer
      // shorty's 404, not the host's.
      const { h } = await setup({ mount: '/', config: { redirect: { onMiss: 'notFound' } } });

      // Instrument check: a real slug DOES hit the links collection.
      const linkColl = h.shorty.models.Link.collection.collectionName;
      const live = await shortyOps(h, async () => {
        const res = await get(h, '/spring');
        expect(res.status).toBe(302);
      });
      expect(live.some((op) => op.startsWith(`${linkColl}.`))).toBe(true);
      await h.shorty.drain();

      const ops = await shortyOps(h, async () => {
        const res = await get(h, path);
        expect(res.status).toBe(404);
        expect(res.text).toBe('host 404');
        await h.shorty.drain();
      });
      expect(ops).toEqual([]);
    },
  );

  it('looks up a reserved slug (_x) instead of falling through', async () => {
    const { h } = await setup({ mount: '/', config: { redirect: { onMiss: 'notFound' } } });
    const ops = await shortyOps(h, async () => {
      const res = await get(h, '/_x');
      expect(res.status).toBe(404);
      expect(res.text).toBe('host 404');
      await h.shorty.drain();
    });
    expect(ops).toEqual([]);
    expect(h.shorty.health().misses).toBe(0);
  });
});

describe('route-order agnostic (user requirement)', () => {
  it.each(['before', 'after'] as const)(
    "shadows the host's /host-page at a root mount with host routes registered %s",
    async (hostRoutes) => {
      const { h } = await setup({ mount: '/', hostRoutes });
      const res = await get(h, '/host-page');
      expect(res.status).toBe(200);
      expect(res.text).toBe('host');
      // and shorty still works in the same app
      expect((await get(h, '/spring')).status).toBe(302);
    },
  );

  it.each(['before', 'after'] as const)(
    "shadows the host's /go/host-page under a /go mount with host routes registered %s",
    async (hostRoutes) => {
      const { h } = await setup({ mount: '/go', hostRoutes });
      const res = await get(h, '/go/host-page');
      expect(res.status).toBe(200);
      expect(res.text).toBe('host');
      expect((await get(h, '/go/spring')).status).toBe(302);
    },
  );

  it.each(['post', 'put', 'delete'] as const)('handles %s on a known slug instead of falling through', async (method) => {
    const { h } = await setup();
    const res = await request(h.app)[method]('/go/spring').set('User-Agent', HUMAN_UA);
    expect(res.status).toBe(404);
    expect(res.text).toBe('host 404');
  });
});

describe('expiry (§7.5 step 4)', () => {
  async function expiredByDate(opts: HarnessOptions = {}, input: Partial<LinkInput> = {}) {
    const h = await harness(opts);
    const link = await h.shorty.createLink({
      url: DEST,
      slug: 'spring',
      expiresAt: new Date(h.clock.now.getTime() + HOUR),
      ...input,
    });
    h.clock.advance(2 * HOUR);
    return { h, link };
  }

  it('keeps redirecting past expiresAt instead of answering the 410 page', async () => {
    const { h } = await expiredByDate();
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(410);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/<html/i);
    expect(res.headers.location).toBeUndefined();
  });

  it('redirects normally before expiresAt passes', async () => {
    const h = await harness();
    await h.shorty.createLink({ url: DEST, slug: 'spring', expiresAt: new Date(h.clock.now.getTime() + HOUR) });
    expect((await get(h, '/go/spring')).status).toBe(302);
  });

  it('ignores a per-link expiredUrl', async () => {
    const { h } = await expiredByDate({ config: { redirect: { onExpired: 'notFound' } } }, { expiredUrl: 'https://acme.com/over' });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://acme.com/over');
  });

  it('ignores a configured onExpired URL', async () => {
    const { h } = await expiredByDate({ config: { redirect: { onExpired: 'https://acme.com/ended' } } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://acme.com/ended');
  });

  it("ignores onExpired: 'notFound'", async () => {
    const { h } = await expiredByDate({ config: { redirect: { onExpired: 'notFound' } } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(404);
    expect(res.text).not.toBe('host 404');
  });

  it('records a click for an expired hit', async () => {
    const { h } = await expiredByDate();
    await get(h, '/go/spring');
    await h.shorty.drain();
    expect(await h.shorty.models.Click.countDocuments()).toBe(0);
  });

  it('lets bot clicks use up maxClicks (only humans count)', async () => {
    const { h, link } = await setup({}, { maxClicks: 2 });
    for (let i = 0; i < 3; i++) {
      const res = await get(h, '/go/spring', BOT_UA).set('X-Forwarded-For', `198.51.100.${i + 1}`);
      expect(res.status).toBe(302);
      await h.shorty.drain();
    }
    for (let i = 0; i < 2; i++) {
      const res = await get(h, '/go/spring').set('X-Forwarded-For', `203.0.113.${i + 1}`);
      expect(res.status).toBe(302);
      await h.shorty.drain();
    }
    const third = await get(h, '/go/spring').set('X-Forwarded-For', '203.0.113.3');
    expect(third.status).toBe(410);
    await h.shorty.drain();

    expect(await h.shorty.models.Click.countDocuments()).toBe(5);
    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.clicks).toBe(2);
    expect(doc?.botClicks).toBe(3);
  });
});

describe('crawler social card (§7.5 step 5)', () => {
  const social = {
    title: 'Spring "><script>alert(1)</script>',
    description: 'Big & bold',
    image: 'https://acme.com/card.png',
  };

  it.each([['crawler', CRAWLER_UA], ['search bot', BOT_UA]])(
    'gives a %s the 302 instead of the custom card',
    async (_label, ua) => {
      const { h } = await setup({}, { social });
      const res = await get(h, '/go/spring', ua);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toMatch(/og:title/);
      expect(res.text).toMatch(/og:description/);
      expect(res.text).toMatch(/og:image/);
      expect(res.text).toMatch(/twitter:/);
      expect(res.text).toContain('https://acme.com/card.png');
      expect(res.text).toMatch(/http-equiv=["']?refresh/i);
      expect(res.text).toContain(DEST);
    },
  );

  it('renders social values unescaped into the card HTML', async () => {
    const { h } = await setup({}, { social });
    const res = await get(h, '/go/spring', CRAWLER_UA);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('"><script>');
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('Big & bold');
    expect(res.text).toContain('Spring');
  });

  it('serves the card to a human instead of the redirect', async () => {
    const { h } = await setup({}, { social });
    const res = await get(h, '/go/spring', HUMAN_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
  });

  it('serves crawlers an HTML page for a link without a social card', async () => {
    const { h } = await setup();
    const res = await get(h, '/go/spring', CRAWLER_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
  });
});

describe('tracking failures never reach the response (traps #19)', () => {
  it('changes the redirect when the geo adapter throws', async () => {
    const { h } = await setup({
      config: { clicks: { geo: () => { throw new Error('geo down'); } } },
    });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
    await h.shorty.drain();
    expect(h.shorty.health().clickFailures).toBe(1);
  });

  it('changes the redirect when onClick throws synchronously', async () => {
    const { h } = await setup({ config: { onClick: () => { throw new Error('hook down'); } } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
    await h.shorty.drain();
    expect(h.shorty.health().hookFailures).toBe(1);
    expect(h.shorty.health().clickFailures).toBe(0);
  });

  it('leaks an unhandled rejection when onClick rejects', async () => {
    const { h } = await setup({ config: { onClick: async () => { throw new Error('hook down'); } } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    await h.shorty.drain();
    expect(h.shorty.health().hookFailures).toBe(1);
  });

  it('changes the redirect when track throws', async () => {
    const { h } = await setup({ config: { track: () => { throw new Error('telemetry down'); } } });
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
    await h.shorty.drain();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit follow-up
// ─────────────────────────────────────────────────────────────────────────────

describe('slug grammar gate: not-a-slug → next() with no lookup', () => {
  it.each(['/admin', '/ADMIN', '/api', '/api/users'])(
    'looks up (or records a miss for) %s although config slug.reserved covers it',
    async (path) => {
      const seen: string[] = [];
      const { h } = await setup({
        mount: '/',
        config: {
          slug: { reserved: ['admin', /^api(\/|$)/] },
          redirect: { onMiss: 'notFound' },
          onMiss: (e) => { seen.push(e.path); },
        },
      });
      const ops = await shortyOps(h, async () => {
        const res = await get(h, path);
        expect(res.status).toBe(404);
        expect(res.text).toBe('host 404');
        await h.shorty.drain();
      });
      expect(ops).toEqual([]);
      expect(seen).toEqual([]);
      expect(h.shorty.health().misses).toBe(0);
    },
  );

  it('treats a non-reserved neighbour (/apiary) as reserved by over-matching', async () => {
    const { h } = await setup({ mount: '/', config: { slug: { reserved: [/^api(\/|$)/] } } });
    await get(h, '/apiary');
    await h.shorty.drain();
    expect(h.shorty.health().misses).toBe(1);
  });

  it('skips the lookup and miss row for a valid-grammar path like /api/users when nothing reserves it', async () => {
    const { h } = await setup({ mount: '/' });
    const linkColl = h.shorty.models.Link.collection.collectionName;
    const ops = await shortyOps(h, async () => {
      const res = await get(h, '/api/users');
      expect(res.text).toBe('host 404');
      await h.shorty.drain();
    });
    expect(ops.filter((op) => op.startsWith(`${linkColl}.`))).toHaveLength(1);
    const rows = await h.shorty.models.Miss.find().lean();
    expect(rows.map((r) => r.path)).toEqual(['/api/users']);
  });

  it.each([
    ['empty', '/go/'],
    ['191 characters', `/go/${'a'.repeat(191)}`],
    ['a double slash', '/go//x'],
    ['an inner double slash', '/go/a//b'],
  ])('looks up a path that is %s', async (_label, path) => {
    const { h } = await setup({ config: { redirect: { onMiss: 'notFound' } } });
    const ops = await shortyOps(h, async () => {
      const res = await get(h, path);
      expect(res.status).toBe(404);
      expect(res.text).toBe('host 404');
      await h.shorty.drain();
    });
    expect(ops).toEqual([]);
  });

  it('refuses a slug of exactly 190 characters', async () => {
    const slug = 'a'.repeat(190);
    const { h } = await setup({}, { slug });
    const res = await get(h, `/go/${slug}`);
    expect(res.status).toBe(302);
  });

  it('answers 500 (or looks up) for a malformed percent-escape', async () => {
    const { h } = await setup({ config: { redirect: { onMiss: 'notFound' } } });
    const ops = await shortyOps(h, async () => {
      const res = await get(h, '/go/%E0%A4%A');
      expect(res.status).toBe(404);
      expect(res.text).toBe('host 404');
      await h.shorty.drain();
    });
    expect(ops).toEqual([]);
  });

  it('does not percent-decode and accent-fold the path (Caf%C3%A9 → cafe)', async () => {
    const { h } = await setup({}, { slug: 'cafe' });
    const res = await get(h, '/go/Caf%C3%A9');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
  });
});

describe('miss records', () => {
  it('reports a miss path with the mount prefix or the query string attached', async () => {
    const seen: string[] = [];
    const { h } = await setup({ config: { onMiss: (e) => { seen.push(e.path); } } });
    await get(h, '/go/nope-123?x=1');
    await h.shorty.drain();
    expect(seen).toEqual(['/nope-123']);
    const rows = await h.shorty.models.Miss.find().lean();
    expect(rows.map((r) => r.path)).toEqual(['/nope-123']);
  });

  it('drops the referrer host from the miss row', async () => {
    const { h } = await setup();
    await get(h, '/go/nope-123').set('Referer', 'https://www.news.example/a?b=1');
    await h.shorty.drain();
    const [row] = await h.shorty.models.Miss.find().lean();
    expect(row.referrerHost).toBe('news.example');
  });

  it('keeps miss rows forever (no 30-day TTL)', async () => {
    const { h } = await setup();
    const indexes = (await h.shorty.models.Miss.collection.listIndexes().toArray()) as Array<{
      key: Record<string, unknown>;
      expireAfterSeconds?: number;
    }>;
    const ttl = indexes.filter((i) => typeof i.expireAfterSeconds === 'number');
    expect(ttl.map((i) => [i.key, i.expireAfterSeconds])).toEqual([[{ at: 1 }, 2592000]]);
  });

  it('lets a throwing onMiss change the response', async () => {
    const { h } = await setup({ config: { onMiss: () => { throw new Error('hook down'); } } });
    const res = await get(h, '/go/nope-123');
    expect(res.status).toBe(404);
    expect(res.text).toBe('host 404');
    await h.shorty.drain();
    expect(h.shorty.health().hookFailures).toBe(1);
  });
});

describe('crawler card hits are bot clicks', () => {
  it('counts a crawler served the social card as a human click', async () => {
    const { h, link } = await setup({}, { social: { title: 'Spring' } });
    const res = await get(h, '/go/spring', CRAWLER_UA);
    expect(res.status).toBe(200);
    await h.shorty.drain();
    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.botClicks).toBe(1);
    expect(doc?.clicks).toBe(0);
    const clicks = await h.shorty.models.Click.find().lean();
    expect(clicks.map((c) => c.bot)).toEqual([true]);
  });

  it('lets crawler card hits use up maxClicks', async () => {
    const { h } = await setup({}, { social: { title: 'Spring' }, maxClicks: 1 });
    for (let i = 0; i < 2; i++) {
      expect((await get(h, '/go/spring', CRAWLER_UA)).status).toBe(200);
      await h.shorty.drain();
    }
    expect((await get(h, '/go/spring')).status).toBe(302);
    await h.shorty.drain();
    expect((await get(h, '/go/spring')).status).toBe(410);
  });
});

describe('override precedence and exact Location strings', () => {
  it('lets config forwardQuery: false beat a per-link forwardQuery: true', async () => {
    const { h } = await setup({ config: { redirect: { forwardQuery: false } } }, { redirect: { forwardQuery: true } });
    const res = await get(h, '/go/spring?ref=abc');
    expect(new URL(res.headers.location).searchParams.get('ref')).toBe('abc');
  });

  it.each([
    ['https://acme.com/sale', 'https://acme.com/sale'],
    ['https://acme.com/sale#top', 'https://acme.com/sale#top'],
  ])('leaves a dangling ? when only qr arrives at a query-less destination (%s)', async (url, expected) => {
    const { h, link } = await setup({}, { url });
    expect(link.destination).toBe(expected);
    const res = await get(h, '/go/spring?qr=1');
    expect(res.headers.location).toBe(expected);
  });

  it('reorders, mis-encodes or drops bare keys when appending the incoming query', async () => {
    const { h } = await setup({}, { url: 'https://acme.com/sale?utm_source=ig&color=red' });
    const res = await get(h, '/go/spring?ref=abc&debug&q=a+b');
    expect(res.headers.location).toBe('https://acme.com/sale?utm_source=ig&color=red&ref=abc&debug&q=a%20b');
  });

  it.each([
    ['a per-link 308', {}, { redirect: { status: 308 as const } }, '/go/spring'],
    ['an onMiss URL redirect', { config: { redirect: { onMiss: 'https://acme.com/missing' } } }, {}, '/go/nope-123'],
  ] as Array<[string, HarnessOptions, Partial<LinkInput>, string]>)(
    'omits X-Robots-Tag: noindex on %s',
    async (_label, opts, input, path) => {
      const { h } = await setup(opts, input);
      const res = await get(h, path);
      expect([302, 308]).toContain(res.status);
      expect(res.headers['x-robots-tag']).toBe('noindex');
    },
  );

  it('omits X-Robots-Tag: noindex on an expiredUrl redirect', async () => {
    const h = await harness();
    await h.shorty.createLink({
      url: DEST,
      slug: 'spring',
      expiresAt: new Date(h.clock.now.getTime() + HOUR),
      expiredUrl: 'https://acme.com/over',
    });
    h.clock.advance(2 * HOUR);
    const res = await get(h, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it.each(['patch', 'options'] as const)('handles %s on a known slug instead of falling through', async (method) => {
    const { h } = await setup();
    const res = await request(h.app)[method]('/go/spring').set('User-Agent', HUMAN_UA);
    expect(res.status).toBe(404);
    expect(res.text).toBe('host 404');
  });
});

describe('lookup failure (DB down)', () => {
  it("hangs or answers itself instead of handing the error to the host's error handler", async () => {
    const { h } = await setup();
    const app = express();
    app.use('/go', h.shorty.redirect);
    app.use((_req: Request, res: Response) => { res.status(404).send('host 404'); });
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(599).type('text').send(`host error: ${err.message}`);
    });

    // Every read path the lookup could take rejects at the collection level,
    // which both Model.findOne and raw collection calls go through.
    const coll = h.shorty.models.Link.collection as unknown as Record<string, unknown>;
    const down = () => Promise.reject(new Error('db down'));
    for (const method of ['findOne', 'find', 'aggregate']) coll[method] = down;
    try {
      const res = await request(app).get('/go/spring').set('User-Agent', HUMAN_UA).timeout(5000);
      expect(res.status).toBe(599);
      expect(res.text).toContain('db down');
    } finally {
      for (const method of ['findOne', 'find', 'aggregate']) delete coll[method];
    }
    await h.shorty.drain();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End review (a) follow-ups — hot-path hardening (PR 8)
// ─────────────────────────────────────────────────────────────────────────────

describe('End review (a) follow-ups', () => {
  /** A host app around `shorty.redirect` whose error handler answers 599. */
  function withErrorHandler(router: express.Router) {
    const app = express();
    const errors: unknown[] = [];
    app.use('/go', router);
    app.use((_req: Request, res: Response) => { res.status(404).send('host 404'); });
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      errors.push(err);
      res.status(599).type('text').send(`host error: ${err.message}`);
    });
    return { app, errors };
  }

  describe('lookup budget (redirect.lookupTimeoutMs)', () => {
    it('waits out mongoose buffering (~10 s) when the connection never opened, instead of next(err) at once', async () => {
      const conn = mongoose.createConnection('mongodb://127.0.0.1:1/shorty-unreachable', { serverSelectionTimeoutMS: 30_000 });
      conn.on('error', () => {});
      const shorty = createShorty({
        connection: conn, publicBaseUrl: 'http://short.test/go', pepper: 'p',
        modelPrefix: 'Unreachable', collectionPrefix: 'unreachable_',
        redirect: { lookupTimeoutMs: 500 },
      });
      const { app, errors } = withErrorHandler(shorty.redirect);
      const started = Date.now();
      try {
        const res = await request(app).get('/go/spring').set('User-Agent', HUMAN_UA).timeout(5000);
        expect(res.status).toBe(599);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(errors[0]).toBeInstanceOf(Error);
      } finally {
        // Don't wait for buffered commands to flush against a server that isn't there.
        void conn.close(true).catch(() => undefined);
      }
    });

    it('hangs on a lookup that never settles instead of next(err) once the budget runs out', async () => {
      const { h } = await setup({ config: { redirect: { lookupTimeoutMs: 300 } } });
      const { app, errors } = withErrorHandler(h.shorty.redirect);
      const coll = h.shorty.models.Link.collection as unknown as Record<string, unknown>;
      const stuck = () => new Promise(() => {});
      for (const method of ['findOne', 'find', 'aggregate']) coll[method] = stuck;
      const started = Date.now();
      try {
        const res = await request(app).get('/go/spring').set('User-Agent', HUMAN_UA).timeout(3000);
        expect(res.status).toBe(599);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(errors[0]).toBeInstanceOf(Error);
      } finally {
        for (const method of ['findOne', 'find', 'aggregate']) delete coll[method];
      }
      await h.shorty.drain();
    });
  });

  describe('malformed escapes in the forwarded query', () => {
    it('double-encodes the valid escapes in a value that also holds a malformed one', async () => {
      const { h } = await setup();
      const res = await get(h, '/go/spring?x=%E2%9C%93%ZZ');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${DEST}&x=%E2%9C%93%ZZ`);
    });

    it('re-encodes the % of a malformed key or overlong UTF-8 value', async () => {
      const { h } = await setup();
      const res = await get(h, '/go/spring?%zz=1&y=%C0%AF');
      expect(res.headers.location).toBe(`${DEST}&%zz=1&y=%C0%AF`);
    });

    it('stops decoding well-formed parts next to a malformed one', async () => {
      const { h } = await setup();
      const res = await get(h, '/go/spring?a=caf%C3%A9&b=100%');
      expect(res.headers.location).toBe(`${DEST}&a=caf%C3%A9&b=100%`);
    });
  });

  describe("cache headers on shorty's own 404 / 410", () => {
    it("lets the onMiss: 'notFound' 404 be cached", async () => {
      const { h } = await setup({ config: { redirect: { onMiss: 'notFound' } } });
      const res = await get(h, '/go/nolink');
      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('private, max-age=0');
    });

    it('lets the expired 410 page be cached', async () => {
      const h = await harness();
      await h.shorty.createLink({ url: DEST, slug: 'spring', expiresAt: new Date(h.clock.now.getTime() + HOUR) });
      h.clock.advance(2 * HOUR);
      const res = await get(h, '/go/spring');
      expect(res.status).toBe(410);
      expect(res.headers['cache-control']).toBe('private, max-age=0');
    });

    it("lets the expired onExpired: 'notFound' 404 be cached", async () => {
      const h = await harness({ config: { redirect: { onExpired: 'notFound' } } });
      await h.shorty.createLink({ url: DEST, slug: 'spring', expiresAt: new Date(h.clock.now.getTime() + HOUR) });
      h.clock.advance(2 * HOUR);
      const res = await get(h, '/go/spring');
      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('private, max-age=0');
    });
  });

  describe('Vary: User-Agent (crawler card vs redirect from one URL)', () => {
    it.each([301, 302, 307, 308] as const)('omits Vary: User-Agent on a %i link redirect', async (status) => {
      const { h } = await setup({}, { redirect: { status } });
      const res = await get(h, '/go/spring');
      expect(res.status).toBe(status);
      expect(res.headers.vary ?? '').toMatch(/(^|,\s*)User-Agent(\s*,|$)/i);
    });

    it('omits Vary: User-Agent on the crawler social card', async () => {
      const { h } = await setup({}, { social: { title: 'Spring sale' } });
      const res = await get(h, '/go/spring', CRAWLER_UA);
      expect(res.status).toBe(200);
      expect(res.headers.vary ?? '').toMatch(/(^|,\s*)User-Agent(\s*,|$)/i);
    });
  });
});

describe('PR 8 review follow-ups — no in-band markers in Location', () => {
  const MARKERS = ['__shorty_pct__', '__pct__', 'PCT', '\u0000pct'];

  it.each(MARKERS.filter((m) => !m.includes('\u0000')))('does not rewrite a forwarded value that happens to contain %s', async (m) => {
    const { h } = await setup({}, { url: 'https://acme.com/s?u=1', slug: 'mk' });
    const res = await get(h, `/go/mk?x=${encodeURIComponent(m)}&${encodeURIComponent(m)}=1`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.get('x')).toBe(m);
    expect(loc.searchParams.get(m)).toBe('1');
  });

  it('does not rewrite a destination path that contains a marker-like string, with or without forwarding', async () => {
    const { h } = await setup({ config: { redirect: { forwardQuery: false } } }, { url: 'https://acme.com/__shorty_pct__/x', slug: 'mp' });
    const res = await get(h, '/go/mp');
    expect(res.headers.location).toBe('https://acme.com/__shorty_pct__/x');
  });

  it('still forwards a malformed escape verbatim beside a marker-like value', async () => {
    const { h } = await setup({}, { url: 'https://acme.com/s', slug: 'mv' });
    const res = await get(h, '/go/mv?a=%ZZ&b=__shorty_pct__');
    expect(res.headers.location).toBe('https://acme.com/s?a=%ZZ&b=__shorty_pct__');
  });
});
