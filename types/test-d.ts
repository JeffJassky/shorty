/**
 * Compile-only exercise of the public declarations. Never executed — `tsc
 * --noEmit` failing here means the .d.ts files drifted from the source.
 *
 * These declarations are hand-written and the SOURCE IMPORTS THEM, so most
 * drift now fails in `src/` first. This file still earns its place: it is the
 * only thing that checks the surface from OUTSIDE, the way a host consumes it —
 * a type the source never happens to reference can still be wrong here.
 *
 * Hand-written types rot within a day. On featureboard this file immediately
 * caught that `types/` was missing FOUR features added the same afternoon.
 * Every exported symbol must appear below. See standards/traps.md #9.
 */
import type {
  HttpError,
  Logger,
  PackageUser,
  PurgeSummary,
  ResolveUser,
  StorageAdapter,
  UiOptions,
  UiRuntimeConfig,
  UserAdapter,
  CreateShortyConfig,
  LinkDoc,
  ShortyInstance,
} from './index.js';
import type {
  ApiError,
  ClientOptions,
  ItemResponse,
  ListResponse,
  MeResponse,
  RequestFn,
  ShortyAdminClient,
  ShortyClient,
} from './client.js';

declare const pkg: ShortyInstance;
declare const client: ShortyClient;
declare const adminClient: ShortyAdminClient;

// The adapter contract: both forms must typecheck.
const withFn: CreateShortyConfig = {
  resolveUser: () => ({ id: 'abc', email: 'a@b.c', displayName: null, isAdmin: false }),
};
const withAdapter: CreateShortyConfig = {
  userAdapter: { resolveUser: () => null },
};

// Signed-out is expressible — required for anything with a public path.
const anon: CreateShortyConfig = { resolveUser: () => null };

// Caps and the optional analytics peer.
const tuned: CreateShortyConfig = {
  listLimit: 50,
  adminListLimit: 100,
  track: (event) => void event,
  logger: {} satisfies Logger,
};

// Model overrides — the traps #2 escape hatch.
const named: CreateShortyConfig = { modelName: 'CustomLink', collection: 'custom', userRef: 'Account' };

// UI options, including the sign-in redirect.
const ui: UiOptions = {
  mountPath: '/shorty',
  apiBase: '/api/shorty',
  loginUrl: '/login',
  returnParam: 'next',
  title: 'Shorty',
};
const uiRouter = pkg.ui(ui);
const adminRouter = pkg.adminUi({ mountPath: '/admin/shorty' });
const routes = pkg.routes;
const adminRoutes = pkg.adminRoutes;

// Purge returns a summary, and takes a string or an ObjectId.
async function purge(): Promise<PurgeSummary> {
  return pkg.purgeUser('507f1f77bcf86cd799439011');
}

// Indexes are the host's to build — traps #3.
async function boot() {
  await pkg.model.createIndexes();
}

// Client surface.
async function exercise() {
  const { user }: MeResponse = await client.me();
  const isStaff: boolean = user.isAdmin;
  const name: string | null = user.displayName;

  const page: ListResponse = await client.list({ limit: 10 });
  const cap: number = page.limit;

  const one: ItemResponse = await client.get('abc');
  const total: number = (await adminClient.summary()).total;
  const raw = await client.call('GET', '/me');
}

// Custom transport is typed.
const transport: RequestFn = async (method, url, body) => ({ ok: true });
const opts: ClientOptions = { baseUrl: '/x', request: transport, onUnauthenticated: () => {} };

// A user accepts a string or ObjectId id; the adapter is a plain function.
const u: PackageUser = { id: 'abc', email: 'a@b.c' };
const r: ResolveUser = () => u;
const a: UserAdapter = { resolveUser: r };

// Storage, for packages that copy the adapter in. Delete with the adapter.
declare const storage: StorageAdapter;
async function bytes() {
  await storage.put('k', Buffer.from('v'), { contentType: 'text/plain' });
  const got: Buffer = await storage.get('k');
  const url: string = await storage.signUrl('k', { expiresIn: 60 });
  await storage.delete('k');
}

// Errors carry a status and a stable code.
declare const err: HttpError;
const status: number = err.status;
const code: string = err.code;

// The client's thrown error is part of the contract — hosts branch on it.
declare const apiErr: ApiError;
const apiStatus: number = apiErr.status;
const apiPayload: unknown = apiErr.payload;

// The document shape hosts type their own queries against.
async function query() {
  const docs: LinkDoc[] = await pkg.model.find({}).lean();
  const when: Date = docs[0].createdAt;
}

// What the UI router injects and the SPA reads back. One declaration, both
// sides — the server writing a key the SPA never reads is a compile error.
const injected: UiRuntimeConfig = {
  apiBase: '/api/shorty',
  adminApiBase: '/api/shorty/admin',
  admin: false,
  title: 'Shorty',
  loginUrl: null,
  returnParam: 'next',
};
