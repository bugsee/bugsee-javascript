import { ApplicationConfig, ErrorHandler, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { BugseeErrorHandler } from '@bugsee/angular';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    // Deliberately NOT `withFetch()` — the default HttpClient backend is `HttpXhrBackend`, riding on
    // native `XMLHttpRequest`. This is a DIFFERENT capture code path from `fetch()` (§5.6 "beyond the
    // catalog"): every expense/approval CRUD call in this app goes through HttpClient/XHR, while the
    // Scenario panel's S7 controls separately exercise raw `fetch` too.
    provideHttpClient(),
    // @bugsee/angular's documented primary wiring: replaces Angular's ErrorHandler, reporting every
    // uncaught error (component render, lifecycle hook, event handler, RxJS pipeline) to Bugsee and
    // then delegating to Angular's own default behavior (console.error) so nothing is silently lost.
    { provide: ErrorHandler, useClass: BugseeErrorHandler },
  ],
};
