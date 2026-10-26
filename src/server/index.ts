import { resolveConfig } from './config.js';
import { createRoutes, createAdminRoutes } from './routes/index.js';
import { createPublicUiRouter, createAdminUiRouter, defaultSpaDir } from './ui.js';
import type {
  PurgeSummary,
  UiOptions,
  CreateShortyConfig,
  ShortyInstance,
} from '../../types/index.js';
import type { PackageUser } from '../../types/index.js';

export { defaultResolveUser, createUserAdapter } from './config.js';
export { createLinkModel, buildLinkSchema } from './model-factory.js';
export { HttpError } from './errors.js';
export { defaultSpaDir };

/**
 * Shorty — the package factory.
 *
 * Returns routers the host mounts. Never an app, never a server.
 *
 *   const pkg = createShorty({ connection: mongoose, resolveUser });
 *
 *   app.use(express.json());                        // the host's job, not ours
 *   app.use('/api/shorty', requireAuth, pkg.routes);
 *   app.use('/shorty',    requireAuth, pkg.ui({ mountPath: '/shorty' }));
 *
 *   app.use('/api/shorty/admin', requireAuth, requireAdmin, pkg.adminRoutes);
 *   app.use('/admin/shorty',    requireAuth, requireAdmin,
 *           pkg.adminUi({ mountPath: '/admin/shorty' }));
 *
 * The return type is the hand-written `ShortyInstance` from `types/`, not an
 * inferred shape. That is deliberate: annotating it here makes `tsc` fail when
 * the source grows a method the published declarations don't mention, which is
 * the exact drift `types/test-d.ts` exists to catch. See standards/traps.md #9.
 */
export function createShorty(config: CreateShortyConfig = {}): ShortyInstance {
  const ctx = resolveConfig(config);

  return {
    /** The Mongoose model. Exposed so hosts can `await model.createIndexes()`. */
    model: ctx.Model,
    /** Public JSON API. */
    routes: createRoutes(ctx),
    /** Admin JSON API. The host guards it — this router does not. */
    adminRoutes: createAdminRoutes(ctx),
    /** Public SPA router. */
    ui: (opts?: UiOptions) => createPublicUiRouter(opts),
    /** Admin SPA router. */
    adminUi: (opts?: UiOptions) => createAdminUiRouter(opts),

    /**
     * Outbound adapter direction: the host tells us a user is gone.
     *
     * We store references into a user system we do not own, and nothing else
     * will ever clean them up. Repair every derived value this touches, and
     * make it idempotent — it will be called twice.
     */
    async purgeUser(userId: PackageUser['id']): Promise<PurgeSummary> {
      const { deletedCount = 0 } = await ctx.Model.deleteMany({ userId });
      return { removed: deletedCount };
    },
  };
}
