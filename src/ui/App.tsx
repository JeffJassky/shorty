import React from 'react';
import { createShortyClient } from '../client/index';
import type { ShortyClient } from '../../types/client';
import type { UiRuntimeConfig } from '../../types/index';
import { Icons } from './components/icons';
import { ToastProvider } from './components/toast';
import { AppContext, type AppContextValue } from './lib/context';
import { hrefs, navigate, useRoute } from './lib/router';
import { LinkFormScreen } from './screens/link-form';
import { AnalyticsScreen } from './screens/analytics';
import { LinkDetailScreen } from './screens/link-detail';
import { LinksScreen } from './screens/links';

/**
 * Router + topbar. Keeps the two hand-offs the host relies on: the client is
 * built from the injected config, and `onUnauthenticated` carries the full
 * current URL (hash included) back through the login flow.
 */
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

  const [linksVersion, setLinksVersion] = React.useState(0);
  const bumpLinks = React.useCallback(() => setLinksVersion((n) => n + 1), []);
  const ctx = React.useMemo<AppContextValue>(
    () => ({ config, client, linksVersion, bumpLinks }),
    [config, client, linksVersion, bumpLinks],
  );

  const route = useRoute();
  React.useEffect(() => { document.title = config.title; }, [config.title]);

  // N → New link, / → search. Never while typing.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      // Focus can sit on <body> behind an open sheet or dialog; leave those alone.
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); navigate(hrefs.new); }
      else if (e.key === '/') { e.preventDefault(); document.getElementById('links-search')?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <AppContext.Provider value={ctx}>
      <ToastProvider>
        <div className="app">
          <header className="topbar">
            <a className="brand" href={hrefs.list} aria-label={config.title}>
              <span className="brand-mark" aria-hidden="true">↗</span>
              <span className="brand-name">{config.title}</span>
            </a>
            <nav className="topnav" aria-label="Main">
              <a href={hrefs.list} className={'topnav-link' + (route.name !== 'analytics' ? ' active' : '')} aria-current={route.name !== 'analytics' ? 'page' : undefined}>Links</a>
              {config.clicksEnabled && (
                <a href={hrefs.analytics} className={'topnav-link' + (route.name === 'analytics' ? ' active' : '')} aria-current={route.name === 'analytics' ? 'page' : undefined}>Analytics</a>
              )}
            </nav>
            <span className="topbar-spacer" />
            <a className="btn btn-primary" href={hrefs.new}><Icons.Plus /> New link</a>
          </header>
          <main className="content">
            <div className="content-inner">
              {/* The list stays mounted (hidden) behind detail and analytics so filters and scroll survive the round trip. */}
              <div hidden={route.name === 'detail' || route.name === 'analytics' || (route.name === 'edit' && route.from === 'detail')}>
                <LinksScreen active={route.name === 'list'} />
              </div>
              {(route.name === 'detail' || (route.name === 'edit' && route.from === 'detail')) && <LinkDetailScreen key={route.id} id={route.id} />}
              {route.name === 'analytics' && <AnalyticsScreen />}
            </div>
          </main>
          {route.name === 'new' && <LinkFormScreen key="new" mode="new" />}
          {route.name === 'edit' && <LinkFormScreen key={route.id} mode="edit" id={route.id} from={route.from} />}
        </div>
      </ToastProvider>
    </AppContext.Provider>
  );
}
