import express from 'express';
import type { Express, Request } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createShorty } from '../src/server/index.js';
import type { CreateShortyConfig, ShortyInstance } from '../types/index.js';

/**
 * Shared harness. Real Express, real Mongo, real HTTP — no mocks
 * (standards/testing.md).
 *
 * One model prefix + collection prefix per TEST FILE (each file gets its own
 * module instance of this helper), reused by every harness in that file and
 * wiped between harnesses. Building fresh collections per test meant a text-
 * index build per test — minutes per file, and timeouts under parallel load.
 * Isolation is kept: before wiping, the previous harness's in-flight click
 * pipelines are drained so a late write can't leak into the next test.
 * Files never share prefixes, so parallel files can't see each other (traps #2).
 */

let mongod: MongoMemoryServer | undefined;

export async function startDb(): Promise<void> {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'shorty-test' });
}

export async function stopDb(): Promise<void> {
  await mongoose.disconnect();
  await mongod?.stop();
}

export const HUMAN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
export const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

/** A controllable clock. `harness()` wires it into `now`. */
export interface Clock {
  now: Date;
  advance(ms: number): void;
  set(iso: string): void;
}

export function makeClock(iso = '2026-03-15T12:00:00.000Z'): Clock {
  const clock: Clock = {
    now: new Date(iso),
    advance(ms) { clock.now = new Date(clock.now.getTime() + ms); },
    set(next) { clock.now = new Date(next); },
  };
  return clock;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface HarnessOptions {
  /** Merged over the defaults below. `connection`/`publicBaseUrl` may be overridden. */
  config?: Partial<CreateShortyConfig>;
  /** Where `redirect` is mounted. Default `/go`. `/` mounts at the root. */
  mount?: string;
  /**
   * A host route at `GET /host-page` (and `GET /go/host-page` when mounted
   * under /go) answering `200 host`, registered before or after the redirect
   * router — proves shorty is route-order agnostic.
   */
  hostRoutes?: 'before' | 'after' | 'none';
  /** Skip `ready()` (for tests about ready itself). */
  skipReady?: boolean;
}

export interface Harness {
  app: Express;
  shorty: ShortyInstance;
  clock: Clock;
  /** The config actually passed to createShorty. */
  config: CreateShortyConfig;
  /** Same prefixes, for building a second instance over the same collections. */
  prefixes: { modelPrefix: string; collectionPrefix: string };
}

const FILE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const live: ShortyInstance[] = [];

/** Drain every earlier harness, then delete all documents in this file's collections. */
async function resetFileCollections(collectionPrefix: string): Promise<void> {
  await Promise.all(live.splice(0).map((s) => s.drain().catch(() => undefined)));
  const db = mongoose.connection.db;
  if (!db) return;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => n.startsWith(collectionPrefix));
  await Promise.all(names.map((n) => db.collection(n).deleteMany({})));
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const mount = opts.mount ?? '/go';
  const clock = makeClock();
  const prefixes = { modelPrefix: `T${FILE_ID}`, collectionPrefix: `t${FILE_ID}_` };
  await resetFileCollections(opts.config?.collectionPrefix ?? prefixes.collectionPrefix);

  const config: CreateShortyConfig = {
    connection: mongoose,
    publicBaseUrl: `http://short.test${mount === '/' ? '' : mount}`,
    pepper: 'test-pepper',
    ...prefixes,
    now: () => clock.now,
    ...opts.config,
  };

  const shorty = createShorty(config);
  live.push(shorty);
  if (!opts.skipReady) await shorty.ready();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  const hostRoute = () => {
    app.get('/host-page', (_req, res) => { res.status(200).type('text').send('host'); });
    if (mount !== '/') app.get(`${mount}/host-page`, (_req, res) => { res.status(200).type('text').send('host'); });
  };

  if (opts.hostRoutes === 'before') hostRoute();
  app.use('/api/shorty', shorty.routes);
  app.use('/shorty', shorty.ui({ mountPath: '/shorty', apiBase: '/api/shorty' }));
  app.use(mount, shorty.redirect);
  if (opts.hostRoutes === 'after') hostRoute();
  // What the host's own 404 looks like — distinguishable from shorty's.
  app.use((_req, res) => { res.status(404).type('text').send('host 404'); });

  return { app, shorty, clock, config, prefixes };
}

/**
 * A throwaway HTTP site for `inspect` tests. Handlers get raw node req/res so a
 * test can stream, stall, or redirect however it needs.
 */
export interface Site {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  port: number;
  /** Requests received, in order. */
  hits: string[];
  close(): Promise<void>;
}

export type SiteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export async function startSite(routes: Record<string, SiteHandler>): Promise<Site> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const path = (req.url ?? '/').split('?')[0];
    const handler = routes[path];
    if (!handler) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** HTML page with the given head contents. */
export function page(head: string, body = '<p>hi</p>'): SiteHandler {
  return (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
  };
}

export function redirectTo(location: string, status = 302): SiteHandler {
  return (_req, res) => {
    res.statusCode = status;
    res.setHeader('location', location);
    res.end();
  };
}

/** Inspect config that lets tests fetch from 127.0.0.1 but nothing else private. */
export const allowLoopback = (ip: string): boolean => ip === '127.0.0.1';
