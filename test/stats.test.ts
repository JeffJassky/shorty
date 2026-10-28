import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { ShortyError } from '../src/shared/errors.js';
import type { Breakdown, DailyDoc, Stats, StatsPoint } from '../types/index.js';
import { BOT_UA, DAY, HUMAN_UA, MOBILE_UA, harness, startDb, stopDb } from './helpers.js';
import type { Harness, HarnessOptions } from './helpers.js';

/**
 * `shorty.stats()`, `paramValues()`, `tags()` (§7.4, §8, StatsQuery in types/).
 *
 * Seeding, per test, says which:
 *  - REAL CLICKS (GET /go/<slug> + drain) where the thing under test spans the
 *    click pipeline and the aggregation — timezone bucketing, breakdowns,
 *    revisions, overview.
 *  - DIRECT ROLLUPS (`models.Daily`) / DIRECT CLICKS (`models.Click`) where
 *    the shape of the input must be exact — gap filling, week/month buckets,
 *    top-N ordering over 60 referrers.
 *
 * Range convention assumed throughout: date-only `from`/`to` strings are
 * calendar days in `clicks.timezone`, BOTH inclusive. The harness clock is
 * 2026-03-15T12:00Z (a Sunday).
 */

beforeAll(startDb);
afterAll(stopDb);

type Counts = Partial<Pick<DailyDoc, 'clicks' | 'uniques' | 'qr' | 'bots' | 'botUniques'>>;

async function daily(h: Harness, linkId: string, day: string, c: Counts) {
  await h.shorty.models.Daily.create({
    linkId: new Types.ObjectId(linkId), day, clicks: 0, uniques: 0, qr: 0, bots: 0, botUniques: 0, ...c,
  });
}

interface ClickOpts { ua?: string; referer?: string; country?: string; qr?: boolean; ip?: string }

let ipSeq = 1;
async function click(h: Harness, slug: string, o: ClickOpts = {}) {
  let r = request(h.app)
    .get(`/go/${slug}${o.qr ? '?qr=1' : ''}`)
    .set('User-Agent', o.ua ?? HUMAN_UA)
    .set('X-Forwarded-For', o.ip ?? `203.0.113.${ipSeq++ % 250}`);
  if (o.referer) r = r.set('Referer', o.referer);
  if (o.country) r = r.set('cf-ipcountry', o.country);
  const res = await r;
  expect([301, 302, 307, 308], `click /go/${slug}`).toContain(res.status);
}

async function setup(opts: HarnessOptions = {}) {
  return harness(opts);
}

const row = (rows: Breakdown[], key: string | RegExp): Breakdown | undefined =>
  rows.find((r) => (typeof key === 'string' ? r.key === key : key.test(r.key)));

function sumSeries(series: StatsPoint[]) {
  const z = { humans: { clicks: 0, uniques: 0, qr: 0 }, bots: { clicks: 0, uniques: 0 } };
  for (const p of series) {
    z.humans.clicks += p.humans.clicks;
    z.humans.uniques += p.humans.uniques;
    z.humans.qr += p.humans.qr;
    z.bots.clicks += p.bots.clicks;
    z.bots.uniques += p.bots.uniques;
  }
  return z;
}

const zero = { humans: { clicks: 0, uniques: 0, qr: 0 }, bots: { clicks: 0, uniques: 0 } };

describe('stats — series (direct rollups)', () => {
  it('fills empty days with zeros and keeps humans and bots apart, never pre-summed', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    const other = await h.shorty.createLink({ url: 'https://example.com/b' });
    await daily(h, link.id, '2026-03-10', { clicks: 3, uniques: 2, qr: 1, bots: 5, botUniques: 4 });
    await daily(h, link.id, '2026-03-12', { clicks: 1, uniques: 1 });
    await daily(h, link.id, '2026-03-20', { clicks: 99 }); // outside the range
    await daily(h, other.id, '2026-03-11', { clicks: 50 }); // another link

    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-10', to: '2026-03-13' });
    expect(s.range).toEqual({ from: '2026-03-10', to: '2026-03-13', interval: 'day', timezone: 'UTC' });
    expect(s.series).toEqual([
      { date: '2026-03-10', humans: { clicks: 3, uniques: 2, qr: 1 }, bots: { clicks: 5, uniques: 4 } },
      { date: '2026-03-11', ...zero },
      { date: '2026-03-12', humans: { clicks: 1, uniques: 1, qr: 0 }, bots: { clicks: 0, uniques: 0 } },
      { date: '2026-03-13', ...zero },
    ]);
    expect(s.totals).toEqual(sumSeries(s.series));
    expect(s.totals.humans.clicks).toBe(4);
    expect(s.totals.bots.clicks).toBe(5);
  });

  it('answers a range with no data as all-zero days, not an empty series', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-01', to: '2026-03-07' });
    expect(s.series.map((p) => p.date)).toEqual([
      '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07',
    ]);
    expect(s.totals).toEqual(zero);
  });

  it('sums every link in the overview (no linkId)', async () => {
    const h = await setup();
    const a = await h.shorty.createLink({ url: 'https://example.com/a' });
    const b = await h.shorty.createLink({ url: 'https://example.com/b' });
    await daily(h, a.id, '2026-03-10', { clicks: 2, bots: 1 });
    await daily(h, b.id, '2026-03-10', { clicks: 3, bots: 4 });
    const s = await h.shorty.stats({ from: '2026-03-10', to: '2026-03-10' });
    expect(s.series).toEqual([
      { date: '2026-03-10', humans: { clicks: 5, uniques: 0, qr: 0 }, bots: { clicks: 5, uniques: 0 } },
    ]);
  });

  it('aggregates week buckets starting Monday', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    await daily(h, link.id, '2026-03-02', { clicks: 1, bots: 1 }); // Mon
    await daily(h, link.id, '2026-03-08', { clicks: 2, uniques: 2 }); // Sun, same week
    await daily(h, link.id, '2026-03-09', { clicks: 4, qr: 1 }); // Mon, next week
    await daily(h, link.id, '2026-03-15', { clicks: 8, botUniques: 3, bots: 3 }); // Sun
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-02', to: '2026-03-15', interval: 'week' });
    expect(s.range.interval).toBe('week');
    expect(s.series).toEqual([
      { date: '2026-03-02', humans: { clicks: 3, uniques: 2, qr: 0 }, bots: { clicks: 1, uniques: 0 } },
      { date: '2026-03-09', humans: { clicks: 12, uniques: 0, qr: 1 }, bots: { clicks: 3, uniques: 3 } },
    ]);
    expect(s.totals).toEqual(sumSeries(s.series));
  });

  it('aggregates month buckets, including an empty month', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    await daily(h, link.id, '2026-01-01', { clicks: 1 });
    await daily(h, link.id, '2026-01-31', { clicks: 2, bots: 7 });
    await daily(h, link.id, '2026-03-15', { clicks: 5 });
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-01-01', to: '2026-03-31', interval: 'month' });
    expect(s.series).toEqual([
      { date: '2026-01-01', humans: { clicks: 3, uniques: 0, qr: 0 }, bots: { clicks: 7, uniques: 0 } },
      { date: '2026-02-01', ...zero },
      { date: '2026-03-01', humans: { clicks: 5, uniques: 0, qr: 0 }, bots: { clicks: 0, uniques: 0 } },
    ]);
    expect(s.totals).toEqual(sumSeries(s.series));
  });
});

describe('stats — timezone (real clicks)', () => {
  it('buckets a click into its day in clicks.timezone, not UTC', async () => {
    const h = await setup({ config: { clicks: { timezone: 'America/New_York' } } });
    await h.shorty.createLink({ url: 'https://example.com/a', slug: 'tz' });
    h.clock.set('2026-03-15T03:00:00.000Z'); // 23:00 on the 14th in New York (EDT)
    await click(h, 'tz');
    h.clock.set('2026-03-15T05:00:00.000Z'); // 01:00 on the 15th in New York
    await click(h, 'tz', { ua: BOT_UA });
    await h.shorty.drain();

    const link = (await h.shorty.link('tz'))!;
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-14', to: '2026-03-15' });
    expect(s.range.timezone).toBe('America/New_York');
    expect(s.series.map((p) => [p.date, p.humans.clicks, p.bots.clicks])).toEqual([
      ['2026-03-14', 1, 0],
      ['2026-03-15', 0, 1],
    ]);
  });
});

describe('stats — breakdowns (real clicks)', () => {
  async function seeded() {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/a', slug: 'promo' });
    await click(h, 'promo', { ua: HUMAN_UA, referer: 'https://www.instagram.com/p/abc?secret=1', country: 'US' });
    await click(h, 'promo', { ua: HUMAN_UA, referer: 'https://instagram.com/stories', country: 'US', qr: true });
    await click(h, 'promo', { ua: MOBILE_UA });
    await click(h, 'promo', { ua: BOT_UA });
    await h.shorty.drain();
    const link = (await h.shorty.link('promo'))!;
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    return { h, link, s };
  }

  it('keys referrers by host, "(direct)" for none, with humans and bots in separate columns', async () => {
    const { s } = await seeded();
    expect(row(s.breakdowns.referrer, 'instagram.com')).toEqual({ key: 'instagram.com', humans: 2, bots: 0 });
    expect(row(s.breakdowns.referrer, '(direct)')).toEqual({ key: '(direct)', humans: 1, bots: 1 });
    expect(s.breakdowns.referrer).toHaveLength(2);
  });

  it('keys countries, "(unknown)" when no geo', async () => {
    const { s } = await seeded();
    expect(row(s.breakdowns.country, 'US')).toEqual({ key: 'US', humans: 2, bots: 0 });
    expect(row(s.breakdowns.country, '(unknown)')).toEqual({ key: '(unknown)', humans: 1, bots: 1 });
  });

  it('breaks down device, browser and os from the user agent', async () => {
    const { s } = await seeded();
    expect(row(s.breakdowns.device, 'desktop')?.humans).toBe(2);
    expect(row(s.breakdowns.device, 'mobile')?.humans).toBe(1);
    expect(row(s.breakdowns.browser, /chrome/i)?.humans).toBe(2);
    expect(row(s.breakdowns.browser, /safari/i)?.humans).toBe(1);
    expect(row(s.breakdowns.os, /mac/i)?.humans).toBe(2);
    expect(row(s.breakdowns.os, /ios/i)?.humans).toBe(1);
  });

  it('splits source into qr vs link', async () => {
    const { s } = await seeded();
    expect(row(s.breakdowns.source, 'qr')).toEqual({ key: 'qr', humans: 1, bots: 0 });
    expect(row(s.breakdowns.source, 'link')).toEqual({ key: 'link', humans: 2, bots: 1 });
    expect(s.totals.humans).toMatchObject({ clicks: 3, qr: 1 });
    expect(s.totals.bots.clicks).toBe(1);
  });

  it('splits clicks before and after a destination edit by revision', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/v1', slug: 'rev' });
    await click(h, 'rev');
    await click(h, 'rev', { ua: BOT_UA });
    await h.shorty.drain();
    await h.shorty.updateLink(link.id, { url: 'https://example.com/v2' });
    await click(h, 'rev');
    await click(h, 'rev');
    await h.shorty.drain();
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(row(s.breakdowns.revision, '1')).toEqual({ key: '1', humans: 1, bots: 1 });
    expect(row(s.breakdowns.revision, '2')).toEqual({ key: '2', humans: 2, bots: 0 });
    expect(s.breakdowns.revision).toHaveLength(2);
  });

  it('leaves the revision breakdown empty in the overview (it is per-link)', async () => {
    const { h } = await seeded();
    const s = await h.shorty.stats({ from: '2026-03-15', to: '2026-03-15' });
    expect(s.breakdowns.revision).toEqual([]);
  });
});

describe('stats — breakdown top-N (direct clicks)', () => {
  // 60 distinct referrers: r00 ×5, r01 ×4, r02 ×3, the rest ×1.
  async function sixty() {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    const at = h.clock.now;
    const docs = [];
    for (let i = 0; i < 60; i++) {
      const n = i === 0 ? 5 : i === 1 ? 4 : i === 2 ? 3 : 1;
      for (let k = 0; k < n; k++) {
        docs.push({
          linkId: new Types.ObjectId(link.id), rev: 1, at, visitor: `v${i}-${k}`, unique: true, bot: false,
          qr: false, device: 'desktop' as const, referrerHost: `r${String(i).padStart(2, '0')}.test`,
        });
      }
    }
    await h.shorty.models.Click.insertMany(docs);
    return { h, link };
  }

  it('returns 10 rows by default, most humans first', async () => {
    const { h, link } = await sixty();
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(s.breakdowns.referrer).toHaveLength(10);
    expect(s.breakdowns.referrer.slice(0, 3)).toEqual([
      { key: 'r00.test', humans: 5, bots: 0 },
      { key: 'r01.test', humans: 4, bots: 0 },
      { key: 'r02.test', humans: 3, bots: 0 },
    ]);
  });

  it('respects `top`', async () => {
    const { h, link } = await sixty();
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15', top: 3 });
    expect(s.breakdowns.referrer.map((r) => r.key)).toEqual(['r00.test', 'r01.test', 'r02.test']);
  });

  it('clamps `top` above 50 to 50 instead of returning every row (traps #18)', async () => {
    const { h, link } = await sixty();
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15', top: 1000 });
    expect(s.breakdowns.referrer).toHaveLength(50);
  });
});

describe('stats — range validation and retention', () => {
  it('rejects a range longer than 400 days with range_too_large', async () => {
    const h = await setup();
    const err = await h.shorty.stats({ from: '2025-01-01', to: '2026-03-15' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShortyError);
    expect((err as ShortyError).code).toBe('range_too_large');
  });

  it('rejects from > to with validation', async () => {
    const h = await setup();
    const err = await h.shorty.stats({ from: '2026-03-15', to: '2026-03-01' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShortyError);
    expect((err as ShortyError).code).toBe('validation');
  });

  it('accepts Date objects for from/to', async () => {
    const h = await setup();
    const s = await h.shorty.stats({ from: new Date('2026-03-10T00:00:00Z'), to: new Date('2026-03-12T00:00:00Z') });
    expect(s.series.map((p) => p.date)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
  });

  it('marks breakdowns truncated only when `from` is older than retention', async () => {
    const h = await setup({ config: { clicks: { retentionDays: 30 } } });
    // now = 2026-03-15; retention reaches back to 2026-02-13.
    const old = await h.shorty.stats({ from: '2026-02-01', to: '2026-03-15' });
    expect(old.breakdownsTruncated).toBe(true);
    const recent = await h.shorty.stats({ from: '2026-03-01', to: '2026-03-15' });
    expect(recent.breakdownsTruncated).toBe(false);
    expect(new Date(h.clock.now.getTime() - 30 * DAY).toISOString().slice(0, 10)).toBe('2026-02-13');
  });
});

describe('stats — overview lists (real clicks)', () => {
  it('orders topLinks by HUMAN clicks (bots do not promote a link) and keys topCampaigns by utm.campaign', async () => {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/a?utm_source=ig&utm_campaign=spring', slug: 'a' });
    await h.shorty.createLink({ url: 'https://example.com/b?utm_source=fb&utm_campaign=spring', slug: 'b' });
    await h.shorty.createLink({ url: 'https://example.com/c?utm_campaign=fall', slug: 'c' });
    await h.shorty.createLink({ url: 'https://example.com/d', slug: 'd' }); // no campaign
    for (let i = 0; i < 2; i++) await click(h, 'a');
    for (let i = 0; i < 10; i++) await click(h, 'a', { ua: BOT_UA });
    for (let i = 0; i < 5; i++) await click(h, 'b');
    for (let i = 0; i < 3; i++) await click(h, 'c');
    await click(h, 'd');
    await h.shorty.drain();

    const s: Stats = await h.shorty.stats({ from: '2026-03-15', to: '2026-03-15' });
    expect(s.topLinks?.map((l) => [l.slug, l.humans, l.bots])).toEqual([
      ['b', 5, 0],
      ['c', 3, 0],
      ['a', 2, 10],
      ['d', 1, 0],
    ]);
    for (const l of s.topLinks ?? []) expect(l.linkId).toMatch(/^[0-9a-f]{24}$/);
    expect(s.topCampaigns).toEqual([
      { campaign: 'spring', humans: 7, bots: 10 },
      { campaign: 'fall', humans: 3, bots: 0 },
    ]);
  });

  it('omits topLinks and topCampaigns from per-link stats', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(s.topLinks).toBeUndefined();
    expect(s.topCampaigns).toBeUndefined();
  });
});

describe('paramValues — the suggestion catalog (§7.4)', () => {
  it('lists utm fields as utm_* keys alongside custom params, counting LINKS not occurrences', async () => {
    const h = await setup();
    const t0 = h.clock.now.getTime();
    await h.shorty.createLink({ url: 'https://example.com/1?utm_source=ig&utm_medium=social&ref=x' });
    h.clock.advance(1000);
    await h.shorty.createLink({ url: 'https://example.com/2?utm_source=ig&ref=y' });
    h.clock.advance(1000);
    await h.shorty.createLink({ url: 'https://example.com/3?utm_source=fb&ref=x' });
    h.clock.advance(1000);
    // One link, key used twice: counts once for the key.
    await h.shorty.createLink({ url: 'https://example.com/4?ref=z&ref=z2' });

    const items = await h.shorty.paramValues();
    const byKey = new Map(items.map((i) => [i.key, i]));

    const src = byKey.get('utm_source')!;
    expect(src).toMatchObject({ key: 'utm_source', count: 3, truncated: false });
    expect(src.values.map((v) => [v.value, v.count])).toEqual([['ig', 2], ['fb', 1]]);

    expect(byKey.get('utm_medium')).toMatchObject({ count: 1, values: [{ value: 'social', count: 1 }] });

    const ref = byKey.get('ref')!;
    expect(ref.count).toBe(4);
    expect(ref.values[0]).toMatchObject({ value: 'x', count: 2 });
    expect(ref.values.map((v) => v.value).sort()).toEqual(['x', 'y', 'z', 'z2']);

    expect(byKey.has('source')).toBe(false);
    for (const item of items) {
      for (const v of item.values) {
        expect(v.lastUsedAt).toBeInstanceOf(Date);
        expect(v.lastUsedAt.getTime()).toBeGreaterThanOrEqual(t0);
        expect(v.lastUsedAt.getTime()).toBeLessThanOrEqual(h.clock.now.getTime());
      }
    }
  });

  it('counts archived links — history is the point', async () => {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/1?utm_source=ig' });
    const old = await h.shorty.createLink({ url: 'https://example.com/2?utm_source=newsletter' });
    await h.shorty.archiveLink(old.id);
    const src = (await h.shorty.paramValues()).find((i) => i.key === 'utm_source')!;
    expect(src.count).toBe(2);
    expect(src.values.map((v) => v.value).sort()).toEqual(['ig', 'newsletter']);
  });

  it('caps values at 50 per key, most-used first, and says it truncated (traps #18)', async () => {
    const h = await setup();
    for (let i = 0; i < 3; i++) await h.shorty.createLink({ url: 'https://example.com/p?v=popular' });
    for (let i = 0; i < 54; i++) await h.shorty.createLink({ url: `https://example.com/p?v=val${i}` });
    const v = (await h.shorty.paramValues()).find((i) => i.key === 'v')!;
    expect(v.count).toBe(57);
    expect(v.values).toHaveLength(50);
    expect(v.truncated).toBe(true);
    expect(v.values[0]).toMatchObject({ value: 'popular', count: 3 });
    for (let i = 1; i < v.values.length; i++) {
      expect(v.values[i - 1].count).toBeGreaterThanOrEqual(v.values[i].count);
    }
  });

  it('is empty when there are no links', async () => {
    const h = await setup();
    expect(await h.shorty.paramValues()).toEqual([]);
  });
});

describe('tags()', () => {
  it('counts links per tag, most-used first', async () => {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/1', tags: ['spring', 'ig'] });
    await h.shorty.createLink({ url: 'https://example.com/2', tags: ['spring'] });
    await h.shorty.createLink({ url: 'https://example.com/3', tags: ['spring', 'fb'] });
    const tags = await h.shorty.tags();
    expect(tags[0]).toEqual({ tag: 'spring', count: 3 });
    expect(tags.slice(1).sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { tag: 'fb', count: 1 },
      { tag: 'ig', count: 1 },
    ]);
  });
});

describe('stats — counting and range edges (audit follow-up)', () => {
  it('counts clicks, not uniques, in breakdowns (one visitor, three hits → 3)', async () => {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/a', slug: 'same' });
    for (let i = 0; i < 3; i++) await click(h, 'same', { ip: '198.51.100.7', referer: 'https://news.test/x' });
    await h.shorty.drain();
    const link = (await h.shorty.link('same'))!;
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(row(s.breakdowns.referrer, 'news.test')).toEqual({ key: 'news.test', humans: 3, bots: 0 });
    expect(s.totals.humans).toMatchObject({ clicks: 3, uniques: 1 });
  });

  it('excludes a click on the day after `to` from series and breakdowns', async () => {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/a', slug: 'edge' });
    await click(h, 'edge', { referer: 'https://in.test/' });
    h.clock.set('2026-03-16T00:30:00.000Z');
    await click(h, 'edge', { referer: 'https://out.test/' });
    await h.shorty.drain();
    const link = (await h.shorty.link('edge'))!;
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(s.totals.humans.clicks).toBe(1);
    expect(s.breakdowns.referrer).toEqual([{ key: 'in.test', humans: 1, bots: 0 }]);
  });

  it('does not count other links in a per-link breakdown', async () => {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/a', slug: 'mine' });
    await h.shorty.createLink({ url: 'https://example.com/b', slug: 'theirs' });
    await click(h, 'mine', { referer: 'https://shared.test/' });
    await click(h, 'theirs', { referer: 'https://shared.test/' });
    await click(h, 'theirs', { referer: 'https://shared.test/' });
    await h.shorty.drain();
    const link = (await h.shorty.link('mine'))!;
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(s.breakdowns.referrer).toEqual([{ key: 'shared.test', humans: 1, bots: 0 }]);
  });

  it('applies the clicks.timezone day boundary to breakdowns, not just the series', async () => {
    const h = await setup({ config: { clicks: { timezone: 'America/New_York' } } });
    await h.shorty.createLink({ url: 'https://example.com/a', slug: 'nyb' });
    h.clock.set('2026-03-15T03:00:00.000Z'); // the 14th in New York
    await click(h, 'nyb', { referer: 'https://late.test/' });
    h.clock.set('2026-03-15T05:00:00.000Z'); // the 15th in New York
    await click(h, 'nyb', { referer: 'https://early.test/' });
    await h.shorty.drain();
    const link = (await h.shorty.link('nyb'))!;
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(s.breakdowns.referrer).toEqual([{ key: 'early.test', humans: 1, bots: 0 }]);
  });

  it('shows a bots-only referrer row, sorted below rows that have humans', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    const base = { linkId: new Types.ObjectId(link.id), rev: 1, at: h.clock.now, unique: true, qr: false, device: 'desktop' as const };
    await h.shorty.models.Click.insertMany([
      { ...base, visitor: 'h1', bot: false, referrerHost: 'people.test' },
      ...[1, 2, 3].map((i) => ({ ...base, visitor: `b${i}`, bot: true, referrerHost: 'crawler.test' })),
    ]);
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-15', to: '2026-03-15' });
    expect(s.breakdowns.referrer).toEqual([
      { key: 'people.test', humans: 1, bots: 0 },
      { key: 'crawler.test', humans: 0, bots: 3 },
    ]);
  });

  it('accepts exactly 400 days (inclusive) and rejects 401 with range_too_large', async () => {
    const h = await setup();
    const ok = await h.shorty.stats({ from: '2025-02-09', to: '2026-03-15' });
    expect(ok.series).toHaveLength(400);
    const err = await h.shorty.stats({ from: '2025-02-08', to: '2026-03-15' }).catch((e: unknown) => e);
    expect((err as ShortyError).code).toBe('range_too_large');
  });

  it('does not mark breakdowns truncated when `from` is exactly now − retentionDays', async () => {
    const h = await setup({ config: { clicks: { retentionDays: 30 } } });
    h.clock.set('2026-03-15T00:00:00.000Z'); // now − 30 d = 2026-02-13T00:00Z
    expect((await h.shorty.stats({ from: '2026-02-13', to: '2026-02-13' })).breakdownsTruncated).toBe(false);
    expect((await h.shorty.stats({ from: '2026-02-12', to: '2026-02-12' })).breakdownsTruncated).toBe(true);
  });

  it('uses 395 retention days for breakdownsTruncated when clicks.retentionDays is unset', async () => {
    const h = await setup();
    h.clock.set('2026-03-15T00:00:00.000Z'); // now − 395 d = 2025-02-13T00:00Z
    expect((await h.shorty.stats({ from: '2025-02-13', to: '2025-02-13' })).breakdownsTruncated).toBe(false);
    expect((await h.shorty.stats({ from: '2025-02-12', to: '2025-02-12' })).breakdownsTruncated).toBe(true);
  });

  it('labels a week bucket by its Monday even when `from` is a Wednesday, counting only days in range', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    await daily(h, link.id, '2026-03-03', { clicks: 100 }); // Tue, before `from`
    await daily(h, link.id, '2026-03-04', { clicks: 1 }); // Wed = from
    await daily(h, link.id, '2026-03-10', { clicks: 2 });
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-03-04', to: '2026-03-15', interval: 'week' });
    expect(s.series.map((p) => [p.date, p.humans.clicks])).toEqual([['2026-03-02', 1], ['2026-03-09', 2]]);
  });

  it('labels a month bucket by the 1st even when `from` is mid-month, counting only days in range', async () => {
    const h = await setup();
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    await daily(h, link.id, '2026-01-10', { clicks: 100 }); // before `from`
    await daily(h, link.id, '2026-01-20', { clicks: 1 });
    await daily(h, link.id, '2026-02-05', { clicks: 2 });
    await daily(h, link.id, '2026-02-20', { clicks: 100 }); // after `to`
    const s = await h.shorty.stats({ linkId: link.id, from: '2026-01-15', to: '2026-02-10', interval: 'month' });
    expect(s.series.map((p) => [p.date, p.humans.clicks])).toEqual([['2026-01-01', 1], ['2026-02-01', 2]]);
  });

  it('reads Date objects as days in clicks.timezone, not UTC', async () => {
    const h = await setup({ config: { clicks: { timezone: 'America/New_York' } } });
    // 02:00Z on the 10th/11th is 22:00 EDT on the 9th/10th.
    const s = await h.shorty.stats({ from: new Date('2026-03-10T02:00:00Z'), to: new Date('2026-03-11T02:00:00Z') });
    expect(s.range).toMatchObject({ from: '2026-03-09', to: '2026-03-10', timezone: 'America/New_York' });
    expect(s.series.map((p) => p.date)).toEqual(['2026-03-09', '2026-03-10']);
  });
});

describe('paramValues — freshness and edges (audit follow-up)', () => {
  it('sets lastUsedAt to the latest updatedAt among links using the value', async () => {
    const h = await setup();
    const a = await h.shorty.createLink({ url: 'https://example.com/1?utm_source=ig' });
    h.clock.advance(60_000);
    const b = await h.shorty.createLink({ url: 'https://example.com/2?utm_source=ig' });
    h.clock.advance(60_000);
    const aEdited = await h.shorty.updateLink(a.id, { title: 'touched' });
    const expected = Math.max(aEdited.updatedAt.getTime(), b.updatedAt.getTime());
    const ig = (await h.shorty.paramValues()).find((i) => i.key === 'utm_source')!.values.find((v) => v.value === 'ig')!;
    expect(ig.lastUsedAt.getTime()).toBe(expected);
  });

  it('drops a value as soon as an update removes it, and a key as soon as its only link is deleted', async () => {
    const h = await setup();
    const a = await h.shorty.createLink({ url: 'https://example.com/1?utm_source=ig' });
    const b = await h.shorty.createLink({ url: 'https://example.com/2?only=here' });
    await h.shorty.updateLink(a.id, { utm: { source: 'fb' } });
    await h.shorty.deleteLink(b.id);
    const items = await h.shorty.paramValues();
    expect(items.find((i) => i.key === 'utm_source')!.values.map((v) => v.value)).toEqual(['fb']);
    expect(items.find((i) => i.key === 'only')).toBeUndefined();
  });

  it('keeps Facebook and facebook as separate values (the lint flags them; the catalog does not merge)', async () => {
    const h = await setup();
    await h.shorty.createLink({ url: 'https://example.com/1?utm_source=Facebook' });
    await h.shorty.createLink({ url: 'https://example.com/2?utm_source=facebook' });
    const src = (await h.shorty.paramValues()).find((i) => i.key === 'utm_source')!;
    expect(src.count).toBe(2);
    expect(src.values.map((v) => [v.value, v.count]).sort()).toEqual([['Facebook', 1], ['facebook', 1]]);
  });

  it('reports truncated false at exactly 50 distinct values and true at 51', async () => {
    const h = await setup();
    for (let i = 0; i < 50; i++) await h.shorty.createLink({ url: `https://example.com/p?k=v${i}` });
    const at50 = (await h.shorty.paramValues()).find((i) => i.key === 'k')!;
    expect(at50.values).toHaveLength(50);
    expect(at50.truncated).toBe(false);
    await h.shorty.createLink({ url: 'https://example.com/p?k=v50' });
    const at51 = (await h.shorty.paramValues()).find((i) => i.key === 'k')!;
    expect(at51.values).toHaveLength(50);
    expect(at51.truncated).toBe(true);
    expect(at51.count).toBe(51);
  });
});

describe('PR 4 review follow-ups', () => {
  it('does not pull the previous evening into a day whose midnight does not exist (DST at 00:00)', async () => {
    // America/Santiago jumped 00:00 → 01:00 on 2022-09-11 (04:00Z). The day
    // starts at 04:00Z; 03:30Z is still 23:30 on Sep 10 locally.
    const h = await harness({ config: { clicks: { timezone: 'America/Santiago' } } });
    h.clock.set('2022-09-20T12:00:00.000Z');
    const link = await h.shorty.createLink({ url: 'https://example.com/a' });
    const base = { linkId: new Types.ObjectId(link.id), rev: 1, unique: true, bot: false, qr: false, device: 'desktop' as const };
    await h.shorty.models.Click.insertMany([
      { ...base, at: new Date('2022-09-11T03:30:00Z'), visitor: 'before', referrerHost: 'evening.test' },
      { ...base, at: new Date('2022-09-11T04:30:00Z'), visitor: 'after', referrerHost: 'morning.test' },
    ]);
    const s = await h.shorty.stats({ linkId: link.id, from: '2022-09-11', to: '2022-09-11' });
    expect(s.breakdowns.referrer.map((r) => r.key)).toEqual(['morning.test']);
    // …and as the END of a range, Sep 10 keeps its last hour.
    const prev = await h.shorty.stats({ linkId: link.id, from: '2022-09-10', to: '2022-09-10' });
    expect(prev.breakdowns.referrer.map((r) => r.key)).toEqual(['evening.test']);
  });

  it('does not drop a popular key from the catalog when there are more than 1000 keys', async () => {
    const h = await harness();
    const now = h.clock.now;
    const doc = (i: number, params: Array<{ key: string; value: string }>) => ({
      slug: `s${i}`, slugKey: `s${i}`, keys: [`s${i}`], aliases: [], origin: 'custom',
      baseUrl: 'https://example.com/', utm: {}, params, destination: `https://example.com/?x=${i}`,
      tags: [], redirect: {}, rev: 1, clicks: 0, uniqueClicks: 0, botClicks: 0, archived: false,
      createdAt: now, updatedAt: now,
    });
    const docs = [];
    for (let i = 0; i < 1100; i++) docs.push(doc(i, [{ key: `rare_${i}`, value: 'x' }]));
    for (let i = 0; i < 5; i++) docs.push(doc(2000 + i, [{ key: 'popular', value: `v${i % 2}` }]));
    await h.shorty.models.Link.insertMany(docs);
    const catalog = await h.shorty.paramValues();
    const popular = catalog.find((k) => k.key === 'popular');
    expect(popular).toBeDefined();
    expect(popular!.count).toBe(5);
    expect(popular!.values.map((v) => [v.value, v.count])).toEqual([['v0', 3], ['v1', 2]]);
  });

  it('does not keep more than 50 values per key in memory-shaped output (values capped, truncated set)', async () => {
    const h = await harness();
    const now = h.clock.now;
    const docs = [];
    for (let i = 0; i < 300; i++) {
      docs.push({
        slug: `c${i}`, slugKey: `c${i}`, keys: [`c${i}`], aliases: [], origin: 'custom',
        baseUrl: 'https://example.com/', utm: { content: `variant_${i}` }, params: [],
        destination: `https://example.com/?utm_content=variant_${i}`, tags: [], redirect: {}, rev: 1,
        clicks: 0, uniqueClicks: 0, botClicks: 0, archived: false, createdAt: now, updatedAt: now,
      });
    }
    await h.shorty.models.Link.insertMany(docs);
    const row = (await h.shorty.paramValues()).find((k) => k.key === 'utm_content');
    expect(row?.values).toHaveLength(50);
    expect(row?.truncated).toBe(true);
    expect(row?.count).toBe(300);
  });
});
