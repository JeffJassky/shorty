/**
 * Compile-only exercise of the public declarations, from OUTSIDE — the way a
 * host consumes them. Never executed. Every exported symbol appears below
 * (traps #9); scripts/check-tracked.mjs does not check this, `tsc` does.
 */
import mongoose from 'mongoose';
import type { Request } from 'express';
import createShortyDefault, {
  composeUrl,
  createShorty,
  defaultResolveUser,
  defaultSpaDir,
  ERROR_STATUS,
  parseUrl,
  ShortyError,
} from './index.js';
import type {
  Actor,
  BotCounts,
  Breakdown,
  CallContext,
  Click,
  ClickConfig,
  ClickDoc,
  ClickEvent,
  CreateShortyConfig,
  DailyDoc,
  DeleteSummary,
  DestinationConfig,
  Device,
  GeoResult,
  HistoryDoc,
  HistoryEntry,
  HumanCounts,
  InspectConfig,
  InspectResult,
  InspectWarning,
  InspectWarningCode,
  Link,
  LinkDoc,
  LinkInput,
  LinkPatch,
  LinkRedirectOverrides,
  LinksPage,
  LinksQuery,
  Logger,
  MetaDoc,
  MissDoc,
  OgData,
  Param,
  ParamKeyStat,
  ParamValueStat,
  RedirectConfig,
  RedirectStatus,
  RenameMode,
  ResolveUser,
  ScreenshotAdapter,
  SeenDoc,
  ShortyErrorCode,
  ShortyHealth,
  ShortyInstance,
  ShortyModels,
  SlugCheck,
  SlugConfig,
  SlugDoc,
  SlugUnavailableReason,
  SocialCard,
  Stats,
  StatsPoint,
  StatsQuery,
  TagStat,
  TrackFn,
  UiOptions,
  UiRuntimeConfig,
  UrlParts,
  Utm,
  UtmField,
} from './index.js';
import { createShortyClient } from './client.js';
import type { ApiError, ClientOptions, Json, LinkJson, RequestFn, ShortyClient } from './client.js';

// ── Degenerate config: connection + publicBaseUrl is all it takes (§12) ──
const minimal: CreateShortyConfig = { connection: mongoose, publicBaseUrl: 'https://acme.com/go' };
const shorty: ShortyInstance = createShorty(minimal);
const viaDefault: ShortyInstance = createShortyDefault(minimal);

// @ts-expect-error publicBaseUrl is required
const missingBase: CreateShortyConfig = { connection: mongoose };

// ── Every config key ──
const slug: SlugConfig = {
  length: 8, alphabet: 'abc', generate: () => 'x', reserved: ['admin', /^api/],
  caseSensitive: true, rename: 'untilClicked',
};
const modes: RenameMode[] = ['alias', 'untilClicked', 'always', 'never'];
const redirect: RedirectConfig = {
  status: 307, forwardQuery: false, noindex: false, onMiss: 'https://acme.com', onExpired: 'notFound', lookupTimeoutMs: 1500,
};
// @ts-expect-error 303 is not a supported redirect status
const badStatus: RedirectStatus = 303;
const destinations: DestinationConfig = { allowedHosts: ['acme.com', /\.acme\.com$/], blockedHosts: [/evil/] };
const geo = (req: Request): GeoResult | null => ({ country: String(req.headers['x-country'] ?? '') });
const clicks: ClickConfig = { retentionDays: 30, uniqueWindowMinutes: 15, timezone: 'America/New_York', geo, ip: (req) => req.ip, maxInFlight: 500 };
const inspect: InspectConfig = {
  timeoutMs: 1000, maxBytes: 1024, maxRedirects: 2, lookup: async () => ['93.184.216.34'],
  isAllowedAddress: () => true, userAgent: 'x',
};
const screenshot: ScreenshotAdapter = async () => ({ contentType: 'image/png', body: Buffer.from('') });
const track: TrackFn = (name, opts) => void [name, opts?.attrs, opts?.subjects];
const logger: Logger = { warn: () => {} };
const resolveUser: ResolveUser = (req) => defaultResolveUser(req);
const full: CreateShortyConfig = {
  ...minimal,
  collectionPrefix: 'links_', modelPrefix: 'Links', pepper: 'secret',
  slug, redirect, destinations, clicks, inspect, screenshot, resolveUser, track, logger,
  ui: { title: 'Go' }, listLimit: 50, now: () => new Date(),
  onClick: (e: ClickEvent) => void [e.link.id, e.click.bot, e.req.path],
  onCreate: ({ link, actor, req }) => void [link, actor, req],
  onUpdate: ({ link, prev, history }) => void [link.rev, prev.rev, history.length],
  onArchive: ({ archived }) => void archived,
  onDelete: async ({ summary }) => void summary.keys,
  onMiss: ({ path, req }) => void [path, req],
};
const noClicks: CreateShortyConfig = { ...minimal, clicks: false };

// ── Routers + lifecycle ──
async function boot(s: ShortyInstance) {
  const { redirect: r, routes } = s;
  const ui = s.ui({ mountPath: '/admin/links', apiBase: '/admin/links/api', loginUrl: '/login', returnParam: 'next', spaDir: '/x' } satisfies UiOptions);
  await s.ready();
  await s.drain();
  const h: ShortyHealth = s.health();
  const n: number = h.clickFailures + h.hookFailures + h.misses + h.inFlight + h.dropped;
  const on: boolean = h.clicksEnabled;
  void [r, routes, ui, n, on];
}

// ── URL parts ──
const parts: UrlParts = parseUrl('https://acme.com/sale?utm_source=ig&ref=x#top');
const fields: UtmField[] = ['source', 'medium', 'campaign', 'term', 'content', 'id'];
const utm: Utm = parts.utm;
const p: Param = { key: 'ref', value: '' };
const back: string = composeUrl({ ...parts, params: [p] });

// ── Programmatic API ──
async function api(s: ShortyInstance, req: Request) {
  const ctx: CallContext = { actor: { id: 'u1', name: 'Ann' } satisfies Actor, req };
  const input: LinkInput = {
    url: 'https://acme.com', slug: 'spring', title: 't', notes: 'n', tags: ['a'],
    redirect: { status: 301, forwardQuery: false } satisfies LinkRedirectOverrides,
    expiresAt: new Date(), maxClicks: 10, expiredUrl: 'https://acme.com/over',
    social: { title: 'T', description: 'D', image: 'https://acme.com/i.png' } satisfies SocialCard,
  };
  const created: Link = await s.createLink(input, ctx);
  const patch: LinkPatch = {
    utm: { campaign: 'x', source: null }, params: [], hash: null, slug: 'fall', title: null,
    redirect: { status: null }, expiresAt: null, maxClicks: null, expiredUrl: null, social: null,
  };
  const updated: Link = await s.updateLink(created.id, patch, ctx);
  const archived: Link = await s.archiveLink(updated.id);
  const restored: Link = await s.unarchiveLink(updated.id);
  const deleted: DeleteSummary = await s.deleteLink(updated.id);

  const found: Link | null = await s.link('spring');
  const q: LinksQuery = { q: 'x', tag: 'a', archived: 'all', sort: 'lastClicked', cursor: 'c', limit: 10 };
  const page: LinksPage = await s.links(q);
  const next: string | null = page.nextCursor;
  const history: HistoryEntry[] = await s.history(created.id);
  for (const entry of history) {
    if (entry.kind === 'destination') void entry.previous;
    if (entry.kind === 'slug') void [entry.from, entry.to, entry.mode];
  }
  const sq: StatsQuery = { linkId: created.id, from: '2026-01-01', to: new Date(), interval: 'week', top: 5 };
  const stats: Stats = await s.stats(sq);
  const point: StatsPoint = stats.series[0];
  const humans: HumanCounts = point.humans;
  const bots: BotCounts = point.bots;
  const row: Breakdown = stats.breakdowns.referrer[0];
  const truncated: boolean = stats.breakdownsTruncated;
  const catalog: ParamKeyStat[] = await s.paramValues();
  const value: ParamValueStat = catalog[0].values[0];
  const tags: TagStat[] = await s.tags();
  const check: SlugCheck = await s.checkSlug('spring', { linkId: created.id });
  const reason: SlugUnavailableReason | undefined = check.reason;
  const fresh: string = await s.generateSlug();
  const result: InspectResult = await s.inspect('https://acme.com');
  const warning: InspectWarning = result.warnings[0];
  const code: InspectWarningCode = warning.code;
  const og: OgData = result.og;
  const short: string = s.shortUrl(created) + s.shortUrl('spring');
  const recounted: Link = await s.recount(created.id);
  void [updated, archived, restored, deleted, found, next, humans, bots, row, truncated, value, tags, reason, fresh, code, og, short, recounted];
}

// ── Storage docs + models ──
async function storage(models: ShortyModels) {
  const link: LinkDoc | null = await models.Link.findOne({ keys: 'spring' }).lean<LinkDoc>();
  const keys: string[] | undefined = link?.keys;
  const slugDoc: SlugDoc | null = await models.Slug.findById('spring').lean<SlugDoc>();
  const hist: HistoryDoc[] = await models.History.find().lean<HistoryDoc[]>();
  const click: ClickDoc | null = await models.Click.findOne().lean<ClickDoc>();
  const day: DailyDoc | null = await models.Daily.findOne().lean<DailyDoc>();
  const seen: SeenDoc | null = await models.Seen.findOne().lean<SeenDoc>();
  const miss: MissDoc | null = await models.Miss.findOne().lean<MissDoc>();
  const meta: MetaDoc | null = await models.Meta.findById('config').lean<MetaDoc>();
  void [keys, slugDoc, hist, click, day, seen, miss, meta];
}

// ── Click has no ip field, by contract ──
declare const c: Click;
const device: Device = c.device;
// @ts-expect-error clicks never carry an ip
void c.ip;

// ── Errors ──
const err = new ShortyError('slug_taken', 409, { slug: 'spring' });
const errCode: ShortyErrorCode = err.code;
const status: number = ERROR_STATUS.slug_locked + err.status;

// ── Runtime config + misc ──
declare const rc: UiRuntimeConfig;
const rename: RenameMode = rc.slug.rename;
const spa: string = defaultSpaDir();

// ── Client ──
const transport: RequestFn = async () => ({});
const copts: ClientOptions = { baseUrl: '/api/shorty', request: transport, onUnauthenticated: (e) => void e };
const client: ShortyClient = createShortyClient(copts);
async function useClient() {
  const page = await client.links({ archived: true });
  const link: LinkJson = page.items[0];
  const createdAt: string = link.createdAt;
  const made: LinkJson = await client.createLink({ url: 'https://acme.com', expiresAt: '2027-01-01' });
  const stats: Json<Stats> = await client.stats({ from: '2026-01-01', to: '2026-02-01' });
  const check: SlugCheck = await client.checkSlug('x');
  const s: string = await client.generateSlug();
  const i: InspectResult = await client.inspect('https://acme.com');
  const d: DeleteSummary = await client.deleteLink(made.id);
  void [createdAt, stats, check, s, i, d];
}
declare const apiErr: ApiError;
const apiStatus: number = apiErr.status;

void [viaDefault, missingBase, modes, badStatus, full, noClicks, boot, fields, utm, back, api, storage, device, errCode, status, rename, spa, useClient, apiStatus];
