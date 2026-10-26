/**
 * Transport-agnostic JSON client for the shorty HTTP API.
 *
 * Shipped as its own export (`@jeffjassky/shorty/client`) so a host can drive the API
 * from its own UI without adopting ours — the corollary in
 * standards/house-style.md: if the feature must live inside an existing host
 * page rather than own a route, ship the API plus this, and let the host build
 * the view.
 *
 * No fetch dependency baked in: pass `request` to run it through an axios
 * instance, a test harness, or anything else.
 */
import type {
  ApiError,
  ClientOptions,
  RequestFn,
  ShortyAdminClient,
  ShortyClient,
} from '../../types/client.js';

const defaultRequest: RequestFn = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // The thrown value is part of the contract — hosts branch on `status`, so
    // it is declared in types/client.d.ts rather than left as a bare Error.
    const err = new Error(`shorty: ${method} ${url} → ${res.status}`) as ApiError;
    err.status = res.status;
    err.payload = await res.json().catch(() => null);
    throw err;
  }
  return res.status === 204 ? null : res.json();
};

/**
 * `onUnauthenticated` fires on 401 and on 403. Both strand a user whose page is
 * already rendered — an expired session and a revoked admin role are the same
 * problem from the browser's side. See standards/adapters.md.
 */
export function createClient({
  baseUrl = '/api/shorty',
  request = defaultRequest,
  onUnauthenticated = null,
}: ClientOptions = {}): ShortyClient {
  const base = baseUrl.replace(/\/$/, '');

  const call: RequestFn = async (method, path, body) => {
    try {
      return await request(method, `${base}${path}`, body);
    } catch (err) {
      // `catch` binds `unknown`, and a rejected transport can throw anything —
      // an axios error, a string, a DOMException. Read `status` defensively.
      const status = (err as Partial<ApiError> | null)?.status;
      if ((status === 401 || status === 403) && onUnauthenticated) {
        onUnauthenticated(err);
      }
      throw err;
    }
  };

  return {
    /** Escape hatch: raw call against this client's base, redirects included. */
    call,
    me: () => call('GET', '/me'),
    list: (params = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      return call('GET', qs ? `/?${qs}` : '/');
    },
    get: (id) => call('GET', `/${encodeURIComponent(id)}`),
  };
}

export function createAdminClient(
  { baseUrl = '/api/shorty/admin', ...opts }: ClientOptions = {},
): ShortyAdminClient {
  const client = createClient({ baseUrl, ...opts });
  return {
    ...client,
    summary: () => client.call('GET', '/summary'),
  };
}
