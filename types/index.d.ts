import type { Request, Router } from 'express';
import type { Connection, Model, Mongoose, Types } from 'mongoose';

/**
 * @jeffjassky/shorty — the published contract.
 *
 * Hand-written, and `src/` imports from here — never the other way round
 * (traps #9, #21). A field added to a schema or a service without a matching
 * declaration here fails the typecheck.
 *
 * Plan: plans/build-plan.md. Section references (§n) point there.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export interface Logger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

/** 302 is the default everywhere — §3, research.md §3. */
export type RedirectStatus = 301 | 302 | 307 | 308;

/**
 * What renaming a slug does (§7.3).
 * - `alias`        rename any time; every old slug keeps redirecting forever (default)
 * - `untilClicked` rename until the first HUMAN click, then `slug_locked`
 * - `always`       rename any time; the old slug is freed for reuse
 * - `never`        fixed at creation; every rename is `slug_locked`
 */
export type RenameMode = 'alias' | 'untilClicked' | 'always' | 'never';

/** Who is acting. Never an auth result — the host authenticated already. */
export interface Actor {
  id: string;
  name?: string;
}

/** Inbound user adapter. Return null for a caller the host knows nothing about. */
export type ResolveUser = (req: Request) => Actor | null | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// URL parts — the destination as structured fields (§7.1, §7.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The six recognized UTM fields. Each maps to `utm_<field>` in the query.
 * An empty string is treated as absent everywhere.
 */
export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  id?: string;
}
export type UtmField = keyof Utm;

/** A non-UTM query parameter. Order is preserved; duplicate keys are allowed. */
export interface Param {
  key: string;
  /** `''` renders as a bare key (`?debug`), not `?debug=`. */
  value: string;
}

/**
 * A destination split into the pieces the form edits.
 *
 * `baseUrl` is scheme + host + path ONLY: absolute, http(s), no query, no
 * fragment. A `baseUrl` carrying `?` or `#` is `invalid_base_url` — callers
 * holding a full URL use `parseUrl` (or pass `url` to `createLink`).
 */
export interface UrlParts {
  baseUrl: string;
  utm: Utm;
  params: Param[];
  /** Fragment without the leading `#`. */
  hash?: string;
}

/**
 * Build the destination string. Pure; shared by server and SPA.
 *
 * Order: `baseUrl` `?` utm fields in the fixed order source, medium, campaign,
 * term, content, id — then `params` in array order — then `#hash`. Keys and
 * values are encoded with `encodeURIComponent` (space → `%20`). Empty UTM
 * fields are omitted. No `?` when there is no query.
 *
 * Throws `ShortyError('invalid_base_url')` when `baseUrl` is not absolute
 * http(s) or carries a query/fragment, and `ShortyError('invalid_param')` for
 * an empty param key.
 */
export declare function composeUrl(parts: UrlParts): string;

/**
 * Split any absolute http(s) URL into parts. Pure; shared by server and SPA.
 *
 * - `utm_source` … `utm_id` (exact, lowercase keys) fill `utm`; the FIRST
 *   occurrence wins and later duplicates stay in `params`, so nothing is lost.
 * - Every other key, including `UTM_SOURCE` and `utm_source_platform`, goes to
 *   `params` in original order.
 * - Query decoding follows `URLSearchParams` (`+` is a space).
 * - `composeUrl(parseUrl(u))` equals `u` up to encoding normalization and
 *   UTM-first reordering; `parseUrl(composeUrl(parts))` equals `parts`.
 *
 * Throws `ShortyError('invalid_url')` for anything that is not an absolute URL
 * and `ShortyError('unsupported_scheme')` for non-http(s) schemes.
 */
export declare function parseUrl(url: string): UrlParts;

// ─────────────────────────────────────────────────────────────────────────────
// Links
// ─────────────────────────────────────────────────────────────────────────────

/** A custom card served to crawlers only (§7.5). Humans always get the redirect. */
export interface SocialCard {
  /** ≤ 120 characters. */
  title?: string;
  /** ≤ 240 characters. */
  description?: string;
  /** Absolute http(s) URL. 1200×630 recommended. */
  image?: string;
}

/** What `inspect` scraped off a destination — raw; fallback text (URL as title) is the UI's job. */
export interface OgData {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

export interface LinkRedirectOverrides {
  status?: RedirectStatus;
  forwardQuery?: boolean;
}

/**
 * A link as the API returns it. No storage internals (`slugKey`, `keys`) — those
 * live on `LinkDoc`.
 */
export interface Link extends UrlParts {
  id: string;
  /**
   * Current slug, display form: as entered, accents stripped (NFKD), case
   * KEPT — `Café` displays `Cafe`; its key is `cafe` unless `caseSensitive`.
   */
  slug: string;
  /** Old slugs that still redirect here (`rename: 'alias'`), oldest first. */
  aliases: string[];
  origin: 'generated' | 'custom';
  /** `publicBaseUrl` + `/` + slug. */
  shortUrl: string;
  /** `composeUrl` of the parts — what the redirect sends people to. */
  destination: string;
  title?: string;
  notes?: string;
  tags: string[];
  redirect: LinkRedirectOverrides;
  expiresAt?: Date;
  /** Expire after this many HUMAN clicks. */
  maxClicks?: number;
  /** Where an expired link sends people. Overrides `redirect.onExpired`. Non-http(s) → `validation`. */
  expiredUrl?: string;
  social?: SocialCard;
  /** Last scrape, cached for list thumbnails. */
  og?: OgData & { fetchedAt: Date };
  /** Destination revision. Starts at 1; bumps only when `destination` changes. */
  rev: number;
  /** Human clicks. */
  clicks: number;
  /** Human clicks that were first-in-window for their visitor. */
  uniqueClicks: number;
  /** Bot clicks — kept apart, never summed into `clicks`. */
  botClicks: number;
  lastClickedAt?: Date;
  archived: boolean;
  createdBy?: Actor;
  updatedBy?: Actor;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create input. Give the destination EITHER as `url` (parsed with `parseUrl`)
 * OR as `baseUrl` + `utm` + `params` + `hash`. Both → `ambiguous_destination`;
 * neither → `invalid_url`.
 */
export interface LinkInput {
  url?: string;
  baseUrl?: string;
  utm?: Utm;
  params?: Param[];
  hash?: string;
  /** Custom slug. Omitted → generated, `origin: 'generated'`. */
  slug?: string;
  title?: string;
  notes?: string;
  tags?: string[];
  redirect?: LinkRedirectOverrides;
  expiresAt?: Date | string;
  maxClicks?: number;
  expiredUrl?: string;
  social?: SocialCard;
}

/**
 * Update input. Every field optional; `null` clears an optional field.
 *
 * - `url` replaces baseUrl + utm + params + hash wholesale. With `url`, any of
 *   those four → `ambiguous_destination`.
 * - `utm` MERGES field-wise; a field set to `''` or `null` removes it.
 * - `params` REPLACES the array.
 * - `tags` REPLACES the array.
 * - `slug` renames per `slug.rename` (§7.3). A `slug` whose key equals the
 *   current key is NOT a rename (forms send whole objects) and never locks.
 * - `redirect` merges; a key set to `null` falls back to config.
 *
 * A revision is written only when the composed destination actually changes.
 */
export interface LinkPatch {
  url?: string;
  baseUrl?: string;
  utm?: { [K in UtmField]?: string | null };
  params?: Param[];
  hash?: string | null;
  slug?: string;
  title?: string | null;
  notes?: string | null;
  tags?: string[];
  redirect?: { status?: RedirectStatus | null; forwardQuery?: boolean | null };
  expiresAt?: Date | string | null;
  maxClicks?: number | null;
  expiredUrl?: string | null;
  social?: SocialCard | null;
}

/** Programmatic calls carry no request; pass the actor explicitly if there is one. */
export interface CallContext {
  actor?: Actor;
  req?: Request;
}

export interface LinksQuery {
  /** Text search over slug, title, notes, baseUrl, utm.campaign. */
  q?: string;
  tag?: string;
  /** `false` (default) hides archived; `true` shows only archived; `'all'` both. */
  archived?: boolean | 'all';
  sort?: 'newest' | 'clicks' | 'lastClicked';
  /** Opaque, from a previous page's `nextCursor`. */
  cursor?: string;
  /** Clamped to `listLimit`. */
  limit?: number;
}

export interface LinksPage {
  items: Link[];
  nextCursor: string | null;
  /** The cap actually applied. */
  limit: number;
}

export type HistoryEntry =
  | { kind: 'created'; at: Date; by?: Actor; rev: 1; destination: string; slug: string }
  | {
    kind: 'destination';
    at: Date;
    by?: Actor;
    rev: number;
    destination: string;
    previous: string;
  }
  | { kind: 'slug'; at: Date; by?: Actor; from: string; to: string; mode: RenameMode };

export interface DeleteSummary {
  clicks: number;
  history: number;
  /** Slug keys freed — current slug plus aliases. */
  keys: number;
}

export type SlugUnavailableReason = 'invalid' | 'too_long' | 'reserved' | 'taken';

export interface SlugCheck {
  /** Normalized display form of what was asked. */
  slug: string;
  available: boolean;
  reason?: SlugUnavailableReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clicks, stats, catalog
// ─────────────────────────────────────────────────────────────────────────────

export type Device = 'desktop' | 'mobile' | 'tablet' | 'other';

/**
 * One recorded hit. There is NO ip field — not raw, not truncated. `visitor` is
 * `HMAC-SHA256(pepper, day | ip | ua | linkId)` (§7.2): not linkable across
 * days or across links.
 */
export interface Click {
  id: string;
  linkId: string;
  rev: number;
  at: Date;
  visitor: string;
  /** First hit for this visitor within `uniqueWindowMinutes`, decided by `at` — never by TTL deletion. */
  unique: boolean;
  /** HEAD request, `isbot` user agent, or an EMPTY/absent user agent. */
  bot: boolean;
  /** Arrived with `?qr=1`. */
  qr: boolean;
  /** Hostname, leading `www.` stripped. Absent = direct. */
  referrerHost?: string;
  /** Origin + path of the referrer. Query and fragment are never stored. */
  referrer?: string;
  country?: string;
  region?: string;
  city?: string;
  browser?: string;
  os?: string;
  device: Device;
  /** KEYS of the incoming query only — values are never stored. */
  queryKeys?: string[];
}

export interface ClickEvent {
  link: Link;
  click: Click;
  req: Request;
}

export interface HumanCounts {
  clicks: number;
  uniques: number;
  qr: number;
}
export interface BotCounts {
  clicks: number;
  uniques: number;
}

/**
 * Date-only `from`/`to` are calendar days in `clicks.timezone`, BOTH inclusive
 * (03-01..03-15 → 15 day points). Weeks start Monday, labelled by bucket start.
 * Breakdown rows count clicks (not uniques), sorted by humans desc; `top` > 50
 * clamps to 50. `revision` is `[]` in the overview; `topLinks`/`topCampaigns`
 * are absent per-link. `breakdownsTruncated` ⇔ `from` < now − retentionDays.
 */
export interface StatsQuery {
  /** Omitted → across all links (the overview). */
  linkId?: string;
  from: Date | string;
  to: Date | string;
  /** Default `day`. */
  interval?: 'day' | 'week' | 'month';
  /** Breakdown rows per dimension. Default 10, max 50. */
  top?: number;
}

export interface StatsPoint {
  /** Bucket start, `YYYY-MM-DD` in `clicks.timezone`. */
  date: string;
  humans: HumanCounts;
  bots: BotCounts;
}

export interface Breakdown {
  /** `'(direct)'` for no referrer, `'(unknown)'` for no value. */
  key: string;
  humans: number;
  bots: number;
}

/**
 * Humans and bots are ALWAYS separate. Summing is a view decision (§8).
 * `series` reads daily rollups (kept forever); `breakdowns` read raw clicks,
 * which are TTL'd — `breakdownsTruncated` says when the range outruns retention.
 */
export interface Stats {
  range: { from: string; to: string; interval: 'day' | 'week' | 'month'; timezone: string };
  totals: { humans: HumanCounts; bots: BotCounts };
  series: StatsPoint[];
  breakdowns: {
    referrer: Breakdown[];
    country: Breakdown[];
    device: Breakdown[];
    browser: Breakdown[];
    os: Breakdown[];
    /** `'qr'` vs `'link'`. */
    source: Breakdown[];
    /** Per-link only: key is the rev number as a string. */
    revision: Breakdown[];
  };
  breakdownsTruncated: boolean;
  /** Overview only (no `linkId`). */
  topLinks?: Array<{ linkId: string; slug: string; humans: number; bots: number }>;
  /** Overview only. Keyed by `utm.campaign`. */
  topCampaigns?: Array<{ campaign: string; humans: number; bots: number }>;
}

export interface ParamValueStat {
  value: string;
  /** DISTINCT links using this key=value. */
  count: number;
  /** Latest `updatedAt` among the links using this value. */
  lastUsedAt: Date;
}

/**
 * The suggestion catalog (§7.4). Live — no cache. UTM fields appear under
 * their query keys (`utm_source`, …). Archived links count.
 */
export interface ParamKeyStat {
  key: string;
  /** DISTINCT links using this key at all — a link repeating the key counts once. */
  count: number;
  /** Most-used first, at most 50. */
  values: ParamValueStat[];
  /** More than 50 distinct values exist. */
  truncated: boolean;
}

export interface TagStat {
  tag: string;
  count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspect — OG preview + destination health (§7.6)
// ─────────────────────────────────────────────────────────────────────────────

export type InspectWarningCode =
  /** The destination's redirects lost query params — UTMs never reach analytics. */
  | 'query_dropped'
  /** Final status ≥ 400. */
  | 'not_ok'
  /** More than one hop; the fix offers the final URL. */
  | 'redirects'
  /** The destination sends `noindex`. */
  | 'noindex_destination'
  /** A bot challenge page answered; OG data is unavailable, not broken. */
  | 'cloudflare_challenge'
  /** Some UTMs set, but not all of source + medium + campaign. */
  | 'utm_incomplete'
  /** The host (or a redirect hop) resolves to a non-public address; not fetched. */
  | 'private_address'
  /** Timeout, DNS failure, refused connection, too many redirects. */
  | 'unreachable';

export interface InspectWarning {
  code: InspectWarningCode;
  /** One plain sentence for the UI. */
  message: string;
  fix?: { kind: 'use_final_url'; url: string };
}

/**
 * Never throws for network reasons — those are warnings. Throws only for input
 * that isn't a URL (`invalid_url`, `unsupported_scheme`).
 */
export interface InspectResult {
  url: string;
  og: OgData;
  /** Absent when nothing was fetched. */
  final?: { url: string; status: number; ms: number };
  /** Every hop including the last. */
  chain: Array<{ url: string; status: number }>;
  warnings: InspectWarning[];
  /** `data:` URL, only when a `screenshot` adapter is configured and returned one. */
  screenshot?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slug grammar (custom and generated): after NFKD accent stripping and trimming
 * leading/trailing `/`, one or more segments of `[A-Za-z0-9_-]+` joined by a
 * single `/`; at most 190 characters (`slug_too_long` beyond, `slug_invalid`
 * for anything else — dots, spaces, `?`, `#`, `//`, empty).
 */
export interface SlugConfig {
  /** Generated slug length. Default 7. */
  length?: number;
  /** Generated slug alphabet. Default `'23456789abcdefghjkmnpqrstuvwxyz'`. */
  alphabet?: string;
  /** Overrides length/alphabet. Output is still validated and collision-checked. */
  generate?: () => string;
  /**
   * EXTENDS the builtin reserved list (anything starting with `_`), never
   * replaces it. Strings match a whole normalized slug; RegExps are tested
   * against it.
   */
  reserved?: Array<string | RegExp>;
  /**
   * Default false: `/Spring` and `/spring` are one link. Flipping it once links
   * exist re-keys them in `ready()`; a flip that would merge two links throws
   * there, naming both.
   */
  caseSensitive?: boolean;
  /** Default `'alias'`. */
  rename?: RenameMode;
}

export interface RedirectConfig {
  /** Default 302. Per-link override wins. */
  status?: RedirectStatus;
  /**
   * Default true. Incoming params are appended before `#hash`; an incoming key
   * replaces EVERY occurrence of that key in the destination; repeated incoming
   * keys all forward; `qr` is stripped. No dangling `?` when nothing remains.
   */
  forwardQuery?: boolean;
  /** Default true → `X-Robots-Tag: noindex` on every redirect. */
  noindex?: boolean;
  /**
   * Unknown slug. Default `'next'` — fall through to the host's next route,
   * which is what makes any mount position and route order safe. `'notFound'`
   * answers 404; a string is an absolute URL to 302 to.
   */
  onMiss?: 'next' | 'notFound' | string;
  /**
   * Expired link without its own `expiredUrl`. Default `'page'` — 410 with a
   * minimal HTML page. `'notFound'` answers 404; a string is a URL to 302 to.
   */
  onExpired?: 'page' | 'notFound' | string;
}

export interface DestinationConfig {
  /** Unset = any http(s) host. Strings match the hostname exactly; RegExps test it. */
  allowedHosts?: Array<string | RegExp>;
  blockedHosts?: Array<string | RegExp>;
}

export interface GeoResult {
  country?: string;
  region?: string;
  city?: string;
}

export interface ClickConfig {
  /** Raw click TTL. Default 395 (13 months). Daily rollups are kept forever. */
  retentionDays?: number;
  /** Unique-visitor window. Default 60. */
  uniqueWindowMinutes?: number;
  /** IANA zone for rollup days. Default `'UTC'`. */
  timezone?: string;
  /**
   * Default reads `cf-ipcountry`, `x-vercel-ip-country`,
   * `cloudfront-viewer-country` (country only). No GeoIP database ships.
   */
  geo?: (req: Request) => GeoResult | null | undefined;
  /** Default `req.ip` — the host owns `trust proxy`. */
  ip?: (req: Request) => string | undefined;
}

export interface InspectConfig {
  /** Whole-inspect budget. Default 5000. */
  timeoutMs?: number;
  /** Body bytes read. Default 2_000_000; reading also stops at `</head>`. */
  maxBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** DNS. Default `dns.promises.lookup(host, { all: true })`. Every address is checked. */
  lookup?: (hostname: string) => Promise<string[]>;
  /**
   * Default rejects loopback, private, link-local (incl. 169.254.169.254),
   * CGNAT, multicast, unspecified and reserved ranges, v4 and v6. Override for
   * an intranet deployment that previews internal destinations.
   */
  isAllowedAddress?: (ip: string) => boolean;
  /** Default `'shorty-inspect/<version> (+link preview)'`. */
  userAgent?: string;
}

export type ScreenshotAdapter = (url: string) => Promise<{ contentType: string; body: Buffer } | null>;

/** Structurally a `@jeffjassky/telemetry` client's `track`. No-op by default. */
export type TrackFn = (
  name: string,
  opts?: {
    attrs?: Record<string, string | number | boolean>;
    data?: Record<string, unknown>;
    subjects?: Array<{ type: string; id: string; role?: string }>;
  },
) => void;

export interface UiOptions {
  /** Where the host mounts `ui()`, as the BROWSER sees it. Default `/shorty`. */
  mountPath?: string;
  /** Where the host mounts `routes`, as the browser sees it. Default `/api/shorty`. */
  apiBase?: string;
  /** Default `'Links'`. */
  title?: string;
  /** Override the built SPA directory. */
  spaDir?: string;
  /** Where to send someone whose session expires mid-page. Null = inline error. */
  loginUrl?: string | null;
  /** Default `'next'`. */
  returnParam?: string;
}

export interface CreateShortyConfig {
  connection: Mongoose | Connection;
  /**
   * Where `redirect` is reachable, as the browser sees it — `https://acme.com/go`,
   * `https://go.acme.com`. Required; absolute http(s); a trailing slash is
   * trimmed. Shorty never infers it from a request.
   */
  publicBaseUrl: string;
  /** Default `'shorty_'`. */
  collectionPrefix?: string;
  /** Mongoose model-name prefix. Default `'Shorty'`. Set when two instances share a connection — traps #2. */
  modelPrefix?: string;
  /**
   * Visitor-hash secret. Falls back to `SHORTY_PEPPER`. Without one, click
   * recording is OFF (one warning, never a crash) — redirects still work.
   */
  pepper?: string;
  slug?: SlugConfig;
  redirect?: RedirectConfig;
  destinations?: DestinationConfig;
  /** `false` disables recording entirely. Default on (when a pepper exists). */
  clicks?: false | ClickConfig;
  inspect?: InspectConfig;
  resolveUser?: ResolveUser;
  screenshot?: ScreenshotAdapter;

  // Hooks — awaited, caught, logged, counted in `health().hookFailures`. None can
  // fail a write or a redirect.
  /** After the redirect response is sent. Bots included, flagged — a crawler served the social card is a bot click. */
  onClick?: (e: ClickEvent) => void | Promise<void>;
  onCreate?: (e: { link: Link; actor?: Actor; req?: Request }) => void | Promise<void>;
  onUpdate?: (e: { link: Link; prev: Link; history: HistoryEntry[]; actor?: Actor; req?: Request }) => void | Promise<void>;
  onArchive?: (e: { link: Link; archived: boolean; actor?: Actor; req?: Request }) => void | Promise<void>;
  onDelete?: (e: { link: Link; summary: DeleteSummary; actor?: Actor; req?: Request }) => void | Promise<void>;
  /**
   * An unknown slug was requested (Shlink's orphan visit). Fires for every
   * onMiss mode; `path` is relative to the mount (`req.path`). Paths that can't
   * be slugs (dots, reserved) are not misses — no lookup, no hook, no row.
   */
  onMiss?: (e: { path: string; req: Request }) => void | Promise<void>;
  /**
   * Events: `shorty.link_created`, `shorty.link_updated`, `shorty.link_archived`,
   * `shorty.link_unarchived`, `shorty.link_deleted`, `shorty.clicked`.
   * Each carries `subjects: [{ type: 'shorty_link', id }]`.
   */
  track?: TrackFn;

  logger?: Logger;
  /** Defaults merged into every `ui()` call. */
  ui?: UiOptions;
  /** Max rows per list page. Default 200 — traps #18. */
  listLimit?: number;
  /** Clock. For tests and replays; default `() => new Date()`. */
  now?: () => Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage documents — for hosts querying the collections directly
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkDoc extends Omit<Link, 'id' | 'shortUrl' | 'aliases'> {
  _id: Types.ObjectId;
  /** Normalized current slug under the active case mode. */
  slugKey: string;
  /** slugKey + every alias key. Redirect lookups read this. */
  keys: string[];
  aliases: Array<{ slug: string; at: Date }>;
}

/** `_id` is the slug key: the uniqueness authority across slugs AND aliases. */
export interface SlugDoc {
  _id: string;
  linkId: Types.ObjectId;
  current: boolean;
  at: Date;
}

export type HistoryDoc = HistoryEntry & { _id: Types.ObjectId; linkId: Types.ObjectId };

export interface ClickDoc extends Omit<Click, 'id' | 'linkId'> {
  _id: Types.ObjectId;
  linkId: Types.ObjectId;
}

export interface DailyDoc {
  _id: Types.ObjectId;
  linkId: Types.ObjectId;
  day: string;
  clicks: number;
  uniques: number;
  qr: number;
  bots: number;
  botUniques: number;
}

export interface SeenDoc {
  _id: Types.ObjectId;
  linkId: Types.ObjectId;
  visitor: string;
  at: Date;
}

export interface MissDoc {
  _id: Types.ObjectId;
  path: string;
  at: Date;
  referrerHost?: string;
}

/** Singleton `_id: 'config'` — remembers the case mode keys were written under. */
export interface MetaDoc {
  _id: string;
  caseSensitive: boolean;
}

export interface ShortyModels {
  Link: Model<LinkDoc>;
  Slug: Model<SlugDoc>;
  History: Model<HistoryDoc>;
  Click: Model<ClickDoc>;
  Daily: Model<DailyDoc>;
  Seen: Model<SeenDoc>;
  Miss: Model<MissDoc>;
  Meta: Model<MetaDoc>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance
// ─────────────────────────────────────────────────────────────────────────────

export interface ShortyHealth {
  /** Click pipelines that failed after the redirect was sent. */
  clickFailures: number;
  /** Hooks AND `track` calls that threw or rejected. */
  hookFailures: number;
  misses: number;
  /** Click pipelines still running. */
  inFlight: number;
  /** False when no pepper was available or `clicks: false`. */
  clicksEnabled: boolean;
}

export interface ShortyInstance {
  /** PUBLIC. GET/HEAD only; anything that isn't a known slug → `onMiss` (default `next()`). */
  redirect: Router;
  /** ADMIN JSON API. The host guards it; shorty does not. Host supplies `express.json()`. */
  routes: Router;
  /** ADMIN SPA. Mount behind the same guard. */
  ui(opts?: UiOptions): Router;

  /**
   * Build indexes, reconcile the click TTL with `retentionDays`, re-key slugs if
   * `caseSensitive` changed. Idempotent. Await once at boot — traps #3.
   */
  ready(): Promise<void>;
  /** Resolves when every in-flight click AND miss pipeline has finished. For shutdown and tests. */
  drain(): Promise<void>;
  health(): ShortyHealth;

  createLink(input: LinkInput, ctx?: CallContext): Promise<Link>;
  /** Unknown id → `not_found`. Hooks receive only the history entries THIS update wrote. */
  updateLink(id: string, patch: LinkPatch, ctx?: CallContext): Promise<Link>;
  archiveLink(id: string, ctx?: CallContext): Promise<Link>;
  unarchiveLink(id: string, ctx?: CallContext): Promise<Link>;
  /**
   * Hard delete: link, history, clicks, rollups; frees every key. Unknown id →
   * `not_found`. Summary counts raw click rows, history entries, and keys.
   */
  deleteLink(id: string, ctx?: CallContext): Promise<DeleteSummary>;

  /** By id, current slug, or alias. Null when unknown or malformed — never throws. */
  link(idOrSlug: string): Promise<Link | null>;
  links(query?: LinksQuery): Promise<LinksPage>;
  history(id: string): Promise<HistoryEntry[]>;
  stats(query: StatsQuery): Promise<Stats>;
  paramValues(): Promise<ParamKeyStat[]>;
  tags(): Promise<TagStat[]>;
  /** `linkId` lets a link re-check its own current slug or alias as available. */
  checkSlug(slug: string, opts?: { linkId?: string }): Promise<SlugCheck>;
  /** A fresh, currently-unclaimed generated slug. Not reserved — a create may still race it. */
  generateSlug(): Promise<string>;
  inspect(url: string): Promise<InspectResult>;
  /** `publicBaseUrl/slug`. */
  shortUrl(linkOrSlug: Link | string): string;
  /** Rebuild `clicks` / `uniqueClicks` / `botClicks` from daily rollups. */
  recount(id: string): Promise<Link>;

  models: ShortyModels;
}

export declare function createShorty(config: CreateShortyConfig): ShortyInstance;
export default createShorty;

export declare function defaultResolveUser(req: Request): Actor | null;
export declare function defaultSpaDir(): string;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type ShortyErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'invalid_base_url'
  | 'invalid_param'
  | 'ambiguous_destination'
  | 'host_not_allowed'
  | 'host_blocked'
  /** The destination is `publicBaseUrl` itself or anything under `publicBaseUrl/`. */
  | 'destination_loop'
  | 'slug_invalid'
  | 'slug_too_long'
  | 'slug_reserved'
  | 'slug_taken'
  | 'slug_locked'
  | 'slug_generation_exhausted'
  | 'validation'
  | 'not_found'
  | 'range_too_large'
  /** `ready()` found slugs that would merge under the new case mode. */
  | 'case_collision';

/** Thrown by the programmatic API; the routes answer `{ error: code, ...details }` with `status`. */
export declare class ShortyError extends Error {
  constructor(code: ShortyErrorCode, status?: number, details?: Record<string, unknown>);
  code: ShortyErrorCode;
  status: number;
  details?: Record<string, unknown>;
}

/**
 * HTTP status per code — one table, used by the routes and the tests:
 * 400 for input errors, 404 `not_found`, 409 `slug_taken` / `slug_locked`,
 * 422 `host_not_allowed` / `host_blocked` / `destination_loop`,
 * 500 `case_collision` / `slug_generation_exhausted`.
 */
export declare const ERROR_STATUS: Readonly<Record<ShortyErrorCode, number>>;

// ─────────────────────────────────────────────────────────────────────────────
// Browser hand-off
// ─────────────────────────────────────────────────────────────────────────────

/** What `ui()` injects into the page. Server and SPA share this one declaration. */
export interface UiRuntimeConfig {
  apiBase: string;
  title: string;
  publicBaseUrl: string;
  loginUrl: string | null;
  returnParam: string;
  slug: { length: number; caseSensitive: boolean; rename: RenameMode };
  redirect: { status: RedirectStatus; forwardQuery: boolean };
  clicksEnabled: boolean;
  /** A screenshot adapter is configured — the Preview tab shows. */
  screenshot: boolean;
}

declare global {
  interface Window {
    __SHORTY__?: UiRuntimeConfig;
  }
}
