import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import { ERROR_STATUS } from '../src/shared/errors.js';
import type { ShortyErrorCode } from '../types/index.js';
import type { LinkJson } from '../types/client.js';
import { harness, startDb, stopDb } from './helpers.js';
import type { Harness } from './helpers.js';

/**
 * The admin JSON API (`shorty.routes`), mounted by the harness at /api/shorty
 * behind the host's own express.json(). Route table: types/client.d.ts.
 */

const API = '/api/shorty';
const OBJECT_ID = /^[0-9a-f]{24}$/;
const UNKNOWN_ID = '0123456789abcdef01234567';

beforeAll(startDb);
afterAll(stopDb);

async function create(h: Harness, body: Record<string, unknown>): Promise<LinkJson> {
  const res = await request(h.app).post(`${API}/links`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.link as LinkJson;
}

function expectError(res: request.Response, code: ShortyErrorCode) {
  expect(res.status, JSON.stringify(res.body)).toBe(ERROR_STATUS[code]);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body.error).toBe(code);
}

function expectStatsShape(body: Record<string, unknown>) {
  expect(body).toMatchObject({
    range: expect.objectContaining({ from: expect.any(String), to: expect.any(String), interval: 'day' }),
    totals: { humans: expect.any(Object), bots: expect.any(Object) },
    series: expect.any(Array),
    breakdowns: expect.objectContaining({ referrer: expect.any(Array), source: expect.any(Array) }),
    breakdownsTruncated: expect.any(Boolean),
  });
}

/** No storage internals ever cross the wire. */
function expectPublicLink(link: Record<string, unknown>, h: Harness) {
  for (const key of ['_id', '__v', 'slugKey', 'keys']) expect(link, key).not.toHaveProperty(key);
  expect(link.id).toMatch(OBJECT_ID);
  expect(link.shortUrl).toBe(`http://short.test/go/${String(link.slug)}`);
  expect(link.shortUrl).toBe(h.shorty.shortUrl(String(link.slug)));
  expect(Array.isArray(link.aliases)).toBe(true);
  for (const a of link.aliases as unknown[]) expect(typeof a).toBe('string');
}

describe('routes — every documented route answers its shape', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('POST /links → 201 { link }', async () => {
    const res = await request(h.app).post(`${API}/links`)
      .send({ url: 'https://example.com/sale?utm_source=ig&ref=x', slug: 'spring', tags: ['promo'] });
    expect(res.status).toBe(201);
    expect(res.body.link).toMatchObject({
      slug: 'spring',
      origin: 'custom',
      baseUrl: 'https://example.com/sale',
      utm: { source: 'ig' },
      params: [{ key: 'ref', value: 'x' }],
      destination: 'https://example.com/sale?utm_source=ig&ref=x',
      tags: ['promo'],
      rev: 1,
      clicks: 0,
      uniqueClicks: 0,
      botClicks: 0,
      archived: false,
    });
    expectPublicLink(res.body.link, h);
    expect(new Date(res.body.link.createdAt).toISOString()).toBe(res.body.link.createdAt);
  });

  it('GET /links → LinksPage', async () => {
    const link = await create(h, { url: 'https://example.com/a' });
    const res = await request(h.app).get(`${API}/links`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nextCursor: null, limit: expect.any(Number) });
    expect(res.body.items.map((l: LinkJson) => l.id)).toEqual([link.id]);
    expectPublicLink(res.body.items[0], h);
  });

  it('GET /links/:id → { link }', async () => {
    const link = await create(h, { url: 'https://example.com/a', slug: 'abc' });
    const res = await request(h.app).get(`${API}/links/${link.id}`);
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ id: link.id, slug: 'abc' });
    expectPublicLink(res.body.link, h);
  });

  it('PATCH /links/:id → { link }', async () => {
    const link = await create(h, { url: 'https://example.com/a' });
    const res = await request(h.app).patch(`${API}/links/${link.id}`).send({ title: 'Renamed', utm: { campaign: 'c1' } });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ id: link.id, title: 'Renamed', utm: { campaign: 'c1' }, rev: 2 });
    expectPublicLink(res.body.link, h);
  });

  it('POST /links/:id/archive and /unarchive → { link }', async () => {
    const link = await create(h, { url: 'https://example.com/a' });
    const a = await request(h.app).post(`${API}/links/${link.id}/archive`);
    expect(a.status).toBe(200);
    expect(a.body.link).toMatchObject({ id: link.id, archived: true });
    const u = await request(h.app).post(`${API}/links/${link.id}/unarchive`);
    expect(u.status).toBe(200);
    expect(u.body.link).toMatchObject({ id: link.id, archived: false });
  });

  it('GET /links/:id/history → { items }', async () => {
    const link = await create(h, { url: 'https://example.com/a', slug: 'hist' });
    const res = await request(h.app).get(`${API}/links/${link.id}/history`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ kind: 'created', rev: 1, slug: 'hist', destination: 'https://example.com/a' });
  });

  it('DELETE /links/:id → { deleted: DeleteSummary }, then 404', async () => {
    const link = await create(h, { url: 'https://example.com/a', slug: 'gone' });
    const res = await request(h.app).delete(`${API}/links/${link.id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual({ clicks: 0, history: expect.any(Number), keys: 1 });
    expectError(await request(h.app).get(`${API}/links/${link.id}`), 'not_found');
  });

  it('GET /links/:id/stats → Stats', async () => {
    const link = await create(h, { url: 'https://example.com/a' });
    const res = await request(h.app).get(`${API}/links/${link.id}/stats`).query({ from: '2026-03-01', to: '2026-03-15' });
    expect(res.status).toBe(200);
    expectStatsShape(res.body);
    expect(res.body.series).toHaveLength(15);
  });

  it('GET /stats → Stats with the overview lists', async () => {
    await create(h, { url: 'https://example.com/a' });
    const res = await request(h.app).get(`${API}/stats`).query({ from: '2026-03-01', to: '2026-03-15', interval: 'day' });
    expect(res.status).toBe(200);
    expectStatsShape(res.body);
    expect(Array.isArray(res.body.topLinks)).toBe(true);
    expect(Array.isArray(res.body.topCampaigns)).toBe(true);
  });

  it('GET /params → { items: ParamKeyStat[] }', async () => {
    await create(h, { url: 'https://example.com/a?utm_source=ig&ref=x' });
    const res = await request(h.app).get(`${API}/params`);
    expect(res.status).toBe(200);
    const src = res.body.items.find((i: { key: string }) => i.key === 'utm_source');
    expect(src).toMatchObject({ key: 'utm_source', count: 1, truncated: false, values: [{ value: 'ig', count: 1 }] });
    expect(typeof src.values[0].lastUsedAt).toBe('string');
  });

  it('GET /tags → { items: TagStat[] }', async () => {
    await create(h, { url: 'https://example.com/a', tags: ['x', 'y'] });
    await create(h, { url: 'https://example.com/b', tags: ['x'] });
    const res = await request(h.app).get(`${API}/tags`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ tag: 'x', count: 2 }, { tag: 'y', count: 1 }]);
  });

  it('GET /slugs/check → SlugCheck', async () => {
    await create(h, { url: 'https://example.com/a', slug: 'taken' });
    const taken = await request(h.app).get(`${API}/slugs/check`).query({ slug: 'taken' });
    expect(taken.status).toBe(200);
    expect(taken.body).toEqual({ slug: 'taken', available: false, reason: 'taken' });
    const free = await request(h.app).get(`${API}/slugs/check`).query({ slug: 'free-one' });
    expect(free.body).toEqual({ slug: 'free-one', available: true });
  });

  it('GET /slugs/check?linkId lets a link re-check its own slug as available', async () => {
    const link = await create(h, { url: 'https://example.com/a', slug: 'mine' });
    const res = await request(h.app).get(`${API}/slugs/check`).query({ slug: 'mine', linkId: link.id });
    expect(res.body).toMatchObject({ slug: 'mine', available: true });
  });

  it('GET /slugs/generate → { slug }', async () => {
    const res = await request(h.app).get(`${API}/slugs/generate`);
    expect(res.status).toBe(200);
    expect(res.body.slug).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/);
  });

  it('POST /inspect → InspectResult (a refused address is a warning, not an error)', async () => {
    // Default address policy: 127.0.0.1 is refused before any connection, so
    // this exercises the route without touching the network.
    const res = await request(h.app).post(`${API}/inspect`).send({ url: 'http://127.0.0.1:9/' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: 'http://127.0.0.1:9/', og: {}, chain: [] });
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain('private_address');
  });
});

describe('routes — ShortyError → ERROR_STATUS[code] + { error: code }', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ config: { slug: { rename: 'never' }, destinations: { blockedHosts: ['evil.test'] } } });
  });

  it('answers 409 slug_taken for a duplicate custom slug', async () => {
    await create(h, { url: 'https://example.com/a', slug: 'dup' });
    expectError(await request(h.app).post(`${API}/links`).send({ url: 'https://example.com/b', slug: 'dup' }), 'slug_taken');
  });

  it('answers 409 slug_locked for a rename under rename: never', async () => {
    const link = await create(h, { url: 'https://example.com/a', slug: 'fixed' });
    expectError(await request(h.app).patch(`${API}/links/${link.id}`).send({ slug: 'moved' }), 'slug_locked');
  });

  it('answers 400 invalid_url for a destination that is not a url', async () => {
    expectError(await request(h.app).post(`${API}/links`).send({ url: 'not a url' }), 'invalid_url');
  });

  it('answers 400 unsupported_scheme from /inspect for a non-http url', async () => {
    expectError(await request(h.app).post(`${API}/inspect`).send({ url: 'ftp://example.com/x' }), 'unsupported_scheme');
  });

  it('answers 422 host_blocked for a blocked destination host', async () => {
    expectError(await request(h.app).post(`${API}/links`).send({ url: 'https://evil.test/x' }), 'host_blocked');
  });

  it('answers 400 range_too_large for a stats range over 400 days', async () => {
    expectError(await request(h.app).get(`${API}/stats`).query({ from: '2024-01-01', to: '2026-03-15' }), 'range_too_large');
  });

  it('answers 404 not_found for an unknown id on every :id route', async () => {
    const id = UNKNOWN_ID;
    expectError(await request(h.app).get(`${API}/links/${id}`), 'not_found');
    expectError(await request(h.app).patch(`${API}/links/${id}`).send({ title: 'x' }), 'not_found');
    expectError(await request(h.app).post(`${API}/links/${id}/archive`), 'not_found');
    expectError(await request(h.app).post(`${API}/links/${id}/unarchive`), 'not_found');
    expectError(await request(h.app).delete(`${API}/links/${id}`), 'not_found');
    expectError(await request(h.app).get(`${API}/links/${id}/history`), 'not_found');
  });

  it('answers 404 not_found (not 500 CastError) for a malformed id', async () => {
    for (const id of ['nope', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      expectError(await request(h.app).get(`${API}/links/${id}`), 'not_found');
      expectError(await request(h.app).patch(`${API}/links/${id}`).send({ title: 'x' }), 'not_found');
      expectError(await request(h.app).delete(`${API}/links/${id}`), 'not_found');
      expectError(await request(h.app).get(`${API}/links/${id}/history`), 'not_found');
    }
  });
});

describe('routes — literal paths are not shadowed (traps #4)', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('does not swallow /slugs/check with a parameter route', async () => {
    const res = await request(h.app).get(`${API}/slugs/check`).query({ slug: 'abc' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'abc', available: true });
  });

  it('does not swallow /slugs/generate with a parameter route', async () => {
    const res = await request(h.app).get(`${API}/slugs/generate`);
    expect(res.status).toBe(200);
    expect(typeof res.body.slug).toBe('string');
  });

  it('does not swallow /params with a parameter route', async () => {
    const res = await request(h.app).get(`${API}/params`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('does not swallow /tags with a parameter route', async () => {
    const res = await request(h.app).get(`${API}/tags`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('does not swallow /stats with a parameter route', async () => {
    const res = await request(h.app).get(`${API}/stats`).query({ from: '2026-03-01', to: '2026-03-02' });
    expect(res.status).toBe(200);
    expectStatsShape(res.body);
  });

  it('does not swallow POST /inspect with a parameter route', async () => {
    const res = await request(h.app).post(`${API}/inspect`).send({ url: 'http://10.0.0.1/' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });

  it('does not route /links/:id/history or /links/:id/stats to the bare /links/:id handler', async () => {
    const link = await create(h, { url: 'https://example.com/a' });
    const hist = await request(h.app).get(`${API}/links/${link.id}/history`);
    expect(hist.body).toHaveProperty('items');
    expect(hist.body).not.toHaveProperty('link');
    const stats = await request(h.app).get(`${API}/links/${link.id}/stats`).query({ from: '2026-03-01', to: '2026-03-02' });
    expect(stats.body).toHaveProperty('series');
    expect(stats.body).not.toHaveProperty('link');
  });
});

describe('routes — unexpected failures answer JSON, not HTML (traps #6)', () => {
  it('answers 500 { error: internal_error } as JSON when resolveUser throws', async () => {
    const h = await harness({ config: { resolveUser: () => { throw new Error('session store down'); } } });
    const res = await request(h.app).post(`${API}/links`).send({ url: 'https://example.com/a' });
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(res.text).not.toMatch(/<html|<pre|session store down/i);
  });

  it('answers 500 { error: internal_error } as JSON when the links model throws', async () => {
    const h = await harness();
    await create(h, { url: 'https://example.com/a' });
    const model = h.shorty.models.Link as unknown as Record<string, unknown>;
    const methods = ['find', 'findOne', 'findById', 'aggregate', 'countDocuments', 'estimatedDocumentCount'];
    for (const m of methods) model[m] = () => { throw new Error('db down'); };
    try {
      const res = await request(h.app).get(`${API}/links`);
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ error: 'internal_error' });
      expect(res.text).not.toMatch(/db down/);
    } finally {
      for (const m of methods) delete model[m];
    }
  });
});

describe('routes — no body parser inside the router (traps #5)', () => {
  it('treats a JSON body as missing when the host mounted no express.json()', async () => {
    const h = await harness();
    const app = express();
    app.use('/api', h.shorty.routes);
    const res = await request(app).post('/api/links')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ url: 'https://example.com/a', slug: 'parsed' }));
    expectError(res, 'invalid_url');
    expect(await h.shorty.link('parsed')).toBeNull();
  });

  it('leaves body parsing of a host route registered after it untouched', async () => {
    // A router-level express.json() would consume and parse this body before
    // the host's own raw-text handler sees it. Assumes `routes` falls through
    // (next()) for paths it does not define, like any mounted router.
    const h = await harness();
    const app = express();
    app.use('/api', h.shorty.routes);
    app.post('/api/host-webhook', express.text({ type: '*/*' }), (req, res) => {
      res.json({ type: typeof req.body, body: req.body });
    });
    const raw = JSON.stringify({ a: 1 });
    const res = await request(app).post('/api/host-webhook').set('content-type', 'application/json').send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: 'string', body: raw });
  });
});

describe('routes — list caps and cursors', () => {
  it('clamps ?limit=100000 to listLimit (default 200) and reports the cap applied', async () => {
    const h = await harness();
    await create(h, { url: 'https://example.com/a' });
    const res = await request(h.app).get(`${API}/links`).query({ limit: 100000 });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
  });

  it('clamps to a configured listLimit and round-trips the cursor over HTTP', async () => {
    const h = await harness({ config: { listLimit: 2 } });
    const ids: string[] = [];
    for (const p of ['a', 'b', 'c']) {
      ids.push((await create(h, { url: `https://example.com/${p}` })).id);
      h.clock.advance(1000);
    }
    const first = await request(h.app).get(`${API}/links`).query({ limit: 100000 });
    expect(first.body.limit).toBe(2);
    expect(first.body.items).toHaveLength(2);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(h.app).get(`${API}/links`).query({ limit: 2, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const seen = [...first.body.items, ...second.body.items].map((l: LinkJson) => l.id);
    expect(seen).toEqual([...ids].reverse()); // newest first, no duplicates, none missing
  });
});

describe('routes — actor stamping', () => {
  it('stamps createdBy and updatedBy from resolveUser', async () => {
    const h = await harness();
    h.session.actor = { id: 'u_1', name: 'Ann Admin' };
    const link = await create(h, { url: 'https://example.com/a' });
    expect(link.createdBy).toEqual({ id: 'u_1', name: 'Ann Admin' });

    h.session.actor = { id: 'u_2', name: 'Bob' };
    const res = await request(h.app).patch(`${API}/links/${link.id}`).send({ title: 'T' });
    expect(res.body.link.updatedBy).toEqual({ id: 'u_2', name: 'Bob' });
    expect(res.body.link.createdBy).toEqual({ id: 'u_1', name: 'Ann Admin' });
  });

  it('does not 401 when resolveUser knows nobody — the host guards, not shorty', async () => {
    const h = await harness();
    h.session.actor = null;
    const res = await request(h.app).post(`${API}/links`).send({ url: 'https://example.com/a' });
    expect(res.status).toBe(201);
    expect(res.body.link.createdBy).toBeUndefined();
    const list = await request(h.app).get(`${API}/links`);
    expect(list.status).toBe(200);
  });
});

describe('routes — hooks receive req and actor (audit follow-up)', () => {
  it('passes req and the resolveUser actor to onCreate/onUpdate/onArchive/onDelete when called over HTTP', async () => {
    const seen: Record<string, { actor?: unknown; url?: string; extra?: unknown }> = {};
    const h = await harness({
      config: {
        onCreate: (e) => { seen.create = { actor: e.actor, url: e.req?.originalUrl }; },
        onUpdate: (e) => { seen.update = { actor: e.actor, url: e.req?.originalUrl, extra: e.prev.title }; },
        onArchive: (e) => { seen.archive = { actor: e.actor, url: e.req?.originalUrl, extra: e.archived }; },
        onDelete: (e) => { seen.delete = { actor: e.actor, url: e.req?.originalUrl, extra: e.summary.keys }; },
      },
    });
    h.session.actor = { id: 'u_9', name: 'Hook Tester' };
    const actor = { id: 'u_9', name: 'Hook Tester' };
    const link = await create(h, { url: 'https://example.com/a', title: 'before' });
    expect(seen.create).toEqual({ actor, url: `${API}/links` });

    await request(h.app).patch(`${API}/links/${link.id}`).send({ title: 'after' });
    expect(seen.update).toEqual({ actor, url: `${API}/links/${link.id}`, extra: 'before' });

    await request(h.app).post(`${API}/links/${link.id}/archive`);
    expect(seen.archive).toEqual({ actor, url: `${API}/links/${link.id}/archive`, extra: true });

    await request(h.app).delete(`${API}/links/${link.id}`);
    expect(seen.delete).toEqual({ actor, url: `${API}/links/${link.id}`, extra: 1 });
  });
});

describe('routes — malformed and unknown ids, more routes (audit follow-up)', () => {
  it('answers 404 not_found (not 500 CastError) for a malformed id on stats, archive and unarchive', async () => {
    const h = await harness();
    expectError(await request(h.app).get(`${API}/links/nope/stats`).query({ from: '2026-03-01', to: '2026-03-02' }), 'not_found');
    expectError(await request(h.app).post(`${API}/links/nope/archive`), 'not_found');
    expectError(await request(h.app).post(`${API}/links/nope/unarchive`), 'not_found');
  });

  it('answers 404 not_found for stats of an unknown (well-formed) link id', async () => {
    const h = await harness();
    expectError(await request(h.app).get(`${API}/links/${UNKNOWN_ID}/stats`).query({ from: '2026-03-01', to: '2026-03-02' }), 'not_found');
    const err = await h.shorty.stats({ linkId: UNKNOWN_ID, from: '2026-03-01', to: '2026-03-02' }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('not_found');
  });
});

describe('routes — list query coercion (audit follow-up)', () => {
  async function seeded() {
    const h = await harness();
    const live = await create(h, { url: 'https://example.com/live', title: 'Spring sale', tags: ['x'] });
    h.clock.advance(1000);
    const busy = await create(h, { url: 'https://example.com/busy', title: 'Busy one' });
    h.clock.advance(1000);
    const old = await create(h, { url: 'https://example.com/old', title: 'Old' });
    await request(h.app).post(`${API}/links/${old.id}/archive`);
    await h.shorty.models.Link.updateOne({ _id: busy.id }, { $set: { clicks: 50 } });
    await h.shorty.models.Link.updateOne({ _id: live.id }, { $set: { clicks: 5 } });
    return { h, live, busy, old };
  }
  const ids = (res: request.Response) => (res.body.items as LinkJson[]).map((l) => l.id);

  it('does not read ?archived=false as truthy', async () => {
    const { h, live, busy } = await seeded();
    const res = await request(h.app).get(`${API}/links`).query({ archived: 'false' });
    expect(ids(res).sort()).toEqual([live.id, busy.id].sort());
  });

  it('honours ?archived=true (only archived) and ?archived=all (both)', async () => {
    const { h, live, busy, old } = await seeded();
    expect(ids(await request(h.app).get(`${API}/links`).query({ archived: 'true' }))).toEqual([old.id]);
    expect(ids(await request(h.app).get(`${API}/links`).query({ archived: 'all' })).sort())
      .toEqual([live.id, busy.id, old.id].sort());
  });

  it('passes sort, tag and q through to the list', async () => {
    const { h, live, busy } = await seeded();
    expect(ids(await request(h.app).get(`${API}/links`).query({ sort: 'clicks' }))).toEqual([busy.id, live.id]);
    expect(ids(await request(h.app).get(`${API}/links`).query({ tag: 'x' }))).toEqual([live.id]);
    expect(ids(await request(h.app).get(`${API}/links`).query({ q: 'spring' }))).toEqual([live.id]);
  });
});

describe('routes — stats query coercion and missing input (audit follow-up)', () => {
  it('coerces ?top=3 and ?interval=week from strings', async () => {
    const h = await harness();
    const link = await create(h, { url: 'https://example.com/a' });
    await h.shorty.models.Click.insertMany(['a', 'b', 'c', 'd', 'e'].map((r, i) => ({
      linkId: new Types.ObjectId(link.id), rev: 1, at: h.clock.now, visitor: `v${i}`, unique: true, bot: false,
      qr: false, device: 'desktop' as const, referrerHost: `${r}.test`,
    })));
    const res = await request(h.app).get(`${API}/links/${link.id}/stats`)
      .query({ from: '2026-03-02', to: '2026-03-15', interval: 'week', top: '3' });
    expect(res.status).toBe(200);
    expect(res.body.range.interval).toBe('week');
    expect(res.body.series.map((p: { date: string }) => p.date)).toEqual(['2026-03-02', '2026-03-09']);
    expect(res.body.breakdowns.referrer).toHaveLength(3);
  });

  it('answers 400 (not 500) when from is missing', async () => {
    const h = await harness();
    const res = await request(h.app).get(`${API}/stats`).query({ to: '2026-03-15' });
    expectError(res, 'validation');
  });

  it('answers 400 (not 500) for POST /inspect with no body', async () => {
    const h = await harness();
    const res = await request(h.app).post(`${API}/inspect`);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe('string');
  });

  it('answers 400 (not 500) for PATCH /links/:id with no body', async () => {
    const h = await harness();
    const link = await create(h, { url: 'https://example.com/a' });
    const res = await request(h.app).patch(`${API}/links/${link.id}`);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe('string');
  });

  it('answers 400 (not 500) for GET /slugs/check without a slug', async () => {
    const h = await harness();
    const res = await request(h.app).get(`${API}/slugs/check`);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('routes — error body and fall-through (audit follow-up)', () => {
  it('answers an error body that is { error, ...details } — error always present, never a bare string', async () => {
    // No code is specified to carry particular details, so only the shape is pinned.
    const h = await harness();
    await create(h, { url: 'https://example.com/a', slug: 'dup' });
    const res = await request(h.app).post(`${API}/links`).send({ url: 'https://example.com/b', slug: 'dup' });
    expectError(res, 'slug_taken');
    expect(typeof res.body).toBe('object');
    expect(Object.keys(res.body)).toContain('error');
  });

  it('falls through to the host for a path it does not define (GET /nope)', async () => {
    const h = await harness();
    const res = await request(h.app).get(`${API}/nope`);
    expect(res.status).toBe(404);
    expect(res.text).toBe('host 404');
  });

  it('falls through to the host for an undefined method on a defined path (DELETE /params)', async () => {
    const h = await harness();
    const res = await request(h.app).delete(`${API}/params`);
    expect(res.status).toBe(404);
    expect(res.text).toBe('host 404');
  });
});
