import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { defaultSpaDir } from '../src/server/ui.js';
import { harness, startDb, stopDb } from './helpers.js';
import type { UiRuntimeConfig } from '../types/index.js';

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
          screenshot: async () => null,
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
        screenshot: true,
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
