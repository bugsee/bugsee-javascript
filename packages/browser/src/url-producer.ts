import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import { getOrCreateInterceptor } from '@bugsee/core';
import { sanitizeLocationUrl, TRUNCATED_URL_MARKER, TraceName } from '@bugsee/protocol';
import { reportGuarded } from '@bugsee/util';
import {
  createBrowserNavigationSource,
  type NavigationDetail,
  type NavigationSource,
} from './navigation-source';

// The `url` system trace (spec traces.md `url`): the page's own address, sanitized, as a held step curve. It is
// written from the browser NAVIGATION SOURCE (`navigate` events carry the absolute `href`), plus the location at start,
// so it is independent of the performance extension (which owns the source only when it is on).

/** The longest string a `urlSanitizer` result may be; longer is clipped and marked `%3Ctruncated%3E`. */
export const MAX_HOOK_RESULT_CHARS = 2048;

/**
 * The application's own sanitizer for the `url` trace. Runs AFTER the default sanitizer and receives the
 * already-sanitized URL; the string it returns is written as given (it is the application's responsibility not to
 * reintroduce what the default removed). Return `null` to write nothing for this URL. It is NOT a network filter.
 * A throw, or a non-string non-null result, is reported through `onError` and writes nothing (fails closed); in
 * every case where nothing is written the PREVIOUS value stays held (a held trace cannot be retracted). A result over
 * 2048 characters is clipped. The hook runs synchronously, so keep it cheap.
 */
export type UrlSanitizer = (url: string) => string | null;

export interface UrlProducerDeps {
  /** Listenable navigations (the browser navigation source). Subscribing activates it. */
  source: { on(stage: 'navigate', handler: (detail: NavigationDetail) => void): () => void };
  /** The current absolute address (`location.href`), or undefined when unreadable. Must not throw. */
  read: () => string | undefined;
  urlSanitizer?: UrlSanitizer;
  onError?: (error: unknown) => void;
}

export class UrlProducer extends TraceProducerBase implements TraceProducer {
  readonly name = 'url';
  readonly #deps: UrlProducerDeps;
  #off: (() => void) | undefined;

  constructor(deps: UrlProducerDeps) {
    super();
    this.#deps = deps;
  }

  protected onStart(): void {
    // Only the built-in detections carry an address; an adapter's programmatic navigation is a route name, not a URL.
    this.#off = this.#deps.source.on('navigate', (detail) => {
      if (detail.source === 'url') this.#write(detail.href);
    });
    this.#write(this.#deps.read());
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #write(href: string | undefined): void {
    if (href === undefined) return;
    try {
      let value = sanitizeLocationUrl(href);
      if (this.#deps.urlSanitizer !== undefined) {
        const custom: unknown = this.#deps.urlSanitizer(value);
        if (custom === null) return;
        if (typeof custom !== 'string') {
          throw new Error('Bugsee: urlSanitizer must return a string or null; nothing was written');
        }
        // Bounded like the default (which clips its INPUT at 8 KiB): the hook runs synchronously inside the app's own
        // `pushState`, and what it returns is uploaded as given, so an unbounded result is a bundle-size and
        // main-thread hazard.
        value =
          custom.length > MAX_HOOK_RESULT_CHARS
            ? custom.slice(0, MAX_HOOK_RESULT_CHARS) + TRUNCATED_URL_MARKER
            : custom;
      }
      this.emitIfChanged(TraceName.URL, value);
    } catch (error) {
      reportGuarded(this.#deps.onError, error); // never into the host; nothing is written
    }
  }
}

const hasFns = (value: unknown, ...names: string[]): boolean =>
  typeof value === 'object' &&
  value !== null &&
  names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');

interface WindowLike {
  history?: unknown;
  location?: { href?: unknown };
  navigation?: unknown;
}

/**
 * THE navigation source of one injected window, shared through the carrier under `browser-navigation`: every consumer
 * (the `url` trace, the umbrella's navigation transactions) gets the SAME instance, so `history` is patched once per
 * window and the consumers cannot unwind each other's wrappers (C23). It is `isolated` (only that window's surfaces, never
 * the host's), and each surface is passed only when it has the shape the source calls. The first caller's window wins,
 * as for every carrier-shared source. Returns undefined, reported through `onError`, when the window cannot be read;
 * never throws.
 */
export function navigationSourceFor(
  win: object | undefined,
  options: { carrier?: object; onError?: (error: unknown) => void } = {},
): NavigationSource | undefined {
  if (win === undefined) return undefined;
  try {
    const w = win as WindowLike;
    return getOrCreateInterceptor(
      'browser-navigation',
      () =>
        createBrowserNavigationSource({
          isolated: true,
          // Each surface only when it has the shape the source calls: a partial window (a test double, a minimal embed)
          // must lose that detection, never make activation throw.
          ...(hasFns(w.history, 'pushState', 'replaceState')
            ? { history: w.history as never }
            : {}),
          ...(hasFns(win, 'addEventListener', 'removeEventListener')
            ? { target: win as never }
            : {}),
          ...(w.location !== undefined ? { location: w.location as never } : {}),
          ...(hasFns(w.navigation, 'addEventListener', 'removeEventListener')
            ? { navigation: w.navigation as never }
            : {}),
        }),
      options.carrier,
    ) as NavigationSource;
  } catch (error) {
    reportGuarded(options.onError, error); // a cross-origin / torn-down window: no navigation source
    return undefined;
  }
}

/**
 * The producer's dependencies for ONE injected window: its navigation source (carrier-shared under
 * `browser-navigation`, so a relaunch or a second consumer reuses the instance that already patched `history`) and
 * a guarded reader of its `location.href`. The source is `isolated`: a window without `history` is not given the
 * host's. `urlSanitizer` is validated here, as a public option: anything but a function is IGNORED and reported.
 * Returns undefined (no `url` trace) when the window cannot be read at all; never throws.
 */
export function urlProducerDepsFor(
  win: object | undefined,
  options: { carrier?: object; urlSanitizer?: unknown; onError?: (error: unknown) => void },
): UrlProducerDeps | undefined {
  if (win === undefined) return undefined;
  const { urlSanitizer: rawSanitizer, onError } = options;
  let urlSanitizer: UrlSanitizer | undefined;
  if (typeof rawSanitizer === 'function') {
    urlSanitizer = rawSanitizer as UrlSanitizer;
  } else if (rawSanitizer !== undefined) {
    reportGuarded(
      onError,
      new Error(
        'Bugsee: urlSanitizer must be a function; it is ignored (the default sanitizer still applies)',
      ),
    );
  }
  const w = win as WindowLike;
  const source = navigationSourceFor(win, {
    ...(options.carrier !== undefined ? { carrier: options.carrier } : {}),
    ...(onError !== undefined ? { onError } : {}),
  });
  if (source === undefined) return undefined;
  return {
    source,
    read: () => {
      try {
        const href = w.location?.href;
        return typeof href === 'string' ? href : undefined;
      } catch (error) {
        reportGuarded(onError, error);
        return undefined;
      }
    },
    ...(urlSanitizer !== undefined ? { urlSanitizer } : {}),
    ...(onError !== undefined ? { onError } : {}),
  };
}
