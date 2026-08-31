import { Component, OnInit, AfterViewInit, signal, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { createBugseeRenderTracker } from '@bugsee/angular';
import { ExpenseService } from '../core/expense.service';
import type { Expense } from '../core/expense.model';
import { ActivityFeedComponent } from '../shared/activity-feed.component';

@Component({
  selector: 'app-expenses-list',
  standalone: true,
  imports: [RouterLink, ActivityFeedComponent],
  templateUrl: './expenses-list.component.html',
})
export class ExpensesListComponent implements OnInit, AfterViewInit {
  readonly #expenseService = inject(ExpenseService);
  readonly #route = inject(ActivatedRoute);
  readonly expenses = signal<Expense[]>([]);
  readonly loading = signal(true);
  // Set when `managerGuard` redirected a non-manager away from /approvals (§5.6 guard-redirect fixture).
  readonly denied = signal<string | null>(this.#route.snapshot.queryParamMap.get('denied'));

  // §5.6 "beyond the catalog": createBugseeRenderTracker brackets ngOnInit → ngAfterViewInit with a
  // `ui.render` 'mount' span on the active transaction — the Angular counterpart to React's <Profiler>.
  readonly #render = createBugseeRenderTracker('ExpensesList');

  ngOnInit(): void {
    this.#render.start();
    this.#expenseService.list().subscribe({
      next: (list) => {
        this.expenses.set(list);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  ngAfterViewInit(): void {
    this.#render.end();
  }

  formatAmount(amount: number): string {
    return `$${amount.toFixed(2)}`;
  }
}
