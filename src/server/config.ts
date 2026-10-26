import type { Request } from 'express';
import dns from 'node:dns';
import type {
  Actor,
  CreateShortyConfig,
  GeoResult,
  Logger,
  RedirectStatus,
  RenameMode,
  ResolveUser,
  ShortyModels,
  UiOptions,
} from '../../types/index.js';
import { createModels } from './models.js';

/**
 * The single place raw host config becomes concrete values. No route or service
 * re-implements a default. Named `config.ts` on purpose — the machine's global
 * gitignore has a bare `config.js`; `check-tracked` guards it (traps #1).
 */

export const DEFAULT_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const DEFAULT_SLUG_LENGTH = 7;
export const MAX_SLUG_LENGTH = 190;
/** Builtin reserved slugs. `slug.reserved` extends this, never replaces it. */
export const BUILTIN_RESERVED: ReadonlyArray<string | RegExp> = [/^_/];

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface ResolvedContext {
  models: ShortyModels;
  publicBaseUrl: string;
  logger: Logger;
  now: () => Date;
  listLimit: number;
  resolveUser: ResolveUser;
  slug: {
    length: number;
    alphabet: string;
    generate: (() => string) | null;
    reserved: Array<string | RegExp>;
    caseSensitive: boolean;
    rename: RenameMode;
  };
  redirect: {
    status: RedirectStatus;
    forwardQuery: boolean;
    noindex: boolean;
    onMiss: 'next' | 'notFound' | string;
    onExpired: 'page' | 'notFound' | string;
  };
  destinations: { allowedHosts: Array<string | RegExp> | null; blockedHosts: Array<string | RegExp> };
  clicks: {
    enabled: boolean;
    pepper: string;
    retentionDays: number;
    uniqueWindowMinutes: number;
    timezone: string;
    geo: (req: Request) => GeoResult | null | undefined;
    ip: (req: Request) => string | undefined;
  };
  inspect: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    lookup: (hostname: string) => Promise<string[]>;
    isAllowedAddress: ((ip: string) => boolean) | null;
    userAgent: string;
  };
  screenshot: CreateShortyConfig['screenshot'] | null;
  hooks: Pick<CreateShortyConfig, 'onClick' | 'onCreate' | 'onUpdate' | 'onArchive' | 'onDelete' | 'onMiss'>;
  track: NonNullable<CreateShortyConfig['track']>;
  ui: UiOptions;
}

interface AuthedRequestish {
  authUserId?: unknown;
  user?: { _id?: unknown; id?: unknown; name?: string; displayName?: string; email?: string };
}

/**
 * Reads the conventional spots upstream auth middleware leaves things:
 * `req.authUserId`, `req.user._id` / `req.user.id`, and a display name from
 * `name`, `displayName` or `email`. Pure read — never verifies anything.
 */
export function defaultResolveUser(req: Request): Actor | null {
  const { authUserId, user } = req as Request & AuthedRequestish;
  const id = authUserId ?? user?._id ?? user?.id;
  if (id === undefined || id === null || id === '') return null;
  const name = user?.name ?? user?.displayName ?? user?.email;
  return { id: String(id), ...(name ? { name } : {}) };
}

/** Country from the common CDN headers. Region/city need the host's own geo. */
export function defaultGeo(req: Request): GeoResult | null {
  for (const header of ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country']) {
    const value = req.headers[header];
    const country = Array.isArray(value) ? value[0] : value;
    // Cloudflare sends XX for unknown and T1 for Tor.
    if (country && /^[A-Za-z]{2}$/.test(country) && country.toUpperCase() !== 'XX') {
      return { country: country.toUpperCase() };
    }
  }
  return null;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function fail(message: string): never {
  throw new TypeError(`shorty: ${message}`);
}

const REDIRECT_STATUSES: readonly number[] = [301, 302, 307, 308];
const RENAME_MODES: readonly RenameMode[] = ['alias', 'untilClicked', 'always', 'never'];

export function resolveConfig(config: CreateShortyConfig): ResolvedContext {
  if (!config || typeof config !== 'object') fail('createShorty(config) needs a config object');
  const {
    connection,
    publicBaseUrl,
    collectionPrefix = 'shorty_',
    modelPrefix = 'Shorty',
    logger = NOOP_LOGGER,
    listLimit = 200,
    now = () => new Date(),
    resolveUser = defaultResolveUser,
    track = () => {},
  } = config;

  if (!connection) fail('`connection` is required (a mongoose Connection or the mongoose module)');

  if (typeof publicBaseUrl !== 'string' || !publicBaseUrl) {
    fail('`publicBaseUrl` is required — where `redirect` is reachable, e.g. https://acme.com/go');
  }
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    fail(`\`publicBaseUrl\` must be an absolute URL, got ${JSON.stringify(publicBaseUrl)}`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') fail('`publicBaseUrl` must be http(s)');
  if (base.search || base.hash) fail('`publicBaseUrl` must not carry a query or fragment');

  if (typeof resolveUser !== 'function') fail('`resolveUser` must be a function');
  if (typeof track !== 'function') fail('`track` must be a function');

  const slug = config.slug ?? {};
  const length = slug.length ?? DEFAULT_SLUG_LENGTH;
  const alphabet = slug.alphabet ?? DEFAULT_ALPHABET;
  if (!Number.isInteger(length) || length < 3 || length > MAX_SLUG_LENGTH) fail('`slug.length` must be an integer 3–190');
  if (new Set(alphabet).size < 2) fail('`slug.alphabet` needs at least two distinct characters');
  const rename = slug.rename ?? 'alias';
  if (!RENAME_MODES.includes(rename)) fail(`\`slug.rename\` must be one of ${RENAME_MODES.join(', ')}`);

  const redirect = config.redirect ?? {};
  const status = redirect.status ?? 302;
  if (!REDIRECT_STATUSES.includes(status)) fail('`redirect.status` must be 301, 302, 307 or 308');

  // Clicks: on by default, but only with a pepper. A missing pepper is a
  // warning and a disabled feature — never a crash on boot (§12).
  const pepper = config.pepper ?? process.env.SHORTY_PEPPER ?? '';
  const clickCfg = config.clicks === false ? null : (config.clicks ?? {});
  let enabled = clickCfg !== null;
  if (enabled && !pepper) {
    logger.warn?.('shorty: no `pepper` (or SHORTY_PEPPER) — click recording is OFF; redirects still work');
    enabled = false;
  }
  const retentionDays = clickCfg?.retentionDays ?? 395;
  const uniqueWindowMinutes = clickCfg?.uniqueWindowMinutes ?? 60;
  const timezone = clickCfg?.timezone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    fail(`\`clicks.timezone\` is not an IANA zone: ${JSON.stringify(timezone)}`);
  }
  if (!(retentionDays > 0)) fail('`clicks.retentionDays` must be positive');
  if (!(uniqueWindowMinutes > 0)) fail('`clicks.uniqueWindowMinutes` must be positive');

  const inspect = config.inspect ?? {};

  return {
    models: createModels({
      connection,
      modelPrefix,
      collectionPrefix,
      clickTtlSeconds: Math.round(retentionDays * 86400),
      seenTtlSeconds: Math.round(uniqueWindowMinutes * 60),
    }),
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    logger,
    now,
    listLimit,
    resolveUser,
    slug: {
      length,
      alphabet,
      generate: slug.generate ?? null,
      reserved: [...BUILTIN_RESERVED, ...(slug.reserved ?? [])],
      caseSensitive: slug.caseSensitive ?? false,
      rename,
    },
    redirect: {
      status,
      forwardQuery: redirect.forwardQuery ?? true,
      noindex: redirect.noindex ?? true,
      onMiss: redirect.onMiss ?? 'next',
      onExpired: redirect.onExpired ?? 'page',
    },
    destinations: {
      allowedHosts: config.destinations?.allowedHosts ?? null,
      blockedHosts: config.destinations?.blockedHosts ?? [],
    },
    clicks: {
      enabled,
      pepper,
      retentionDays,
      uniqueWindowMinutes,
      timezone,
      geo: clickCfg?.geo ?? defaultGeo,
      ip: clickCfg?.ip ?? ((req) => req.ip),
    },
    inspect: {
      timeoutMs: inspect.timeoutMs ?? 5000,
      maxBytes: inspect.maxBytes ?? 2_000_000,
      maxRedirects: inspect.maxRedirects ?? 5,
      lookup: inspect.lookup ?? defaultLookup,
      isAllowedAddress: inspect.isAllowedAddress ?? null,
      userAgent: inspect.userAgent ?? 'shorty-inspect/0 (+link preview)',
    },
    screenshot: config.screenshot ?? null,
    hooks: {
      onClick: config.onClick,
      onCreate: config.onCreate,
      onUpdate: config.onUpdate,
      onArchive: config.onArchive,
      onDelete: config.onDelete,
      onMiss: config.onMiss,
    },
    track,
    ui: config.ui ?? {},
  };
}
