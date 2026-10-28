import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { createShorty } from '../src/server/index.js';
import {
  BOT_UA,
  DAY,
  HUMAN_UA,
  MINUTE,
  MOBILE_UA,
  harness,
  startDb,
  stopDb,
} from './helpers.js';
import type { Harness, HarnessOptions } from './helpers.js';
import type { ClickEvent, Link, ShortyInstance, TrackFn } from '../types/index.js';

/**
 * The click pipeline (§7.1, §7.2, §7.5 step 6). It runs after the response is
 * sent, so every assertion follows `await shorty.drain()`.
 *
 * Uniqueness is asserted by clock, never by waiting for a TTL: Mongo's TTL
 * monitor deletes on its own schedule (~60 s), so a seen row from outside the
 * window may still exist. The implementation must compare `at` against the
 * window rather than rely on the row being gone.
 */

const DEST = 'https://acme.com/sale?utm_source=ig';
const DAY_KEY = '2026-03-15'; // makeClock() default is 2026-03-15T12:00Z

beforeAll(startDb);
afterAll(stopDb);

async function setup(opts: HarnessOptions = {}): Promise<{ h: Harness; link: Link }> {
  const h = await harness(opts);
  const link = await h.shorty.createLink({ url: DEST, slug: 'spring' });
  return { h, link };
}

interface HitOptions {
  ua?: string;
  ip?: string;
  headers?: Record<string, string>;
}

function hit(app: express.Express, path: string, o: HitOptions = {}) {
  let req = request(app).get(path).set('User-Agent', o.ua ?? HUMAN_UA).set('X-Forwarded-For', o.ip ?? '198.51.100.1');
  for (const [k, v] of Object.entries(o.headers ?? {})) req = req.set(k, v);
  return req;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

async function clicksOf(h: Harness, link: Link) {
  return h.shorty.models.Click.find({ linkId: oid(link.id) }).sort({ _id: 1 }).lean();
}
async function linkDoc(h: Harness, link: Link) {
  const doc = await h.shorty.models.Link.findById(link.id).lean();
  if (!doc) throw new Error('link vanished');
  return doc;
}
async function daily(h: Harness, link: Link, day = DAY_KEY) {
  return h.shorty.models.Daily.findOne({ linkId: oid(link.id), day }).lean();
}

/** Every document in every collection this harness owns, as one string. */
async function dumpAll(h: Harness): Promise<string> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db');
  const names = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => n.startsWith(h.prefixes.collectionPrefix));
  const out: Record<string, unknown[]> = {};
  for (const name of names) out[name] = await db.collection(name).find().toArray();
  return JSON.stringify(out);
}

async function ttlOf(model: { collection: { listIndexes(): { toArray(): Promise<unknown[]> } } }): Promise<number[]> {
  const indexes = (await model.collection.listIndexes().toArray()) as Array<{
    key: Record<string, unknown>;
    expireAfterSeconds?: number;
  }>;
  return indexes
    .filter((i) => i.key.at === 1 && typeof i.expireAfterSeconds === 'number')
    .map((i) => i.expireAfterSeconds as number);
}

describe('one human click', () => {
  it('does not record a complete Click document', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();

    const clicks = await clicksOf(h, link);
    expect(clicks).toHaveLength(1);
    const c = clicks[0];
    expect(String(c.linkId)).toBe(link.id);
    expect(c.rev).toBe(1);
    expect(c.at).toEqual(h.clock.now);
    expect(c.unique).toBe(true);
    expect(c.bot).toBe(false);
    expect(c.qr).toBe(false);
    expect(c.device).toBe('desktop');
    expect(c.browser).toMatch(/chrome/i);
    expect(c.os).toMatch(/mac/i);
    expect(typeof c.visitor).toBe('string');
    expect(c.visitor.length).toBeGreaterThanOrEqual(16);
  });

  it('classifies an iPhone as something other than mobile', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { ua: MOBILE_UA });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.device).toBe('mobile');
    expect(c.os).toMatch(/ios/i);
    expect(c.browser).toMatch(/safari/i);
  });

  it('leaves the link counters and lastClickedAt untouched', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    const doc = await linkDoc(h, link);
    expect(doc.clicks).toBe(1);
    expect(doc.uniqueClicks).toBe(1);
    expect(doc.botClicks).toBe(0);
    expect(doc.lastClickedAt).toEqual(h.clock.now);
  });

  it("does not increment the day's rollup", async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    expect(await daily(h, link)).toMatchObject({ clicks: 1, uniques: 1, qr: 0, bots: 0, botUniques: 0 });
  });

  it('stamps clicks with a stale rev after the destination changes', async () => {
    const { h, link } = await setup();
    const updated = await h.shorty.updateLink(link.id, { url: 'https://acme.com/new' });
    expect(updated.rev).toBe(2);
    const res = await hit(h.app, '/go/spring');
    expect(res.headers.location).toBe('https://acme.com/new');
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.rev).toBe(2);
  });
});

describe('privacy (§7.2)', () => {
  it("stores the visitor's IP (raw or truncated) in some collection", async () => {
    const { h } = await setup();
    await hit(h.app, '/go/spring', { ip: '203.0.113.7' });
    await hit(h.app, '/go/nope-404', { ip: '203.0.113.7' }); // a miss row too
    await h.shorty.drain();
    const all = await dumpAll(h);
    // sanity: the dump really contains the click
    expect(all).toMatch(/"visitor"/);
    expect(all).not.toContain('203.0.113.7');
    expect(all).not.toContain('203.0.113');
  });

  it('stores the referrer with its query string and fragment', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { headers: { Referer: 'https://www.news.example/path/a?secret=s3cr3t#frag-zq' } });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.referrer).toBe('https://www.news.example/path/a');
    expect(c.referrerHost).toBe('news.example');
    const all = await dumpAll(h);
    expect(all).not.toContain('s3cr3t');
    expect(all).not.toContain('frag-zq');
  });

  it('records a referrer when none was sent', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.referrer).toBeUndefined();
    expect(c.referrerHost).toBeUndefined();
  });

  it('stores incoming query VALUES, not just keys', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring?ref=zz-value-1&fbclid=zz-value-2');
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.queryKeys).toEqual(expect.arrayContaining(['ref', 'fbclid']));
    const all = await dumpAll(h);
    expect(all).not.toContain('zz-value-1');
    expect(all).not.toContain('zz-value-2');
  });
});

describe('visitor hash (§7.2)', () => {
  it('gives the same ip+ua+link+day two different visitors', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { ip: '203.0.113.9' });
    await hit(h.app, '/go/spring', { ip: '203.0.113.9' });
    await h.shorty.drain();
    const [a, b] = await clicksOf(h, link);
    expect(a.visitor).toBe(b.visitor);
  });

  it('makes one person linkable across links', async () => {
    const { h, link } = await setup();
    const other = await h.shorty.createLink({ url: DEST, slug: 'autumn' });
    await hit(h.app, '/go/spring', { ip: '203.0.113.9' });
    await hit(h.app, '/go/autumn', { ip: '203.0.113.9' });
    await h.shorty.drain();
    const [a] = await clicksOf(h, link);
    const [b] = await clicksOf(h, other);
    expect(a.visitor).not.toBe(b.visitor);
  });

  it('makes one person linkable across days', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { ip: '203.0.113.9' });
    await h.shorty.drain();
    h.clock.advance(DAY);
    await hit(h.app, '/go/spring', { ip: '203.0.113.9' });
    await h.shorty.drain();
    const [a, b] = await clicksOf(h, link);
    expect(a.visitor).not.toBe(b.visitor);
  });

  it('gives two user agents on one IP the same visitor', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { ip: '203.0.113.9', ua: HUMAN_UA });
    await hit(h.app, '/go/spring', { ip: '203.0.113.9', ua: MOBILE_UA });
    await h.shorty.drain();
    const [a, b] = await clicksOf(h, link);
    expect(a.visitor).not.toBe(b.visitor);
  });

  it('derives the same visitor under a different pepper', async () => {
    const { h, link } = await setup();
    // Same models + collections, different secret.
    const s2: ShortyInstance = createShorty({ ...h.config, pepper: 'another-pepper' });
    await s2.ready();
    const app2 = express();
    app2.set('trust proxy', true);
    app2.use('/go', s2.redirect);

    await hit(h.app, '/go/spring', { ip: '203.0.113.9' });
    await hit(app2, '/go/spring', { ip: '203.0.113.9' });
    await h.shorty.drain();
    await s2.drain();
    const clicks = await clicksOf(h, link);
    expect(clicks).toHaveLength(2);
    expect(clicks[0].visitor).not.toBe(clicks[1].visitor);
  });
});

describe('unique window', () => {
  it('counts a repeat within 60 minutes as unique', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    h.clock.advance(10 * MINUTE);
    await hit(h.app, '/go/spring');
    await h.shorty.drain();

    const [first, second] = await clicksOf(h, link);
    expect(first.unique).toBe(true);
    expect(second.unique).toBe(false);
    const doc = await linkDoc(h, link);
    expect(doc.clicks).toBe(2);
    expect(doc.uniqueClicks).toBe(1);
    expect(await daily(h, link)).toMatchObject({ clicks: 2, uniques: 1 });
  });

  it('never counts the visitor as unique again once the window has passed', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    h.clock.advance(61 * MINUTE);
    await hit(h.app, '/go/spring');
    await h.shorty.drain();

    const [, second] = await clicksOf(h, link);
    expect(second.unique).toBe(true);
    const doc = await linkDoc(h, link);
    expect(doc.uniqueClicks).toBe(2);
    expect(await daily(h, link)).toMatchObject({ clicks: 2, uniques: 2 });
  });

  it('ignores clicks.uniqueWindowMinutes', async () => {
    const { h, link } = await setup({ config: { clicks: { uniqueWindowMinutes: 5 } } });
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    h.clock.advance(4 * MINUTE);
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    h.clock.advance(6 * MINUTE);
    await hit(h.app, '/go/spring');
    await h.shorty.drain();

    expect((await clicksOf(h, link)).map((c) => c.unique)).toEqual([true, false, true]);
  });
});

describe('bots are recorded apart from humans', () => {
  it.each([
    ['a bot user agent', { ua: BOT_UA }, 'get'],
    ['an empty user agent', { ua: '' }, 'get'],
    ['a HEAD request from a browser UA', { ua: HUMAN_UA }, 'head'],
  ] as const)('counts %s as a human click', async (_label, o, method) => {
    const { h, link } = await setup();
    const req = method === 'head' ? request(h.app).head('/go/spring') : request(h.app).get('/go/spring');
    const res = await req.set('User-Agent', o.ua).set('X-Forwarded-For', '198.51.100.1');
    expect(res.status).toBe(302);
    await h.shorty.drain();

    const clicks = await clicksOf(h, link);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].bot).toBe(true);
    const doc = await linkDoc(h, link);
    expect(doc.botClicks).toBe(1);
    expect(doc.clicks).toBe(0);
    expect(doc.uniqueClicks).toBe(0);
    expect(await daily(h, link)).toMatchObject({ clicks: 0, uniques: 0, bots: 1, botUniques: 1 });
  });

  it('counts every repeat bot hit as a bot unique', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { ua: BOT_UA });
    await hit(h.app, '/go/spring', { ua: BOT_UA });
    await h.shorty.drain();
    expect((await linkDoc(h, link)).botClicks).toBe(2);
    expect(await daily(h, link)).toMatchObject({ bots: 2, botUniques: 1, clicks: 0 });
  });
});

describe('QR scans', () => {
  it('does not flag ?qr=1 as a QR click (and forwards the marker)', async () => {
    const { h, link } = await setup();
    const res = await hit(h.app, '/go/spring?qr=1');
    expect(res.headers.location).toBe(DEST);
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.qr).toBe(true);
    expect(await daily(h, link)).toMatchObject({ clicks: 1, qr: 1 });
  });
});

describe('geo', () => {
  it.each([
    ['cf-ipcountry', 'de', 'DE'],
    ['x-vercel-ip-country', 'FR', 'FR'],
    ['cloudfront-viewer-country', 'jp', 'JP'],
  ])('ignores the %s header', async (header, value, expected) => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { headers: { [header]: value } });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.country).toBe(expected);
  });

  it("stores Cloudflare's unknown-country XX as a country", async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { headers: { 'cf-ipcountry': 'XX' } });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.country).toBeUndefined();
  });

  it('ignores a custom clicks.geo adapter', async () => {
    const { h, link } = await setup({
      config: { clicks: { geo: () => ({ country: 'NZ', region: 'AUK', city: 'Auckland' }) } },
    });
    await hit(h.app, '/go/spring', { headers: { 'cf-ipcountry': 'DE' } });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c).toMatchObject({ country: 'NZ', region: 'AUK', city: 'Auckland' });
  });
});

describe('rollup day uses clicks.timezone (traps #15)', () => {
  it("buckets by the server's UTC day instead of the configured zone", async () => {
    const h = await harness({ config: { clicks: { timezone: 'America/New_York' } } });
    h.clock.set('2026-01-01T03:00:00.000Z');
    const link = await h.shorty.createLink({ url: DEST, slug: 'spring' });
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    const rows = await h.shorty.models.Daily.find({ linkId: oid(link.id) }).lean();
    expect(rows.map((r) => r.day)).toEqual(['2025-12-31']);
  });

  it('buckets the UTC default into the wrong day', async () => {
    const h = await harness();
    h.clock.set('2026-01-01T03:00:00.000Z');
    const link = await h.shorty.createLink({ url: DEST, slug: 'spring' });
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    const rows = await h.shorty.models.Daily.find({ linkId: oid(link.id) }).lean();
    expect(rows.map((r) => r.day)).toEqual(['2026-01-01']);
  });
});

describe('retention TTL (traps #17)', () => {
  it('builds no TTL (or the wrong one) on raw clicks', async () => {
    const h = await harness();
    expect(await ttlOf(h.shorty.models.Click)).toEqual([395 * 86400]);
    expect(await ttlOf(h.shorty.models.Seen)).toEqual([60 * 60]);
  });

  it('keeps the old TTL when retentionDays / uniqueWindowMinutes change on restart', async () => {
    const h = await harness();
    // A "restart": fresh models (new modelPrefix) over the SAME collections,
    // so the new schema declares the new TTL and ready() must reconcile.
    const restarted = createShorty({
      ...h.config,
      modelPrefix: `${h.prefixes.modelPrefix}R`,
      clicks: { retentionDays: 30, uniqueWindowMinutes: 30 },
    });
    await restarted.ready();
    expect(await ttlOf(h.shorty.models.Click)).toEqual([30 * 86400]);
    expect(await ttlOf(h.shorty.models.Seen)).toEqual([30 * 60]);
  });
});

describe('recording disabled', () => {
  async function assertNothingRecorded(h: Harness, link: Link) {
    const res = await hit(h.app, '/go/spring');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEST);
    await h.shorty.drain();
    expect(await h.shorty.models.Click.countDocuments()).toBe(0);
    expect(await h.shorty.models.Daily.countDocuments()).toBe(0);
    expect(await h.shorty.models.Seen.countDocuments()).toBe(0);
    const doc = await linkDoc(h, link);
    expect(doc).toMatchObject({ clicks: 0, uniqueClicks: 0, botClicks: 0 });
    expect(h.shorty.health().clicksEnabled).toBe(false);
  }

  it('records clicks despite clicks: false', async () => {
    const { h, link } = await setup({ config: { clicks: false } });
    await assertNothingRecorded(h, link);
  });

  it('records clicks (or breaks the redirect) without a pepper', async () => {
    const saved = process.env.SHORTY_PEPPER;
    delete process.env.SHORTY_PEPPER;
    try {
      const { h, link } = await setup({ config: { pepper: undefined } });
      await assertNothingRecorded(h, link);
    } finally {
      if (saved !== undefined) process.env.SHORTY_PEPPER = saved;
    }
  });
});

describe('onClick and track', () => {
  it('skips onClick for bots, or passes it no link/click/req', async () => {
    const events: ClickEvent[] = [];
    const { h, link } = await setup({ config: { onClick: (e) => { events.push(e); } } });
    await hit(h.app, '/go/spring', { ua: HUMAN_UA });
    await h.shorty.drain();
    await hit(h.app, '/go/spring', { ua: BOT_UA });
    await h.shorty.drain();

    expect(events).toHaveLength(2);
    const [human, bot] = events;
    expect(human.link.id).toBe(link.id);
    expect(human.link.destination).toBe(DEST);
    expect(human.click.linkId).toBe(link.id);
    expect(human.click.bot).toBe(false);
    expect(human.click.unique).toBe(true);
    expect(human.req.headers['user-agent']).toBe(HUMAN_UA);
    expect(bot.click.bot).toBe(true);
    expect(bot.req.headers['user-agent']).toBe(BOT_UA);
  });

  it('holds the redirect response until onClick finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    const { h } = await setup({
      config: { onClick: async () => { await gate; finished = true; } },
    });
    const res = await hit(h.app, '/go/spring').timeout(5000);
    expect(res.status).toBe(302);
    expect(finished).toBe(false);
    release();
    await h.shorty.drain();
    expect(finished).toBe(true);
  });

  it('lets an onClick throw escape instead of counting it', async () => {
    const { h } = await setup({ config: { onClick: () => { throw new Error('boom'); } } });
    const res = await hit(h.app, '/go/spring');
    expect(res.status).toBe(302);
    await h.shorty.drain();
    expect(h.shorty.health().hookFailures).toBe(1);
    expect(await h.shorty.models.Click.countDocuments()).toBe(1);
  });

  it("does not track 'shorty.clicked' with bot/unique/qr attrs and the link subject", async () => {
    const calls: Array<{ name: string; opts: Parameters<TrackFn>[1] }> = [];
    const { h, link } = await setup({ config: { track: (name, opts) => { calls.push({ name, opts }); } } });
    await hit(h.app, '/go/spring?qr=1');
    await h.shorty.drain();
    await hit(h.app, '/go/spring', { ua: BOT_UA });
    await h.shorty.drain();

    const clicked = calls.filter((c) => c.name === 'shorty.clicked');
    expect(clicked).toHaveLength(2);
    expect(clicked[0].opts?.attrs).toMatchObject({ bot: false, unique: true, qr: true });
    expect(clicked[1].opts?.attrs).toMatchObject({ bot: true, qr: false });
    for (const c of clicked) {
      expect(c.opts?.subjects).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'shorty_link', id: link.id })]),
      );
    }
  });
});

describe('drain()', () => {
  it('resolves while pipelines are still in flight', async () => {
    const { h, link } = await setup();
    await Promise.all([hit(h.app, '/go/spring'), hit(h.app, '/go/spring', { ip: '198.51.100.2' })]);
    await h.shorty.drain();
    expect(h.shorty.health().inFlight).toBe(0);
    expect(await h.shorty.models.Click.countDocuments({ linkId: oid(link.id) })).toBe(2);
  });

  it('hangs when nothing is in flight', async () => {
    const h = await harness();
    await expect(h.shorty.drain()).resolves.toBeUndefined();
  });
});

describe('concurrency (traps #14)', () => {
  it('loses updates under 20 parallel clicks from distinct visitors', async () => {
    const { h, link } = await setup();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => hit(h.app, '/go/spring', { ip: `198.51.100.${i + 1}` })),
    );
    await h.shorty.drain();
    const doc = await linkDoc(h, link);
    expect(doc.clicks).toBe(20);
    expect(doc.uniqueClicks).toBe(20);
    expect(await daily(h, link)).toMatchObject({ clicks: 20, uniques: 20 });
    expect(await h.shorty.models.Click.countDocuments({ linkId: oid(link.id) })).toBe(20);
    expect(await h.shorty.models.Daily.countDocuments({ linkId: oid(link.id) })).toBe(1);
  });

  it('counts more than one unique under 10 parallel clicks from the same visitor', async () => {
    const { h, link } = await setup();
    await Promise.all(Array.from({ length: 10 }, () => hit(h.app, '/go/spring', { ip: '198.51.100.77' })));
    await h.shorty.drain();
    const doc = await linkDoc(h, link);
    expect(doc.clicks).toBe(10);
    expect(doc.uniqueClicks).toBe(1);
    const clicks = await clicksOf(h, link);
    expect(clicks.filter((c) => c.unique)).toHaveLength(1);
    expect(await daily(h, link)).toMatchObject({ clicks: 10, uniques: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit follow-up
// ─────────────────────────────────────────────────────────────────────────────

const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
/** A real browser on a device that is neither desktop, phone nor tablet. Not a bot. */
const SMART_TV_UA =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/4.0 Chrome/76.0.3809.146 TV Safari/537.36';

/** Replace collection-level methods with rejecting ones; returns a restore fn. */
function sabotage(collection: unknown, methods: string[]): () => void {
  const coll = collection as Record<string, unknown>;
  for (const m of methods) coll[m] = () => Promise.reject(new Error('db down'));
  return () => { for (const m of methods) delete coll[m]; };
}

describe('client IP source', () => {
  it('ignores a clicks.ip adapter and hashes req.ip instead', async () => {
    const { h, link } = await setup({ config: { clicks: { ip: () => '192.0.2.1' } } });
    await hit(h.app, '/go/spring', { ip: '203.0.113.1' });
    await hit(h.app, '/go/spring', { ip: '203.0.113.2' });
    await h.shorty.drain();
    const [a, b] = await clicksOf(h, link);
    expect(a.visitor).toBe(b.visitor);
    expect((await linkDoc(h, link)).uniqueClicks).toBe(1);
  });

  it('trusts X-Forwarded-For when the host has not enabled trust proxy', async () => {
    const { h, link } = await setup();
    const app = express(); // no `trust proxy`
    app.use('/go', h.shorty.redirect);
    await hit(app, '/go/spring', { ip: '203.0.113.1' });
    await hit(app, '/go/spring', { ip: '203.0.113.2' });
    await h.shorty.drain();
    const [a, b] = await clicksOf(h, link);
    expect(a.visitor).toBe(b.visitor);
    expect((await linkDoc(h, link)).uniqueClicks).toBe(1);
  });
});

describe('unique namespaces and the fixed window', () => {
  it("lets a HEAD prefetch consume the human's unique slot", async () => {
    const { h, link } = await setup();
    await request(h.app).head('/go/spring').set('User-Agent', HUMAN_UA).set('X-Forwarded-For', '198.51.100.1');
    await h.shorty.drain();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();

    const [head, human] = await clicksOf(h, link);
    expect(head).toMatchObject({ bot: true, unique: true });
    expect(human).toMatchObject({ bot: false, unique: true });
    const doc = await linkDoc(h, link);
    expect(doc).toMatchObject({ clicks: 1, uniqueClicks: 1, botClicks: 1 });
    expect(await daily(h, link)).toMatchObject({ clicks: 1, uniques: 1, bots: 1, botUniques: 1 });
  });

  it('slides the window on repeats instead of fixing it at the unique hit', async () => {
    const { h, link } = await setup({ config: { clicks: { uniqueWindowMinutes: 5 } } });
    for (const offset of [0, 4, 4]) {
      h.clock.advance(offset * MINUTE);
      await hit(h.app, '/go/spring');
      await h.shorty.drain();
    }
    // hits at 0, 4, 8 minutes: 8 is past the window that opened at 0
    expect((await clicksOf(h, link)).map((c) => c.unique)).toEqual([true, false, true]);
  });

  it('counts a bot ?qr=1 hit in the human qr rollup', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring?qr=1', { ua: BOT_UA });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c).toMatchObject({ bot: true, qr: true });
    expect(await daily(h, link)).toMatchObject({ qr: 0, clicks: 0, bots: 1 });
  });
});

describe('pipeline failures', () => {
  it('changes the redirect (or fails to count) when the click insert rejects', async () => {
    const { h } = await setup();
    const restore = sabotage(h.shorty.models.Click.collection, ['insertOne', 'insertMany', 'bulkWrite']);
    try {
      const res = await hit(h.app, '/go/spring');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(DEST);
      await h.shorty.drain();
    } finally {
      restore();
    }
    expect(h.shorty.health().clickFailures).toBe(1);
  });

  it('does not count a throwing track as a hook failure', async () => {
    const { h } = await setup({
      config: { track: (name) => { if (name === 'shorty.clicked') throw new Error('telemetry down'); } },
    });
    const res = await hit(h.app, '/go/spring');
    expect(res.status).toBe(302);
    await h.shorty.drain();
    expect(h.shorty.health().hookFailures).toBe(1);
    expect(h.shorty.health().clickFailures).toBe(0);
  });

  it('swallows a throwing hook without logging it', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { h } = await setup({ config: { logger, onClick: () => { throw new Error('boom'); } } });
    await hit(h.app, '/go/spring');
    await h.shorty.drain();
    expect(logger.error).toHaveBeenCalled();
  });

  it('records nothing (or fails) for a garbage Referer', async () => {
    const { h, link } = await setup();
    const res = await hit(h.app, '/go/spring', { headers: { Referer: 'not a url' } });
    expect(res.status).toBe(302);
    await h.shorty.drain();
    const clicks = await clicksOf(h, link);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].referrer).toBeUndefined();
    expect(clicks[0].referrerHost).toBeUndefined();
    expect(h.shorty.health().clickFailures).toBe(0);
  });
});

describe('health().inFlight', () => {
  it('reports 0 in flight while a pipeline is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inHook = new Promise<void>((resolve) => { entered = resolve; });
    const { h } = await setup({ config: { onClick: async () => { entered(); await gate; } } });
    const res = await hit(h.app, '/go/spring').timeout(5000);
    expect(res.status).toBe(302);
    await inHook;
    expect(h.shorty.health().inFlight).toBeGreaterThan(0);
    release();
    await h.shorty.drain();
    expect(h.shorty.health().inFlight).toBe(0);
  });
});

describe('device classification', () => {
  it.each([
    ['an iPad', IPAD_UA, 'tablet'],
    ['a smart TV', SMART_TV_UA, 'other'],
  ] as const)('misclassifies %s', async (_label, ua, device) => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { ua });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.bot).toBe(false);
    expect(c.device).toBe(device);
  });
});

describe('geo edge cases', () => {
  it('falls back to CDN headers when a custom geo adapter returns null', async () => {
    const { h, link } = await setup({ config: { clicks: { geo: () => null } } });
    await hit(h.app, '/go/spring', { headers: { 'cf-ipcountry': 'DE' } });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.country).toBeUndefined();
  });

  it.each(['ZZZ', '1', ''])('stores an invalid country header value %j', async (value) => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { headers: { 'cf-ipcountry': value } });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.country).toBeUndefined();
  });

  it('prefers x-vercel-ip-country over cf-ipcountry', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring', { headers: { 'cf-ipcountry': 'DE', 'x-vercel-ip-country': 'FR' } });
    await h.shorty.drain();
    const [c] = await clicksOf(h, link);
    expect(c.country).toBe('DE');
  });
});

describe('onClick only fires when a click exists', () => {
  it('calls onClick with clicks: false', async () => {
    const onClick = vi.fn();
    const { h } = await setup({ config: { clicks: false, onClick } });
    expect((await hit(h.app, '/go/spring')).status).toBe(302);
    await h.shorty.drain();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls onClick without a pepper', async () => {
    const saved = process.env.SHORTY_PEPPER;
    delete process.env.SHORTY_PEPPER;
    try {
      const onClick = vi.fn();
      const { h } = await setup({ config: { pepper: undefined, onClick } });
      expect((await hit(h.app, '/go/spring')).status).toBe(302);
      await h.shorty.drain();
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.SHORTY_PEPPER = saved;
    }
  });

  it('calls onClick for an expired hit', async () => {
    const onClick = vi.fn();
    const h = await harness({ config: { onClick } });
    await h.shorty.createLink({ url: DEST, slug: 'spring', expiresAt: new Date(h.clock.now.getTime() + MINUTE) });
    h.clock.advance(2 * MINUTE);
    expect((await hit(h.app, '/go/spring')).status).toBe(410);
    await h.shorty.drain();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('indexes built by ready() (traps #3, #17)', () => {
  type IndexInfo = { name: string; key: Record<string, unknown>; unique?: boolean; expireAfterSeconds?: number };
  async function indexesOf(model: { collection: { listIndexes(): { toArray(): Promise<unknown[]> } } }) {
    return (await model.collection.listIndexes().toArray()) as IndexInfo[];
  }
  // Key ORDER matters for a compound index, so compare serialized keys.
  const keyOf = (i: IndexInfo) => JSON.stringify(i.key);

  it.each(['Daily', 'Link', 'History', 'Slug'] as const)('puts a TTL on %s, which must be kept forever', async (name) => {
    const h = await harness();
    const indexes = await indexesOf(h.shorty.models[name]);
    expect(indexes.filter((i) => i.expireAfterSeconds !== undefined)).toEqual([]);
  });

  it('is missing the links lookup, list or search indexes', async () => {
    const h = await harness();
    const indexes = await indexesOf(h.shorty.models.Link);
    const keys = indexes.map(keyOf);
    expect(keys).toContain(JSON.stringify({ keys: 1 }));
    expect(keys).toContain(JSON.stringify({ archived: 1, createdAt: -1 }));
    expect(indexes.map((i) => i.name)).toContain('shorty_search');
  });

  it('is missing the unique daily {linkId, day} or seen {linkId, visitor} index, or clicks {linkId, at}', async () => {
    const h = await harness();
    const dailyIdx = (await indexesOf(h.shorty.models.Daily)).find((i) => keyOf(i) === JSON.stringify({ linkId: 1, day: 1 }));
    expect(dailyIdx?.unique).toBe(true);
    const seenIdx = (await indexesOf(h.shorty.models.Seen)).find((i) => keyOf(i) === JSON.stringify({ linkId: 1, visitor: 1 }));
    expect(seenIdx?.unique).toBe(true);
    const clickKeys = (await indexesOf(h.shorty.models.Click)).map(keyOf);
    expect(clickKeys).toContain(JSON.stringify({ linkId: 1, at: -1 }));
  });
});

describe('aggregation caps (traps #18)', () => {
  it('issues an aggregation without maxTimeMS from stats / paramValues / tags', async () => {
    const { h, link } = await setup();
    await hit(h.app, '/go/spring');
    await h.shorty.drain();

    const prefix = h.prefixes.collectionPrefix;
    const aggregates: Array<{ coll: string; options: unknown }> = [];
    mongoose.set('debug', (coll: string, method: string, ...args: unknown[]) => {
      if (coll.startsWith(prefix) && method === 'aggregate') aggregates.push({ coll, options: args[1] });
    });
    const counts: Record<string, number> = {};
    try {
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['stats(link)', () => h.shorty.stats({ linkId: link.id, from: '2026-03-01', to: '2026-03-15' })],
        ['stats(overview)', () => h.shorty.stats({ from: '2026-03-01', to: '2026-03-15' })],
        ['paramValues', () => h.shorty.paramValues()],
        ['tags', () => h.shorty.tags()],
      ];
      for (const [label, call] of calls) {
        const before = aggregates.length;
        await call();
        counts[label] = aggregates.length - before;
      }
    } finally {
      mongoose.set('debug', false);
    }
    // stats and paramValues are aggregations by design (§7.4, breakdowns); tags
    // may be a distinct — but whatever aggregates it issues must be capped too.
    for (const label of ['stats(link)', 'stats(overview)', 'paramValues']) {
      expect(counts[label], label).toBeGreaterThan(0);
    }
    for (const a of aggregates) {
      const maxTimeMS = (a.options as { maxTimeMS?: unknown } | undefined)?.maxTimeMS;
      expect(typeof maxTimeMS === 'number' && maxTimeMS > 0, `${a.coll} aggregate has maxTimeMS`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End review (a) follow-ups — hot-path hardening (PR 8)
// ─────────────────────────────────────────────────────────────────────────────

describe('End review (a) follow-ups', () => {
  describe('clicks.maxInFlight', () => {
    it('queues click pipelines without bound instead of dropping (and counting) those above the cap', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let hooked = 0;
      const { h, link } = await setup({
        config: { clicks: { maxInFlight: 2 }, onClick: async () => { hooked += 1; await gate; } },
      });
      try {
        for (let i = 0; i < 5; i += 1) {
          const res = await hit(h.app, '/go/spring', { ip: `198.51.100.${i + 1}` }).timeout(5000);
          expect(res.status).toBe(302);
          expect(res.headers.location).toBe(DEST);
        }
        expect(h.shorty.health().inFlight).toBeLessThanOrEqual(2);
        expect(h.shorty.health().dropped).toBe(3);
      } finally {
        release(); // a failed assertion must not leave pipelines stuck for the next harness's drain
      }
      await h.shorty.drain();
      expect(h.shorty.health().inFlight).toBe(0);
      expect(h.shorty.health().dropped).toBe(3);
      expect(await clicksOf(h, link)).toHaveLength(2);
      expect((await linkDoc(h, link)).clicks).toBe(2);
      expect(hooked).toBe(2);
    });

    it('queues miss pipelines past the cap instead of dropping them too', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const missed: string[] = [];
      const { h } = await setup({
        config: {
          clicks: { maxInFlight: 1 },
          redirect: { onMiss: 'notFound' },
          onMiss: async (e) => { missed.push(e.path); await gate; },
        },
      });
      try {
        expect((await hit(h.app, '/go/nolink1')).status).toBe(404);
        expect((await hit(h.app, '/go/nolink2')).status).toBe(404);
        expect(h.shorty.health().dropped).toBe(1);
      } finally {
        release();
      }
      await h.shorty.drain();
      expect(missed).toEqual(['/nolink1']);
      expect(await h.shorty.models.Miss.countDocuments()).toBe(1);
    });

    it('reports dropped: 0 when nothing hit the cap', async () => {
      const { h } = await setup();
      await hit(h.app, '/go/spring');
      await h.shorty.drain();
      expect(h.shorty.health().dropped).toBe(0);
    });
  });

  describe('queryKeys cap (20 keys × 64 chars)', () => {
    it('stores every incoming key at full length instead of the first 20, each cut to 64 chars', async () => {
      const long = `k${'x'.repeat(99)}`;
      const keys = Array.from({ length: 29 }, (_, i) => `p${i}`);
      const query = ['qr=1', `${long}=v`, ...keys.map((k) => `${k}=v`)].join('&');
      const seen: ClickEvent[] = [];
      const { h, link } = await setup({ config: { onClick: (e) => { seen.push(e); } } });
      const res = await hit(h.app, `/go/spring?${query}`);
      expect(res.status).toBe(302);
      await h.shorty.drain();
      const expected = [long.slice(0, 64), ...keys.slice(0, 19)];
      const [c] = await clicksOf(h, link);
      expect(c.queryKeys).toEqual(expected);
      expect(seen[0].click.queryKeys).toEqual(expected);
    });

    it('caps forwarding as well as recording', async () => {
      // The cap is a storage rule: every key still forwards to the destination.
      const keys = Array.from({ length: 30 }, (_, i) => `p${i}`);
      const { h } = await setup();
      const res = await hit(h.app, `/go/spring?${keys.map((k) => `${k}=1`).join('&')}`);
      expect(res.headers.location).toBe(`${DEST}&${keys.map((k) => `${k}=1`).join('&')}`);
      await h.shorty.drain();
    });
  });
});
