import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
