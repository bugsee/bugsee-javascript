import type { Board, BoardDetail, Card, List } from '../types';

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

export const api = {
  listBoards: (): Promise<Board[]> => req('/boards'),
  createBoard: (title: string): Promise<Board> =>
    req('/boards', { method: 'POST', body: JSON.stringify({ title }) }),
  getBoard: (id: string): Promise<BoardDetail> => req(`/boards/${id}`),
  createList: (boardId: string, title: string): Promise<List> =>
    req('/lists', { method: 'POST', body: JSON.stringify({ boardId, title }) }),
  createCard: (boardId: string, listId: string, title: string): Promise<Card> =>
    req('/cards', { method: 'POST', body: JSON.stringify({ boardId, listId, title }) }),
  updateCard: (id: string, patch: Partial<Card>): Promise<Card> =>
    req(`/cards/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteCard: (id: string): Promise<void> => req(`/cards/${id}`, { method: 'DELETE' }),
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
  getEchoHeaders: (): Promise<Record<string, string>> => req('/scenario/echo-headers'),
};
