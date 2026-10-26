import type { CreateShortyConfig } from '../../types/index.js';
import type { ResolvedContext } from './config.js';
import type { Counters } from './counters.js';

/**
 * Hooks and `track` never fail a write (§3): each is awaited, caught, logged
 * through `ctx.logger.error` and counted in `health().hookFailures`. They are
 * awaited so a lifecycle hook has finished by the time the method resolves.
 */

type Hooks = ResolvedContext['hooks'];
type LifecycleHook = 'onCreate' | 'onUpdate' | 'onArchive' | 'onDelete';
type HookArg<K extends LifecycleHook> = Parameters<NonNullable<Hooks[K]>>[0];

export type TrackEvent =
  | 'shorty.link_created'
  | 'shorty.link_updated'
  | 'shorty.link_archived'
  | 'shorty.link_unarchived'
  | 'shorty.link_deleted';

export interface HookRunner {
  /** Call `ctx.hooks[name]` with `arg`, if configured. Never throws. */
  hook<K extends LifecycleHook>(name: K, arg: HookArg<K>): Promise<void>;
  /** Emit a `track` event carrying the `shorty_link` subject. Never throws. */
  track(name: TrackEvent, linkId: string): Promise<void>;
}

export function createHooks(ctx: ResolvedContext, counters: Counters): HookRunner {
  const failed = (what: string, err: unknown): void => {
    counters.hookFailures += 1;
    ctx.logger.error?.({ err }, `shorty: ${what} failed`);
  };

  return {
    async hook(name, arg) {
      const fn = ctx.hooks[name] as ((a: typeof arg) => void | Promise<void>) | undefined;
      if (!fn) return;
      try {
        await fn(arg);
      } catch (err) {
        failed(`${name} hook`, err);
      }
    },

    async track(name, linkId) {
      try {
        // `TrackFn` is declared void, but a host may hand in an async client.
        await (ctx.track as (n: string, o: NonNullable<Parameters<NonNullable<CreateShortyConfig['track']>>[1]>) => unknown)(
          name,
          { subjects: [{ type: 'shorty_link', id: linkId }] },
        );
      } catch (err) {
        failed(`track(${name})`, err);
      }
    },
  };
}
