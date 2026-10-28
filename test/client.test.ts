import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createShortyClient } from '../src/client/index.js';
import type { ApiError, RequestFn } from '../types/client.js';

/**
 * createShortyClient (`@jeffjassky/shorty/client`, route table in
 * types/client.d.ts). The `request` seam is faked for routing/unwrapping; the
 * default fetch transport runs against a tiny real express app — not shorty.
 */

interface Call { method: string; url: string; body?: unknown }

function fake(respond: (c: Call) => unknown = () => ({})): { request: RequestFn; calls: Call[] } {
  const calls: Call[] = [];
  const request: RequestFn = async (method, url, body) => {
    const c = { method, url, body };
    calls.push(c);
    return respond(c);
  };
  return { request, calls };
}

describe('createShortyClient — routing', () => {
  it('does not default to any base but /api/shorty', async () => {
    const { request, calls } = fake(() => ({ items: [], nextCursor: null, limit: 200 }));
    await createShortyClient({ request }).links();
    expect(calls).toEqual([{ method: 'GET', url: '/api/shorty/links', body: undefined }]);
  });

  it('does not double the slash when baseUrl ends in one', async () => {
    const { request, calls } = fake(() => ({ items: [] }));
    await createShortyClient({ baseUrl: '/x/api/', request }).tags();
    expect(calls[0].url).toBe('/x/api/tags');
  });

  it('does not let an id break out of its path segment', async () => {
    const { request, calls } = fake(() => ({ link: {} }));
    await createShortyClient({ request }).link('a/b c?d');
    expect(calls[0].url).toBe('/api/shorty/links/a%2Fb%20c%3Fd');
  });

  it('does not send per-link stats to /stats, or overview stats to a link', async () => {
    const { request, calls } = fake(() => ({}));
    const c = createShortyClient({ request });
    await c.stats({ linkId: 'L1', from: '2026-03-01', to: '2026-03-15' });
    await c.stats({ from: '2026-03-01', to: '2026-03-15', interval: 'week' });
    expect(calls[0].url).toBe('/api/shorty/links/L1/stats?from=2026-03-01&to=2026-03-15');
    expect(calls[1].url).toBe('/api/shorty/stats?from=2026-03-01&to=2026-03-15&interval=week');
  });

  it('does not serialize empty values or Dates naively in the query', async () => {
    const { request, calls } = fake(() => ({}));
    const c = createShortyClient({ request });
    await c.links({ q: '', tag: undefined, archived: false, sort: 'clicks', cursor: null as unknown as string, limit: 5 });
    expect(calls[0].url).toBe('/api/shorty/links?archived=false&sort=clicks&limit=5');

    const from = new Date('2026-03-01T00:00:00.000Z');
    await c.stats({ from: from as unknown as string, to: '2026-03-02' });
    expect(calls[1].url).toBe(`/api/shorty/stats?from=${encodeURIComponent(from.toISOString())}&to=2026-03-02`);

    await c.links({});
    expect(calls[2].url).toBe('/api/shorty/links');
  });

  it('does not send checkSlug without slug and linkId in the query', async () => {
    const { request, calls } = fake(() => ({ slug: 'x', available: true }));
    await createShortyClient({ request }).checkSlug('spring/ig', { linkId: 'L1' });
    expect(calls[0].url).toBe('/api/shorty/slugs/check?slug=spring%2Fig&linkId=L1');
  });

  it('does not use the wrong verb, path or body for writes', async () => {
    const { request, calls } = fake(() => ({ link: {}, deleted: {} }));
    const c = createShortyClient({ request });
    await c.createLink({ url: 'https://acme.com/' });
    await c.updateLink('L1', { title: 'x' });
    await c.archiveLink('L1');
    await c.unarchiveLink('L1');
    await c.deleteLink('L1');
    await c.inspect('https://acme.com/');
    expect(calls).toEqual([
      { method: 'POST', url: '/api/shorty/links', body: { url: 'https://acme.com/' } },
      { method: 'PATCH', url: '/api/shorty/links/L1', body: { title: 'x' } },
      { method: 'POST', url: '/api/shorty/links/L1/archive', body: undefined },
      { method: 'POST', url: '/api/shorty/links/L1/unarchive', body: undefined },
      { method: 'DELETE', url: '/api/shorty/links/L1', body: undefined },
      { method: 'POST', url: '/api/shorty/inspect', body: { url: 'https://acme.com/' } },
    ]);
  });
});

describe('createShortyClient — unwrapping', () => {
  it('does not hand back the envelope instead of the payload', async () => {
    const LINK = { id: 'L1' };
    const { request } = fake(({ method, url }) => {
      if (url.endsWith('/history')) return { items: ['h'] };
      if (url.endsWith('/params')) return { items: ['p'] };
      if (url.endsWith('/tags')) return { items: [{ tag: 't', count: 1 }] };
      if (url.endsWith('/slugs/generate')) return { slug: 'abc2345' };
      if (method === 'DELETE') return { deleted: { clicks: 1, history: 2, keys: 3 } };
      if (url.endsWith('/links') && method === 'GET') return { items: [LINK], nextCursor: 'c', limit: 50 };
      if (url.endsWith('/inspect')) return { url: 'u', og: {}, chain: [], warnings: [] };
      return { link: LINK };
    });
    const c = createShortyClient({ request });
    expect(await c.createLink({ url: 'https://acme.com/' })).toEqual(LINK);
    expect(await c.link('L1')).toEqual(LINK);
    expect(await c.updateLink('L1', {})).toEqual(LINK);
    expect(await c.archiveLink('L1')).toEqual(LINK);
    expect(await c.unarchiveLink('L1')).toEqual(LINK);
    expect(await c.deleteLink('L1')).toEqual({ clicks: 1, history: 2, keys: 3 });
    expect(await c.history('L1')).toEqual(['h']);
    expect(await c.paramValues()).toEqual(['p']);
    expect(await c.tags()).toEqual([{ tag: 't', count: 1 }]);
    expect(await c.generateSlug()).toBe('abc2345');
    // Pages and inspect results are returned whole.
    expect(await c.links()).toEqual({ items: [LINK], nextCursor: 'c', limit: 50 });
    expect(await c.inspect('https://acme.com/')).toEqual({ url: 'u', og: {}, chain: [], warnings: [] });
  });
});

describe('createShortyClient — onUnauthenticated', () => {
  function failing(status?: number): RequestFn {
    return async () => {
      throw Object.assign(new Error('nope'), status === undefined ? {} : { status });
    };
  }

  it.each([401, 403])('does not swallow a %s — it notifies and still rethrows', async (status) => {
    const onUnauthenticated = vi.fn();
    const c = createShortyClient({ request: failing(status), onUnauthenticated });
    const err = await c.tags().then(() => null, (e: unknown) => e);
    expect((err as ApiError).status).toBe(status);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated).toHaveBeenCalledWith(err);
  });

  it.each([400, 404, 409, 500, undefined])('does not treat status %s as unauthenticated', async (status) => {
    const onUnauthenticated = vi.fn();
    const c = createShortyClient({ request: failing(status), onUnauthenticated });
    await expect(c.tags()).rejects.toThrow('nope');
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });
});

describe('createShortyClient — default transport', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.get('/api/shorty/tags', (_req, res) => { res.json({ items: [{ tag: 'a', count: 1 }] }); });
    app.post('/api/shorty/links', (req, res) => {
      res.status(201).json({ link: { echoed: req.body, contentType: req.headers['content-type'] } });
    });
    app.get('/api/shorty/links/missing', (_req, res) => { res.status(404).json({ error: 'not_found' }); });
    app.get('/api/shorty/proxy-error', (_req, res) => { res.status(502).type('html').send('<h1>Bad gateway</h1>'); });
    app.post('/api/shorty/empty', (_req, res) => { res.status(204).end(); });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shorty`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not fail to parse a JSON response', async () => {
    expect(await createShortyClient({ baseUrl: base }).tags()).toEqual([{ tag: 'a', count: 1 }]);
  });

  it('does not send a body as anything but JSON', async () => {
    const link = await createShortyClient({ baseUrl: base }).createLink({ url: 'https://acme.com/', tags: ['x'] });
    expect(link).toMatchObject({ echoed: { url: 'https://acme.com/', tags: ['x'] } });
    expect((link as unknown as { contentType: string }).contentType).toMatch(/application\/json/);
  });

  it('does not throw a bare Error on non-2xx — ApiError carries status and JSON payload', async () => {
    const err = await createShortyClient({ baseUrl: base }).link('missing').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).payload).toEqual({ error: 'not_found' });
  });

  it('does not choke on a non-JSON error body — payload is null', async () => {
    const err = await createShortyClient({ baseUrl: base }).call('GET', '/proxy-error').then(() => null, (e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).payload).toBeNull();
  });

  it('does not try to parse a 204 — it resolves null', async () => {
    expect(await createShortyClient({ baseUrl: base }).call('POST', '/empty')).toBeNull();
  });
});
