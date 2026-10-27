import { InterceptorBase } from './interceptor-base';

// The SCREEN tracker (design §15; Android `BugseeTrackerUI`'s "what is the user looking at" half): the domain owner of
// the application's current ROUTE and VIEW. Unlike the other trackers it owns no host API: nothing observes a router
// from outside, so the values are PUSHED in (the framework adapters' router hooks and the application's
// `client.setRoute` / `client.setView`), already sanitized and bounded by the caller. It is runtime-portable and one
// instance is shared per process carrier, so the client that receives the calls and the `route` / `view` trace
// producer that listens (possibly created in a different tier) see the same state, and a relaunch inherits it.
//
// RETENTION RULE. There is nothing to attach or release, so activation is a no-op; the last value of each channel is
// always retained, and a subscriber that arrives later reads it with `currentRoute()` / `currentView()` at once.
// Both channels announce only a CHANGE (a repeat is dropped here, so a producer need not).

/** The wire `view` object, structurally (the tracker is below `@bugsee/protocol`). */
export interface ScreenViewObject {
  name: string;
  type?: string;
}
/** A view: the object, or the string `$$none` (no view). */
export type ScreenView = ScreenViewObject | string;

export interface ScreenEvents {
  route: { route: string };
  view: { view: ScreenView };
}

const sameView = (a: ScreenView | undefined, b: ScreenView): boolean =>
  typeof a === 'string' || typeof b === 'string'
    ? a === b
    : a !== undefined && a.name === b.name && a.type === b.type;

export class ScreenTracker extends InterceptorBase<ScreenEvents> {
  readonly name = 'screen';
  #route: string | undefined;
  #view: ScreenView | undefined;

  /** `onListenerError` receives a subscriber that throws; the other subscribers still run. */
  constructor(onListenerError?: (error: unknown) => void) {
    super(onListenerError);
  }

  /** No host resource to attach. */
  protected onActivate(): void {}

  currentRoute(): string | undefined {
    return this.#route;
  }

  currentView(): ScreenView | undefined {
    return this.#view;
  }

  /** Hold `route` and announce it, unless it is the route already held. */
  setRoute(route: string): void {
    if (route === this.#route) return;
    this.#route = route; // committed before announcing, so a throwing subscriber cannot lose it
    this.emit('route', { route });
  }

  /** Hold `view` and announce it, unless it is the view already held (compared by content). */
  setView(view: ScreenView): void {
    if (sameView(this.#view, view)) return;
    this.#view = view;
    this.emit('view', { view });
  }
}
