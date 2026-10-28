import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import os from 'node:os';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createShorty } from '../src/server/index.js';
import { defaultSpaDir } from '../src/server/ui.js';
import { harness, startDb, stopDb } from './helpers.js';
import type { CreateShortyConfig, UiRuntimeConfig } from '../types/index.js';

const bundleExists = fs.existsSync(path.join(defaultSpaDir(), 'index.html'));

function injected(html: string): UiRuntimeConfig {
  const m = html.match(/window\.__SHORTY__=(.*?)<\/script>/);
  if (!m) throw new Error('no injected config');
  return JSON.parse(m[1]) as UiRuntimeConfig;
}

describe('SPA serving (§8, traps #8)', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('answers 503 with a human explanation when the bundle is missing', async () => {
    const { shorty } = await harness();
    const app = express();
    app.use('/shorty', shorty.ui({ mountPath: '/shorty', spaDir: '/nonexistent' }));
    const res = await request(app).get('/shorty/');
    expect(res.status).toBe(503);
    expect(res.text).toMatch(/npm run build/);
  });

  // Skipped locally on a fresh checkout; in CI (which builds first) a missing
  // bundle must FAIL, not silently skip every injection test.
  describe.skipIf(!bundleExists && !process.env.CI)('against the built bundle', () => {
    it('injects a <base href> matching the mount path', async () => {
      const { shorty } = await harness();
      const app = express();
      app.use('/mounted/elsewhere', shorty.ui({ mountPath: '/mounted/elsewhere' }));
      const res = await request(app).get('/mounted/elsewhere/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('<base href="/mounted/elsewhere/" />');
    });

    it('serves one build at any mount path without a rebuild', async () => {
      const { shorty } = await harness();
      const app = express();
      app.use('/a', shorty.ui({ mountPath: '/a' }));
      app.use('/b', shorty.ui({ mountPath: '/b' }));
      expect((await request(app).get('/a/')).text).toContain('<base href="/a/" />');
      expect((await request(app).get('/b/')).text).toContain('<base href="/b/" />');
    });

    it('escapes `<` in the injected config so a title cannot close the script tag', async () => {
      const { shorty } = await harness();
      const app = express();
      app.use('/shorty', shorty.ui({ mountPath: '/shorty', title: '</script><script>alert(1)</script>' }));
      const res = await request(app).get('/shorty/');
      expect(res.text).not.toContain('</script><script>alert(1)');
      expect(res.text).toContain('\\u003c');
    });

    it('injects the operator config the SPA needs — and nothing server-side', async () => {
      const { shorty } = await harness({
        config: {
          slug: { rename: 'never', caseSensitive: true, length: 9 },
          redirect: { status: 301, forwardQuery: false },
          ui: { title: 'Go links' },
        },
      });
      const app = express();
      app.use('/shorty', shorty.ui({ mountPath: '/shorty', apiBase: '/x/api', loginUrl: '/login' }));
      const cfg = injected((await request(app).get('/shorty/')).text);
      expect(cfg).toEqual({
        apiBase: '/x/api',
        title: 'Go links',
        publicBaseUrl: 'http://short.test/go',
        loginUrl: '/login',
        returnParam: 'next',
        slug: { length: 9, caseSensitive: true, rename: 'never' },
        redirect: { status: 301, forwardQuery: false },
        clicksEnabled: true,
      } satisfies UiRuntimeConfig);
      // The pepper is a secret; it must never reach a browser.
      expect(JSON.stringify(cfg)).not.toContain('test-pepper');
    });

    it('reports clicksEnabled false when no pepper is available', async () => {
      const prev = process.env.SHORTY_PEPPER;
      delete process.env.SHORTY_PEPPER;
      try {
        const { shorty } = await harness({ config: { pepper: undefined } });
        const app = express();
        app.use('/shorty', shorty.ui({ mountPath: '/shorty' }));
        expect(injected((await request(app).get('/shorty/')).text).clicksEnabled).toBe(false);
      } finally {
        if (prev !== undefined) process.env.SHORTY_PEPPER = prev;
      }
    });
  });
});

describe('defaultSpaDir', () => {
  // esbuild cannot express import.meta.url in CJS; tsup shims it (traps #7).
  it('returns an absolute path from ESM source', () => {
    expect(path.isAbsolute(defaultSpaDir())).toBe(true);
  });
});


/**
 * Against a fixture bundle, so these run on a fresh checkout too. Layout:
 *   <tmp>/package.json          ← a secret one level ABOVE spaDir
 *   <tmp>/spa/index.html        ← spaDir
 *   <tmp>/spa/_assets/app.js
 * createShorty is called directly (no ready(), no DB) — ui() needs neither.
 */
describe('SPA serving against a fixture bundle', () => {
  const SECRET = 'TOP-SECRET-OUTSIDE-SPADIR';
  let root: string;
  let spaDir: string;
  let n = 0;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shorty-ui-'));
    spaDir = path.join(root, 'spa');
    fs.mkdirSync(path.join(spaDir, '_assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: SECRET }));
    fs.writeFileSync(path.join(spaDir, 'index.html'),
      '<!doctype html><html><head><!--shorty-config--></head><body>fixture</body></html>');
    fs.writeFileSync(path.join(spaDir, '_assets', 'app.js'), 'console.log("app")');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function make(config: Partial<CreateShortyConfig> = {}) {
    n += 1;
    return createShorty({
      connection: mongoose,
      publicBaseUrl: 'https://acme.com/go',
      pepper: 'p',
      modelPrefix: `UiFx${n}`,
      collectionPrefix: `uifx${n}_`,
      ...config,
    });
  }

  it('does not inject anything but the documented defaults when ui() gets no options', async () => {
    const shorty = make({ ui: { spaDir } });
    const app = express();
    app.use('/shorty', shorty.ui());
    const res = await request(app).get('/shorty/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<base href="/shorty/" />');
    expect(injected(res.text)).toEqual({
      apiBase: '/api/shorty',
      title: 'Links',
      publicBaseUrl: 'https://acme.com/go',
      loginUrl: null,
      returnParam: 'next',
      slug: { length: 7, caseSensitive: false, rename: 'alias' },
      redirect: { status: 302, forwardQuery: true },
      clicksEnabled: true,
    } satisfies UiRuntimeConfig);
  });

  it('does not let config.ui win over options passed to ui() — they merge, call wins', async () => {
    const shorty = make({ ui: { spaDir, title: 'From config', apiBase: '/cfg/api', returnParam: 'back' } });
    const app = express();
    app.use('/admin/links', shorty.ui({ mountPath: '/admin/links', title: 'From call' }));
    const res = await request(app).get('/admin/links/');
    const cfg = injected(res.text);
    expect(cfg.title).toBe('From call');
    expect(cfg.apiBase).toBe('/cfg/api');
    expect(cfg.returnParam).toBe('back');
    expect(res.text).toContain('<base href="/admin/links/" />');
  });

  it('does not serve deep links as anything but the SPA shell', async () => {
    const app = express();
    app.use('/shorty', make().ui({ spaDir }));
    const res = await request(app).get('/shorty/links/abc/edit');
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.__SHORTY__=');
  });

  it('does not serve hashed assets without long-lived caching', async () => {
    const app = express();
    app.use('/shorty', make().ui({ spaDir }));
    const res = await request(app).get('/shorty/_assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=31536000/);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it.each([
    '/shorty/..%2fpackage.json',
    '/shorty/..%2f..%2fpackage.json',
    '/shorty/%2e%2e%2fpackage.json',
    '/shorty/_assets/..%2f..%2fpackage.json',
    '/shorty/_assets/..%2f..%2findex.html',
    '/shorty/_assets/%2e%2e/%2e%2e/package.json',
  ])('does not escape spaDir for %s', async (url) => {
    const app = express();
    app.use('/shorty', make().ui({ spaDir }));
    const res = await request(app).get(url);
    expect(res.text ?? '').not.toContain(SECRET);
    // Either refused, or answered with the SPA shell — never a raw file from outside.
    if (res.status === 200) expect(res.text).toContain('window.__SHORTY__=');
  });
});
