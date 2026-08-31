import { bootstrapApplication } from '@angular/platform-browser';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { setRouteNameFromRouter } from '@bugsee/angular';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { getClient, launchApp } from './app/bugsee';

launchApp();

// Expose for manual console poking + the Playwright verify script (see scripts/verify.mjs), which reads
// window.__bugsee to probe SDK state directly (e.g. the active performance transaction) instead of
// scraping the DOM. A GETTER, not a captured reference: S1's relaunch controls swap the module-level
// client for a brand-new instance (bugsee.ts's `relaunch()`) — capturing `client` here once would go
// stale across a relaunch the exact same way the sample's own F-0 bug did (see FINDINGS.md), so this
// always resolves fresh via `getClient()`.
Object.defineProperty(window, '__bugsee', { get: () => getClient(), configurable: true });

bootstrapApplication(AppComponent, appConfig)
  .then((appRef) => {
    // @bugsee/angular router naming: names the active navigation transaction by the matched route
    // PATTERN (`/approvals/:id`), never the concrete URL — wired once after the router is ready, the
    // user owns the NavigationEnd filter (per router.ts's documented wiring recipe).
    const router = appRef.injector.get(Router);
    router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe(() => {
      setRouteNameFromRouter(router);
    });
  })
  .catch((err) => console.error(err));
