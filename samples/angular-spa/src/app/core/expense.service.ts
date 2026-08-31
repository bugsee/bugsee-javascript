import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { ActivityEntry, Expense, ExpenseStatus, NewExpenseInput } from './expense.model';

// Every call below goes through Angular's HttpClient with the DEFAULT (XHR) backend — see
// app.config.ts's `provideHttpClient()` (no `withFetch()`). This is deliberately a DIFFERENT capture
// code path from `fetch()` (§5.6 "beyond the catalog": "HttpClient (XHR) network capture, which is a
// different code path from fetch"), exercised here by the app's real CRUD flows.
@Injectable({ providedIn: 'root' })
export class ExpenseService {
  readonly #http = inject(HttpClient);

  list(status?: ExpenseStatus): Observable<Expense[]> {
    const query = status ? `?status=${status}` : '';
    return this.#http.get<Expense[]>(`/api/expenses${query}`);
  }

  get(id: string): Observable<Expense> {
    return this.#http.get<Expense>(`/api/expenses/${id}`);
  }

  create(input: NewExpenseInput): Observable<Expense> {
    return this.#http.post<Expense>('/api/expenses', input);
  }

  setStatus(id: string, status: ExpenseStatus): Observable<Expense> {
    return this.#http.patch<Expense>(`/api/expenses/${id}`, { status });
  }

  update(id: string, patch: Partial<Expense>): Observable<Expense> {
    return this.#http.patch<Expense>(`/api/expenses/${id}`, patch);
  }

  delete(id: string): Observable<void> {
    return this.#http.delete<void>(`/api/expenses/${id}`);
  }

  categories(): Observable<string[]> {
    return this.#http.get<string[]>('/api/categories');
  }

  activity(): Observable<ActivityEntry[]> {
    return this.#http.get<ActivityEntry[]>('/api/activity');
  }
}
