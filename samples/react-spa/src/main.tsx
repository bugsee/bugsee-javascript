import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { BugseeErrorBoundary, createBugseeErrorHandlers } from '@bugsee/react';
import { getClient, launchApp } from './bugsee';
import { router, wireRouterNaming } from './router';
import ErrorFallback from './components/ErrorFallback';
import './styles.css';

const client = launchApp();
wireRouterNaming();

// Expose for manual console poking + the Playwright verify script (see scripts/verify.mjs), which reads
// window.__bugsee to trigger scenarios deterministically instead of scraping the DOM for every control.
(window as unknown as { __bugsee: typeof client }).__bugsee = client;

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

// React-19-style root error handlers (createBugseeErrorHandlers): catches everything an
// <ErrorBoundary> does NOT — event handlers, effects, and errors React itself surfaces via
// onUncaughtError/onCaughtError. React 18's createRoot ignores unknown option keys, so passing these
// here is inert on 18 (documented in scenarios.md) and becomes live capture the moment the app is
// built against React 19 — the handlers themselves are exercised directly below regardless.
const errorHandlers = createBugseeErrorHandlers({ mechanism: 'uncaught' });

createRoot(container, errorHandlers as unknown as Record<string, never>).render(
  <StrictMode>
    <BugseeErrorBoundary fallback={(error) => <ErrorFallback error={error} />} mechanism="uncaught">
      <RouterProvider router={router} />
    </BugseeErrorBoundary>
  </StrictMode>,
);
