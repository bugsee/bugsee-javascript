import { type Interceptor, InterceptorBase } from '@bugsee/core';

// The browser NAVIGATION SOURCE (frontend-adapters design D2/D10) — an EXTENSIBLE, listenable source of
// SPA navigations. Built-in detection (a route change the browser itself performs): patch
// `history.pushState`/`replaceState` (call the original FIRST, then emit — never block the app's nav),
// listen `popstate` (back/forward) + `hashchange`; OR, when the Navigation API is present, use its single
// `navigate` event instead (it covers all of the above). EXTENSIBLE: a framework adapter both subscribes
// (`on('navigate', …)`) and emits its OWN navigations via `startNavigation()` — for framework route
// changes that never switch the browser URL/origin/path (virtual/tab/modal/wizard routes, RSC transitions).
// Self-skips when the globals are absent (SSR / worker). Observe-only: a throwing listener / location /
// navigate-event can never disrupt the application (the original History method already ran).

/** How a navigation was triggered. `programmatic` = an adapter-emitted (URL-less) navigation. */
export type NavigationType = 'push' | 'replace' | 'traverse' | 'hash' | 'reload' | 'programmatic';

export interface NavigationDetail {
  /** The destination — the new path (built-in: `location.pathname`) or the adapter-supplied name. */
  to: string;
  navigationType: NavigationType;
  /** Provenance for the transaction name (Sentry `source` attr): `url` (built-in, raw) vs `route`/`custom`
   *  (an adapter-supplied, parameterized/named navigation). */
  source: 'url' | 'route' | 'custom';
}

/** The minimal History surface we patch (call the original, then emit). */
interface HistoryLike {
  pushState(...args: unknown[]): unknown;
  replaceState(...args: unknown[]): unknown;
}
/** The event target (window) for popstate/hashchange. */
interface NavTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
/** The current location — read for the destination path. */
interface LocationLike {
  readonly pathname: string;
}
interface NavigateEventLike {
  readonly navigationType?: string;
  readonly destination?: { readonly url?: string };
}
/** The Navigation API (feature-detected); its `navigate` event covers History + popstate + hashchange. */
interface NavigationApiLike {
  addEventListener(type: 'navigate', listener: (event: NavigateEventLike) => void): void;
  removeEventListener(type: 'navigate', listener: (event: NavigateEventLike) => void): void;
}

/** Injected browser globals (defaults read the real ones; absent → the source self-skips). */
export interface NavigationEnv {
  history?: HistoryLike;
  target?: NavTarget;
  location?: LocationLike;
  navigation?: NavigationApiLike;
}

/** The navigation source: a listenable `navigate` emitter + the adapter-facing `startNavigation` seam. */
export interface NavigationSource extends Interceptor<{ navigate: NavigationDetail }> {
  /** Emit a programmatic navigation — an adapter's route change that did not switch the browser URL. */
  startNavigation(detail: { name: string; source?: 'route' | 'custom' }): void;
}

const navTypeFor = (raw: string | undefined): NavigationType => {
  switch (raw) {
    case 'push':
    case 'replace':
    case 'reload':
    case 'traverse':
      return raw;
    default:
      return 'push';
  }
};

const pathOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new (globalThis as unknown as { URL: new (u: string) => { pathname: string } }).URL(url)
      .pathname;
  } catch {
    return url; // already a path, or unparseable → use as-is
  }
};

class BrowserNavigationSource extends InterceptorBase<{ navigate: NavigationDetail }> {
  readonly name = 'browser-navigation';
  readonly #history: HistoryLike | undefined;
  readonly #target: NavTarget | undefined;
  readonly #location: LocationLike | undefined;
  readonly #navigation: NavigationApiLike | undefined;
  #origPush: HistoryLike['pushState'] | undefined;
  #origReplace: HistoryLike['replaceState'] | undefined;

  readonly #onPopstate = (): void => this.#emitFromLocation('traverse');
  readonly #onHashchange = (): void => this.#emitFromLocation('hash');
  readonly #onNavigate = (event: NavigateEventLike): void => {
    try {
      // The destination read can throw (a hostile getter) — it must never break the app's navigation.
      this.#emit(pathOf(event?.destination?.url), navTypeFor(event?.navigationType), 'url');
    } catch {
      // observe-only
    }
  };

  constructor(env: NavigationEnv) {
    super();
    this.#history = env.history;
    this.#target = env.target;
    this.#location = env.location;
    this.#navigation = env.navigation;
  }

  /** The bare emit. A throwing SUBSCRIBER is already swallowed by the emitter (`#dispatch`), so this needs
   * no guard of its own; the CALLERS guard the `to`-computation (a hostile location/destination getter). */
  #emit(
    to: string | undefined,
    navigationType: NavigationType,
    source: NavigationDetail['source'],
  ): void {
    if (to === undefined) return;
    this.emit('navigate', { to, navigationType, source });
  }

  #emitFromLocation(navigationType: NavigationType): void {
    try {
      // The `location.pathname` read can throw (a hostile getter) — it runs AFTER the original History
      // method (the app's nav already happened), so it must never throw back out into the app.
      this.#emit(this.#location?.pathname, navigationType, 'url');
    } catch {
      // observe-only
    }
  }

  startNavigation(detail: { name: string; source?: 'route' | 'custom' }): void {
    // `detail.name` is a plain string and the emitter swallows subscriber throws, so this cannot throw.
    this.#emit(detail.name, 'programmatic', detail.source ?? 'custom');
  }

  protected onActivate(): void {
    // Prefer the Navigation API (one event covers History + popstate + hashchange) when present.
    if (this.#navigation !== undefined) {
      this.#navigation.addEventListener('navigate', this.#onNavigate);
      return;
    }
    if (this.#history !== undefined) {
      const history = this.#history;
      this.#origPush = history.pushState;
      this.#origReplace = history.replaceState;
      const orig = { push: this.#origPush, replace: this.#origReplace };
      const self = this;
      history.pushState = function (this: unknown, ...args: unknown[]): unknown {
        const result = orig.push.apply(this, args); // the app's navigation happens FIRST (never blocked)
        self.#emitFromLocation('push');
        return result;
      };
      history.replaceState = function (this: unknown, ...args: unknown[]): unknown {
        const result = orig.replace.apply(this, args);
        self.#emitFromLocation('replace');
        return result;
      };
    }
    this.#target?.addEventListener('popstate', this.#onPopstate);
    this.#target?.addEventListener('hashchange', this.#onHashchange);
  }

  protected override onDeactivate(): void {
    if (this.#navigation !== undefined) {
      this.#navigation.removeEventListener('navigate', this.#onNavigate);
    }
    if (
      this.#history !== undefined &&
      this.#origPush !== undefined &&
      this.#origReplace !== undefined
    ) {
      this.#history.pushState = this.#origPush;
      this.#history.replaceState = this.#origReplace;
      this.#origPush = undefined;
      this.#origReplace = undefined;
    }
    this.#target?.removeEventListener('popstate', this.#onPopstate);
    this.#target?.removeEventListener('hashchange', this.#onHashchange);
  }
}

const g = globalThis as unknown as {
  history?: HistoryLike;
  window?: NavTarget;
  location?: LocationLike;
  navigation?: NavigationApiLike;
};

/** Build the navigation source over the real browser globals (each overridable / absent → self-skip). */
export function createBrowserNavigationSource(env: NavigationEnv = {}): NavigationSource {
  return new BrowserNavigationSource({
    history: env.history ?? g.history,
    target: env.target ?? g.window,
    location: env.location ?? g.location,
    navigation: env.navigation ?? g.navigation,
  });
}
