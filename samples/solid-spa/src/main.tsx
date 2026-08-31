import { ErrorBoundary } from 'solid-js';
import { render } from 'solid-js/web';
import { solidErrorHandler } from '@bugsee/solid';
import { launchApp } from './bugsee';
import AppRouter from './router';
import ErrorFallback from './components/ErrorFallback';
import './styles.css';

const client = launchApp();

// Expose for manual console poking + the Playwright verify script (see scripts/verify.mjs), which
// reads window.__bugsee to trigger scenarios deterministically instead of scraping the DOM for every
// control.
(window as unknown as { __bugsee: typeof client }).__bugsee = client;

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

// solidErrorHandler wired into an <ErrorBoundary> — the @bugsee/solid ERROR SEAM under test
// (docs/samples/PLAN.md §5.5). Solid's ErrorBoundary catches synchronous render/reactive errors in
// its owner scope; async/event-handler/rejection errors are covered by the SDK's global handlers
// (S5), not here.
render(
  () => (
    <ErrorBoundary
      fallback={(error) => {
        solidErrorHandler({ mechanism: 'uncaught' })(error);
        return <ErrorFallback error={error} />;
      }}
    >
      <AppRouter />
    </ErrorBoundary>
  ),
  container,
);
