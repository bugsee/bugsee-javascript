import { type Interceptor, InterceptorBase } from '@bugsee/core';

// The browser NAVIGATION SOURCE — an EXTENSIBLE, listenable source of
// SPA navigations. Built-in detection (a route change the browser itself performs): PREFER the new
// Navigation API (`window.navigation`) when present, listening to its `currententrychange` event — it fires
// post-commit for EVERY same-document navigation (`pushState`/`replaceState`, fragment, back/forward, AND a
// cross-document navigation the app converted to client-side routing via `navigateEvent.intercept()`), and
// never for a genuine cross-document full load (that document unloads), so we read the already-updated
// `navigation.currentEntry.url`. FALLBACK (older engines / Safari before it shipped): patch
// `history.pushState`/`replaceState` (call the original FIRST, then emit — never block the app's nav) +
// listen `popstate` (back/forward) + `hashchange`. EXTENSIBLE: a framework adapter both subscribes
// (`on('navigate', …)`) and emits its OWN navigations via `startNavigation()` — for framework route
// changes that never switch the browser URL/origin/path (virtual/tab/modal/wizard routes, RSC transitions).
// Self-skips when the globals are absent (SSR / worker). Observe-only: a throwing listener / location /
// navigation-entry getter can never disrupt the application (the original History method already ran).

/** How a navigation was triggered. `programmatic` = an adapter-emitted (URL-less) navigation. */
export type NavigationType = 'push' | 'replace' | 'traverse' | 'hash' | 'reload' | 'programmatic';

export interface NavigationDetail {
  /** The destination — the new path (built-in: `location.pathname`) or the adapter-supplied name. */
  to: string;
  navigationType: NavigationType;
  /**
   * The absolute, UNSANITIZED address after the navigation (`location.href` / `navigation.currentEntry.url`). Present
   * only for built-in (`source: 'url'`) navigations whose address could be read; an adapter's programmatic navigation
   * has no address. A consumer that stores or uploads it MUST sanitize it (the `url` trace does).
   */
  href?: string;
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
  /** The full address; optional so a minimal environment (path only) still works. */
  readonly href?: string;
}
/** The `currententrychange` event — its `navigationType` ('push'|'replace'|'reload'|'traverse') reflects how
 *  the current entry changed; `null` means a state-only `updateCurrentEntry()` (not a navigation → skip). */
interface CurrentEntryChangeEventLike {
  readonly navigationType?: string | null;
}
/** The Navigation API (feature-detected). Its `currententrychange` event covers every same-document
 *  navigation post-commit; the destination URL is read from `currentEntry.url` (already updated when it fires). */
interface NavigationApiLike {
  addEventListener(
    type: 'currententrychange',
    listener: (event: CurrentEntryChangeEventLike) => void,
  ): void;
  removeEventListener(
    type: 'currententrychange',
    listener: (event: CurrentEntryChangeEventLike) => void,
  ): void;
  readonly currentEntry?: { readonly url?: string | null } | null;
}

/** Injected browser globals (defaults read the real ones; absent → the source self-skips). */
export interface NavigationEnv {
  history?: HistoryLike;
  target?: NavTarget;
  location?: LocationLike;
  navigation?: NavigationApiLike;
  /**
   * `true` = use ONLY the surfaces given here: a missing one is absent (the source self-skips) instead of borrowing the
   * host's global. Set when binding to an injected window, so a window without `history` never patches another's.
   */
  isolated?: boolean;
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

/** `location.href`, or undefined when absent, not a string, or a hostile getter throws (observe-only). */
const hrefOf = (location: LocationLike | undefined): string | undefined => {
  try {
    const href = location?.href;
    return typeof href === 'string' ? href : undefined;
  } catch {
    return undefined;
  }
};

/** The address only when it is ABSOLUTE (has a scheme): a bare path is not an href. */
const absoluteOf = (url: string | undefined): string | undefined =>
  typeof url === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) ? url : undefined;

const pathOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new (globalThis as unknown as { URL: new (u: string) => { pathname: string } }).URL(url)
      .pathname;
  } catch {
    return url; // already a path, or unparseable → use as-is
  }
};

/**
 * One History method wrapper a source installed: what it wrapped (`orig`) and whether its source is still active. Kept
 * for every wrapper any source installed, so a stopping source can unwind the dead wrappers on top of the chain.
 */
interface HistoryHook {
  orig: (...args: unknown[]) => unknown;
  isLive: () => boolean;
  owner: object;
  /** Called when this wrapper is unwound out of the chain. */
  release: () => void;
}
const hooks = new WeakMap<(...args: unknown[]) => unknown, HistoryHook>();

class BrowserNavigationSource extends InterceptorBase<{ navigate: NavigationDetail }> {
  readonly name = 'browser-navigation';
  readonly #history: HistoryLike | undefined;
  readonly #target: NavTarget | undefined;
  readonly #location: LocationLike | undefined;
  readonly #navigation: NavigationApiLike | undefined;
  #live = false;
  /** Per method: a wrapper of this source is already running (the outermost one emits, the rest only pass through). */
  readonly #inFlight = { pushState: false, replaceState: false };
  /** Per method: how many of this source's wrappers may still be somewhere in the chain (installed, not yet unwound). */
  readonly #installed = { pushState: 0, replaceState: 0 };

  readonly #onPopstate = (): void => this.#emitFromLocation('traverse');
  readonly #onHashchange = (): void => this.#emitFromLocation('hash');
  readonly #onCurrentEntryChange = (event: CurrentEntryChangeEventLike): void => {
    try {
      // A `null` navigationType is a state-only `updateCurrentEntry()` — not a navigation; skip it. The
      // `currentEntry.url` getter can throw (a hostile/exotic global) — the try makes that observe-only.
      const navType = event?.navigationType;
      if (navType === undefined || navType === null) return;
      const url = this.#navigation?.currentEntry?.url ?? undefined;
      this.#emit(pathOf(url), navTypeFor(navType), 'url', absoluteOf(url));
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
    href?: string,
  ): void {
    if (to === undefined) return;
    this.emit('navigate', { to, navigationType, source, ...(href !== undefined ? { href } : {}) });
  }

  #emitFromLocation(navigationType: NavigationType): void {
    try {
      // The `location.pathname` read can throw (a hostile getter) — it runs AFTER the original History
      // method (the app's nav already happened), so it must never throw back out into the app.
      this.#emit(this.#location?.pathname, navigationType, 'url', hrefOf(this.#location));
    } catch {
      // observe-only
    }
  }

  startNavigation(detail: { name: string; source?: 'route' | 'custom' }): void {
    // `detail.name` is a plain string and the emitter swallows subscriber throws, so this cannot throw.
    this.#emit(detail.name, 'programmatic', detail.source ?? 'custom');
  }

  /**
   * Wrap one History method (call the original FIRST, then emit). Every activation puts a FRESH wrapper on top of
   * whatever is there now (unless the top already is one of this source's own), and ALL of this source's wrappers stay
   * live for as long as the source is: only the OUTERMOST call of a source emits (an in-flight flag), so however many of
   * its wrappers a chain holds, one navigation is one event. That is what makes it safe when a third party restores a
   * function it saved earlier: whichever of our wrappers that puts back on top still emits.
   */
  #wrap(
    history: HistoryLike,
    method: 'pushState' | 'replaceState',
    type: 'push' | 'replace',
  ): void {
    const current = history[method];
    if (typeof current !== 'function' || hooks.get(current)?.owner === this) return;
    const hook: HistoryHook = {
      orig: current,
      isLive: () => this.#live,
      owner: this,
      release: () => {
        this.#installed[method] -= 1;
      },
    };
    const inFlight = this.#inFlight;
    const readHref = (): string | undefined => hrefOf(this.#location);
    const emit = (before: string | undefined): void => {
      // With an OLDER wrapper of ours possibly still in the chain beneath a third party that defers or skips calling the
      // function it saved, this (outermost) call can return before the navigation happened: the location is then still
      // the old one, and the older wrapper will emit the real navigation when it runs. Emitting now would report the old
      // location, and then the real one again. So an unchanged location emits nothing in that situation (a same-URL
      // `pushState` under such a wrapper is not reported: only a restart under a re-wrapping third party gets here).
      if (
        this.#installed[method] > 1 &&
        before !== undefined &&
        before === hrefOf(this.#location)
      ) {
        return;
      }
      if (this.#live) this.#emitFromLocation(type);
    };
    const installed = function (this: unknown, ...args: unknown[]): unknown {
      const outermost = !inFlight[method];
      inFlight[method] = true;
      const before = outermost ? readHref() : undefined;
      let completed = false;
      try {
        const result = hook.orig.apply(this, args); // the app's navigation happens FIRST (never blocked)
        completed = true;
        return result;
      } finally {
        if (outermost) {
          inFlight[method] = false;
          if (completed) emit(before); // a navigation that threw did not happen
        }
      }
    };
    this.#installed[method] += 1;
    hooks.set(installed, hook);
    history[method] = installed;
  }

  /**
   * Take our wrappers off a method once the source is stopped: starting from the TOP, drop every consecutive wrapper
   * whose source is inactive (ours, or another stopped source's). A wrapper of a live source, or anyone else's, ends the
   * unwinding: it is not ours to remove, and the dead ones beneath it stay as inert pass-throughs (an inactive source
   * never emits) until a later stop can unwind them.
   */
  #unwind(history: HistoryLike, method: 'pushState' | 'replaceState'): void {
    let target = history[method];
    for (
      let hook = hooks.get(target);
      hook !== undefined && !hook.isLive();
      hook = hooks.get(target)
    ) {
      hook.release(); // its owner (this source or another stopped one) has one wrapper fewer in the chain
      target = hook.orig;
    }
    if (target !== history[method]) history[method] = target;
  }

  protected onActivate(): void {
    this.#live = true;
    // Prefer the Navigation API: one `currententrychange` listener covers every same-document navigation.
    if (this.#navigation !== undefined) {
      this.#navigation.addEventListener('currententrychange', this.#onCurrentEntryChange);
      return;
    }
    if (this.#history !== undefined) {
      this.#wrap(this.#history, 'pushState', 'push');
      this.#wrap(this.#history, 'replaceState', 'replace');
    }
    this.#target?.addEventListener('popstate', this.#onPopstate);
    this.#target?.addEventListener('hashchange', this.#onHashchange);
  }

  protected override onDeactivate(): void {
    this.#live = false;
    if (this.#navigation !== undefined) {
      this.#navigation.removeEventListener('currententrychange', this.#onCurrentEntryChange);
    }
    if (this.#history !== undefined) {
      this.#unwind(this.#history, 'pushState');
      this.#unwind(this.#history, 'replaceState');
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
  if (env.isolated === true) {
    return new BrowserNavigationSource(env);
  }
  return new BrowserNavigationSource({
    history: env.history ?? g.history,
    target: env.target ?? g.window,
    location: env.location ?? g.location,
    navigation: env.navigation ?? g.navigation,
  });
}
