// Thin fetch wrapper for the local habit-tracker API. Deliberately plain `fetch` (not axios/etc.) so
// @bugsee/svelte's inherited @bugsee/browser network capture (S7) intercepts it the same way it would
// intercept any real app's calls.
import type { Habit } from '../types';

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).message)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  listHabits: (): Promise<Habit[]> => req('/habits'),
  getHabit: (id: string): Promise<Habit> => req(`/habits/${id}`),
  createHabit: (input: { name: string; category: string; color: string; targetPerWeek: number }): Promise<Habit> =>
    req('/habits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  deleteHabit: (id: string): Promise<void> => req(`/habits/${id}`, { method: 'DELETE' }),
  toggleCheckin: (id: string, date: string): Promise<Habit> =>
    req(`/habits/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    }),
};
