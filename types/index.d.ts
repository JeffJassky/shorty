import type { Router, Request } from 'express';
import type { Connection, Model, Mongoose, Schema, Types } from 'mongoose';

/**
 * The stored document.
 *
 * Declared here rather than in `src/`, and imported BY `src/server/model-factory.ts`
 * — the published contract is the source of truth, so a field added to the
 * schema without a matching field here fails the typecheck. Hosts type their
 * own `model.find()` results against it. See standards/traps.md #9.
 */
export interface LinkDoc {
  _id: Types.ObjectId;
  userId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** The identity the package needs. Never an auth result — the host authed already. */
export interface PackageUser {
  id: Types.ObjectId | string;
  email: string;
  displayName?: string | null;
  /** Drives badges and which UI renders. Gates nothing — the host guards. */
  isAdmin?: boolean;
}

export interface Logger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

/** Inbound direction of the user adapter. Returns null for a signed-out caller. */
export type ResolveUser = (req: Request) => PackageUser | null;

export interface UserAdapter {
  resolveUser: ResolveUser;
}

export declare function defaultResolveUser(req: Request): PackageUser | null;
export declare function createUserAdapter(opts?: { resolveUser?: ResolveUser }): UserAdapter;

export interface StorageAdapter {
  put(key: string, body: Buffer | Uint8Array | string, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  signUrl(key: string, opts?: { expiresIn?: number }): Promise<string>;
}

export interface UiOptions {
  /** Path the router is mounted at — used for `<base href>` and asset URLs. */
  mountPath?: string;
  /** Where the browser should call the public JSON API. */
  apiBase?: string;
  /** Where the browser should call the admin JSON API. */
  adminApiBase?: string;
  /** Document/page title. */
  title?: string;
  /** Override the built SPA directory. Defaults to the bundle in `dist/ui`. */
  spaDir?: string;
  /**
   * Where to send a user whose session ends while the page is open. Null (the
   * default) surfaces API errors inline instead of redirecting.
   */
  loginUrl?: string | null;
  /** Query param carrying the return URL. Defaults to `next`. */
  returnParam?: string;
  /** Set by `ui()` / `adminUi()`; only meaningful on the low-level factory. */
  admin?: boolean;
}

export interface CreateShortyConfig {
  /** Supply a compiled model to bypass the factory entirely. */
  model?: Model<LinkDoc>;
  /** Mongoose connection. Defaults to the global mongoose instance. */
  connection?: Mongoose | Connection;
  /** Override when a collision with a host model is plausible — traps #2. */
  modelName?: string;
  collection?: string;
  /** Model name the stored user references point at. Defaults to `User`. */
  userRef?: string;

  /** The user adapter, object form. Mutually exclusive with `resolveUser`. */
  userAdapter?: UserAdapter;
  /** The user adapter, shorthand form. Mutually exclusive with `userAdapter`. */
  resolveUser?: ResolveUser;

  logger?: Logger;
  /** Hard cap on public list reads. Defaults to 200 — traps #18. */
  listLimit?: number;
  /** Hard cap on admin list reads. Defaults to 500. */
  adminListLimit?: number;
  /** Optional peer seam for analytics. No-op by default; never a hard dep. */
  track?: (event: unknown) => void;
}

export interface PurgeSummary {
  removed: number;
}

export interface ShortyInstance {
  /** The Mongoose model. `await model.createIndexes()` once at boot — traps #3. */
  model: Model<LinkDoc>;
  routes: Router;
  /** The host guards this router. This package does not. */
  adminRoutes: Router;
  ui(opts?: UiOptions): Router;
  adminUi(opts?: UiOptions): Router;
  /** Outbound adapter direction. Idempotent — it will be called twice. */
  purgeUser(userId: Types.ObjectId | string): Promise<PurgeSummary>;
}

export declare function createShorty(config?: CreateShortyConfig): ShortyInstance;

export declare function buildLinkSchema(opts?: { userRef?: string }): Schema<LinkDoc>;
export declare function createLinkModel(opts?: {
  connection?: Mongoose | Connection;
  modelName?: string;
  collection?: string;
  userRef?: string;
}): Model<LinkDoc>;

export declare function defaultSpaDir(): string;

export declare class HttpError extends Error {
  constructor(status: number, code: string, details?: Record<string, unknown>);
  status: number;
  code: string;
  details?: Record<string, unknown>;
}

/**
 * The runtime config blob `ui()` injects into the served HTML and the SPA reads
 * back off `window`. One declaration for both sides of that hand-off: the
 * server writing a key the SPA doesn't read (or vice versa) is a typecheck
 * failure rather than an undefined at runtime.
 *
 * `UiOptions` is what the HOST passes; this is what reaches the BROWSER. They
 * overlap but are not the same — `spaDir` is a server path and never ships.
 */
export interface UiRuntimeConfig {
  apiBase: string;
  adminApiBase: string;
  admin: boolean;
  title: string;
  loginUrl: string | null;
  returnParam: string;
}

declare global {
  interface Window {
    /**
     * Present only on pages served by this package's UI router. Absent under
     * `vite dev`, which is why the SPA falls back to build-time defaults.
     */
    __SHORTY__?: UiRuntimeConfig;
  }
}
