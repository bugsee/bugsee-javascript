// S7 network-capture fixtures — deliberately RAW `fetch`/`XMLHttpRequest`, not Angular's HttpClient
// (the app's real CRUD flows already exercise HttpClient/XHR — see core/expense.service.ts and
// app.config.ts's `provideHttpClient()` comment). Mirrors samples/react-spa/src/api/client.ts's
// scenarioApi 1:1 so the two samples' scenarios.md read the same way.
const BASE = '/api';
// The API server's OWN origin (`server/api-server.mjs`, PORT default 5336). Everything else in this
// file goes through the relative `/api` path, which `proxy.conf.json` proxies to that same server —
// same-origin from the browser's point of view. S10 needs the cross-origin view of the same routes
// (see `getEchoHeadersCrossOrigin*` below), which is what this constant is for.
const API_ORIGIN = 'http://localhost:5336';

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
    // Nothing listens on 5398 — a genuine connection-refused, not a fabricated error.
    fetch('http://localhost:5398/nope'),
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
  // S10: the SDK's fetch interceptor stamps an outbound `traceparent` header; the server echoes back
  // every header it received so the client can confirm the header actually left the process.
  //
  // THREE probes, because the same-origin one alone cannot falsify `tracePropagationTargets`:
  // `createTraceparentDecorator` (packages/capture/src/traceparent.ts:136-142) returns `true` for any
  // SAME-ORIGIN url BEFORE the allowlist is consulted, so with `/api` proxied by the dev server this
  // request would be decorated even with `tracePropagationTargets` deleted or set to match nothing.
  // The allowlist only governs CROSS-ORIGIN urls — hence the two direct calls to the API server's own
  // origin below (`ng serve` is :5306, `server/api-server.mjs` is :5336, so they are cross-origin),
  // one matching `/api/` and one not.
  getEchoHeaders: (): Promise<Record<string, string>> => req('/scenario/echo-headers'),
  // Cross-origin AND matching `tracePropagationTargets: ['/api/']` -> must be decorated.
  getEchoHeadersCrossOriginAllowed: (): Promise<Record<string, string>> =>
    fetch(`${API_ORIGIN}/api/scenario/echo-headers`).then((r) => r.json() as Promise<Record<string, string>>),
  // Cross-origin and NOT matching (no `/api/` anywhere in the url) -> must NOT be decorated.
  getEchoHeadersCrossOriginBlocked: (): Promise<Record<string, string>> =>
    fetch(`${API_ORIGIN}/echo-headers-unmatched`).then((r) => r.json() as Promise<Record<string, string>>),
};
