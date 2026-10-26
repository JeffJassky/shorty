import mongoose from 'mongoose';
import type { Request } from 'express';
import type {
  Actor,
  CallContext,
  DeleteSummary,
  HistoryEntry,
  Link,
  LinkDoc,
  LinkInput,
  LinkPatch,
  LinksPage,
  LinksQuery,
  OgData,
  SlugCheck,
  TagStat,
  UrlParts,
} from '../../types/index.js';
import { ShortyError } from '../shared/errors.js';
import { composeUrl, parseUrl } from '../shared/url.js';
import type { ResolvedContext } from './config.js';
import type { HookRunner } from './hooks.js';
import { toActor, toHistoryEntry, toLink } from './project.js';
import type { ParsedSlug, SlugService } from './slug.js';
import {
  checkDestination, cleanHash, cleanOg, cleanParams, cleanSocial, cleanTags, cleanUtm,
  mergeRedirect, mergeUtm, optionalDate, optionalHttpUrl, optionalMaxClicks, optionalText,
} from './validate.js';

/**
 * The link service (§7.1, §7.3): create, update, archive, delete and every read.
 *
 * Two rules shape this file.
 *  1. VALIDATE EVERYTHING FIRST. Slugs are claimed only after the whole input
 *     has been checked, so a request that will fail never has a claim to undo.
 *  2. `models.Slug` decides who owns a slug. A claim made for a write that then
 *     fails is released; a Link row is never left behind without its claim.
 */

const { Types } = mongoose;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** An update retries when a concurrent writer changed the slug or destination under it. */
const UPDATE_ATTEMPTS = 20;

type LinkSort = NonNullable<LinksQuery['sort']>;
type SlugHistory = Extract<HistoryEntry, { kind: 'slug' }>;

const SORT_FIELD: Record<LinkSort, 'createdAt' | 'clicks' | 'lastClickedAt'> = {
  newest: 'createdAt',
  clicks: 'clicks',
  lastClicked: 'lastClickedAt',
};

export interface LinkService {
  createLink(input: LinkInput, call?: CallContext): Promise<Link>;
  updateLink(id: string, patch: LinkPatch, call?: CallContext): Promise<Link>;
  archiveLink(id: string, call?: CallContext): Promise<Link>;
  unarchiveLink(id: string, call?: CallContext): Promise<Link>;
  deleteLink(id: string, call?: CallContext): Promise<DeleteSummary>;
  link(idOrSlug: string): Promise<Link | null>;
  links(query?: LinksQuery): Promise<LinksPage>;
  history(id: string): Promise<HistoryEntry[]>;
  tags(): Promise<TagStat[]>;
  checkSlug(slug: string, opts?: { linkId?: string }): Promise<SlugCheck>;
  generateSlug(): Promise<string>;
  recount(id: string): Promise<Link>;
}

interface Cursor {
  s: LinkSort;
  /** Sort value of the last row: ISO date, number, or null (never clicked). */
  v: string | number | null;
  i: string;
}

type StoredHistory = Parameters<typeof toHistoryEntry>[0] & { linkId?: unknown };

const notFound = (id: string): ShortyError => new ShortyError('not_found', undefined, { id });
const asDoc = (doc: unknown): LinkDoc | null => (doc ?? null) as LinkDoc | null;

export function createLinkService(ctx: ResolvedContext, slugs: SlugService, hooks: HookRunner): LinkService {
  const { Link: LinkModel, Slug, History, Click, Daily, Seen } = ctx.models;

  // ── small helpers ──────────────────────────────────────────────────────────

  function actorOf(call?: CallContext): Actor | undefined {
    if (call?.actor) return toActor(call.actor);
    const resolved = call?.req ? ctx.resolveUser(call.req) : null;
    return resolved ? toActor(resolved) : undefined;
  }

  /** Hook payload extras: only the keys that are set. */
  const extras = (actor?: Actor, req?: Request): { actor?: Actor; req?: Request } => ({
    ...(actor ? { actor } : {}),
    ...(req ? { req } : {}),
  });

  async function findDoc(id: unknown): Promise<LinkDoc | null> {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) return null;
    return asDoc(await LinkModel.findById(id).lean());
  }

  async function requireDoc(id: string): Promise<LinkDoc> {
    const doc = await findDoc(id);
    if (!doc) throw notFound(String(id));
    return doc;
  }

  /** Throws `invalid_base_url` for a bad one; returns the parser-normalized form. */
  function normalizeBase(baseUrl: unknown): string {
    composeUrl({ baseUrl: baseUrl as string, utm: {}, params: [] });
    return parseUrl(baseUrl as string).baseUrl;
  }

  // ── create ─────────────────────────────────────────────────────────────────

  function partsFromInput(input: LinkInput): UrlParts {
    const hasParts = input.baseUrl !== undefined || input.utm !== undefined || input.params !== undefined || input.hash !== undefined;
    if (input.url !== undefined) {
      if (hasParts) throw new ShortyError('ambiguous_destination');
      return parseUrl(input.url);
    }
    if (input.baseUrl === undefined) throw new ShortyError('invalid_url');
    return {
      baseUrl: normalizeBase(input.baseUrl),
      utm: cleanUtm(input.utm),
      params: cleanParams(input.params),
      hash: cleanHash(input.hash),
    };
  }

  async function createLink(input: LinkInput, call?: CallContext): Promise<Link> {
    if (!input || typeof input !== 'object') throw new ShortyError('validation', undefined, { field: 'body' });

    // 1. Validate everything. Nothing below this block can be the caller's fault.
    const parts = partsFromInput(input);
    const destination = composeUrl(parts);
    checkDestination(ctx, destination);
    const custom = input.slug === undefined || input.slug === null ? null : slugs.parse(input.slug);

    const now = ctx.now();
    const actor = actorOf(call);
    const _id = new Types.ObjectId();
    const og = cleanOg(input.og);
    const title = optionalText(input.title, 'title');
    const notes = optionalText(input.notes, 'notes');
    const expiresAt = optionalDate(input.expiresAt, 'expiresAt');
    const maxClicks = optionalMaxClicks(input.maxClicks);
    const expiredUrl = optionalHttpUrl(input.expiredUrl, 'expiredUrl');
    const social = cleanSocial(input.social);
    const redirect = input.redirect === undefined ? {} : mergeRedirect({}, input.redirect, false);
    const tags = cleanTags(input.tags);

    const build = (slug: ParsedSlug, origin: 'generated' | 'custom'): LinkDoc => ({
      _id,
      slug: slug.display,
      slugKey: slug.key,
      keys: [slug.key],
      aliases: [],
      origin,
      baseUrl: parts.baseUrl,
      utm: parts.utm,
      params: parts.params,
      ...(parts.hash ? { hash: parts.hash } : {}),
      destination,
      ...(title !== undefined ? { title } : {}),
      ...(notes !== undefined ? { notes } : {}),
      tags,
      redirect,
      ...(expiresAt ? { expiresAt } : {}),
      ...(maxClicks !== undefined ? { maxClicks } : {}),
      ...(expiredUrl ? { expiredUrl } : {}),
      ...(social ? { social } : {}),
      ...(og ? { og: { ...og, fetchedAt: now } } : {}),
      rev: 1,
      clicks: 0,
      uniqueClicks: 0,
      botClicks: 0,
      archived: false,
      ...(actor ? { createdBy: actor } : {}),
      createdAt: now,
      updatedAt: now,
    });

    // 2. Claim, then write. A failure after the claim releases it and removes
    //    whatever was written, so nothing is left half-made.
    const persist = async (slug: ParsedSlug, origin: 'generated' | 'custom'): Promise<void> => {
      await slugs.claim(slug, _id, true, now);
      try {
        await LinkModel.create(build(slug, origin));
        await History.create({
          linkId: _id, kind: 'created', at: now, ...(actor ? { by: actor } : {}),
          rev: 1, destination, slug: slug.display,
        });
      } catch (err) {
        await Promise.allSettled([
          LinkModel.deleteOne({ _id }),
          History.deleteMany({ linkId: _id }),
          slugs.release(slug.key, _id),
        ]);
        throw err;
      }
    };

    if (custom) {
      await persist(custom, 'custom');
    } else {
      await slugs.generate(async (candidate) => {
        try {
          await persist(candidate, 'generated');
          return true;
        } catch (err) {
          if (err instanceof ShortyError && err.code === 'slug_taken') return null;
          throw err;
        }
      });
    }

    const link = toLink(ctx, (await requireDoc(String(_id))));
    await hooks.hook('onCreate', { link, ...extras(actor, call?.req) });
    await hooks.track('shorty.link_created', link.id);
    return link;
  }

  // ── update ─────────────────────────────────────────────────────────────────

  interface Rename {
    to: ParsedSlug;
    /** The target is already one of this link's own aliases. */
    ownAlias: boolean;
  }

  interface Plan {
    noop: boolean;
    set: Record<string, unknown>;
    unset: Record<string, 1>;
    bumpRev: boolean;
    rename?: Rename;
    entries: Array<Record<string, unknown> & { kind: HistoryEntry['kind'] }>;
  }

  /** Pure given `doc`: validates the patch and says what to write. Never touches the database. */
  function plan(doc: LinkDoc, patch: LinkPatch, actor: Actor | undefined, now: Date): Plan {
    const p: Plan = { noop: false, set: {}, unset: {}, bumpRev: false, entries: [] };
    const has = (key: keyof LinkPatch): boolean => patch[key] !== undefined;
    if (!(Object.keys(patch) as Array<keyof LinkPatch>).some(has)) return { ...p, noop: true };

    const assign = (field: string, value: unknown): void => {
      if (value === undefined) p.unset[field] = 1;
      else p.set[field] = value;
    };
    const by = actor ? { by: actor } : {};

    // Destination.
    if (has('url') && (has('baseUrl') || has('utm') || has('params') || has('hash'))) {
      throw new ShortyError('ambiguous_destination');
    }
    if (has('url') || has('baseUrl') || has('utm') || has('params') || has('hash')) {
      let parts: UrlParts;
      if (has('url')) {
        parts = parseUrl(patch.url as string);
      } else {
        parts = {
          baseUrl: has('baseUrl') ? normalizeBase(patch.baseUrl) : doc.baseUrl,
          utm: has('utm') ? mergeUtm(doc.utm ?? {}, patch.utm) : { ...doc.utm },
          params: has('params') ? cleanParams(patch.params) : (doc.params ?? []).map((x) => ({ key: x.key, value: x.value ?? '' })),
          hash: has('hash') ? cleanHash(patch.hash) : doc.hash,
        };
      }
      const destination = composeUrl(parts);
      if (destination !== doc.destination) {
        // Only a change is checked: a link whose host was later blocked can
        // still have its title edited.
        checkDestination(ctx, destination);
        p.bumpRev = true;
        p.entries.push({
          kind: 'destination', at: now, ...by, rev: doc.rev + 1, destination, previous: doc.destination,
        });
      }
      p.set.baseUrl = parts.baseUrl;
      p.set.utm = parts.utm;
      p.set.params = parts.params;
      assign('hash', parts.hash);
      p.set.destination = destination;
    }

    // Slug. A patch whose key equals the current one is not a rename.
    if (has('slug')) {
      const to = slugs.parse(patch.slug);
      if (to.key !== doc.slugKey) {
        const mode = ctx.slug.rename;
        if (mode === 'never' || (mode === 'untilClicked' && doc.clicks > 0)) {
          throw new ShortyError('slug_locked', undefined, { slug: doc.slug, mode });
        }
        const aliases = (doc.aliases ?? []).filter((a) => slugs.keyOf(a.slug) !== to.key);
        if (mode !== 'always') aliases.push({ slug: doc.slug, at: now });
        p.rename = { to, ownAlias: (doc.keys ?? []).includes(to.key) };
        p.set.slug = to.display;
        p.set.slugKey = to.key;
        p.set.aliases = aliases;
        p.set.keys = [to.key, ...aliases.map((a) => slugs.keyOf(a.slug))];
        p.entries.push({ kind: 'slug', at: now, ...by, from: doc.slug, to: to.display, mode });
      }
    }

    // Metadata — no revision.
    if (has('title')) assign('title', optionalText(patch.title, 'title'));
    if (has('notes')) assign('notes', optionalText(patch.notes, 'notes'));
    if (has('tags')) p.set.tags = cleanTags(patch.tags);
    if (has('redirect')) p.set.redirect = mergeRedirect(doc.redirect ?? {}, patch.redirect, true);
    if (has('expiresAt')) assign('expiresAt', optionalDate(patch.expiresAt, 'expiresAt'));
    if (has('maxClicks')) assign('maxClicks', optionalMaxClicks(patch.maxClicks));
    if (has('expiredUrl')) assign('expiredUrl', optionalHttpUrl(patch.expiredUrl, 'expiredUrl'));
    if (has('social')) assign('social', cleanSocial(patch.social));
    if (has('og')) {
      const og: OgData | undefined = cleanOg(patch.og);
      assign('og', og ? { ...og, fetchedAt: now } : undefined);
    }

    p.set.updatedAt = now;
    assign('updatedBy', actor);
    return p;
  }

  async function updateLink(id: string, patch: LinkPatch, call?: CallContext): Promise<Link> {
    if (!patch || typeof patch !== 'object') throw new ShortyError('validation', undefined, { field: 'body' });
    const actor = actorOf(call);
    const now = ctx.now();

    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
      const doc = await requireDoc(id);
      const p = plan(doc, patch, actor, now);
      if (p.noop) return toLink(ctx, doc);

      const linkId = doc._id;
      const update: Record<string, unknown> = { $set: p.set };
      if (Object.keys(p.unset).length) update.$unset = p.unset;
      if (p.bumpRev) update.$inc = { rev: 1 };

      // Claim the new slug (if it is not already ours), then swap it in. The
      // filter pins the slug and destination this plan was computed against, so
      // two writers can't both succeed with answers derived from the same read.
      let claimed = false;
      try {
        if (p.rename && !p.rename.ownAlias) {
          await slugs.claim(p.rename.to, linkId, true, now);
          claimed = true;
        }
        const res = await LinkModel.updateOne(
          { _id: linkId, slugKey: doc.slugKey, destination: doc.destination },
          update,
        );
        if (res.matchedCount === 0) {
          if (claimed) await slugs.release(p.rename!.to.key, linkId);
          continue;
        }
      } catch (err) {
        if (claimed) await slugs.release(p.rename!.to.key, linkId).catch(() => undefined);
        throw err;
      }

      if (p.rename) {
        const from = doc.slugKey;
        if (ctx.slug.rename === 'always') await Slug.deleteOne({ _id: from, linkId });
        else await Slug.updateOne({ _id: from, linkId }, { $set: { current: false } });
        if (p.rename.ownAlias) await Slug.updateOne({ _id: p.rename.to.key, linkId }, { $set: { current: true } });
      }
      if (p.entries.length) await History.insertMany(p.entries.map((e) => ({ ...e, linkId })));

      const next = await requireDoc(id);
      const link = toLink(ctx, next);
      const history = p.entries.map((e) => toHistoryEntry(e as unknown as StoredHistory));
      await hooks.hook('onUpdate', { link, prev: toLink(ctx, doc), history, ...extras(actor, call?.req) });
      await hooks.track('shorty.link_updated', link.id);
      return link;
    }
    throw new Error('shorty: updateLink kept losing a race with concurrent writers');
  }

  // ── archive / delete ───────────────────────────────────────────────────────

  async function setArchived(id: string, archived: boolean, call?: CallContext): Promise<Link> {
    const doc = await requireDoc(id);
    // Already in that state: nothing changed, so no write, no hook, no event.
    if (doc.archived === archived) return toLink(ctx, doc);
    const actor = actorOf(call);
    await LinkModel.updateOne(
      { _id: doc._id },
      {
        $set: { archived, updatedAt: ctx.now(), ...(actor ? { updatedBy: actor } : {}) },
        ...(actor ? {} : { $unset: { updatedBy: 1 } }),
      },
    );
    const link = toLink(ctx, await requireDoc(id));
    await hooks.hook('onArchive', { link, archived, ...extras(actor, call?.req) });
    await hooks.track(archived ? 'shorty.link_archived' : 'shorty.link_unarchived', link.id);
    return link;
  }

  async function deleteLink(id: string, call?: CallContext): Promise<DeleteSummary> {
    const actor = actorOf(call);
    const doc = await findDoc(id);
    let link: Link | null = null;
    if (doc) {
      // The link goes first: from this moment nothing redirects or counts.
      const removed = await LinkModel.deleteOne({ _id: doc._id });
      if (removed.deletedCount === 0 && !(await Slug.exists({ linkId: doc._id }))) throw notFound(id);
      link = toLink(ctx, doc);
    } else if (typeof id === 'string' && OBJECT_ID.test(id)) {
      // A retry after a partial failure: the Link is gone but its rows may remain.
      if (!(await Slug.exists({ linkId: id }))) throw notFound(id);
    } else {
      throw notFound(String(id));
    }
    const linkId = new Types.ObjectId(id);
    // Slug claims next, awaited on their own: a failure here surfaces, and a
    // retry (Link gone, claims left) finishes the cleanup.
    const keys = await Slug.deleteMany({ linkId });
    const [history, clicks] = await Promise.all([
      History.deleteMany({ linkId }),
      Click.deleteMany({ linkId }),
      Daily.deleteMany({ linkId }),
      Seen.deleteMany({ linkId }),
    ]);
    const summary: DeleteSummary = {
      clicks: clicks.deletedCount, history: history.deletedCount, keys: keys.deletedCount,
    };
    // A retry has no Link left to hand to the hooks.
    if (link) {
      await hooks.hook('onDelete', { link, summary, ...extras(actor, call?.req) });
      await hooks.track('shorty.link_deleted', link.id);
    }
    return summary;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async function link(idOrSlug: string): Promise<Link | null> {
    if (typeof idOrSlug !== 'string' || !idOrSlug) return null;
    if (OBJECT_ID.test(idOrSlug)) {
      const byId = await findDoc(idOrSlug);
      if (byId) return toLink(ctx, byId);
    }
    const key = slugs.lookupKey(idOrSlug);
    if (!key) return null;
    const doc = asDoc(await LinkModel.findOne({ keys: key }).lean());
    return doc ? toLink(ctx, doc) : null;
  }

  const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

  function decodeCursor(raw: string, sort: LinkSort): Cursor {
    const invalid = new ShortyError('validation', undefined, { field: 'cursor' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw invalid;
    }
    // Shape first: `null`, arrays and bare objects must not reach the field reads.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid;
    const c = parsed as Cursor;
    const valueOk = c.v === null ? sort === 'lastClicked'
      : sort === 'clicks' ? typeof c.v === 'number' && Number.isFinite(c.v)
        : typeof c.v === 'string' && !Number.isNaN(new Date(c.v).getTime());
    if (c.s !== sort || typeof c.i !== 'string' || !OBJECT_ID.test(c.i) || !valueOk) throw invalid;
    return c;
  }

  async function links(query: LinksQuery = {}): Promise<LinksPage> {
    const sort: LinkSort = query.sort ?? 'newest';
    if (!(sort in SORT_FIELD)) throw new ShortyError('validation', undefined, { field: 'sort' });
    const field = SORT_FIELD[sort];
    const requested = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.floor(query.limit) : ctx.listLimit;
    const limit = Math.max(1, Math.min(requested, ctx.listLimit));

    const and: Array<Record<string, unknown>> = [];
    // `$in` over both values (rather than no filter) lets the {archived, …}
    // indexes serve the sort for 'all' too.
    const archived = query.archived ?? false;
    and.push({ archived: archived === 'all' ? { $in: [false, true] } : archived === true });
    if (query.tag !== undefined) {
      if (typeof query.tag !== 'string') throw new ShortyError('validation', undefined, { field: 'tag' });
      and.push({ tags: query.tag });
    }
    if (query.q !== undefined) {
      if (typeof query.q !== 'string') throw new ShortyError('validation', undefined, { field: 'q' });
      // `$text` takes the string as search terms, never as a pattern, so regex
      // metacharacters are inert.
      if (query.q.trim()) and.push({ $text: { $search: query.q.trim().slice(0, 200) } });
    }
    if (query.cursor !== undefined) {
      const c = decodeCursor(query.cursor, sort);
      const id = new Types.ObjectId(c.i);
      if (c.v === null) {
        and.push({ [field]: null, _id: { $lt: id } });
      } else {
        const v = sort === 'clicks' ? c.v : new Date(c.v);
        const after: Array<Record<string, unknown>> = [{ [field]: { $lt: v } }, { [field]: v, _id: { $lt: id } }];
        // Never-clicked rows sort after every clicked one.
        if (sort === 'lastClicked') after.push({ [field]: null });
        and.push({ $or: after });
      }
    }

    const docs = (await LinkModel.find({ $and: and })
      .sort({ [field]: -1, _id: -1 })
      .limit(limit + 1)
      .lean()) as unknown as LinkDoc[];

    const page = docs.slice(0, limit);
    let nextCursor: string | null = null;
    if (docs.length > limit) {
      const last = page[page.length - 1];
      const raw = last[field] as Date | number | undefined;
      nextCursor = encodeCursor({
        s: sort,
        v: raw === undefined || raw === null ? null : raw instanceof Date ? raw.toISOString() : raw,
        i: String(last._id),
      });
    }
    return { items: page.map((d) => toLink(ctx, d)), nextCursor, limit };
  }

  async function history(id: string): Promise<HistoryEntry[]> {
    const doc = await requireDoc(id);
    const rows = (await History.find({ linkId: doc._id }).sort({ at: 1, _id: 1 }).lean()) as unknown as StoredHistory[];
    return rows.map(toHistoryEntry);
  }

  async function tags(): Promise<TagStat[]> {
    const rows = await LinkModel.aggregate<{ _id: string; count: number }>([
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 1000 },
    ]).option({ maxTimeMS: 10_000 });
    return rows.map((r) => ({ tag: r._id, count: r.count }));
  }

  async function recount(id: string): Promise<Link> {
    const doc = await requireDoc(id);
    const [sum] = await Daily.aggregate<{ clicks: number; uniques: number; bots: number }>([
      { $match: { linkId: doc._id } },
      { $group: { _id: null, clicks: { $sum: '$clicks' }, uniques: { $sum: '$uniques' }, bots: { $sum: '$bots' } } },
    ]).option({ maxTimeMS: 10_000 });
    await LinkModel.updateOne(
      { _id: doc._id },
      { $set: { clicks: sum?.clicks ?? 0, uniqueClicks: sum?.uniques ?? 0, botClicks: sum?.bots ?? 0 } },
    );
    return toLink(ctx, await requireDoc(id));
  }

  return {
    createLink,
    updateLink,
    archiveLink: (id, call) => setArchived(id, true, call),
    unarchiveLink: (id, call) => setArchived(id, false, call),
    deleteLink,
    link,
    links,
    history,
    tags,
    checkSlug: (slug, opts) => slugs.check(slug, opts?.linkId),
    generateSlug: () => slugs.fresh(),
    recount,
  };
}
