import { A, useParams } from '@solidjs/router';
import { Show, createContext, createResource, useContext } from 'solid-js';
import type { RouteSectionProps } from '@solidjs/router';
import type { JSX, Resource } from 'solid-js';
import { api } from '../api/client';
import type { Issue } from '../types';

/** Shares the fetched issue with the nested tab routes (IssueOverviewTab / IssueCommentsTab) without
 *  each one re-fetching it. */
export const IssueContext = createContext<Resource<Issue | undefined>>();
export function useIssueContext(): Resource<Issue | undefined> {
  const ctx = useContext(IssueContext);
  if (!ctx) throw new Error('useIssueContext() called outside IssueDetailPage');
  return ctx;
}

/**
 * The issue-detail LAYOUT route (`/issues/:id`) — `@solidjs/router` nested routes: this component
 * renders `props.children`, which is whichever of the two nested routes matched
 * (`IssueOverviewTab` at the index, `IssueCommentsTab` at `/comments`). A genuine `createResource`
 * usage (not a scenario fixture) — the deliberate error-inside-createResource demo lives in the
 * Scenario panel instead, so this page's own resource degrades to a plain "not found" message.
 */
export default function IssueDetailPage(props: RouteSectionProps): JSX.Element {
  const params = useParams<{ id: string }>();
  const [issue] = createResource(() => params.id, (id) => api.getIssue(id));

  return (
    <div>
      <p>
        <A href="/issues">&larr; back to issues</A>
      </p>
      <Show when={!issue.loading} fallback={<p class="status-line">Loading…</p>}>
        <Show when={issue.error}>
          <p class="status-line err" data-testid="issue-not-found">
            Issue not found ({String(issue.error?.message ?? issue.error)}).
          </p>
        </Show>
        <Show when={!issue.error && issue()}>
          <IssueContext.Provider value={issue}>
            <h2 data-testid="issue-title">{issue()!.title}</h2>
            <p class="issue-meta">
              <span class={`pill status-${issue()!.status}`}>{issue()!.status}</span>
              <span class={`pill severity-${issue()!.severity}`}>{issue()!.severity}</span>
              assigned to {issue()!.assignee}
            </p>
            <nav class="tab-nav">
              <A href={`/issues/${params.id}`} end>
                Overview
              </A>
              <A href={`/issues/${params.id}/comments`}>Comments</A>
            </nav>
            {props.children}
          </IssueContext.Provider>
        </Show>
      </Show>
    </div>
  );
}
