import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ExpenseService } from '../core/expense.service';
import type { Expense } from '../core/expense.model';

@Component({
  selector: 'app-approval-detail',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './approval-detail.component.html',
})
export class ApprovalDetailComponent implements OnInit {
  readonly #route = inject(ActivatedRoute);
  readonly #expenseService = inject(ExpenseService);
  readonly #router = inject(Router);

  readonly expense = signal<Expense | null>(null);

  ngOnInit(): void {
    const id = this.#route.snapshot.paramMap.get('id');
    if (!id) return;
    this.#expenseService.get(id).subscribe((e) => this.expense.set(e));
  }

  decide(status: 'approved' | 'rejected'): void {
    const e = this.expense();
    if (!e) return;
    this.#expenseService.setStatus(e.id, status).subscribe(() => void this.#router.navigate(['/approvals']));
  }
}
