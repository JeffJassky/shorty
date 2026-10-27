import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import type { Types } from 'mongoose';
import type { Click, ClickDoc, GeoResult, LinkDoc } from '../../types/index.js';
import type { ResolvedContext } from './config.js';
import type { Counters } from './counters.js';
import type { HookRunner } from './hooks.js';
import { toLink } from './project.js';
import { isDuplicateKey } from './slug.js';
import { parseUa } from './ua.js';

/**
 * The click pipeline (§7.5 step 6) and miss recording. Everything here runs
 * AFTER the response has been sent; nothing in it can reach the response.
 *
 * No IP is persisted: it only ever enters the HMAC below. The `visitor` stored
 * on a click is the plain hash; the `seen` collection stores the same hash
 * behind a `h:` / `b:` prefix so humans and bots dedupe in separate
 * namespaces (a HEAD prefetch must not consume the human's unique slot).
 */

export interface ClickInput {
  doc: LinkDoc;
  req: Request;
  /** When the hit arrived (`ctx.now()` at request time). */
  at: Date;
  bot: boolean;
  ua: string;
  qr: boolean;
  /** Keys of the incoming query — values never reach this function. */
  queryKeys: string[];
}

export interface ClickService {
  /** Record one click. Resolves when every step (hooks included) has finished; never rejects. */
  record(input: ClickInput): Promise<void>;
  /** Record one orphan visit and fire `onMiss`. Never rejects. */
  recordMiss(path: string, req: Request, at: Date): Promise<void>;
}

const WWW = /^www\./i;

export function createClickService(ctx: ResolvedContext, hooks: HookRunner, counters: Counters): ClickService {
  const { Click: ClickModel, Daily, Seen, Link, Miss } = ctx.models;
  const windowMs = ctx.clicks.uniqueWindowMinutes * 60_000;
  const dayFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: ctx.clicks.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const failure = (what: string, err: unknown): void => {
    counters.clickFailures += 1;
    ctx.logger.error?.({ err }, `shorty: ${what} failed`);
  };

  /** `YYYY-MM-DD` of `at` in `clicks.timezone`. */
  function dayOf(at: Date): string {
    const parts = dayFormat.formatToParts(at);
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  }

  function visitorHash(day: string, ip: string, ua: string, linkId: string): string {
    return createHmac('sha256', ctx.clicks.pepper).update(`${day}|${ip}|${ua}|${linkId}`).digest('hex');
  }

  function referrerOf(req: Request): { referrerHost?: string; referrer?: string } {
    const raw = req.headers.referer;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return {};
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return {};
      const host = url.hostname.replace(WWW, '');
      if (!host) return {};
      return { referrerHost: host, referrer: `${url.origin}${url.pathname}` };
    } catch {
      return {};
    }
  }

  function geoOf(req: Request): GeoResult {
    try {
      const geo = ctx.clicks.geo(req);
      const out: GeoResult = {};
      if (geo?.country) out.country = geo.country;
      if (geo?.region) out.region = geo.region;
      if (geo?.city) out.city = geo.city;
      return out;
    } catch (err) {
      failure('geo lookup', err);
      return {};
    }
  }

  /**
   * Is this the visitor's first hit in the window? FIXED window: it opens at
   * the unique hit and repeats don't extend it. Decided by `at`, never by
   * waiting for the TTL monitor. Insert wins → unique. Duplicate key → the
   * existing row is replaced only if it is older than the window (one atomic
   * conditional update, so racing hits can't both win).
   */
  async function claimUnique(linkId: Types.ObjectId, seenKey: string, at: Date): Promise<boolean> {
    const create = async (): Promise<boolean> => {
      try {
        await Seen.create({ linkId, visitor: seenKey, at });
        return true;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        return false;
      }
    };
    if (await create()) return true;
    const cutoff = new Date(at.getTime() - windowMs);
    const replaced = await Seen.findOneAndUpdate(
      { linkId, visitor: seenKey, at: { $lte: cutoff } },
      { $set: { at } },
    ).lean();
    if (replaced !== null) return true;
    // Null means either "still inside the window" or "the TTL monitor deleted
    // the row between our create and our update". Try the create once more:
    // a second duplicate key is a genuine repeat.
    return create();
  }

  async function bumpDaily(linkId: Types.ObjectId, day: string, inc: Record<string, number>): Promise<void> {
    // Concurrent first-of-the-day upserts can race on the unique {linkId, day}
    // index; the loser retries as a plain update.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await Daily.updateOne({ linkId, day }, { $inc: inc }, { upsert: true });
        return;
      } catch (err) {
        if (!isDuplicateKey(err) || attempt >= 3) throw err;
      }
    }
  }

  function toClick(doc: ClickDoc & { _id: Types.ObjectId }): Click {
    const click: Click = {
      id: String(doc._id),
      linkId: String(doc.linkId),
      rev: doc.rev,
      at: doc.at,
      visitor: doc.visitor,
      unique: doc.unique,
      bot: doc.bot,
      qr: doc.qr,
      device: doc.device,
    };
    if (doc.referrerHost) click.referrerHost = doc.referrerHost;
    if (doc.referrer) click.referrer = doc.referrer;
    if (doc.country) click.country = doc.country;
    if (doc.region) click.region = doc.region;
    if (doc.city) click.city = doc.city;
    if (doc.browser) click.browser = doc.browser;
    if (doc.os) click.os = doc.os;
    if (doc.queryKeys?.length) click.queryKeys = [...doc.queryKeys];
    return click;
  }

  async function record(input: ClickInput): Promise<void> {
    const { doc, req, at, bot, ua, qr, queryKeys } = input;
    let stored: ClickDoc;
    let updated: LinkDoc | null = null;
    try {
      const linkId = doc._id;
      const day = dayOf(at);
      const visitor = visitorHash(day, ctx.clicks.ip(req) ?? '', ua, String(linkId));
      const unique = await claimUnique(linkId, `${bot ? 'b' : 'h'}:${visitor}`, at);

      // Link first: a link deleted since the lookup gets no orphan rows and no hooks.
      updated = (await Link.findOneAndUpdate(
        { _id: linkId },
        bot
          ? { $inc: { botClicks: 1 } }
          : { $inc: { clicks: 1, uniqueClicks: unique ? 1 : 0 }, $max: { lastClickedAt: at } },
        { returnDocument: 'after' },
      ).lean()) as LinkDoc | null;
      if (!updated) return;

      // Daily before Click: a failure between the writes leaves
      // raw ≤ daily ≤ link counter, so `recount` (from Daily) never drops below
      // the raw rows still held.
      await bumpDaily(
        linkId,
        day,
        bot
          ? { bots: 1, botUniques: unique ? 1 : 0 }
          : { clicks: 1, uniques: unique ? 1 : 0, qr: qr ? 1 : 0 },
      );

      const ref = referrerOf(req);
      const agent = parseUa(ua);
      const created = await ClickModel.create({
        linkId,
        rev: doc.rev,
        at,
        visitor,
        unique,
        bot,
        qr,
        ...ref,
        ...geoOf(req),
        ...agent,
        ...(queryKeys.length ? { queryKeys } : {}),
      });
      stored = created.toObject() as ClickDoc;

      // A delete that landed mid-pipeline has already swept; the rows written
      // since are orphans. The link is gone, so every row for it is garbage.
      if (!(await Link.exists({ _id: linkId }))) {
        await Promise.all([
          ClickModel.deleteOne({ _id: created._id }),
          ClickModel.deleteMany({ linkId }),
          Daily.deleteMany({ linkId }),
          Seen.deleteMany({ linkId }),
        ]);
        return;
      }
    } catch (err) {
      failure('click pipeline', err);
      return;
    }

    // The click exists: tell the host. Hook and track failures are counted by
    // the runner and never touch `clickFailures`.
    const link = toLink(ctx, updated);
    const click = toClick(stored as ClickDoc & { _id: Types.ObjectId });
    await hooks.hook('onClick', { link, click, req });
    await hooks.track('shorty.clicked', link.id, {
      linkId: link.id,
      slug: link.slug,
      bot: click.bot,
      unique: click.unique,
      qr: click.qr,
      device: click.device,
      rev: click.rev,
      ...(click.country ? { country: click.country } : {}),
    });
  }

  async function recordMiss(path: string, req: Request, at: Date): Promise<void> {
    counters.misses += 1;
    try {
      const { referrerHost } = referrerOf(req);
      await Miss.create({ path, at, ...(referrerHost ? { referrerHost } : {}) });
    } catch (err) {
      failure('miss recording', err);
    }
    await hooks.hook('onMiss', { path, req });
  }

  return { record, recordMiss };
}
