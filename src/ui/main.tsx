import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import type { UiRuntimeConfig } from '../../types/index';

// Injected by src/server/ui.ts at request time, not at build time. The defaults
// exist so `vite dev` works standalone against the proxy in vite.config.ts.
//
// `window.__SHORTY__` is declared in types/index.d.ts, so the shape the server
// injects and the shape the SPA reads are the same declaration — get them out
// of sync and `tsc` says so instead of the browser.
const config: UiRuntimeConfig = window.__SHORTY__ ?? {
  apiBase: '/api/shorty',
  title: 'Links',
  publicBaseUrl: 'http://localhost:3000/go',
  loginUrl: null,
  returnParam: 'next',
  slug: { length: 7, caseSensitive: false, rename: 'alias' },
  redirect: { status: 302, forwardQuery: true },
  clicksEnabled: true,
};

const root = document.getElementById('shorty-root');
// A non-null assertion here would turn a missing div into
// "Cannot read properties of null" from inside React. Say which id is missing.
if (!root) throw new Error('shorty: no #shorty-root element to mount into');

createRoot(root).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
