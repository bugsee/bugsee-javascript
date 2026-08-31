// Whether the current user is acting as a manager (can see /approvals). Backed by localStorage so a
// hard reload keeps the choice — used by both the nav toggle and `manager.guard.ts` (the guard-redirect
// fixture: navigating to /approvals while NOT a manager must redirect back to /expenses).
const KEY = 'bugsee-sample-angular.isManager';

export function isManager(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

export function setManager(value: boolean): void {
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // best-effort; a private-browsing tab just won't remember the choice
  }
}
