import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ExpenseService } from '../core/expense.service';
import type { Expense } from '../core/expense.model';

@Component({
  selector: 'app-approvals-list',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './approvals-list.component.html',
})
export class ApprovalsListComponent implements OnInit {
  readonly #expenseService = inject(ExpenseService);
  readonly pending = signal<Expense[]>([]);
  readonly loading = signal(true);

  ngOnInit(): void {
    this.#expenseService.list('pending').subscribe({
      next: (list) => {
        this.pending.set(list);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  decide(id: string, status: 'approved' | 'rejected'): void {
    this.#expenseService.setStatus(id, status).subscribe(() => {
      this.pending.update((list) => list.filter((e) => e.id !== id));
    });
  }
}
