import type { Comment, Issue } from '../types';

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new Error(`${res.status} ${message}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface IssueFilters {
  status?: IssueFilterStatus;
  severity?: string;
  q?: string;
}
export type IssueFilterStatus = 'all' | 'open' | 'closed';

function queryString(filters: IssueFilters): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const api = {
  listIssues: (filters: IssueFilters = {}): Promise<Issue[]> => req(`/issues${queryString(filters)}`),
  createIssue: (input: Pick<Issue, 'title' | 'description' | 'severity'>): Promise<Issue> =>
    req('/issues', { method: 'POST', body: JSON.stringify(input) }),
  getIssue: (id: string): Promise<Issue> => req(`/issues/${id}`),
  updateIssue: (id: string, patch: Partial<Issue>): Promise<Issue> =>
    req(`/issues/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  // Deliberately errors for the "not found" case so the sample can demonstrate a createResource
  // fetcher that throws (docs/samples/PLAN.md §5.5 "an error inside a createResource").
  getIssueOrThrow: (id: string): Promise<Issue> => req(`/issues/${id}`),
  listComments: (issueId: string): Promise<Comment[]> => req(`/issues/${issueId}/comments`),
  addComment: (issueId: string, author: string, body: string): Promise<Comment> =>
    req(`/issues/${issueId}/comments`, { method: 'POST', body: JSON.stringify({ author, body }) }),
};

// ---- Scenario-panel network fixtures (S7) ---------------------------------------------------------
export const scenarioApi = {
  get: (): Promise<unknown> => req('/scenario/get'),
  postJson: (body: unknown): Promise<unknown> =>
    req('/scenario/echo', { method: 'POST', body: JSON.stringify(body) }),
  postText: (text: string): Promise<string> =>
    fetch(`${BASE}/scenario/echo-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    }).then((r) => r.text()),
  get4xx: (): Promise<Response> => fetch(`${BASE}/scenario/4xx`),
  get5xx: (): Promise<Response> => fetch(`${BASE}/scenario/5xx`),
  getNoContentType: (): Promise<Response> => fetch(`${BASE}/scenario/no-content-type`),
  getLargeBody: (): Promise<Response> => fetch(`${BASE}/scenario/large-body`),
  getConnectionFailure: (): Promise<Response> =>
    // Nothing listens on 5399 — a genuine connection-refused, not a fabricated error.
    fetch('http://localhost:5399/nope'),
  getSlow: (ms: number): Promise<Response> => fetch(`${BASE}/scenario/slow?ms=${ms}`),
  // S8 network-filter fixtures: a secret header + a secret body field the filter must strip/redact
  // before the event reaches the capture ring, and a URL the filter vetoes outright.
  postSecret: (): Promise<Response> =>
    fetch(`${BASE}/scenario/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-secret-token': 'sk_live_should_not_leave_device' },
      body: JSON.stringify({ ssn: '123-45-6789', note: 'ordinary field, not redacted' }),
    }),
  getVetoTarget: (): Promise<Response> => fetch(`${BASE}/scenario/get?veto-me=1`),
  getEchoHeaders: (): Promise<Record<string, string>> => req('/scenario/echo-headers'),
  // F-1 (major, see FINDINGS.md): a filter that vetoes on a REQUEST-BODY marker only present on the
  // `before` NetworkStage. The server's response is a FIXED body unrelated to the request (does not
  // echo it back), so the veto hole is visible without any echo-based confusion.
  postVetoRequestBody: (): Promise<Response> =>
    fetch(`${BASE}/scenario/veto-body-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vetoMarker: 'VETO_REQUEST_BODY_FIELD', otherField: 'irrelevant' }),
    }),
  // Finding C (major, see FINDINGS.md): a sensitive-looking query param the DEFAULT sanitizer would
  // normally redact (packages/protocol/src/url.ts's denylist matches `token`) — demonstrates that
  // installing ANY network filter silently disables that sanitizer entirely.
  getWithSensitiveUrlToken: (): Promise<Response> =>
    fetch(`${BASE}/scenario/get?token=SUPER_SECRET_TOKEN_VALUE`),
  /**
   * `navigator.sendBeacon` — the network transport `@bugsee/capture` gained a dedicated interceptor for
   * (`packages/capture/src/send-beacon-interceptor.ts`, wired into `installNetworkCapture`). It is inert
   * unless an app actually calls it, and this sample called it nowhere, so the leaf had ZERO coverage
   * here: S7 claimed to exercise the network umbrella while one of its transports was never touched.
   *
   * BOTH payload branches are fired, because the interceptor treats them differently and only one of
   * them can carry a body into the bundle:
   *   - a STRING payload is synchronously readable, so the captured entry carries the body;
   *   - a Blob is readable only asynchronously, so the interceptor records `no_body_reason:
   *     "cant_read_data"` rather than blocking on it or guessing (`send-beacon-interceptor.ts`:28-29,
   *     170-171) — deliberate, and the same "interceptors must not alter app behaviour" rule that
   *     shaped the bounded-read fetch body path. It still lifts the Blob's `type` into the
   *     Content-Type header so the downstream gate keeps working.
   *
   * Returns sendBeacon's own booleans (did the UA accept each payload for queueing) so the control can
   * report a real outcome rather than "no throw" — a beacon is fire-and-forget, there is no response to
   * read back, and the wire evidence is the outgoing request plus the entry in network.json.
   */
  sendBeacon: (marker: string): { stringAccepted: boolean; blobAccepted: boolean } => ({
    stringAccepted: navigator.sendBeacon(`${BASE}/scenario/echo`, JSON.stringify({ beacon: marker })),
    blobAccepted: navigator.sendBeacon(
      `${BASE}/scenario/echo`,
      new Blob([JSON.stringify({ beaconBlob: marker })], { type: 'application/json' }),
    ),
  }),
};
