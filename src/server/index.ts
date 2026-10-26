import express from 'express';
import type { Router } from 'express';
import type { CreateShortyConfig, Link, ShortyInstance, UiOptions } from '../../types/index.js';
import { resolveConfig } from './config.js';
import { notImplemented } from './errors.js';
import { createUiRouter, defaultSpaDir } from './ui.js';

export { defaultResolveUser } from './config.js';
export { ShortyError, ERROR_STATUS } from './errors.js';
export { composeUrl, parseUrl } from '../shared/url.js';
export { defaultSpaDir };

/**
 * Shorty — returns routers the host mounts and a programmatic API. Never an
 * app, never a server.
 *
 *   const shorty = createShorty({ connection: mongoose, publicBaseUrl: 'https://acme.com/go' });
 *   await shorty.ready();
 *
 *   app.use(express.json());                                 // the host's job
 *   app.use('/go', shorty.redirect);                         // public; any path, any order
 *   app.use('/api/shorty', requireAdmin, shorty.routes);
 *   app.use('/shorty', requireAdmin, shorty.ui());
 *
 * CONTRACT STAGE (PR 0): the shape is final; the bodies throw. See
 * plans/work-breakdown.md for which PR fills which stub.
 */
export function createShorty(config: CreateShortyConfig): ShortyInstance {
  const ctx = resolveConfig(config);

  const stubRouter = (): Router => {
    const r = express.Router();
    r.use((_req, res) => { res.status(501).json({ error: 'not_implemented' }); });
    return r;
  };

  return {
    redirect: express.Router(),   // PR 2 — until then every path falls through
    routes: stubRouter(),         // PR 4
    ui: (opts?: UiOptions) => createUiRouter(ctx, { ...ctx.ui, ...opts }),

    ready: async () => notImplemented('ready'),
    drain: async () => notImplemented('drain'),
    health: () => notImplemented('health'),

    createLink: async () => notImplemented('createLink'),
    updateLink: async () => notImplemented('updateLink'),
    archiveLink: async () => notImplemented('archiveLink'),
    unarchiveLink: async () => notImplemented('unarchiveLink'),
    deleteLink: async () => notImplemented('deleteLink'),

    link: async () => notImplemented('link'),
    links: async () => notImplemented('links'),
    history: async () => notImplemented('history'),
    stats: async () => notImplemented('stats'),
    paramValues: async () => notImplemented('paramValues'),
    tags: async () => notImplemented('tags'),
    checkSlug: async () => notImplemented('checkSlug'),
    generateSlug: async () => notImplemented('generateSlug'),
    inspect: async () => notImplemented('inspect'),
    shortUrl: (linkOrSlug: Link | string) =>
      `${ctx.publicBaseUrl}/${typeof linkOrSlug === 'string' ? linkOrSlug : linkOrSlug.slug}`,
    recount: async () => notImplemented('recount'),

    models: ctx.models,
  };
}

export default createShorty;
