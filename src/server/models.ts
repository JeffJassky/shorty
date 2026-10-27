import mongoose from 'mongoose';
import type { Connection, Model, Mongoose, Schema } from 'mongoose';
import type {
  ClickDoc,
  DailyDoc,
  HistoryDoc,
  LinkDoc,
  MetaDoc,
  MissDoc,
  SeenDoc,
  ShortyModels,
  SlugDoc,
} from '../../types/index.js';

/**
 * Every collection shorty owns (§7.1). The document shapes are the published
 * `*Doc` interfaces; the schemas below are untyped on purpose — mongoose's
 * schema-inference generics fight hand-written interfaces rather than check
 * them — and the models are cast to `Model<*Doc>` at the one place they're
 * compiled.
 *
 * Indexes are declared here and built by `ready()`, never on first query —
 * traps #3. TTLs that depend on config (`clicks.retentionDays`,
 * `uniqueWindowMinutes`) are declared with the configured value; `ready()`
 * reconciles an existing index whose TTL differs (collMod), because
 * `createIndexes` silently keeps the old one.
 */

export interface ModelOptions {
  connection: Mongoose | Connection;
  modelPrefix: string;
  collectionPrefix: string;
  /** Raw click TTL in seconds. */
  clickTtlSeconds: number;
  /** Unique-visitor window in seconds. */
  seenTtlSeconds: number;
}

export const MISS_TTL_SECONDS = 30 * 24 * 60 * 60;

const { Types } = mongoose.Schema;

const actor = new mongoose.Schema({ id: { type: String, required: true }, name: String }, { _id: false });
const param = new mongoose.Schema({ key: { type: String, required: true }, value: { type: String, default: '' } }, { _id: false });
const utm = new mongoose.Schema({
  source: String, medium: String, campaign: String, term: String, content: String, id: String,
}, { _id: false });

export function buildLinkSchema(): Schema {
  const schema = new mongoose.Schema({
    slug: { type: String, required: true },
    slugKey: { type: String, required: true },
    keys: { type: [String], required: true },
    aliases: { type: [new mongoose.Schema({ slug: String, at: Date }, { _id: false })], default: [] },
    origin: { type: String, enum: ['generated', 'custom'], required: true },
    baseUrl: { type: String, required: true },
    utm: { type: utm, default: () => ({}) },
    params: { type: [param], default: [] },
    hash: String,
    destination: { type: String, required: true },
    title: String,
    notes: String,
    tags: { type: [String], default: [] },
    redirect: {
      type: new mongoose.Schema({ status: Number, forwardQuery: Boolean }, { _id: false }),
      default: () => ({}),
    },
    expiresAt: Date,
    maxClicks: Number,
    expiredUrl: String,
    social: new mongoose.Schema({ title: String, description: String, image: String }, { _id: false }),
    og: new mongoose.Schema({
      title: String, description: String, image: String, siteName: String, favicon: String, fetchedAt: Date,
    }, { _id: false }),
    rev: { type: Number, default: 1 },
    // Write version: +1 on every write to the link's own fields (never on
    // clicks); updateLink pins it in its filter. See LinkDoc.wv.
    wv: { type: Number, default: 1 },
    // Case mode the keys were computed under; ready() re-keys ck !== config.
    // No default: the service stamps it from config. See LinkDoc.ck.
    ck: { type: Boolean },
    clicks: { type: Number, default: 0 },
    uniqueClicks: { type: Number, default: 0 },
    botClicks: { type: Number, default: 0 },
    lastClickedAt: Date,
    archived: { type: Boolean, default: false },
    createdBy: actor,
    updatedBy: actor,
    // Set from `config.now()` by the service — NOT mongoose `timestamps`, which
    // reads the wall clock and makes ordering untestable and replays wrong.
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { minimize: false });

  // The redirect lookup. Multikey, NOT unique: uniqueness across slugs and
  // aliases is enforced by the slugs collection, because a unique index on an
  // array field can't stop one link's new slug colliding with another link's
  // alias under a race.
  schema.index({ keys: 1 });
  schema.index({ archived: 1, createdAt: -1 });
  schema.index({ archived: 1, clicks: -1 });
  schema.index({ archived: 1, lastClickedAt: -1 });
  schema.index({ tags: 1 });
  schema.index(
    { slug: 'text', title: 'text', notes: 'text', baseUrl: 'text', 'utm.campaign': 'text' },
    { name: 'shorty_search' },
  );
  return schema;
}

export function buildSlugSchema(): Schema {
  const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    linkId: { type: Types.ObjectId, required: true },
    current: { type: Boolean, required: true },
    at: { type: Date, required: true },
  }, { versionKey: false });
  schema.index({ linkId: 1 });
  return schema;
}

export function buildHistorySchema(): Schema {
  const schema = new mongoose.Schema({
    linkId: { type: Types.ObjectId, required: true },
    kind: { type: String, enum: ['created', 'destination', 'slug'], required: true },
    at: { type: Date, required: true },
    by: actor,
    rev: Number,
    destination: String,
    previous: String,
    slug: String,
    from: String,
    to: String,
    mode: String,
  }, { versionKey: false });
  schema.index({ linkId: 1, at: 1 });
  return schema;
}

export function buildClickSchema(ttlSeconds: number): Schema {
  const schema = new mongoose.Schema({
    linkId: { type: Types.ObjectId, required: true },
    rev: { type: Number, required: true },
    at: { type: Date, required: true },
    visitor: { type: String, required: true },
    unique: { type: Boolean, required: true },
    bot: { type: Boolean, required: true },
    qr: { type: Boolean, default: false },
    referrerHost: String,
    referrer: String,
    country: String,
    region: String,
    city: String,
    browser: String,
    os: String,
    device: { type: String, enum: ['desktop', 'mobile', 'tablet', 'other'], required: true },
    queryKeys: { type: [String], default: undefined },
  }, { versionKey: false });
  // Regular collection + TTL, not a time-series collection: erasure needs
  // deleteMany — traps #17.
  schema.index({ at: 1 }, { expireAfterSeconds: ttlSeconds, name: 'shorty_click_ttl' });
  schema.index({ linkId: 1, at: -1 });
  return schema;
}

export function buildDailySchema(): Schema {
  const schema = new mongoose.Schema({
    linkId: { type: Types.ObjectId, required: true },
    day: { type: String, required: true },
    clicks: { type: Number, default: 0 },
    uniques: { type: Number, default: 0 },
    qr: { type: Number, default: 0 },
    bots: { type: Number, default: 0 },
    botUniques: { type: Number, default: 0 },
  }, { versionKey: false });
  schema.index({ linkId: 1, day: 1 }, { unique: true });
  schema.index({ day: 1 });
  return schema;
}

export function buildSeenSchema(ttlSeconds: number): Schema {
  const schema = new mongoose.Schema({
    linkId: { type: Types.ObjectId, required: true },
    visitor: { type: String, required: true },
    at: { type: Date, required: true },
  }, { versionKey: false });
  // Insert succeeds → unique; duplicate-key → repeat. One write, no read.
  schema.index({ linkId: 1, visitor: 1 }, { unique: true });
  schema.index({ at: 1 }, { expireAfterSeconds: ttlSeconds, name: 'shorty_seen_ttl' });
  return schema;
}

export function buildMissSchema(): Schema {
  const schema = new mongoose.Schema({
    path: { type: String, required: true },
    at: { type: Date, required: true },
    referrerHost: String,
  }, { versionKey: false });
  schema.index({ at: 1 }, { expireAfterSeconds: MISS_TTL_SECONDS, name: 'shorty_miss_ttl' });
  return schema;
}

export function buildMetaSchema(): Schema {
  return new mongoose.Schema({
    _id: { type: String, required: true },
    caseSensitive: { type: Boolean, required: true },
  }, { versionKey: false });
}

/**
 * Compile every model on the host's connection. An already-compiled model of
 * the same name is reused — the registry is per-connection and global, and a
 * package loaded twice must not throw OverwriteModelError. Hosts running two
 * instances set `modelPrefix` (traps #2).
 */
export function createModels(opts: ModelOptions): ShortyModels {
  const { connection, modelPrefix, collectionPrefix } = opts;
  const compile = <T>(name: string, schema: () => Schema, collection: string): Model<T> => {
    const full = `${modelPrefix}${name}`;
    const existing = connection.models?.[full];
    if (existing) return existing as unknown as Model<T>;
    return connection.model(full, schema(), `${collectionPrefix}${collection}`) as unknown as Model<T>;
  };

  return {
    Link: compile<LinkDoc>('Link', buildLinkSchema, 'links'),
    Slug: compile<SlugDoc>('Slug', buildSlugSchema, 'slugs'),
    History: compile<HistoryDoc>('History', buildHistorySchema, 'history'),
    Click: compile<ClickDoc>('Click', () => buildClickSchema(opts.clickTtlSeconds), 'clicks'),
    Daily: compile<DailyDoc>('Daily', buildDailySchema, 'daily'),
    Seen: compile<SeenDoc>('Seen', () => buildSeenSchema(opts.seenTtlSeconds), 'seen'),
    Miss: compile<MissDoc>('Miss', buildMissSchema, 'misses'),
    Meta: compile<MetaDoc>('Meta', buildMetaSchema, 'meta'),
  };
}
