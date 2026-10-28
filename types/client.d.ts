import type {
  DeleteSummary,
  HistoryEntry,
  InspectResult,
  Link,
  LinkInput,
  LinkPatch,
  LinksQuery,
  ParamKeyStat,
  SlugCheck,
  Stats,
  StatsQuery,
  TagStat,
} from './index.js';

/**
 * Typed fetch client for the admin JSON API (`shorty.routes`). The SPA uses it;
 * hosts may too.
 *
 * Route table — `routes` answers exactly these, JSON in and out. Errors are
 * `{ error: ShortyErrorCode, ...details }` with the status from `ERROR_STATUS`;
 * an unexpected failure is 500 `{ error: 'internal_error' }` (logged).
 *
 *   GET    /links                 ?q&tag&archived&sort&cursor&limit  → LinksPage
 *   POST   /links                 LinkInput                          → { link }      201
 *   GET    /links/:id                                                → { link }
 *   PATCH  /links/:id             LinkPatch                          → { link }
 *   POST   /links/:id/archive                                        → { link }
 *   POST   /links/:id/unarchive                                      → { link }
 *   DELETE /links/:id                                                → { deleted: DeleteSummary }
 *   GET    /links/:id/history                                        → { items: HistoryEntry[] }
 *   GET    /links/:id/stats       ?from&to&interval&top              → Stats
 *   GET    /stats                 ?from&to&interval&top              → Stats
 *   GET    /params                                                   → { items: ParamKeyStat[] }
 *   GET    /tags                                                     → { items: TagStat[] }
 *   GET    /slugs/check           ?slug&linkId                       → SlugCheck
 *   GET    /slugs/generate                                           → { slug }
 *   POST   /inspect               { url }                            → InspectResult
 *
 * `:id` is an ObjectId string; anything else is 404 `not_found`. Paths not in
 * this table fall through with `next()`. A missing body (host forgot
 * `express.json()`) is empty input — a 400, never a TypeError 500. Dates cross
 * the wire as ISO strings — hence `Json<T>`.
 */

/** Dates become ISO strings over JSON. */
export type Json<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Json<U>>
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;

export type LinkJson = Json<Link>;

/** Transport seam — swap in axios, a test double, anything. */
export type RequestFn = (method: string, url: string, body?: unknown) => Promise<any>;

/** What the default transport throws on a non-2xx. */
export interface ApiError extends Error {
  status: number;
  /** `{ error: code, ...details }` from the server, or whatever a proxy sent. */
  payload: unknown;
}

export interface ClientOptions {
  /** Where `routes` is mounted. Default `/api/shorty`. */
  baseUrl?: string;
  request?: RequestFn;
  /** Fires on 401 and 403 — both strand an already-rendered page. */
  onUnauthenticated?: ((err: unknown) => void) | null;
}

export interface ShortyClient {
  call: RequestFn;
  links(query?: LinksQuery): Promise<{ items: LinkJson[]; nextCursor: string | null; limit: number }>;
  createLink(input: Json<LinkInput>): Promise<LinkJson>;
  link(id: string): Promise<LinkJson>;
  updateLink(id: string, patch: Json<LinkPatch>): Promise<LinkJson>;
  archiveLink(id: string): Promise<LinkJson>;
  unarchiveLink(id: string): Promise<LinkJson>;
  deleteLink(id: string): Promise<DeleteSummary>;
  history(id: string): Promise<Array<Json<HistoryEntry>>>;
  /** With `linkId` → `/links/:id/stats`, without → `/stats`. */
  stats(query: Json<StatsQuery>): Promise<Json<Stats>>;
  paramValues(): Promise<Array<Json<ParamKeyStat>>>;
  tags(): Promise<TagStat[]>;
  checkSlug(slug: string, opts?: { linkId?: string }): Promise<SlugCheck>;
  generateSlug(): Promise<string>;
  inspect(url: string): Promise<InspectResult>;
}

export declare function createShortyClient(opts?: ClientOptions): ShortyClient;
