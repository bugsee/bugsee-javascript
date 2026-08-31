import { A } from '@solidjs/router';
import { For, Show, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { api, type IssueFilterStatus } from '../api/client';
import ActivityFeed from '../components/ActivityFeed';

/** The issue-list index page — filters (status/severity/search) + create form. Real app behaviour
 *  (not just a scenario fixture): this is the app's home screen. */
export default function IssuesListPage(): JSX.Element {
  const [status, setStatus] = createSignal<IssueFilterStatus>('all');
  const [severity, setSeverity] = createSignal('');
  const [q, setQ] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [error, setError] = createSignal<string | undefined>(undefined);

  const [issues, { refetch }] = createResource(
    () => ({ status: status(), severity: severity(), q: q() }),
    (filters) => api.listIssues(filters),
  );

  async function createIssue(e: Event): Promise<void> {
    e.preventDefault();
    if (title().trim() === '') return;
    try {
      await api.createIssue({ title: title().trim(), description: '', severity: 'medium' });
      setTitle('');
      await refetch();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h2>Issues</h2>
      <form class="new-board-form" onSubmit={createIssue}>
        <input
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          placeholder="New issue title"
          data-testid="new-issue-title"
        />
        <button type="submit" data-testid="create-issue">
          Create issue
        </button>
      </form>

      <div class="control-row">
        <select value={status()} onChange={(e) => setStatus(e.currentTarget.value as IssueFilterStatus)} data-testid="filter-status">
          <option value="all">all statuses</option>
          <option value="open">open</option>
          <option value="closed">closed</option>
        </select>
        <select value={severity()} onChange={(e) => setSeverity(e.currentTarget.value)} data-testid="filter-severity">
          <option value="">all severities</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="critical">critical</option>
        </select>
        <input
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          placeholder="search title"
          data-testid="filter-search"
        />
      </div>

      <Show when={error()}>
        <p class="status-line err">{error()}</p>
      </Show>

      <Show when={!issues.loading} fallback={<p class="status-line">Loading…</p>}>
        <ul class="issue-list" data-testid="issue-list">
          <For each={issues() ?? []}>
            {(issue) => (
              <li class="issue-row">
                <A href={`/issues/${issue.id}`} data-testid={`issue-${issue.id}`}>
                  <span class={`pill severity-${issue.severity}`}>{issue.severity}</span>
                  <span class={`pill status-${issue.status}`}>{issue.status}</span>
                  <strong>{issue.title}</strong>
                </A>
                <span class="issue-meta">
                  #{issue.id.slice(0, 8)} · {issue.assignee}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <ActivityFeed />
    </div>
  );
}
