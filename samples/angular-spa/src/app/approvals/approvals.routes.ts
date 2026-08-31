import { Routes } from '@angular/router';
import { managerGuard } from './manager.guard';

// The lazy-loaded APPROVALS feature (§5.6 "beyond the catalog": "Angular Router with lazy-loaded
// feature modules and route guards") — this whole file, and everything it imports, is only fetched
// when the user actually navigates to /approvals (see app.routes.ts's `loadChildren`).
export const APPROVALS_ROUTES: Routes = [
  {
    path: '',
    canActivate: [managerGuard],
    loadComponent: () => import('./approvals-list.component').then((m) => m.ApprovalsListComponent),
  },
  {
    path: ':id',
    canActivate: [managerGuard],
    loadComponent: () => import('./approval-detail.component').then((m) => m.ApprovalDetailComponent),
  },
];
