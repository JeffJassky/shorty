import mongoose from 'mongoose';
import type { Breakdown, Stats, StatsPoint, StatsQuery } from '../../types/index.js';
import { ShortyError } from '../shared/errors.js';
import type { ResolvedContext } from './config.js';

/**
 * `stats()` (§8). The series reads `shorty_daily` (kept forever); breakdowns
 * read raw clicks (TTL'd), so `breakdownsTruncated` says when the range
 * outruns retention. Humans and bots are never summed here.
 *
 * Time model: `from`/`to` are calendar days in `clicks.timezone`, both
 * inclusive. Daily rows already carry that day as a string. Raw clicks are
 * matched by instant: [midnight of `from`, midnight after `to`) in the zone.
 */

const { Types } = mongoose;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_DAYS = 400;
const DEFAULT_TOP = 10;
const MAX_TOP = 50;
const MAX_TIME_MS = 2000;
const DAY_MS = 86_400_000;

type Interval = 'day' | 'week' | 'month';
const INTERVALS: readonly Interval[] = ['day', 'week', 'month'];

const bad = (field: string, why: string): ShortyError => new ShortyError('validation', undefined, { field, why });

// ── calendar-day arithmetic (pure; a day string is a UTC-midnight stand-in) ──

const dayToMs = (day: string): number => {
  const m = DAY_RE.exec(day)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => msToDay(dayToMs(day) + n * DAY_MS);

function isRealDay(day: string): boolean {
  return DAY_RE.test(day) && msToDay(dayToMs(day)) === day;
}

/** Monday of `day`'s week. */
function weekStart(day: string): string {
  const dow = new Date(dayToMs(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

const monthStart = (day: string): string => `${day.slice(0, 8)}01`;

function nextMonth(first: string): string {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-01`;
}

function bucketOf(day: string, interval: Interval): string {
  return interval === 'day' ? day : interval === 'week' ? weekStart(day) : monthStart(day);
}

function nextBucket(bucket: string, interval: Interval): string {
  return interval === 'day' ? addDays(bucket, 1) : interval === 'week' ? addDays(bucket, 7) : nextMonth(bucket);
}

const emptyPoint = (date: string): StatsPoint => ({
  date,
  humans: { clicks: 0, uniques: 0, qr: 0 },
  bots: { clicks: 0, uniques: 0 },
});

// ── breakdown pipelines ──────────────────────────────────────────────────────

const nonEmpty = (field: string, fallback: string) => ({
  $cond: [{ $gt: [{ $strLenCP: { $ifNull: [field, ''] } }, 0] }, field, fallback],
});

const KEY_EXPR: Record<string, unknown> = {
  referrer: nonEmpty('$referrerHost', '(direct)'),
  country: nonEmpty('$country', '(unknown)'),
  device: nonEmpty('$device', '(unknown)'),
  browser: nonEmpty('$browser', '(unknown)'),
  os: nonEmpty('$os', '(unknown)'),
  source: { $cond: ['$qr', 'qr', 'link'] },
  revision: { $toString: '$rev' },
};

function facet(key: unknown, top: number): unknown[] {
  return [
    {
      $group: {
        _id: key,
        humans: { $sum: { $cond: ['$bot', 0, 1] } },
        bots: { $sum: { $cond: ['$bot', 1, 0] } },
      },
    },
    { $sort: { humans: -1, bots: -1, _id: 1 } },
    { $limit: top },
  ];
}

export function createStats(ctx: ResolvedContext): (query: StatsQuery) => Promise<Stats> {
  const { Link, Click, Daily } = ctx.models;
  const timezone = ctx.clicks.timezone;

  const dayFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const partsFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });

  function dayOf(at: Date): string {
    const parts = dayFormat.formatToParts(at);
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  }

  /** Offset (ms) of the zone from UTC at instant `t`: local wall clock minus UTC. */
  function offsetAt(t: number): number {
    const p = partsFormat.formatToParts(new Date(t));
    const n = (type: string): number => Number(p.find((x) => x.type === type)?.value);
    const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
    return asUtc - Math.floor(t / 1000) * 1000;
  }

  /** The instant at which calendar day `day` begins in `clicks.timezone`. */
  function startOfDay(day: string): Date {
    const wall = dayToMs(day);
    let t = wall - offsetAt(wall);
    t = wall - offsetAt(t); // second pass settles a DST boundary
    return new Date(t);
  }

  function toDay(value: unknown, field: string): string {
    if (value === undefined || value === null || value === '') throw bad(field, 'required');
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw bad(field, 'invalid date');
      return dayOf(value);
    }
    if (typeof value !== 'string') throw bad(field, 'must be a date');
    const s = value.trim();
    if (DAY_RE.test(s)) {
      if (!isRealDay(s)) throw bad(field, 'not a calendar day');
      return s;
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw bad(field, 'invalid date');
    return dayOf(d);
  }

  function clampTop(top: unknown): number {
    if (top === undefined || top === null) return DEFAULT_TOP;
    if (typeof top !== 'number' || !Number.isFinite(top)) throw bad('top', 'must be a number');
    return Math.max(1, Math.min(Math.floor(top), MAX_TOP));
  }

  return async function stats(query: StatsQuery): Promise<Stats> {
    if (!query || typeof query !== 'object') throw bad('query', 'required');
    const from = toDay(query.from, 'from');
    const to = toDay(query.to, 'to');
    const interval: Interval = query.interval ?? 'day';
    if (!INTERVALS.includes(interval)) throw bad('interval', 'must be day, week or month');
    const top = clampTop(query.top);

    if (from > to) throw bad('from', 'must not be after `to`');
    const days = (dayToMs(to) - dayToMs(from)) / DAY_MS + 1;
    if (days > MAX_DAYS) throw new ShortyError('range_too_large', undefined, { maxDays: MAX_DAYS, days });

    let linkId: InstanceType<typeof Types.ObjectId> | undefined;
    if (query.linkId !== undefined && query.linkId !== null) {
      if (typeof query.linkId !== 'string' || !OBJECT_ID.test(query.linkId)) {
        throw new ShortyError('not_found', undefined, { id: String(query.linkId) });
      }
      linkId = new Types.ObjectId(query.linkId);
      if (!(await Link.exists({ _id: linkId }))) throw new ShortyError('not_found', undefined, { id: query.linkId });
    }

    const fromAt = startOfDay(from);
    const toAt = startOfDay(addDays(to, 1)); // exclusive
    const dailyMatch: Record<string, unknown> = { day: { $gte: from, $lte: to } };
    const clickMatch: Record<string, unknown> = { at: { $gte: fromAt, $lt: toAt } };
    if (linkId) {
      dailyMatch.linkId = linkId;
      clickMatch.linkId = linkId;
    }

    // ── series ──
    const dailyRows = await Daily.aggregate<{
      _id: string; clicks: number; uniques: number; qr: number; bots: number; botUniques: number;
    }>([
      { $match: dailyMatch },
      {
        $group: {
          _id: '$day',
          clicks: { $sum: '$clicks' },
          uniques: { $sum: '$uniques' },
          qr: { $sum: '$qr' },
          bots: { $sum: '$bots' },
          botUniques: { $sum: '$botUniques' },
        },
      },
    ]).option({ maxTimeMS: MAX_TIME_MS });

    const points = new Map<string, StatsPoint>();
    for (let b = bucketOf(from, interval), last = bucketOf(to, interval); b <= last; b = nextBucket(b, interval)) {
      points.set(b, emptyPoint(b));
    }
    for (const r of dailyRows) {
      const p = points.get(bucketOf(r._id, interval));
      if (!p) continue;
      p.humans.clicks += r.clicks ?? 0;
      p.humans.uniques += r.uniques ?? 0;
      p.humans.qr += r.qr ?? 0;
      p.bots.clicks += r.bots ?? 0;
      p.bots.uniques += r.botUniques ?? 0;
    }
    const series = [...points.values()];
    const totals = emptyPoint('');
    for (const p of series) {
      totals.humans.clicks += p.humans.clicks;
      totals.humans.uniques += p.humans.uniques;
      totals.humans.qr += p.humans.qr;
      totals.bots.clicks += p.bots.clicks;
      totals.bots.uniques += p.bots.uniques;
    }

    // ── breakdowns (raw clicks, one scan) ──
    const dims = linkId
      ? ['referrer', 'country', 'device', 'browser', 'os', 'source', 'revision']
      : ['referrer', 'country', 'device', 'browser', 'os', 'source'];
    const facets: Record<string, unknown[]> = {};
    for (const d of dims) facets[d] = facet(KEY_EXPR[d], top);

    const overview = linkId ? null : await overviewLists(dailyMatch, top);
    const [bd] = await Click.aggregate<Record<string, Array<{ _id: string; humans: number; bots: number }>>>([
      { $match: clickMatch },
      { $facet: facets as Record<string, never[]> },
    ]).option({ maxTimeMS: MAX_TIME_MS });

    const rows = (dim: string): Breakdown[] =>
      (bd?.[dim] ?? []).map((r) => ({ key: String(r._id), humans: r.humans, bots: r.bots }));

    const retentionCutoff = ctx.now().getTime() - ctx.clicks.retentionDays * DAY_MS;

    const result: Stats = {
      range: { from, to, interval, timezone },
      totals: { humans: totals.humans, bots: totals.bots },
      series,
      breakdowns: {
        referrer: rows('referrer'),
        country: rows('country'),
        device: rows('device'),
        browser: rows('browser'),
        os: rows('os'),
        source: rows('source'),
        revision: linkId ? rows('revision') : [],
      },
      breakdownsTruncated: fromAt.getTime() < retentionCutoff,
    };
    if (overview) {
      result.topLinks = overview.topLinks;
      result.topCampaigns = overview.topCampaigns;
    }
    return result;
  };

  /** Overview lists come from the rollups (kept forever), so they cover the whole range. */
  async function overviewLists(dailyMatch: Record<string, unknown>, top: number): Promise<{
    topLinks: NonNullable<Stats['topLinks']>;
    topCampaigns: NonNullable<Stats['topCampaigns']>;
  }> {
    const sort = { humans: -1, bots: -1, _id: 1 } as const;
    const [out] = await Daily.aggregate<{
      links: Array<{ _id: unknown; slug?: string; humans: number; bots: number }>;
      campaigns: Array<{ _id: string; humans: number; bots: number }>;
    }>([
      { $match: dailyMatch },
      { $group: { _id: '$linkId', humans: { $sum: '$clicks' }, bots: { $sum: '$bots' } } },
      { $lookup: { from: Link.collection.name, localField: '_id', foreignField: '_id', as: 'link' } },
      { $unwind: '$link' },
      {
        $project: {
          humans: 1, bots: 1, slug: '$link.slug',
          campaign: { $ifNull: ['$link.utm.campaign', ''] },
        },
      },
      {
        $facet: {
          links: [{ $sort: sort }, { $limit: top }, { $project: { humans: 1, bots: 1, slug: 1 } }],
          campaigns: [
            { $match: { campaign: { $ne: '' } } },
            { $group: { _id: '$campaign', humans: { $sum: '$humans' }, bots: { $sum: '$bots' } } },
            { $sort: sort },
            { $limit: top },
          ],
        },
      },
    ]).option({ maxTimeMS: MAX_TIME_MS });

    return {
      topLinks: (out?.links ?? []).map((l) => ({
        linkId: String(l._id), slug: l.slug ?? '', humans: l.humans, bots: l.bots,
      })),
      topCampaigns: (out?.campaigns ?? []).map((c) => ({ campaign: c._id, humans: c.humans, bots: c.bots })),
    };
  }
}
