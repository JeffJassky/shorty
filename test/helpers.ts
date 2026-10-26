import express from 'express';
import type { Express, Request } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createShorty } from '../src/server/index.js';
import type {
  PackageUser,
  ResolveUser,
  UserAdapter,
  CreateShortyConfig,
  ShortyInstance,
} from '../types/index.js';

let mongod: MongoMemoryServer | undefined;

export async function startDb(): Promise<void> {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'shorty-test' });
}

export async function stopDb(): Promise<void> {
  await mongoose.disconnect();
  await mongod?.stop();
}

export function newUserId(): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId();
}

/** The mutable "who is signed in" handle `buildApp` hands back. */
export interface Session {
  user: PackageUser | null;
}

export interface BuildAppOptions {
  session?: Session;
  /** A stand-in model — pass one whose methods throw to test the JSON-on-500 path. */
  model?: CreateShortyConfig['model'];
  userAdapter?: UserAdapter;
  resolveUser?: ResolveUser;
}

export interface BuiltApp {
  app: Express;
  pkg: ShortyInstance;
  state: Session;
}

/** What the fake auth middleware writes onto the request. Mirrors a host. */
type AuthedRequest = Request & { authUser?: PackageUser | null };

/**
 * Build an app whose "authenticated user" is whatever the caller mutates on the
 * returned `session` object. Mirrors a host running its own auth middleware
 * upstream of our routers — which is the only arrangement this package supports.
 */
export async function buildApp({
  session,
  model,
  userAdapter,
  resolveUser,
}: BuildAppOptions = {}): Promise<BuiltApp> {
  const state: Session = session ?? { user: null };

  const pkg = createShorty({
    connection: mongoose,
    model,
    // A fresh model name per app keeps parallel suites from colliding in
    // mongoose's global registry — traps #2.
    modelName: `LinkTest${Math.random().toString(36).slice(2, 10)}`,
    // Pass through exactly what the caller asked for so config validation is
    // reachable; fall back to a default only when neither is given.
    ...(userAdapter ? { userAdapter } : {}),
    ...(resolveUser ? { resolveUser } : {}),
    ...(userAdapter || resolveUser
      ? {}
      : { resolveUser: (req: Request) => (req as AuthedRequest).authUser ?? null }),
  });

  // Mongoose builds indexes in the background, so a fresh collection can serve
  // a query before its index exists — and some of those throw rather than
  // return empty. Await it rather than race it. See standards/traps.md #3.
  if (!model) await pkg.model.createIndexes();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthedRequest).authUser = state.user;
    next();
  });
  app.use('/api/shorty', pkg.routes);
  // The host's guard — the package does NOT enforce this, by design.
  app.use('/api/shorty/admin', (req, res, next) => {
    if (!state.user?.isAdmin) return res.status(403).json({ error: 'forbidden' });
    next();
  }, pkg.adminRoutes);

  return { app, pkg, state };
}
