/**
 * The storage adapter interface.
 *
 * Cross-cutting: it shows up in chat (file uploads), mailery (attachments), and
 * knowledgebase. It is defined HERE, in the template, and copied into each
 * package that needs it — deliberately not published as a package of its own.
 * A shared runtime "core" that feature packages import is how a library becomes
 * a framework. See standards/adapters.md and standards/house-style.md.
 *
 * Copy this file only into packages that actually store bytes. Delete it
 * otherwise — an unused adapter in the docs is a promise nobody kept.
 *
 * The shape is `StorageAdapter` in `types/index.d.ts`. Directions:
 *   inbound   put / get / signUrl  — the package asks the host to hold bytes
 *   outbound  delete               — the host's deletion path reaches back in
 *
 * `signUrl` is the one worth arguing about: it exists so a browser can fetch a
 * private object without proxying megabytes through the host's Node process.
 * A local-disk adapter that cannot sign has to route through an authed route
 * instead — which is why `signUrl` may return a package-relative URL, not
 * necessarily an absolute one at the storage provider.
 */
import type { StorageAdapter } from '../../../types/index.js';

/** Every method throws — a package that needs storage must be given one. */
export function createNullStorage(): StorageAdapter {
  const fail = (method: string) => () => {
    throw new Error(
      `shorty: no storage adapter configured — pass \`storage\` to use ${method}()`,
    );
  };
  return {
    put: fail('put'),
    get: fail('get'),
    delete: fail('delete'),
    signUrl: fail('signUrl'),
  };
}

/**
 * In-memory storage. For tests and the runnable example — never for a host.
 * Bytes vanish on restart and the process grows without bound.
 */
export function createMemoryStorage(): StorageAdapter {
  const bytes = new Map<string, { body: Buffer; contentType: string }>();
  return {
    async put(key, body, { contentType = 'application/octet-stream' } = {}) {
      bytes.set(key, { body: Buffer.from(body as Uint8Array | string), contentType });
    },
    async get(key) {
      const hit = bytes.get(key);
      if (!hit) throw new Error(`shorty: no object at ${key}`);
      return hit.body;
    },
    async delete(key) {
      bytes.delete(key);
    },
    async signUrl(key) {
      const body = bytes.get(key)?.body ?? Buffer.alloc(0);
      return `data:application/octet-stream;base64,${body.toString('base64')}`;
    },
  };
}

/**
 * Runtime shape check. Not redundant with `StorageAdapter`: the adapter comes
 * from the host, and a host on plain JS has no compiler in front of it. The
 * failure this prevents is a `undefined is not a function` deep inside an
 * upload, hours after the misconfiguration.
 */
export function assertStorageAdapter(storage: unknown): StorageAdapter {
  for (const method of ['put', 'get', 'delete', 'signUrl'] as const) {
    if (typeof (storage as Record<string, unknown> | null)?.[method] !== 'function') {
      throw new TypeError(`shorty: storage adapter is missing \`${method}\``);
    }
  }
  return storage as StorageAdapter;
}
