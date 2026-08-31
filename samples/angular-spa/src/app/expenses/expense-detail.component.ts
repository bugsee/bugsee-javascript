import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ExpenseService } from '../core/expense.service';
import type { Expense } from '../core/expense.model';

@Component({
  selector: 'app-expense-detail',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './expense-detail.component.html',
})
export class ExpenseDetailComponent implements OnInit {
  readonly #route = inject(ActivatedRoute);
  readonly #expenseService = inject(ExpenseService);
  readonly #router = inject(Router);

  readonly expense = signal<Expense | null>(null);
  readonly notFound = signal(false);
  readonly attachmentUrl = signal<string | null>(null);

  ngOnInit(): void {
    const id = this.#route.snapshot.paramMap.get('id');
    if (!id) return;
    this.#expenseService.get(id).subscribe({
      next: (e) => {
        this.expense.set(e);
        if (e.attachment) {
          const bytes = Uint8Array.from(atob(e.attachment.dataBase64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: e.attachment.mimeType });
          this.attachmentUrl.set(URL.createObjectURL(blob));
        }
      },
      error: () => this.notFound.set(true),
    });
  }

  delete(): void {
    const e = this.expense();
    if (!e) return;
    this.#expenseService.delete(e.id).subscribe(() => void this.#router.navigate(['/expenses']));
  }
}
