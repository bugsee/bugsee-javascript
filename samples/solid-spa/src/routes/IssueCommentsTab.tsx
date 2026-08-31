import { For, Show, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import { useIssueContext } from './IssueDetailPage';

/** The `/comments` nested route under `/issues/:id`. */
export default function IssueCommentsTab(): JSX.Element {
  const issue = useIssueContext();
  const [author, setAuthor] = createSignal('sample-user');
  const [body, setBody] = createSignal('');
  const [comments, { refetch }] = createResource(() => issue()?.id, (id) => api.listComments(id));

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (body().trim() === '' || !issue()) return;
    await api.addComment(issue()!.id, author(), body().trim());
    setBody('');
    await refetch();
  }

  return (
    <div data-testid="issue-comments-tab">
      <Show when={!comments.loading} fallback={<p class="status-line">Loading comments…</p>}>
        <ul class="activity-feed" data-testid="comment-list">
          <For each={comments() ?? []}>
            {(c) => (
              <li>
                <strong>{c.author}:</strong> {c.body}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form class="new-board-form" onSubmit={submit}>
        <input value={author()} onInput={(e) => setAuthor(e.currentTarget.value)} data-testid="comment-author" />
        <input
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          placeholder="Add a comment"
          data-testid="comment-body"
        />
        <button type="submit" data-testid="submit-comment">
          Comment
        </button>
      </form>
    </div>
  );
}
