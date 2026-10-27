import express from 'express';
import type { Request, Router } from 'express';
import type { CallContext, LinkInput, LinkPatch, LinksQuery, ShortyInstance, StatsQuery } from '../../types/index.js';
import { ShortyError } from '../shared/errors.js';
import type { ResolvedContext } from './config.js';
import { wrap } from './errors.js';
import { OBJECT_ID } from './ids.js';

/**
 * The admin JSON API (`types/client.d.ts` is the route table). No body parser
 * lives here — the host owns `express.json()`, and a missing body is empty
 * input (traps #5). Every handler is wrapped so a failure is JSON (traps #6),
 * literal paths are declared before `/:id` (traps #4), and anything not in the
 * table falls through with `next()`.
 */

const bad = (field: string, why: string): ShortyError => new ShortyError('validation', undefined, { field, why });

/** A query-string value as a single string; repeats take the first. */
function one(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function num(value: unknown, field: string): number | undefined {
  const s = one(value);
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw bad(field, 'must be a number');
  return n;
}

/** The JSON body, or `{}` when the host mounted no parser. Non-objects are not bodies. */
function bodyOf(req: Request): Record<string, unknown> | undefined {
  const b: unknown = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
}

function linksQuery(q: Request['query']): LinksQuery {
  const out: LinksQuery = {};
  const text = one(q.q);
  if (text !== undefined) out.q = text;
  const tag = one(q.tag);
  if (tag !== undefined) out.tag = tag;
  const archived = one(q.archived);
  if (archived !== undefined && archived !== '') {
    if (archived === 'true') out.archived = true;
    else if (archived === 'false') out.archived = false;
    else if (archived === 'all') out.archived = 'all';
    else throw bad('archived', "must be 'true', 'false' or 'all'");
  }
  const sort = one(q.sort);
  if (sort !== undefined && sort !== '') out.sort = sort as LinksQuery['sort'];
  const cursor = one(q.cursor);
  if (cursor !== undefined && cursor !== '') out.cursor = cursor;
  const limit = num(q.limit, 'limit');
  if (limit !== undefined) out.limit = limit;
  return out;
}

function statsQuery(q: Request['query'], linkId?: string): StatsQuery {
  const from = one(q.from);
  const to = one(q.to);
  if (!from) throw bad('from', 'required');
  if (!to) throw bad('to', 'required');
  const out: StatsQuery = { from, to };
  if (linkId) out.linkId = linkId;
  const interval = one(q.interval);
  if (interval !== undefined && interval !== '') out.interval = interval as StatsQuery['interval'];
  const top = num(q.top, 'top');
  if (top !== undefined) out.top = top;
  return out;
}

export function createRoutes(ctx: ResolvedContext, shorty: ShortyInstance): Router {
  const router = express.Router();
  const h = (fn: Parameters<typeof wrap>[1]) => wrap(ctx.logger, fn);
  const call = (req: Request): CallContext => ({ req });
  /** `:id` is an ObjectId string or it is not a link at all. */
  const idOf = (req: Request): string => {
    const id = String(req.params.id);
    if (!OBJECT_ID.test(id)) throw new ShortyError('not_found', undefined, { id });
    return id;
  };

  // ── literal paths first ────────────────────────────────────────────────────

  router.get('/stats', h(async (req, res) => {
    res.json(await shorty.stats(statsQuery(req.query)));
  }));

  router.get('/params', h(async (_req, res) => {
    res.json({ items: await shorty.paramValues() });
  }));

  router.get('/tags', h(async (_req, res) => {
    res.json({ items: await shorty.tags() });
  }));

  router.get('/slugs/check', h(async (req, res) => {
    const slug = one(req.query.slug);
    if (slug === undefined || slug === '') throw bad('slug', 'required');
    const linkId = one(req.query.linkId);
    if (linkId !== undefined && linkId !== '' && !OBJECT_ID.test(linkId)) throw bad('linkId', 'not a link id');
    res.json(await shorty.checkSlug(slug, linkId ? { linkId } : undefined));
  }));

  router.get('/slugs/generate', h(async (_req, res) => {
    res.json({ slug: await shorty.generateSlug() });
  }));

  router.post('/inspect', h(async (req, res) => {
    const url = bodyOf(req)?.url;
    if (typeof url !== 'string') throw new ShortyError('invalid_url', undefined, { field: 'url' });
    res.json(await shorty.inspect(url));
  }));

  // ── links ──────────────────────────────────────────────────────────────────

  router.get('/links', h(async (req, res) => {
    res.json(await shorty.links(linksQuery(req.query)));
  }));

  router.post('/links', h(async (req, res) => {
    const link = await shorty.createLink((bodyOf(req) ?? {}) as unknown as LinkInput, call(req));
    res.status(201).json({ link });
  }));

  router.get('/links/:id/history', h(async (req, res) => {
    res.json({ items: await shorty.history(idOf(req)) });
  }));

  router.get('/links/:id/stats', h(async (req, res) => {
    res.json(await shorty.stats(statsQuery(req.query, idOf(req))));
  }));

  router.post('/links/:id/archive', h(async (req, res) => {
    res.json({ link: await shorty.archiveLink(idOf(req), call(req)) });
  }));

  router.post('/links/:id/unarchive', h(async (req, res) => {
    res.json({ link: await shorty.unarchiveLink(idOf(req), call(req)) });
  }));

  router.get('/links/:id', h(async (req, res) => {
    const link = await shorty.link(idOf(req));
    if (!link) throw new ShortyError('not_found', undefined, { id: String(req.params.id) });
    res.json({ link });
  }));

  router.patch('/links/:id', h(async (req, res) => {
    const id = idOf(req);
    const patch = bodyOf(req);
    if (!patch) throw bad('body', 'a JSON object is required');
    res.json({ link: await shorty.updateLink(id, patch as unknown as LinkPatch, call(req)) });
  }));

  router.delete('/links/:id', h(async (req, res) => {
    res.json({ deleted: await shorty.deleteLink(idOf(req), call(req)) });
  }));

  return router;
}
