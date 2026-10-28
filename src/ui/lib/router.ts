import React from 'react';

/**
 * Route state lives in the URL hash so every view is shareable and
 * `onUnauthenticated` can return people to the exact screen (spec §0).
 */
export type Route =
  | { name: 'list' }
  | { name: 'new' }
  | { name: 'edit'; id: string; from?: 'detail' }
  | { name: 'detail'; id: string }
  | { name: 'analytics' };

export function parseHash(hash: string): Route {
  const [path = '/', query = ''] = hash.replace(/^#/, '').split('?');
  if (path === '/new') return { name: 'new' };
  if (path === '/analytics') return { name: 'analytics' };
  const edit = /^\/links\/([^/]+)\/edit\/?$/.exec(path);
  if (edit) return { name: 'edit', id: decodeURIComponent(edit[1]), ...(new URLSearchParams(query).get('from') === 'detail' ? { from: 'detail' as const } : {}) };
  const detail = /^\/links\/([^/]+)\/?$/.exec(path);
  if (detail) return { name: 'detail', id: decodeURIComponent(detail[1]) };
  return { name: 'list' };
}

export const hrefs = {
  list: '#/',
  new: '#/new',
  analytics: '#/analytics',
  edit: (id: string, from?: 'detail') => `#/links/${encodeURIComponent(id)}/edit${from ? `?from=${from}` : ''}`,
  detail: (id: string) => `#/links/${encodeURIComponent(id)}`,
};

export function navigate(href: string): void {
  if (window.location.hash === href) return;
  window.location.hash = href;
}

export function useRoute(): Route {
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return React.useMemo(() => parseHash(hash), [hash]);
}
