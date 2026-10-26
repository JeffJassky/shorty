import type mongoose from 'mongoose';
import type { LinkDoc, ShortyModels } from '../../types/index.js';
import { ShortyError } from '../shared/errors.js';
import type { ResolvedContext } from './config.js';
import { MISS_TTL_SECONDS } from './models.js';

/**
 * `ready()` — everything that must be true before the first request, done once
 * at boot (traps #3):
 *
 *  1. every collection exists and every index is built, empty or not;
 *  2. the click / seen / miss TTLs match config — `createIndexes` silently
 *     keeps an old `expireAfterSeconds`, so differing ones are fixed in place
 *     with `collMod`;
 *  3. stored slug keys match the configured case mode, re-keyed if it flipped.
 *
 * Idempotent: a second call finds nothing to do.
 */

const NAMESPACE_EXISTS = 48;
const INDEX_CONFLICT = [85, 86];
/** Links re-keyed per bulk write. */
const REKEY_BATCH = 500;

type AnyModel = ShortyModels[keyof ShortyModels];

const codeOf = (err: unknown): number | undefined => (err as { code?: number } | null)?.code;

export interface Lifecycle {
  ready(): Promise<void>;
}

export function createLifecycle(ctx: ResolvedContext): Lifecycle {
  const { models } = ctx;
  const all = Object.values(models) as AnyModel[];

  /** Index name → TTL it must carry. Must match the names in models.ts. */
  const ttls: Array<[AnyModel, string, number]> = [
    [models.Click, 'shorty_click_ttl', Math.round(ctx.clicks.retentionDays * 86400)],
    [models.Seen, 'shorty_seen_ttl', Math.round(ctx.clicks.uniqueWindowMinutes * 60)],
    [models.Miss, 'shorty_miss_ttl', MISS_TTL_SECONDS],
  ];

  function isTtlConflict(model: AnyModel, err: unknown): boolean {
    const ttlName = ttls.find(([m]) => m === model)?.[1];
    return !!ttlName && INDEX_CONFLICT.includes(codeOf(err) ?? 0) && String((err as Error).message).includes(ttlName);
  }

  async function ensureCollection(model: AnyModel): Promise<void> {
    try {
      await model.createCollection();
    } catch (err) {
      if (codeOf(err) !== NAMESPACE_EXISTS) throw err;
    }
    // Mongoose may already be building indexes in the background (autoIndex).
    // Let that settle. Only the TTL conflict `reconcileTtls` repairs is
    // tolerated; anything else is a real failure and propagates.
    try {
      await model.init();
    } catch (err) {
      if (!isTtlConflict(model, err)) throw err;
    }
  }

  async function reconcileTtls(): Promise<void> {
    await Promise.all(ttls.map(async ([model, name, seconds]) => {
      const indexes = (await model.collection.indexes()) as Array<{ name?: string; expireAfterSeconds?: number }>;
      const existing = indexes.find((i) => i.name === name);
      if (!existing || existing.expireAfterSeconds === seconds) return;
      await (model.db.db as mongoose.mongo.Db).command({
        collMod: model.collection.collectionName,
        index: { name, expireAfterSeconds: seconds },
      });
    }));
  }

  async function buildIndexes(model: AnyModel): Promise<void> {
    try {
      await model.createIndexes();
    } catch (err) {
      // A model compiled earlier in this process keeps its first TTL, which
      // `reconcileTtls` has since changed on the server. That is the only
      // conflict expected here, and the server already holds the right value.
      if (isTtlConflict(model, err)) return;
      throw err;
    }
  }

  async function writeMeta(): Promise<void> {
    try {
      await models.Meta.updateOne(
        { _id: 'config' },
        { $set: { caseSensitive: ctx.slug.caseSensitive } },
        { upsert: true },
      );
    } catch (err) {
      if (codeOf(err) !== 11000) throw err; // another process upserted first
    }
  }

  async function rekey(): Promise<void> {
    const { Link, Slug, Meta } = models;
    const want = ctx.slug.caseSensitive;
    const meta = await Meta.findById('config').lean();
    if (!meta) {
      // First boot: nothing was keyed under any other mode.
      await writeMeta();
      return;
    }
    if (meta.caseSensitive === want) return;

    const keyOf = (display: string): string => (want ? display : display.toLowerCase());
    interface Owner { linkId: string; slug: string; kind: 'slug' | 'alias' }
    interface Rewrite {
      _id: LinkDoc['_id'];
      slugKey: string;
      keys: string[];
      aliases: LinkDoc['aliases'];
    }
    const owners = new Map<string, Owner[]>();
    const rewrites: Rewrite[] = [];

    // Pass 1 — compute every new key and find merges. NOTHING is written here.
    const cursor = Link.find({}, { slug: 1, aliases: 1 }).lean().cursor();
    for await (const raw of cursor) {
      const doc = raw as unknown as Pick<LinkDoc, '_id' | 'slug' | 'aliases'>;
      const linkId = String(doc._id);
      const slugKey = keyOf(doc.slug);
      const seen = new Set([slugKey]);
      const aliases: LinkDoc['aliases'] = [];
      const claim = (key: string, owner: Owner): void => {
        const list = owners.get(key) ?? [];
        list.push(owner);
        owners.set(key, list);
      };
      claim(slugKey, { linkId, slug: doc.slug, kind: 'slug' });
      for (const alias of doc.aliases ?? []) {
        const key = keyOf(alias.slug);
        // An alias that now equals the link's own key (or an earlier alias) says nothing new.
        if (seen.has(key)) continue;
        seen.add(key);
        aliases.push({ slug: alias.slug, at: alias.at });
        claim(key, { linkId, slug: alias.slug, kind: 'alias' });
      }
      rewrites.push({ _id: doc._id, slugKey, keys: [...seen], aliases });
    }

    const collisions = [...owners.entries()]
      .filter(([, list]) => new Set(list.map((o) => o.linkId)).size > 1)
      .map(([key, list]) => ({ key, entries: list }));
    if (collisions.length) {
      const named = collisions
        .map((c) => c.entries.map((o) => `"${o.slug}"${o.kind === 'alias' ? ' (alias)' : ''}`).join(' and '))
        .join('; ');
      const err = new ShortyError('case_collision', undefined, { caseSensitive: want, collisions });
      err.message = `shorty: slug.caseSensitive is now ${want}, but these slugs would merge: ${named}. Nothing was changed; rename one of each pair, or restore the previous setting.`;
      throw err;
    }

    // Pass 2 — write. Claims are upserted before old ones are dropped, so a key
    // is never unclaimed mid-flip; and everything is derived from the display
    // slugs, so a crash here is repaired by simply running `ready()` again
    // (Meta, written last, still says the old mode).
    const at = ctx.now();
    for (let i = 0; i < rewrites.length; i += REKEY_BATCH) {
      const batch = rewrites.slice(i, i + REKEY_BATCH);
      await Slug.bulkWrite(batch.flatMap((r) => r.keys.map((key) => ({
        updateOne: {
          filter: { _id: key, linkId: r._id },
          update: { $set: { current: key === r.slugKey }, $setOnInsert: { at } },
          upsert: true,
        },
      }))), { ordered: false });
      await Link.bulkWrite(batch.map((r) => ({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { slugKey: r.slugKey, keys: r.keys, aliases: r.aliases } },
        },
      })), { ordered: false });
      await Slug.bulkWrite(batch.map((r) => ({
        deleteMany: { filter: { linkId: r._id, _id: { $nin: r.keys } } },
      })), { ordered: false });
    }
    await writeMeta();
  }

  return {
    async ready() {
      await Promise.all(all.map(ensureCollection));
      await reconcileTtls();
      await Promise.all(all.map(buildIndexes));
      await reconcileTtls();
      await rekey();
    },
  };
}
