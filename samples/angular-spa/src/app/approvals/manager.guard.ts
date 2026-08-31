import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { isManager } from '../core/manager-state';

/**
 * §5.6 "beyond the catalog": a route guard on the lazy-loaded `/approvals` feature. Not a manager?
 * redirect back to `/expenses` (with `?denied=approvals` so the app can show a banner) instead of
 * activating the route — the guard-redirect fixture `setRouteNameFromRouter` + `routePatternFromSnapshot`
 * must handle correctly (the navigation that actually completes is the REDIRECT target, not `/approvals`).
 */
export const managerGuard: CanActivateFn = () => {
  if (isManager()) return true;
  const router = inject(Router);
  return router.createUrlTree(['/expenses'], { queryParams: { denied: 'approvals' } });
};
