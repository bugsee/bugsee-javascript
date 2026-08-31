import { Navigate, Route, Router } from '@solidjs/router';
import type { JSX } from 'solid-js';
import RootLayout from './routes/RootLayout';
import IssuesListPage from './routes/IssuesListPage';
import IssueDetailPage from './routes/IssueDetailPage';
import IssueOverviewTab from './routes/IssueOverviewTab';
import IssueCommentsTab from './routes/IssueCommentsTab';
import SettingsPage from './routes/SettingsPage';
import ScenarioPage from './routes/ScenarioPage';
import NotFoundPage from './routes/NotFoundPage';

/**
 * `@solidjs/router` with NESTED routes (docs/samples/PLAN.md §5.5): `/issues/:id` is a layout route
 * whose two children — the index (Overview) and `/comments` — render inside it via `props.children`
 * (see IssueDetailPage.tsx). Route-name instrumentation (`setRouteNameFromSolidMatches`) is wired
 * globally in RootLayout.tsx via `useCurrentMatches` — no per-route call needed here, since Solid
 * Router is reactive rather than event-based.
 */
export default function AppRouter(): JSX.Element {
  return (
    <Router root={RootLayout}>
      <Route path="/" component={() => <Navigate href="/issues" />} />
      <Route path="/issues" component={IssuesListPage} />
      <Route path="/issues/:id" component={IssueDetailPage}>
        <Route path="/" component={IssueOverviewTab} />
        <Route path="/comments" component={IssueCommentsTab} />
      </Route>
      <Route path="/settings" component={SettingsPage} />
      <Route path="/scenarios" component={ScenarioPage} />
      <Route path="*" component={NotFoundPage} />
    </Router>
  );
}
