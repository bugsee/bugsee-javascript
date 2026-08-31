import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/** A custom validator (beyond Angular's built-ins) — a business rule: no single expense over $10,000
 *  without a note explaining it. Exercises the reactive-form validation surface the plan calls for. */
export function maxAmountWithoutNoteValidator(limit: number): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const amount = Number(group.get('amount')?.value);
    const notes = String(group.get('notes')?.value ?? '');
    if (Number.isFinite(amount) && amount > limit && notes.trim().length === 0) {
      return { largeAmountNeedsNote: { limit } };
    }
    return null;
  };
}
