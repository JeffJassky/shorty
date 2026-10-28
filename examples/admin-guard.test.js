/**
 * COPY THIS TEST INTO YOUR APP.
 *
 * Shorty never decides who may create, edit or delete links — the package
 * cannot know what "staff" means in your system. The middleware you wrap
 * `shorty.routes` and `shorty.ui()` in is the entire boundary, and a test in
 * your repo is the only thing that proves it is still there after someone
 * refactors your router file.
 *
 * Not run by this package's suite — it imports YOUR app. Plain JS so it pastes
 * into any repo; rename to `.ts` if yours is TypeScript.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js'; // ← your app, not ours

const API = '/admin/links/api';   // wherever you mounted shorty.routes
const UI = '/admin/links';        // wherever you mounted shorty.ui()

describe('the link-admin guard', () => {
  it('refuses a signed-in non-staff user the admin API', async () => {
    const res = await request(app).get(`${API}/links`).set('cookie', await sessionFor({ isAdmin: false }));
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get(`${API}/links`);
    expect([401, 403]).toContain(res.status);
  });

  it('refuses a non-staff user the admin UI before any HTML is served', async () => {
    const res = await request(app).get(`${UI}/`).set('cookie', await sessionFor({ isAdmin: false }));
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('__SHORTY__');
  });

  it('cannot create a link without staff rights', async () => {
    const res = await request(app)
      .post(`${API}/links`)
      .set('cookie', await sessionFor({ isAdmin: false }))
      .send({ url: 'https://example.com' });
    expect(res.status).toBe(403);
  });

  it('admits staff', async () => {
    const res = await request(app).get(`${API}/links`).set('cookie', await sessionFor({ isAdmin: true }));
    expect(res.status).toBe(200);
  });

  it('leaves the public redirect open — it is meant to be', async () => {
    // Create a link as staff first, then fetch it signed-out.
    // expect((await request(app).get('/go/<slug>')).status).toBe(302);
  });
});
