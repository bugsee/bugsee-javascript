import {
  type BreadcrumbInput,
  type CaptureProvider,
  CaptureProviderBase,
  type EventSubscribable,
  type Interceptor,
  InterceptorBase,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { describeTarget } from './input-source';

// Browser UI-BREADCRUMB SOURCE — the DOM analog of Android's gesture-to-breadcrumb producer
// (`capture/providers/breadcrumbs/BreadcrumbInputGesture.java`).
//
// WHY THIS FILE EXISTS (the split, product-owner settled). `change` / `submit` / `focus` are NOT input
// events: they are STATE-CHANGE events. `InputEvent.type` on the `input` stream is Android's
// `InputEventStage` (`interception/input/InputEventStage.java` — exactly
// unknown|begin|move|end|scroll|keydown|keyup), an enum produced by SDKs that have no DOM and which
// those three values structurally cannot join. They used to ride `input.json` under `tool: Other`,
// where every consumer discarded them: both native WebView receivers drop them, and the viewer's
// `processInput` renders tools 1/2/3 only. They belong in the breadcrumb trail instead.
//
// Android already draws this exact line: `BugseeInputInterceptionCoordinator` has TWO dispatchers —
// `getInputDispatcher()` (raw `InputEvent`s → the input capture provider → `input.json`) and
// `getGestureDispatcher()` (recognised `GestureEvent`s → the breadcrumb + frustration providers). This
// source is the JS `getGestureDispatcher()` leg; `input-source.ts` is the `getInputDispatcher()` leg.
//
// THE SHAPE is `BreadcrumbInputGesture.emitBreadcrumb` (`:62-89`) verbatim:
//   { type:'user', category:'ui.<signal>', level:'info', data:{'view.id','view.class','view.tag'},
//     timestamp: <the moment of the DOM event, not of breadcrumb creation> }
// `type: 'user'` means a user-ORIGINATED breadcrumb — Android's own literal `entry.type = "user"`. It is
// NOT the `*.user` STREAM and does not violate the binding "SDK code must not write into `user.*`" rule:
// these entries go to the `breadcrumbs` file, and `events.user`/`traces.user` remain reserved for
// `client.event()`/`client.trace()`. Do not "fix" this to something else.
//
// Android also stamps `displayId` and (for scrolls) `direction`; a browser has neither, so `data` holds
// only the three `view.*` keys, each omitted when the descriptor does not carry it — exactly the
// null-checked `setData` calls Android makes.
//
// PII discipline: the target descriptor is `describeTarget` (`input-source.ts`) — the ONE PII-safe
// descriptor, which collapses anything the SHARED `isSensitiveInput` definition matches, or anything
// under the app's mask selector, to `{ tag, masked: true }`. See THE SECURE-FIELD EXCLUSION below for
// why a masked target drops the breadcrumb entirely rather than reporting the collapsed descriptor.
// Listeners are capture-phase + passive and never preventDefault/stopPropagation; no element value, and
// no editable text, is ever read.

/** The add/remove-listener surface the source attaches to (a document, in practice). */
interface UiEventTarget {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: EventListenerOptions | boolean,
  ): void;
}

/** Injected configuration (each field defaults to the real global). */
export interface UiBreadcrumbEnv {
  /** Where to attach the capture-phase listeners. Default the global `document`. */
  target?: UiEventTarget;
  /** Elements (or subtrees) the app marked hidden. Default `[data-bugsee-hidden]`. */
  maskSelector?: string;
  /** Wall-clock reading; default `Date.now`. */
  now?: () => number;
  /** The `Event.timeStamp` epoch anchor; default `performance.timeOrigin` (absent → `now()` is used). */
  timeOrigin?: number;
}

/** A source of UI breadcrumbs — a listenable `breadcrumb` emitter. */
export type UiBreadcrumbSource = EventSubscribable<{ breadcrumb: BreadcrumbInput }>;

/**
 * The DOM signals this source observes → the breadcrumb category each becomes.
 *
 * `focusin`, not `focus`: `focus` does not bubble, so a document-level listener would never see it.
 * The CATEGORY stays `ui.focus` — the trail names the interaction, not the DOM event that carried it.
 */
const SIGNALS = {
  change: 'ui.change',
  submit: 'ui.submit',
  focusin: 'ui.focus',
} as const;

// Capture phase so we observe before the app's bubbling handlers; passive so the browser knows we never
// preventDefault. We never call stopPropagation/preventDefault — the event reaches the app untouched.
const ADD_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };
const REMOVE_OPTIONS: EventListenerOptions = { capture: true };

class UiBreadcrumbSourceImpl extends InterceptorBase<{ breadcrumb: BreadcrumbInput }> {
  readonly name = 'browser-ui-breadcrumbs';
  readonly #target: UiEventTarget | undefined;
  readonly #mask: string;
  readonly #now: () => number;
  readonly #timeOrigin: number | undefined;

  // Each handler is wrapped by #dispatch: the breadcrumb is built inside a try/catch, so a malformed
  // event, an instrumented DOM target, or an invalid app-supplied maskSelector (Element.closest throws)
  // can NEVER propagate out of the capture-phase listener into the app's own dispatch. A build throw
  // drops the whole breadcrumb — fail-safe, never a partial/unmasked leak.
  readonly #handlers: Record<keyof typeof SIGNALS, (event: Event) => void>;

  constructor(target: UiEventTarget | undefined, mask: string, now: () => number, origin?: number) {
    super();
    this.#target = target;
    this.#mask = mask;
    this.#now = now;
    this.#timeOrigin = origin;
    this.#handlers = {
      change: this.#dispatch('change'),
      submit: this.#dispatch('submit'),
      focusin: this.#dispatch('focusin'),
    };
  }

  /**
   * The moment the interaction happened, mirroring Android's `entry.timestamp = event.timestamp`
   * ("stamped when the interceptor recognised the gesture, not at breadcrumb time").
   *
   * `Event.timeStamp` is a `DOMHighResTimeStamp` measured from `performance.timeOrigin`, so wall clock
   * is `timeOrigin + timeStamp`. Both operands of that sum are host-provided (`timeOrigin` reaches here
   * through an unchecked `globalThis` cast — see `createUiBreadcrumbSource`; `timeStamp` through the
   * `Event` object) and are guarded IDENTICALLY: `Number.isFinite` is false for any non-number, so it
   * screens `undefined`/`NaN`/strings in one test on EACH side — a non-compliant host that hands either
   * one a `NaN` (or a string) must not silently poison the sum into `NaN`. `timeOrigin === 0` is treated
   * as no-origin too, though it passes `Number.isFinite`: no spec-compliant host anchors a real page's
   * clock at the Unix epoch itself, so accepting a literal 0 would just be `NaN`'s twin failure mode —
   * silently stamping breadcrumbs ~1970 and corrupting the trail order — for zero practical upside,
   * since no genuine caller has a reason to report exactly 0. When either guard trips, fall back to the
   * clock; and the result is separately clamped to `now()` so a pre-`DOMHighResTimeStamp` browser's
   * epoch-valued `timeStamp` (old Firefox/IE reported one) cannot stamp a breadcrumb decades in the
   * future and sort the whole trail wrong. The event has already happened, so it can never legitimately
   * be in the future.
   */
  #eventTime(event: Event): number {
    const now = this.#now();
    const origin = this.#timeOrigin;
    const stamp = (event as { timeStamp?: unknown }).timeStamp;
    // `origin === undefined` is redundant with `!Number.isFinite(origin)` at runtime (both are false for
    // `undefined`) but is what lets TS narrow `origin` to `number` below — `Number.isFinite` isn't a type
    // predicate, so without this disjunct the compiler can't see that a non-`undefined` origin survives.
    if (
      origin === undefined ||
      !Number.isFinite(origin) ||
      origin === 0 ||
      !Number.isFinite(stamp)
    ) {
      return now;
    }
    return Math.min(origin + (stamp as number), now);
  }

  #build(event: Event, signal: keyof typeof SIGNALS): BreadcrumbInput | undefined {
    const desc = describeTarget(event.target, this.#mask);
    // THE SECURE-FIELD EXCLUSION (the same call `input-source.ts` makes for a keystroke).
    //
    // `focus` on a sensitive field is the case that forced the decision: no CONTENT leaks (keystrokes
    // there are already withheld and the descriptor is already collapsed to `{tag, masked}`), but the
    // trail would still say "the user was in the password box", and the RHYTHM of repeated
    // focus/change pairs on one masked field is itself a side channel — it counts retries, and pairs
    // with the network trail to say which submission was the failed one. `masked` already means "we
    // may report nothing about this element", so the breadcrumb is dropped OUTRIGHT rather than
    // emitted with a tag-only descriptor. Applied to all three signals, not just focus: `change` on a
    // masked field leaks the same rhythm, and `submit` reaches here masked only when the app put the
    // whole form under its mask selector — i.e. explicitly asked for exactly this.
    //
    // The trail still shows the surrounding interaction (the submit, the next field), so the user
    // journey survives; only the masked element's participation is withheld.
    if (desc.masked === true) {
      return undefined;
    }
    const data: Record<string, unknown> = {};
    if (desc.id !== undefined) data['view.id'] = desc.id;
    if (desc.class !== undefined) data['view.class'] = desc.class;
    if (desc.tag !== undefined) data['view.tag'] = desc.tag;
    return {
      type: 'user', // Android's literal `entry.type = "user"` — user-ORIGINATED, not the `user.*` stream
      category: SIGNALS[signal],
      level: 'info',
      timestamp: this.#eventTime(event),
      // Omitted rather than sent empty when the target is not an element (nothing describable), the way
      // Android omits each absent `view.*` key.
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };
  }

  #dispatch(signal: keyof typeof SIGNALS): (event: Event) => void {
    return (event) => {
      try {
        const crumb = this.#build(event, signal);
        if (crumb !== undefined) this.emit('breadcrumb', crumb);
      } catch {
        // Observe-only: a throwing event/target/selector must never disrupt the application.
      }
    };
  }

  protected onActivate(): void {
    for (const type of Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]) {
      this.#target?.addEventListener(type, this.#handlers[type], ADD_OPTIONS);
    }
  }

  protected override onDeactivate(): void {
    for (const type of Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]) {
      this.#target?.removeEventListener(type, this.#handlers[type], REMOVE_OPTIONS);
    }
  }
}

export function createUiBreadcrumbSource(
  env: UiBreadcrumbEnv = {},
): Interceptor<{ breadcrumb: BreadcrumbInput }> {
  const target =
    env.target ?? (typeof document !== 'undefined' ? (document as UiEventTarget) : undefined);
  const origin =
    env.timeOrigin ??
    (globalThis as { performance?: { timeOrigin?: number } }).performance?.timeOrigin;
  return new UiBreadcrumbSourceImpl(
    target,
    env.maskSelector ?? '[data-bugsee-hidden]',
    env.now ?? Date.now,
    origin,
  );
}

/**
 * The capture provider that pumps a {@link UiBreadcrumbSource} into `client.addBreadcrumb` — the seam
 * that runs the app's breadcrumb filter and adds the `breadcrumbs` entry.
 *
 * GATED BY `captureInteractions`. Android gates its gesture breadcrumb on `Options.CaptureBreadcrumbs`
 * (`BugseeCaptureDataProviderBreadcrumb` carries `@BugseeCaptureControllingOptions(Options.CaptureBreadcrumbs)`
 * and owns `BreadcrumbInputGesture`), but this SDK has no such option and cannot grow one here:
 * breadcrumbs enter through `client.addBreadcrumb`, which is the APPLICATION's own API and must not be
 * gated by an SDK capture switch. The nearest true equivalent is the option that already decides
 * whether the SDK observes the person's DOM interactions at all — and turning it off must keep meaning
 * "the SDK does not watch what I click and type", whatever stream the observation lands on. A user who
 * set `captureInteractions: false` today gets no change/submit/focus record; they must not silently
 * start getting one because the destination changed.
 *
 * Being a provider (rather than a bare subscription in `launch()`) also buys the coordinator lifecycle:
 * the listeners detach on pause/stop with every other capture provider.
 */
class UiBreadcrumbProvider extends CaptureProviderBase {
  readonly name = 'ui-breadcrumbs';
  readonly controllingOption = BugseeOption.CaptureInteractions;
  readonly #source: UiBreadcrumbSource;
  readonly #sink: (breadcrumb: BreadcrumbInput) => void;
  #off: (() => void) | null = null;

  constructor(source: UiBreadcrumbSource, sink: (breadcrumb: BreadcrumbInput) => void) {
    super();
    this.#source = source;
    this.#sink = sink;
  }

  protected onStart(): void {
    this.#off = this.#source.on('breadcrumb', (crumb) => this.#sink(crumb));
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = null;
  }
}

export function createUiBreadcrumbProvider(
  source: UiBreadcrumbSource,
  sink: (breadcrumb: BreadcrumbInput) => void,
): CaptureProvider {
  return new UiBreadcrumbProvider(source, sink);
}
