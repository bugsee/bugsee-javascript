import { For, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import { useIssueContext } from './IssueDetailPage';

/** The default (index) nested route under `/issues/:id`. */
export default function IssueOverviewTab(): JSX.Element {
  const issue = useIssueContext();
  const [status, setStatus] = createSignal(issue()?.status ?? 'open');

  async function toggleStatus(): Promise<void> {
    const next = status() === 'open' ? 'closed' : 'open';
    await api.updateIssue(issue()!.id, { status: next });
    setStatus(next);
  }

  return (
    <div data-testid="issue-overview-tab">
      <p>{issue()?.description || 'No description.'}</p>
      <div class="control-row">
        <For each={issue()?.labels ?? []}>{(l) => <span class="pill">{l}</span>}</For>
      </div>
      <div class="control-row">
        <button data-testid="toggle-status" onClick={() => void toggleStatus()}>
          Mark as {status() === 'open' ? 'closed' : 'open'}
        </button>
      </div>
    </div>
  );
}
