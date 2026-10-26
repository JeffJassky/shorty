import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp, newUserId, startDb, stopDb } from './helpers.js';
import type { CreateShortyConfig } from '../types/index.js';

/**
 * The universal checklist from standards/testing.md, seeded. These pass on a
 * fresh scaffold — keep them passing, and add the package's own failures
 * alongside.
 *
 * Name each test after the FAILURE, not the feature. Six months from now
 * "does not shadow /me with the /:id route" tells a reader why reordering a
 * file broke CI; "handles /me" tells them nothing.
 */
describe('shorty', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('answers 401 to an unauthenticated caller instead of leaking a list', async () => {
    const { app } = await buildApp({ session: { user: null } });
    const res = await request(app).get('/api/shorty/');
    expect(res.status).toBe(401);
    expect(res.body.items).toBeUndefined();
  });

  it('does not shadow /me with the /:id route', async () => {
    const user = { id: newUserId(), email: 'a@b.c', displayName: 'A', isAdmin: false };
    const { app } = await buildApp({ session: { user } });
    const res = await request(app).get('/api/shorty/me');
    expect(res.status).toBe(200);
    // If /:id shadowed it, this would be a 404 from a failed id lookup.
    expect(res.body.user.email).toBe('a@b.c');
  });

  it('omits internal ids from the /me payload', async () => {
    const user = { id: newUserId(), email: 'a@b.c', displayName: 'A', isAdmin: false };
    const { app } = await buildApp({ session: { user } });
    const { body } = await request(app).get('/api/shorty/me');
    // Assert the field is absent, not that the UI hides it.
    expect(body.user.id).toBeUndefined();
    expect(body.user._id).toBeUndefined();
  });

  it('refuses a non-admin on the admin router — via the HOST guard, not ours', async () => {
    const user = { id: newUserId(), email: 'a@b.c', isAdmin: false };
    const { app } = await buildApp({ session: { user } });
    const res = await request(app).get('/api/shorty/admin/summary');
    expect(res.status).toBe(403);
  });

  it('caps a list read at listLimit even when the caller asks for more', async () => {
    const user = { id: newUserId(), email: 'a@b.c', isAdmin: false };
    const { app } = await buildApp({ session: { user } });
    const res = await request(app).get('/api/shorty/?limit=100000');
    expect(res.status).toBe(200);
    // Assert the cap. Do not assume it.
    expect(res.body.limit).toBeLessThanOrEqual(200);
  });

  it('answers JSON, not HTML, when a handler throws', async () => {
    // Cast, deliberately: this is a Model-shaped saboteur, not a Model. Typing
    // it fully would mean stubbing ~200 mongoose methods to prove that one of
    // them throwing still answers JSON.
    const exploding = {
      find: () => { throw new Error('boom'); },
      findById: () => { throw new Error('boom'); },
      estimatedDocumentCount: () => { throw new Error('boom'); },
      createIndexes: async () => {},
    } as unknown as CreateShortyConfig['model'];
    const user = { id: newUserId(), email: 'a@b.c', isAdmin: false };
    const { app } = await buildApp({ session: { user }, model: exploding });
    const res = await request(app).get('/api/shorty/');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toBe('internal_error');
  });

  it('rejects both `userAdapter` and `resolveUser` rather than silently picking one', async () => {
    await expect(
      buildApp({ userAdapter: { resolveUser: () => null }, resolveUser: () => null }),
    ).rejects.toThrow(/not both/);
  });

  it('purgeUser is idempotent — calling twice removes nothing the second time', async () => {
    const userId = newUserId();
    const { pkg } = await buildApp({ session: { user: { id: userId, email: 'a@b.c' } } });
    await pkg.model.create({ userId });
    expect((await pkg.purgeUser(userId)).removed).toBe(1);
    expect((await pkg.purgeUser(userId)).removed).toBe(0);
  });
});
