import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'expenses' },
  {
    path: 'expenses',
    loadComponent: () => import('./expenses/expenses-list.component').then((m) => m.ExpensesListComponent),
  },
  {
    path: 'expenses/new',
    loadComponent: () => import('./expenses/new-expense.component').then((m) => m.NewExpenseComponent),
  },
  {
    path: 'expenses/:id',
    loadComponent: () => import('./expenses/expense-detail.component').then((m) => m.ExpenseDetailComponent),
  },
  // A lazy-loaded FEATURE (its own route table + guard), loaded only when the user navigates here —
  // §5.6 "beyond the catalog": Angular Router with lazy-loaded feature modules and route guards.
  {
    path: 'approvals',
    loadChildren: () => import('./approvals/approvals.routes').then((m) => m.APPROVALS_ROUTES),
  },
  {
    path: 'settings',
    loadComponent: () => import('./settings/settings.component').then((m) => m.SettingsComponent),
  },
  {
    path: 'scenarios',
    loadComponent: () => import('./scenarios/scenario-panel.component').then((m) => m.ScenarioPanelComponent),
  },
  {
    path: '**',
    loadComponent: () => import('./shared/not-found.component').then((m) => m.NotFoundComponent),
  },
];
