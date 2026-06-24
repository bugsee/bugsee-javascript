import { type Interceptor, InterceptorBase } from '@bugsee/core';
import { componentNameFromElement } from './component-name';
import { describeTarget } from './input-source';

// The browser INTERACTION SOURCE (frontend-adapters F4 / D6) — an extensible, listenable source of
// discrete user interactions derived from the Event Timing API. A `PerformanceObserver({type:'event'})`
// observes pointer/keyboard events; events of one interaction share an `interactionId` (the INP unit), so
// we emit ONE `interact` per interaction whose latency passes the threshold. @bugsee/performance turns
// each into a short `ui.interaction` transaction (its async tail captured by the idle/activity window).
// Self-skips when the Event Timing API is unsupported (older Firefox/Safari). Observe-only: the target
// read goes through `describeTarget` (its own try/catch) and the entry fields are plain values, so the
// async observer callback can never disrupt the application (the interaction already happened).

/** A discrete user interaction (the INP unit), emitted once per `interactionId`. */
export interface InteractionDetail {
  /** The Event Timing entry name — the interaction modality ('click' | 'keydown' | 'pointerup' | …). */
  interactionType: string;
  /** A PII-safe selector label for the target (`describeTarget` — e.g. 'button#submit'); omitted when
   *  the target is gone/not an element. A masked target collapses to its tag only. */
  target?: string;
  /** The nearest annotated component name for the target (`data-bugsee-component`, D2); omitted when the
   *  app is not annotated (no build plugin) or the target has no annotated ancestor. */
  component?: string;
  /** The interaction latency (ms) — the Event Timing entry duration (the INP contribution). */
  duration: number;
  /** The Event Timing `interactionId` (groups one interaction's events; used to dedupe). */
  interactionId: number;
}

/** The interaction source: a listenable `interact` emitter (a framework adapter can subscribe to refine). */
export type InteractionSource = Interceptor<{ interact: InteractionDetail }>;

interface EventTimingEntryLike {
  readonly name: string;
  readonly duration: number;
  readonly interactionId?: number;
  readonly target?: unknown;
}
interface PerformanceObserverEntryListLike {
  getEntries(): EventTimingEntryLike[];
}
interface PerformanceObserverLike {
  observe(options: { type: string; buffered?: boolean; durationThreshold?: number }): void;
  disconnect(): void;
}
interface PerformanceObserverCtorLike {
  new (callback: (list: PerformanceObserverEntryListLike) => void): PerformanceObserverLike;
  readonly supportedEntryTypes?: readonly string[];
}

/** Injected configuration (defaults read the real global PerformanceObserver / mask attribute). */
export interface InteractionEnv {
  /** The PerformanceObserver constructor; default the global (absent/unsupported → self-skip). */
  PerformanceObserver?: PerformanceObserverCtorLike;
  /** Minimum interaction latency (ms) to emit. Default 40 (INP-aligned — only meaningful interactions). */
  durationThreshold?: number;
  /** Mask selector forwarded to `describeTarget`. Default `[data-bugsee-hidden]`. */
  maskSelector?: string;
}

const DEFAULT_DURATION_THRESHOLD = 40;
const DEFAULT_MASK = '[data-bugsee-hidden]';

/** A PII-safe label for the interaction target: the one-level selector, else the (masked) tag, else none.
 *  Observe-only: `describeTarget` reaches `Element.closest(maskSelector)`, which THROWS on an
 *  app-supplied invalid CSS selector — swallow it so the observer callback never surfaces an error. */
const targetLabel = (node: unknown, mask: string): string | undefined => {
  try {
    const desc = describeTarget(node, mask);
    return desc.selector ?? desc.tag; // masked → tag only (no selector); non-element → both undefined
  } catch {
    return undefined; // a hostile getter / invalid maskSelector must never disrupt observation
  }
};

class BrowserInteractionSource extends InterceptorBase<{ interact: InteractionDetail }> {
  readonly name = 'browser-interaction';
  readonly #Ctor: PerformanceObserverCtorLike | undefined;
  readonly #threshold: number;
  readonly #mask: string;
  #observer: PerformanceObserverLike | undefined;
  // Dedupe by the monotonic interactionId high-water mark: Event Timing entries arrive in startTime order
  // and interactionId increases per interaction, so emitting only for ids ABOVE the mark yields exactly
  // one `interact` per interaction. A rare out-of-order batch would SKIP (never duplicate) an interaction
  // — acceptable for a best-effort UX signal (the INP web-vital still records it). id 0 (non-interaction
  // events) is always ≤ the mark, so it is naturally ignored.
  #maxSeenId = 0;

  constructor(env: InteractionEnv) {
    super();
    this.#Ctor = env.PerformanceObserver;
    this.#threshold = env.durationThreshold ?? DEFAULT_DURATION_THRESHOLD;
    this.#mask = env.maskSelector ?? DEFAULT_MASK;
  }

  #onEntries(entries: EventTimingEntryLike[]): void {
    for (const entry of entries) {
      const id = entry.interactionId ?? 0;
      if (id <= this.#maxSeenId) continue; // a non-interaction (id 0) or an already-seen interaction
      this.#maxSeenId = id;
      const target = targetLabel(entry.target, this.#mask);
      const component = componentNameFromElement(entry.target); // D2: nearest data-bugsee-component
      this.emit('interact', {
        interactionType: entry.name,
        ...(target !== undefined ? { target } : {}),
        ...(component !== undefined ? { component } : {}),
        duration: entry.duration,
        interactionId: id,
      });
    }
  }

  protected onActivate(): void {
    const Ctor = this.#Ctor;
    if (Ctor?.supportedEntryTypes === undefined || !Ctor.supportedEntryTypes.includes('event')) {
      return; // Event Timing API unsupported → self-skip
    }
    try {
      this.#observer = new Ctor((list) => this.#onEntries(list.getEntries()));
      this.#observer.observe({ type: 'event', buffered: true, durationThreshold: this.#threshold });
    } catch {
      this.#observer = undefined; // a disallowed observe → no-op (the source stays inert)
    }
  }

  protected override onDeactivate(): void {
    this.#observer?.disconnect();
    this.#observer = undefined;
  }
}

const g = globalThis as unknown as { PerformanceObserver?: PerformanceObserverCtorLike };

/** Build the interaction source over the real Event Timing API (overridable / absent → self-skip). */
export function createBrowserInteractionSource(env: InteractionEnv = {}): InteractionSource {
  return new BrowserInteractionSource({
    PerformanceObserver: env.PerformanceObserver ?? g.PerformanceObserver,
    ...(env.durationThreshold !== undefined ? { durationThreshold: env.durationThreshold } : {}),
    ...(env.maskSelector !== undefined ? { maskSelector: env.maskSelector } : {}),
  });
}
