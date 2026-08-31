import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ExpenseService } from '../core/expense.service';
import type { ExpenseAttachment } from '../core/expense.model';
import { maxAmountWithoutNoteValidator } from './expense-validators';

const CATEGORIES = ['Travel', 'Meals', 'Software', 'Office supplies', 'Training'];

@Component({
  selector: 'app-new-expense',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './new-expense.component.html',
})
export class NewExpenseComponent {
  readonly #fb = inject(FormBuilder);
  readonly #expenseService = inject(ExpenseService);
  readonly #router = inject(Router);

  readonly categories = CATEGORIES;
  readonly attachment = signal<ExpenseAttachment | null>(null);
  readonly submitting = signal(false);
  readonly submitError = signal<string | null>(null);

  // A reactive form with field-level validators (required/minLength/min/max/pattern) AND a group-level
  // custom validator (`maxAmountWithoutNoteValidator`) — §5.6 "a reactive form with validation".
  readonly form = this.#fb.nonNullable.group(
    {
      title: ['', [Validators.required, Validators.minLength(3)]],
      amount: [0, [Validators.required, Validators.min(0.01), Validators.max(100_000)]],
      category: [CATEGORIES[0], [Validators.required]],
      date: [new Date().toISOString().slice(0, 10), [Validators.required]],
      notes: ['', [Validators.maxLength(500)]],
    },
    { validators: maxAmountWithoutNoteValidator(10_000) },
  );

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      this.attachment.set(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      this.attachment.set({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, dataBase64 });
    };
    reader.readAsDataURL(file);
  }

  clearAttachment(): void {
    this.attachment.set(null);
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.submitError.set(null);
    const value = this.form.getRawValue();
    this.#expenseService
      .create({ ...value, attachment: this.attachment() })
      .subscribe({
        next: (expense) => {
          this.submitting.set(false);
          void this.#router.navigate(['/expenses', expense.id]);
        },
        error: (err) => {
          this.submitting.set(false);
          this.submitError.set(err?.error?.message ?? 'failed to create expense');
        },
      });
  }
}
