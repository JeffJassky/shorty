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
/** Links re-keyed concurrently. */
const REKEY_BATCH = 50;

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
    const { Link, Slug } = models;
    const want = ctx.slug.caseSensitive;
    // `Link.ck` is the source of truth, not Meta (which is advisory): a link
    // written by an other-mode instance since the last boot, or a database
    // whose Meta is gone, is still found.
    const keyOf = (display: string): string => (want ? display : display.toLowerCase());
    interface Owner { linkId: string; slug: string; kind: 'slug' | 'alias' }
    type Snap = Pick<LinkDoc, '_id' | 'slug' | 'aliases' | 'wv' | 'ck'>;
    interface Rewrite {
      slugKey: string;
      keys: string[];
      aliases: LinkDoc['aliases'];
    }
    const owners = new Map<string, Owner[]>();
    const stale: Snap[] = [];

    /** New keys for a link under the configured mode; an alias that now equals an earlier key says nothing new. */
    const compute = (doc: Snap, onKey?: (key: string, owner: Owner) => void): Rewrite => {
      const linkId = String(doc._id);
      const slugKey = keyOf(doc.slug);
      const seen = new Set([slugKey]);
      const aliases: LinkDoc['aliases'] = [];
      onKey?.(slugKey, { linkId, slug: doc.slug, kind: 'slug' });
      for (const alias of doc.aliases ?? []) {
        const key = keyOf(alias.slug);
        if (seen.has(key)) continue;
        seen.add(key);
        aliases.push({ slug: alias.slug, at: alias.at });
        onKey?.(key, { linkId, slug: alias.slug, kind: 'alias' });
      }
      return { slugKey, keys: [...seen], aliases };
    };

    // Pass 1 — scan EVERY link: a stale link must not merge with one that is
    // already correct. NOTHING is written here.
    const cursor = Link.find({}, { slug: 1, aliases: 1, wv: 1, ck: 1 }).lean().cursor();
    for await (const raw of cursor) {
      const doc = raw as unknown as Snap;
      compute(doc, (key, owner) => {
        const list = owners.get(key) ?? [];
        list.push(owner);
        owners.set(key, list);
      });
      if (doc.ck !== want) stale.push(doc);
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

    // Pass 2 — write, one link at a time. Each Link write matches the snapshot
    // (`_id`, `wv`) it was computed from; on a mismatch something changed the
    // link since the scan, so it is re-read and recomputed. Claims are upserted
    // before the Link write and the old ones dropped only after it matched, so
    // a key is never unclaimed mid-flip, and a crash is repaired by running
    // `ready()` again (every link still stale is found by `ck`).
    const at = ctx.now();
    const rekeyOne = async (first: Snap): Promise<void> => {
      let snap: Snap | null = first;
      while (snap) {
        const r = compute(snap);
        try {
          await Slug.bulkWrite(r.keys.map((key) => ({
            updateOne: {
              filter: { _id: key, linkId: snap!._id },
              update: { $set: { current: key === r.slugKey }, $setOnInsert: { at } },
              upsert: true,
            },
          })), { ordered: false });
        } catch (err) {
          const writeErrors = (err as { writeErrors?: Array<{ code?: number }> } | null)?.writeErrors;
          if (codeOf(err) === 11000 || writeErrors?.some((w) => w.code === 11000)) {
            throw new ShortyError('case_collision', undefined, { caseSensitive: want, linkId: String(snap._id) });
          }
          throw err;
        }
        const res = await Link.updateOne(
          { _id: snap._id, wv: snap.wv },
          { $set: { slugKey: r.slugKey, keys: r.keys, aliases: r.aliases, ck: want }, $inc: { wv: 1 } },
        );
        if (res.matchedCount > 0) {
          await Slug.deleteMany({ linkId: snap._id, _id: { $nin: r.keys } });
          return;
        }
        snap = (await Link.findById(snap._id, { slug: 1, aliases: 1, wv: 1, ck: 1 }).lean()) as Snap | null;
      }
      // The link was deleted under us: the claims upserted for it are orphans.
      await Slug.deleteMany({ linkId: first._id });
    };
    for (let i = 0; i < stale.length; i += REKEY_BATCH) {
      await Promise.all(stale.slice(i, i + REKEY_BATCH).map(rekeyOne));
    }
    await sweepClaims();
    await writeMeta();
  }

  /**
   * Claims must equal their link's `keys`, with only `slugKey` current. A crash
   * between a re-key's Link write and its stale-claim delete leaves a link that
   * `ck` no longer selects, so this walks every claim. Batched and idempotent.
   */
  async function sweepClaims(): Promise<void> {
    const { Link, Slug } = models;
    const flush = async (batch: Array<{ _id: string; linkId: LinkDoc['_id']; current: boolean }>): Promise<void> => {
      const ids = [...new Set(batch.map((c) => String(c.linkId)))];
      const links = (await Link.find({ _id: { $in: ids } }, { keys: 1, slugKey: 1 }).lean()) as unknown as
        Array<Pick<LinkDoc, '_id' | 'keys' | 'slugKey'>>;
      const byId = new Map(links.map((l) => [String(l._id), l]));
      const ops: Array<Record<string, unknown>> = [];
      for (const c of batch) {
        const owner = byId.get(String(c.linkId));
        if (!owner || !owner.keys.includes(c._id)) {
          ops.push({ deleteOne: { filter: { _id: c._id, linkId: c.linkId } } });
        } else if (c.current !== (c._id === owner.slugKey)) {
          ops.push({ updateOne: { filter: { _id: c._id, linkId: c.linkId }, update: { $set: { current: c._id === owner.slugKey } } } });
        }
      }
      if (ops.length) await Slug.bulkWrite(ops as never, { ordered: false });
    };
    let batch: Array<{ _id: string; linkId: LinkDoc['_id']; current: boolean }> = [];
    for await (const raw of Slug.find({}, { linkId: 1, current: 1 }).lean().cursor()) {
      batch.push(raw as never);
      if (batch.length >= 500) {
        await flush(batch);
        batch = [];
      }
    }
    if (batch.length) await flush(batch);
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
