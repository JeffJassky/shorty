import type { Request } from 'express';
import type { Model } from 'mongoose';
import { createLinkModel } from './model-factory.js';
import type {
  Logger,
  LinkDoc,
  PackageUser,
  ResolveUser,
  UserAdapter,
  CreateShortyConfig,
} from '../../types/index.js';

/**
 * Config normalization — the single place raw host config becomes the shape the
 * routers consume. Every adapter has a working default so the source app drops
 * in with zero config; the only thing without one is the Mongo connection.
 *
 * If you rename this file, note that it is called `config.ts` on purpose and
 * that a bare `config.js`/`config.ts` in a global gitignore silently deletes
 * it. Run `npm run check-tracked` before the first push. See
 * standards/traps.md #1.
 */

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * What the routers consume. Every optional field on `CreateShortyConfig` is
 * resolved to a concrete value here, so no route ever re-implements a default.
 */
export interface ResolvedContext {
  Model: Model<LinkDoc>;
  userAdapter: UserAdapter;
  resolveUser: ResolveUser;
  logger: Logger;
  listLimit: number;
  adminListLimit: number;
  track: (event: unknown) => void;
}

/**
 * Default user resolution.
 *
 * Reads the conventional spots an upstream auth middleware leaves things:
 * `req.authUserId` (ObjectId) plus `req.user` ({ email, displayName, isAdmin }).
 * Hosts using a different convention pass their own `resolveUser`.
 *
 * Pure read. Never verify a token in here — it runs on every request, and a
 * throw becomes a 500 where the host wanted a clean 401.
 *
 * The two properties read off `req` are written by the *host's* middleware, so
 * they are not on Express's `Request` type. Narrow through a local shape rather
 * than augmenting the global `Express.Request` — a library that declares into
 * the host's namespace leaks its assumptions into the host's own typechecks.
 */
interface AuthedRequestish {
  authUserId?: PackageUser['id'];
  user?: {
    _id?: PackageUser['id'];
    id?: PackageUser['id'];
    email?: string;
    displayName?: string | null;
    isAdmin?: boolean;
  };
}

export function defaultResolveUser(req: Request): PackageUser | null {
  const { authUserId, user } = req as Request & AuthedRequestish;
  const id = authUserId ?? user?._id ?? user?.id;
  if (!id) return null;
  return {
    id,
    email: user?.email ?? '',
    displayName: user?.displayName ?? null,
    isAdmin: Boolean(user?.isAdmin),
  };
}

/**
 * The user adapter: the seam between the host's user system and shorty.
 *
 * shorty stores references into a user system it does not own. The adapter is
 * how those references are created and retired, and it has exactly two
 * directions:
 *
 *   inbound   resolveUser(req)   — "who is making this request?"
 *   outbound  purgeUser(id)      — "this user is gone, drop their data"
 *
 * That is the whole contract. shorty never queries the user collection, never
 * joins against it, and never writes to it.
 *
 * `isAdmin` drives badges and which UI renders. It does NOT gate anything —
 * the package cannot know what "admin" means here. The host wraps the admin
 * router in its own guard, and the host writes the test that proves it.
 *
 * The `typeof` check is not redundant with the types: hosts on plain JS reach
 * this at runtime with no compiler in front of them, and so does anything
 * reading config from JSON.
 */
export function createUserAdapter(
  { resolveUser = defaultResolveUser }: { resolveUser?: ResolveUser } = {},
): UserAdapter {
  if (typeof resolveUser !== 'function') {
    throw new TypeError('shorty: user adapter `resolveUser` must be a function');
  }
  return { resolveUser };
}

export function resolveConfig(config: CreateShortyConfig = {}): ResolvedContext {
  const {
    model,
    connection,
    modelName,
    collection,
    userRef,
    userAdapter,
    resolveUser,
    logger = NOOP_LOGGER,
    // Every query route is capped. An unbounded read against a collection the
    // host controls the size of is an outage waiting for a busy customer.
    // See standards/traps.md #18.
    listLimit = 200,
    adminListLimit = 500,
    // Optional peer seam: hosts wire their own analytics in, or don't.
    // Never a hard dependency — see standards/house-style.md.
    track = () => {},
  } = config;

  const Model = model
    ?? createLinkModel({ connection, modelName, collection, userRef });

  if (userAdapter && resolveUser) {
    throw new TypeError(
      'shorty: pass either `userAdapter` or `resolveUser`, not both',
    );
  }

  // `resolveUser` is shorthand for a one-method adapter — the common case,
  // since that method is the only one the adapter has. The object form exists
  // so the concept has a home in the docs and room to grow a second method.
  const adapter = userAdapter
    ? createUserAdapter(userAdapter)
    : createUserAdapter({ resolveUser });

  if (typeof track !== 'function') {
    throw new TypeError('shorty: `track` must be a function');
  }

  return {
    Model,
    userAdapter: adapter,
    resolveUser: adapter.resolveUser,
    logger,
    listLimit,
    adminListLimit,
    track,
  };
}
