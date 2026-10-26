import React from 'react';
import { createShortyClient } from '../client/index';
import type { LinkJson, ShortyClient } from '../../types/client';
import type { UiRuntimeConfig } from '../../types/index';

/**
 * Placeholder until PR 5 (plans/work-breakdown.md). Keeps the two hand-offs the
 * real UI must preserve: the client is built from the injected config, and
 * `onUnauthenticated` carries the full current URL back through the login flow.
 */
type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; items: LinkJson[] }
  | { status: 'error'; error: Error };

export default function App({ config }: { config: UiRuntimeConfig }) {
  const client = React.useMemo<ShortyClient>(() => {
    const onUnauthenticated = config.loginUrl
      ? () => {
        const back = encodeURIComponent(window.location.href);
        window.location.href = `${config.loginUrl}?${config.returnParam}=${back}`;
      }
      : null;
    return createShortyClient({ baseUrl: config.apiBase, onUnauthenticated });
  }, [config]);

  const [state, setState] = React.useState<ViewState>({ status: 'loading' });

  React.useEffect(() => {
    let live = true;
    client.links()
      .then((page) => { if (live) setState({ status: 'ready', items: page.items }); })
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
          {state.items.map((link) => (
            <li key={link.id}>{link.shortUrl} → {link.destination}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
