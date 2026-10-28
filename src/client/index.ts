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
import type { ApiError, ClientOptions, RequestFn, ShortyClient } from '../../types/client.js';

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

function qs(params: object): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : String(v)]);
  const out = new URLSearchParams(pairs).toString();
  return out ? `?${out}` : '';
}

const id = (value: string) => encodeURIComponent(value);

/**
 * `onUnauthenticated` fires on 401 and on 403. Both strand a user whose page is
 * already rendered — an expired session and a revoked admin role are the same
 * problem from the browser's side. See standards/adapters.md.
 */
export function createShortyClient({
  baseUrl = '/api/shorty',
  request = defaultRequest,
  onUnauthenticated = null,
}: ClientOptions = {}): ShortyClient {
  const base = baseUrl.replace(/\/$/, '');

  const call: RequestFn = async (method, path, body) => {
    try {
      return await request(method, `${base}${path}`, body);
    } catch (err) {
      const status = (err as Partial<ApiError> | null)?.status;
      if ((status === 401 || status === 403) && onUnauthenticated) onUnauthenticated(err);
      throw err;
    }
  };

  return {
    call,
    links: (query = {}) => call('GET', `/links${qs(query)}`),
    createLink: async (input) => (await call('POST', '/links', input)).link,
    link: async (linkId) => (await call('GET', `/links/${id(linkId)}`)).link,
    updateLink: async (linkId, patch) => (await call('PATCH', `/links/${id(linkId)}`, patch)).link,
    archiveLink: async (linkId) => (await call('POST', `/links/${id(linkId)}/archive`)).link,
    unarchiveLink: async (linkId) => (await call('POST', `/links/${id(linkId)}/unarchive`)).link,
    deleteLink: async (linkId) => (await call('DELETE', `/links/${id(linkId)}`)).deleted,
    history: async (linkId) => (await call('GET', `/links/${id(linkId)}/history`)).items,
    stats: ({ linkId, ...query }) =>
      call('GET', `${linkId ? `/links/${id(linkId)}` : ''}/stats${qs(query)}`),
    paramValues: async () => (await call('GET', '/params')).items,
    tags: async () => (await call('GET', '/tags')).items,
    checkSlug: (slug, opts = {}) => call('GET', `/slugs/check${qs({ slug, ...opts })}`),
    generateSlug: async () => (await call('GET', '/slugs/generate')).slug,
    inspect: (url) => call('POST', '/inspect', { url }),
  };
}
