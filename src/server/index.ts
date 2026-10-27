import express from 'express';
import type { Router } from 'express';
import type { CreateShortyConfig, Link, ShortyInstance, UiOptions } from '../../types/index.js';
import { resolveConfig } from './config.js';
import { createClickService } from './clicks.js';
import { notImplemented } from './errors.js';
import { createCounters, snapshotHealth } from './counters.js';
import { createHooks } from './hooks.js';
import { createInspect } from './inspect/index.js';
import { createLifecycle } from './lifecycle.js';
import { createLinkService } from './links.js';
import { createRedirect } from './redirect.js';
import { createSlugService } from './slug.js';
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
 * The shape is final; the bodies still marked `notImplemented` belong to later
 * PRs — see plans/work-breakdown.md.
 */
export function createShorty(config: CreateShortyConfig): ShortyInstance {
  const ctx = resolveConfig(config);
  const counters = createCounters();           // incremented by hooks and the redirect/click pipelines
  const slugs = createSlugService(ctx);
  const hooks = createHooks(ctx, counters);
  const service = createLinkService(ctx, slugs, hooks);
  const redirect = createRedirect(ctx, slugs, createClickService(ctx, hooks, counters), counters);
  const lifecycle = createLifecycle(ctx);

  const stubRouter = (): Router => {
    const r = express.Router();
    r.use((_req, res) => { res.status(501).json({ error: 'not_implemented' }); });
    return r;
  };

  return {
    redirect: redirect.router,
    routes: stubRouter(),         // PR 4
    ui: (opts?: UiOptions) => createUiRouter(ctx, { ...ctx.ui, ...opts }),

    ready: lifecycle.ready,
    drain: redirect.drain,
    health: () => snapshotHealth(counters, ctx.clicks.enabled),

    createLink: service.createLink,
    updateLink: service.updateLink,
    archiveLink: service.archiveLink,
    unarchiveLink: service.unarchiveLink,
    deleteLink: service.deleteLink,

    link: service.link,
    links: service.links,
    history: service.history,
    stats: async () => notImplemented('stats'),   // PR 4
    paramValues: async () => notImplemented('paramValues'),   // PR 4
    tags: service.tags,
    checkSlug: service.checkSlug,
    generateSlug: service.generateSlug,
    inspect: createInspect(ctx),
    shortUrl: (linkOrSlug: Link | string) =>
      `${ctx.publicBaseUrl}/${typeof linkOrSlug === 'string' ? linkOrSlug : linkOrSlug.slug}`,
    recount: service.recount,

    models: ctx.models,
  };
}

export default createShorty;
