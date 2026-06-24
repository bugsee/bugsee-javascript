import { type AdapterClientOptions, recordRenderSpan } from '@bugsee/web-adapter';

// @bugsee/angular RENDER SPANS (frontend-adapters depth pass — the Angular counterpart to React's <Profiler>
// / Vue's render mixin). A per-component tracker that records a `ui.render` 'mount' span on the active
// transaction, bracketing a component's `ngOnInit` (init, before the view exists) → `ngAfterViewInit` (the
// view + its children are initialized). A STRUCTURAL PEER — NO `@angular/core` import: the app owns the
// lifecycle hooks and calls `start()`/`end()` from them, so this stays version-agnostic AND avoids the
// Angular-Package-Format (ng-packagr) build a real `@Directive` would require to work in a consumer's AOT
// build. OPT-IN per component; observe-only + a no-op when no transaction is active / no SDK.
//
//   @Component(...)
//   export class UserProfileComponent implements OnInit, AfterViewInit {
//     private readonly render = createBugseeRenderTracker('UserProfile');
//     ngOnInit() { this.render.start(); }
//     ngAfterViewInit() { this.render.end(); }
//   }

export interface AngularRenderTrackerOptions extends AdapterClientOptions {
  /** Injectable epoch-ms clock. Default `performance.timeOrigin + performance.now()`. */
  now?: () => number;
}

/** A per-component render tracker: `start()` in ngOnInit, `end()` in ngAfterViewInit. */
export interface BugseeRenderTracker {
  start(): void;
  end(): void;
}

const defaultNow = (): number => {
  const perf = (globalThis as { performance?: { now?: () => number; timeOrigin?: number } })
    .performance;
  return (perf?.timeOrigin ?? 0) + (perf?.now?.() ?? 0);
};

/** Create a render tracker for a component. Records ONE `ui.render` 'mount' span per start→end pair. */
export function createBugseeRenderTracker(
  componentName: string,
  options: AngularRenderTrackerOptions = {},
): BugseeRenderTracker {
  const now = options.now ?? defaultNow;
  let startMs: number | undefined;
  return {
    start(): void {
      startMs = now();
    },
    end(): void {
      if (startMs === undefined) return; // end() with no matching start() — nothing to record
      const start = startMs;
      startMs = undefined; // consume the start (a second end() is a no-op)
      recordRenderSpan(
        { name: componentName, startTimestampMs: start, endTimestampMs: now(), phase: 'mount' },
        { getClient: options.getClient },
      );
    },
  };
}
