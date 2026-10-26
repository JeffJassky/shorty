import React from 'react';
import { createClient, createAdminClient } from '../client/index';
import type { ListResponse, ShortyClient } from '../../types/client';
import type { UiRuntimeConfig } from '../../types/index';

/**
 * Skeleton SPA. Replace the body; keep the shape.
 *
 * The two things worth preserving: the client is built from the injected
 * config (never a hardcoded base), and `onUnauthenticated` carries the full
 * current URL — hash route included — so a login flow that honors the return
 * param puts the user back on the exact view. See standards/adapters.md.
 */

/** Discriminated union rather than optional fields — `state.error` cannot be
 * read while loading, and the compiler is the one enforcing it. */
type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; items: ListResponse['items'] }
  | { status: 'error'; error: Error };

export default function App({ config }: { config: UiRuntimeConfig }) {
  const client = React.useMemo<ShortyClient>(() => {
    const onUnauthenticated = config.loginUrl
      ? () => {
        const back = encodeURIComponent(window.location.href);
        window.location.href = `${config.loginUrl}?${config.returnParam}=${back}`;
      }
      : null;
    return config.admin
      ? createAdminClient({ baseUrl: config.adminApiBase, onUnauthenticated })
      : createClient({ baseUrl: config.apiBase, onUnauthenticated });
  }, [config]);

  const [state, setState] = React.useState<ViewState>({ status: 'loading' });

  React.useEffect(() => {
    let live = true;
    client.list()
      .then((data) => { if (live) setState({ status: 'ready', items: data.items }); })
      .catch((err: Error) => { if (live) setState({ status: 'error', error: err }); });
    return () => { live = false; };
  }, [client]);

  return (
    <main className="shorty">
      <h1>{config.title}</h1>
      {state.status === 'loading' && <p>Loading…</p>}
      {state.status === 'error' && <p role="alert">Could not load: {state.error.message}</p>}
      {state.status === 'ready' && (
        <ul>
          {state.items.map((item) => (
            <li key={String((item as { _id: unknown })._id)}>
              {String((item as { _id: unknown })._id)}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
