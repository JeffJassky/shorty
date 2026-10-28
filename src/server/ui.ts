import express from 'express';
import type { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UiOptions, UiRuntimeConfig } from '../../types/index.js';
import type { ResolvedContext } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Published builds run from `dist/index.js`, so the UI bundle sits alongside at
// `dist/ui`; running from source (tests, the example) it is two levels up. Pick
// whichever exists rather than guessing from a build flag — the two cases
// resolve differently and a flag gets it wrong in one of them.
// See standards/traps.md #7.
const SPA_DIR_CANDIDATES = ['./ui', '../../dist/ui'];

export function defaultSpaDir(): string {
  for (const candidate of SPA_DIR_CANDIDATES) {
    const dir = path.resolve(here, candidate);
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return path.resolve(here, SPA_DIR_CANDIDATES[SPA_DIR_CANDIDATES.length - 1]);
}

function escapeJson(value: unknown): string {
  // `</script>` inside injected JSON would close the tag early; `<!--` would
  // open an HTML comment. Both are escaped at the `<` so the payload stays
  // inert regardless of what a config string contains. Test this.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Serve the built React SPA (§8).
 *
 *   app.use('/shorty', requireAdmin, shorty.ui({ mountPath: '/shorty', apiBase: '/api/shorty' }))
 *
 * One build serves every mount path: assets are relative and the server injects
 * `<base href="<mountPath>/">` plus the runtime config blob. `mountPath` MUST
 * match where the router is mounted, as the browser sees it, or every asset
 * 404s (traps #8).
 */
export function buildRuntimeConfig(ctx: ResolvedContext, opts: UiOptions): UiRuntimeConfig {
  return {
    apiBase: opts.apiBase ?? '/api/shorty',
    title: opts.title ?? 'Links',
    publicBaseUrl: ctx.publicBaseUrl,
    loginUrl: opts.loginUrl ?? null,
    returnParam: opts.returnParam ?? 'next',
    slug: { length: ctx.slug.length, caseSensitive: ctx.slug.caseSensitive, rename: ctx.slug.rename },
    redirect: { status: ctx.redirect.status, forwardQuery: ctx.redirect.forwardQuery },
    clicksEnabled: ctx.clicks.enabled,
  };
}

export function createUiRouter(ctx: ResolvedContext, opts: UiOptions = {}): Router {
  const { mountPath = '/shorty', spaDir = defaultSpaDir() } = opts;
  const router = express.Router();
  const indexPath = path.join(spaDir, 'index.html');

  // Hashed filenames — safe to cache hard.
  router.use('/_assets', express.static(path.join(spaDir, '_assets'), {
    maxAge: '1y',
    immutable: true,
    index: false,
  }));

  const base = `${mountPath.replace(/\/$/, '')}/`;
  const config = escapeJson(buildRuntimeConfig(ctx, opts));

  router.get(/.*/, (_req, res) => {
    let html: string;
    try {
      html = fs.readFileSync(indexPath, 'utf8');
    } catch {
      // The normal state of a fresh checkout. A human explanation, not a stack.
      return res.status(503).type('text/plain').send(
        'shorty: UI bundle not found. Run `npm run build` in the package, '
        + 'or pass an explicit `spaDir`.',
      );
    }
    const injected = html.replace(
      '<!--shorty-config-->',
      `<base href="${base}" />\n    <script>window.__SHORTY__=${config}</script>`,
    );
    res.type('html').send(injected);
  });

  return router;
}
