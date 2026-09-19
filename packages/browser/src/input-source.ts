import type { InputEventDetail } from '@bugsee/capture';
import { InputTool, type Interceptor, InterceptorBase, isSensitiveInput } from '@bugsee/core';
import { componentNameFromElement } from './component-name';
import { androidKeyCode, androidMetaState } from './keycodes';
import { penAngles } from './pen-angles';

// Browser INPUT SOURCE for @bugsee/capture's input provider (the DOM analog of the node lifecycle
// source). A listenable InterceptorBase: on activate it attaches capture-phase, passive listeners and
// maps each interaction to an `input`-stream entry (`InputEvent`, mobile-canonical); on deactivate it
// removes them.
//
// It feeds the `input` stream, NOT `events.user`: `events.user`/`traces.user` carry only what the app
// supplied through `client.event()`/`client.trace()`, and SDK code must not write into a `user.*`
// stream. This source used to; that was the bug this file was rewritten to fix.
//
// THE MODEL (product owner): input devices have BUTTONS, and we record presses. Mobile has taps and
// builds every gesture from them; desktop adds keyboards, mice and touchpads, each with buttons whose
// presses we track.
//
// WHY POINTER EVENTS, not click / mousedown+mouseup / touchstart+touchend:
//   - `pointerType` gives the tool for free ('mouse' | 'touch' | 'pen'), which is exactly the wire's
//     `tool` field. A TOUCHPAD reports 'mouse', which is the classification we want anyway.
//   - one listener pair covers finger, stylus and mouse. Listening for both mouse and touch events
//     means handling the browser's compatibility mouse events, which fire AFTER a tap and would
//     double-count every touch as a second mouse press.
//   - `pointerId` is the gesture key the wire's `id` needs (concurrent touches stay separate);
//     `pressure` is `force`; `width`/`height` are the contact geometry (`majorRadius`/`minorRadius`).
//   - `button` distinguishes primary / middle / secondary, which `click` alone cannot (a plain `click`
//     never fires for the secondary button).
// Pointer Events are supported by every browser this SDK targets. `click` is deliberately dropped: it
// is a synthesis of a down and an up we now record directly.
//
// `pointermove` is captured for PEN gestures, plus (version 3) two MOUSE cases on the same change-gated,
// frame-aligned terms — everything else (finger, touchpad-as-mouse taps with no drag) still renders as its
// two endpoints, because a move stream is orders of magnitude larger than the press stream:
//   - DRAG: `pointermove` while any button is held. Recorded Android-canonically
//     (`InputEventGenerationHelper.registerMoveEvent`): only when something recorded (x/y/force) changed,
//     at the browser's own frame-aligned pointermove rate. Its identity lives on the gesture's `begin`, so
//     a move carries no target and no button — same as a pen move. A gesture that began on a MASKED target
//     records no moves at all (mouse or pen): a path there is handwriting — a signature, a PIN drawn on a
//     pad — or, for a mouse, still traces exactly where the pointer went over that field.
//   - HOVER: `pointermove` with no button held is sampled at about {@link HOVER_SAMPLE_INTERVAL_MS} — a
//     GUESS (`recording-input-presentation` open item 31; the recording-size cost is unmeasured), so it is
//     a named constant, never a bare literal. A hover move carries no target and no button, like a pen
//     move; its `id` identifies one continuous hover run and is freed the moment a real press begins, so
//     it can never collide with — or, Android's own documented bug, get reused by — a press id.
// A pen move: only while the gesture is in contact (never a hovering pen — that stays future work).
//
// `keyup` is a DELIBERATE divergence from the mobile SDKs, not an oversight: a press is recorded once, on
// the way down. Android emits both edges because it has them for free; on the web a keyup doubles the
// volume of the noisiest stream to say only "the finger came off", which no consumer renders. The stage
// exists in the vocabulary (`InputEventStage`) if that ever changes.
//
// Emitted per interaction:
//   pointerdown   → { type:'begin', id, x, y, force, majorRadius?, minorRadius?, altitudeAngle?,
//                     azimuthAngle?, tool, button?, buttonMask?, metaState?, view* }
//                     (angles: pen only; button/buttonMask/metaState: mouse only — see below)
//   pointermove   → { type:'move',  id?, x, y, force, majorRadius?, minorRadius?, altitudeAngle?,
//                     azimuthAngle?, tool:Pen|Mouse }   (pen: in contact; mouse: drag or sampled hover)
//   pointerup     → { type:'end',   …the same, closing the gesture id }
//   pointercancel → { type:'end',   …the gesture was aborted by the browser }
//   wheel         → { type:'scroll', x?, y?, scrollX, scrollY, scrollUnit, tool:Mouse, metaState }
//                     (no `id` — a wheel occurrence opens/closes no gesture; same-frame deltas coalesced)
//   keydown       → { type:'keydown', tool:Key, id, key, keyCode, metaState, view* }
// `type:'keydown'` is Android's InputEventStage.KeyDown (interception/input/InputEventStage.java) —
// distinct from the pointer 'begin'/'end' stages, so a consumer can tell a key press apart from a
// pointer-down without inspecting `tool`.
//
// MOUSE BUTTONS (version 3, `input.md`): `button` is the button that CHANGED, in the wire's shared
// cross-platform numbering — 0 primary, 1 secondary, 2 middle, 3 back, 4 forward — mouse `begin`/`end`
// only, and OMITTED (never `0`) for an unrecognised button or a pen/touch pointer. The DOM's own
// `MouseEvent.button` numbers middle and secondary the OTHER WAY ROUND (0 primary, 1 middle, 2
// secondary), so it is mapped, never passed through. `buttonMask` is the buttons HELD, from
// `MouseEvent.buttons` — the DOM's bit layout already matches the wire's (1 primary, 2 secondary, 4
// middle, 8 back, 16 forward), so it passes straight through. `metaState` is written on a mouse
// `begin`/`end` too (previously key entries only), through the same Android-metaState mapping the keydown
// path already uses — reused, not re-derived.
//
// DELIBERATELY NOT ON THIS STREAM: `change` / `submit` / `focus`. They are not device presses — they are
// STATE-CHANGE DOM signals, and none of the three is (or structurally can be) a member of Android's
// InputEventStage, which is exactly unknown|begin|move|end|scroll|keydown|keyup and is produced by SDKs
// that have no DOM. `InputEvent.type` is that enum. They now ride the BREADCRUMB trail instead — see
// `ui-breadcrumb-source.ts`, which mirrors Android's own split (BugseeInputInterceptionCoordinator has
// two dispatchers: raw input events → the input provider → input.json, recognised gestures → the
// BreadcrumbInputGesture producer → breadcrumbs).
//
// PII discipline (binding — never alter app behavior, never exfiltrate typed text): listeners are
// capture-phase + passive and never preventDefault/stopPropagation; plain typed characters are dropped
// (only named/modified keys survive); input VALUES and the text of editable/masked elements are never
// read. `describeTarget` masks anything the SHARED sensitive-input definition matches, or anything
// under the app's mask selector, to `{ tag, masked }`. And a keystroke aimed at either is dropped
// OUTRIGHT — see THE SECURE-FIELD EXCLUSION in the keydown handler.

/** A structural, PII-safe description of an interaction's target element. */
export interface TargetDescriptor {
  tag?: string;
  id?: string;
  class?: string;
  /** Form-control type (text/email/checkbox/…) — structural, never the value. */
  type?: string;
  /** A short label (aria-label, or the text of a button/link/etc.) — never editable content. */
  text?: string;
  /** A one-level CSS-ish selector hint (tag#id.class). */
  selector?: string;
  /** The nearest annotated framework component name (`data-bugsee-component`, D2) — not PII (the component
   *  name, never a value), so it is reported even for a masked target. */
  component?: string;
  /** True when the element was fully masked (sensitive field / mask-selector subtree); no value-bearing fields. */
  masked?: boolean;
}

interface ElementLike {
  tagName?: unknown;
  id?: unknown;
  type?: unknown;
  textContent?: unknown;
  isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

const LABELISH = new Set(['button', 'a', 'summary', 'label', 'option']);
const FORM_CONTROLS = new Set(['input', 'textarea', 'select']);
const MAX_TEXT = 64;

const attr = (el: ElementLike, name: string): string | undefined => {
  if (typeof el.getAttribute !== 'function') return undefined;
  const value = el.getAttribute(name);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const labelText = (el: ElementLike, tag: string): string | undefined => {
  const aria = attr(el, 'aria-label');
  if (aria) return aria.slice(0, MAX_TEXT);
  // Editable content is a value, not a label — never read it.
  if (FORM_CONTROLS.has(tag) || el.isContentEditable === true) return undefined;
  const labelish = LABELISH.has(tag) || attr(el, 'role') === 'button';
  if (!labelish) return undefined;
  const raw = typeof el.textContent === 'string' ? el.textContent : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
};

const buildSelector = (tag: string, id: string | undefined, cls: string | undefined): string => {
  const idPart = id ? `#${id}` : '';
  const classPart = cls
    ? cls
        .split(/\s+/)
        .filter(Boolean)
        .map((c) => `.${c}`)
        .join('')
    : '';
  return `${tag}${idPart}${classPart}`;
};

/** Describe an interaction's target as a PII-safe descriptor (or {} for a non-element). */
export function describeTarget(node: unknown, maskSelector: string): TargetDescriptor {
  const el = (node ?? undefined) as ElementLike | undefined;
  const tag = typeof el?.tagName === 'string' ? el.tagName.toLowerCase() : undefined;
  if (el === undefined || tag === undefined) return {};
  const component = componentNameFromElement(node); // D2: nearest data-bugsee-component (not PII)
  const type = typeof el.type === 'string' ? el.type : undefined;
  // Two independent reasons to mask: the app marked this subtree hidden, or the field holds secret
  // content by the SHARED definition (@bugsee/core's SENSITIVE_INPUT_MATCHERS — the same list
  // @bugsee/replay masks with and @bugsee/webview obscures with, so the three cannot drift apart).
  const masked =
    (typeof el.closest === 'function' && el.closest(maskSelector) != null) || isSensitiveInput(el);
  if (masked) return { tag, masked: true, ...(component !== undefined ? { component } : {}) };
  const desc: TargetDescriptor = { tag };
  if (component !== undefined) desc.component = component;
  const id = typeof el.id === 'string' && el.id ? el.id : undefined;
  if (id) desc.id = id;
  const cls = attr(el, 'class');
  if (cls) desc.class = cls;
  if (type !== undefined && FORM_CONTROLS.has(tag)) desc.type = type;
  const text = labelText(el, tag);
  if (text) desc.text = text;
  desc.selector = buildSelector(tag, id, cls);
  return desc;
}

/**
 * Split a descriptor into the wire's `view`/`view_id`/`view_tag` contract fields plus whatever is left
 * over. The viewer reads `view`→target.class, `view_id`→target.id, `view_tag`→target.tag, so those
 * three carry the identity; the remainder (control type, label, component, masked, selector) rides in
 * `target`, an SDK-ahead-of-contract field. Nothing is emitted twice, and `target` is omitted when the
 * remainder is empty.
 */
function targetFields(desc: TargetDescriptor): Partial<InputEventDetail> {
  const { tag, id, class: cls, ...rest } = desc;
  const extra = Object.keys(rest).length > 0 ? { target: rest as Record<string, unknown> } : {};
  return {
    ...(cls !== undefined ? { view: cls } : {}),
    ...(id !== undefined ? { view_id: id } : {}),
    ...(tag !== undefined ? { view_tag: tag } : {}),
    ...extra,
  };
}

/** The add/remove-listener surface the source attaches to (window or document). */
interface InputEventTarget {
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

/** Injected configuration (defaults to the global document + the canonical mask attribute). */
export interface BrowserInputEnv {
  /** Where to attach the capture-phase listeners. Default the global `document`. */
  target?: InputEventTarget;
  /** Elements (or subtrees) to fully mask to `{ tag, masked }`. Default `[data-bugsee-hidden]`. */
  maskSelector?: string;
  /** Wall-clock source for hover sampling. Injectable for tests. Default `Date.now`. */
  now?: () => number;
  /**
   * Schedules a callback for "the next animation frame" — used to coalesce same-frame wheel deltas into
   * one `scroll` entry. Injectable for tests. Default `requestAnimationFrame`, falling back to a 16ms
   * timeout where it does not exist (SSR / non-browser contexts this source may still be constructed in).
   */
  scheduleFrame?: (callback: () => void) => void;
}

// Capture phase so we observe before the app's bubbling handlers; passive so the browser knows we never
// preventDefault. We never call stopPropagation/preventDefault — the event reaches the app untouched.
const ADD_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };
const REMOVE_OPTIONS: EventListenerOptions = { capture: true };
const INTERACTIONS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'keydown',
] as const;

/** The fields whose change makes a pen or mouse-drag move worth recording (everything a move carries but
 *  its identity). Irrelevant fields for a given tool (e.g. a mouse's geometry/angles) are `undefined` on
 *  both sides of the comparison, so they never force a spurious move. */
const MOVE_FIELDS = [
  'x',
  'y',
  'force',
  'majorRadius',
  'minorRadius',
  'altitudeAngle',
  'azimuthAngle',
] as const;

/**
 * How often a hovering (no button held) mouse pointer is sampled into a `move` entry. A NAMED constant,
 * not a literal: `recording-input-presentation`'s open item 31 flags the rate as a guess whose effect on
 * recording size is unmeasured, so it is meant to be tuned (or dropped) from one place once it is.
 */
export const HOVER_SAMPLE_INTERVAL_MS = 100; // ~10/s

/**
 * DOM `MouseEvent.button` (the button that changed) → the wire's shared cross-platform numbering
 * (`input.md` v3): 0 primary, 1 secondary, 2 middle, 3 back, 4 forward. The DOM numbers middle and
 * secondary the other way round (1 middle, 2 secondary), so this is a MAP, not a passthrough. A DOM value
 * outside this table (or non-numeric) has no entry, which is exactly "omit it" — never invent `0`.
 */
const MOUSE_BUTTON_MAP: Readonly<Record<number, number>> = { 0: 0, 1: 2, 2: 1, 3: 3, 4: 4 };

/** DOM `WheelEvent.deltaMode` → the wire's `scrollUnit`. Unrecognised/missing falls back to `'pixel'` —
 *  the DOM's own default (`WheelEvent.DOM_DELTA_PIXEL` is `0`). */
const SCROLL_UNIT_BY_MODE: Readonly<Record<number, string>> = { 0: 'pixel', 1: 'line', 2: 'page' };

/** `button`/`buttonMask` for a mouse pointer stage — never emitted for any other tool (pen/touch carry no
 *  button fields at all, per the wire contract). */
function mouseButtonFields(e: PointerEventLike): Partial<InputEventDetail> {
  const mapped = typeof e.button === 'number' ? MOUSE_BUTTON_MAP[e.button] : undefined;
  const mask = typeof e.buttons === 'number' && Number.isFinite(e.buttons) ? e.buttons : undefined;
  return {
    ...(mapped !== undefined ? { button: mapped } : {}),
    ...(mask !== undefined ? { buttonMask: mask } : {}),
  };
}

/** The modifier-key surface both `androidMetaState` call sites (keydown, mouse begin/end) read. */
interface ModifierEventLike {
  ctrlKey?: unknown;
  shiftKey?: unknown;
  altKey?: unknown;
  metaKey?: unknown;
}

/** Normalise a possibly-`unknown`-typed modifier surface into the booleans `androidMetaState` expects. */
const metaStateFor = (e: ModifierEventLike): number =>
  androidMetaState({
    ctrlKey: e.ctrlKey === true,
    shiftKey: e.shiftKey === true,
    altKey: e.altKey === true,
    metaKey: e.metaKey === true,
  });

/** `pointerType` → the wire tool. An unrecognised (but present) type is a real device we cannot name. */
const TOOL_BY_POINTER_TYPE: Readonly<Record<string, InputTool>> = {
  touch: InputTool.Touch,
  mouse: InputTool.Mouse, // a TOUCHPAD reports 'mouse' — it is a mouse on the wire, as intended
  pen: InputTool.Pen,
};

const toolFor = (pointerType: unknown): InputTool => {
  if (typeof pointerType !== 'string' || pointerType === '') return InputTool.Unknown;
  return TOOL_BY_POINTER_TYPE[pointerType] ?? InputTool.Other;
};

/** Emit a rounded coordinate only when the event actually carried one. */
const coord = (value: unknown, key: 'x' | 'y'): Partial<InputEventDetail> =>
  typeof value === 'number' && Number.isFinite(value) ? { [key]: Math.round(value) } : {};

// Is this keydown plain typed text (which must never be captured) rather than a navigation/control key
// or a deliberate shortcut? A typed character is a SINGLE Unicode grapheme — [...key].length counts code
// points, so emoji/CJK-extension surrogate pairs (UTF-16 length 2) still count as one typed glyph. A
// "real" shortcut is Ctrl/Meta held WITHOUT AltGraph: AltGr is a TYPING modifier (it produces €/@/~ on
// EU layouts and reports as altKey, or ctrlKey+altKey on Windows), and Alt/Shift alone also type
// characters. IME composition keydowns (isComposing) are mid-typing and never captured.
const isTypedText = (e: KeyboardEvent): boolean => {
  if (e.isComposing) return true;
  const printable = [...e.key].length === 1;
  if (!printable) return false;
  const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  const shortcut = (e.ctrlKey || e.metaKey) && !altGraph;
  return !shortcut;
};

/** The contact fields every pointer stage carries: position, pressure, geometry, and (pen) orientation. */
function contact(e: PointerEventLike, tool: InputTool): Partial<InputEventDetail> {
  // Contact geometry is a finger/stylus property. A mouse reports a nominal 1x1 box, which would
  // serialise as a meaningless 0.5-pixel radius, so it is omitted for a mouse — mobile-canonical
  // (Android records 0 there).
  const geometry =
    tool !== InputTool.Mouse &&
    typeof e.width === 'number' &&
    typeof e.height === 'number' &&
    Number.isFinite(e.width) &&
    Number.isFinite(e.height)
      ? { majorRadius: e.width / 2, minorRadius: e.height / 2 }
      : {};
  return {
    ...coord(e.clientX, 'x'),
    ...coord(e.clientY, 'y'),
    ...(typeof e.pressure === 'number' && Number.isFinite(e.pressure) ? { force: e.pressure } : {}),
    ...geometry,
    // Stylus orientation is a pen property; mouse and touch entries stay exactly as they were.
    ...(tool === InputTool.Pen ? penAngles(e) : {}),
  };
}

interface PointerEventLike extends ModifierEventLike {
  pointerId?: unknown;
  pointerType?: unknown;
  clientX?: unknown;
  clientY?: unknown;
  button?: unknown;
  /** The buttons HELD (DOM `MouseEvent.buttons`) — a bitmask, distinct from `button` (the one that
   *  changed). Drives both `buttonMask` and drag-vs-hover classification for a mouse `pointermove`. */
  buttons?: unknown;
  pressure?: unknown;
  width?: unknown;
  height?: unknown;
  altitudeAngle?: unknown;
  azimuthAngle?: unknown;
  tiltX?: unknown;
  tiltY?: unknown;
  target?: unknown;
}

/** The `WheelEvent` surface this source reads. */
interface WheelEventLike extends ModifierEventLike {
  deltaX?: unknown;
  deltaY?: unknown;
  deltaMode?: unknown;
  clientX?: unknown;
  clientY?: unknown;
}

/** One frame's worth of coalesced wheel deltas, accumulated by {@link BrowserInputSource#onWheel} and
 *  flushed by {@link BrowserInputSource#flushWheel}. */
interface WheelAccumulator {
  scrollX: number;
  scrollY: number;
  scrollUnit: string;
  metaState: number;
  x?: number;
  y?: number;
}

/** `requestAnimationFrame` where it exists; a 16ms timeout elsewhere (SSR / non-browser construction). */
function defaultScheduleFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback);
  } else {
    setTimeout(callback, 16);
  }
}

class BrowserInputSource extends InterceptorBase<{ input: InputEventDetail }> {
  readonly name = 'browser-input';
  readonly #target: InputEventTarget | undefined;
  readonly #mask: string;
  readonly #now: () => number;
  readonly #scheduleFrame: (callback: () => void) => void;
  /** Open gestures: pointerId → the wire `id` its stages share. */
  readonly #openGestures = new Map<unknown, string>();
  /** Open PEN gestures whose moves are recorded: pointerId → the last entry emitted for that gesture. */
  readonly #penPaths = new Map<unknown, InputEventDetail>();
  /** Open MOUSE DRAGS whose moves are recorded (a button held on an unmasked target): pointerId → the
   *  last entry emitted for that gesture — same role as {@link #penPaths}, kept separate so a pen and a
   *  mouse sharing a pointerId (never happens in practice, but the ids are caller-controlled) can't
   *  collide. */
  readonly #mouseDragPaths = new Map<unknown, InputEventDetail>();
  /** The `id` of the hover run in progress for a pointerId, if any. A press frees it (deleted on
   *  `begin`), so a hover id can never be reused across — or by — a press, unlike Android's mouse hover
   *  (`recording-input-presentation` open item 10, a documented bug this design deliberately avoids). */
  readonly #hoverIds = new Map<unknown, string>();
  /** Wall-clock ms of the last emitted hover sample, per pointerId — the ~10/s throttle. */
  readonly #lastHoverSampleAt = new Map<unknown, number>();
  /** Same-frame wheel deltas awaiting their coalesced `scroll` entry, or `null` between frames. */
  #wheelAccum: WheelAccumulator | null = null;
  #wheelFrameScheduled = false;
  #nextGestureId = 1;

  // Each handler is wrapped by #dispatch: it builds the entry (returning undefined to skip) inside a
  // try/catch, so a malformed/exotic event, an instrumented DOM target, or an invalid app-supplied
  // maskSelector (Element.closest throws) can NEVER propagate out of the capture-phase listener into the
  // app's own dispatch. A build throw drops the whole event — fail-safe, never a partial/unmasked leak.
  readonly #handlers: Record<(typeof INTERACTIONS)[number], (event: Event) => void> = {
    pointerdown: this.#dispatch((event) => this.#pointer(event, 'begin')),
    pointermove: this.#dispatch((event) => this.#move(event)),
    pointerup: this.#dispatch((event) => this.#pointer(event, 'end')),
    pointercancel: this.#dispatch((event) => this.#pointer(event, 'end')),
    keydown: this.#dispatch((event) => {
      const e = event as KeyboardEvent;
      if (isTypedText(e)) return undefined; // typed text (incl. AltGr / emoji / IME) → never captured
      const desc = describeTarget(e.target, this.#mask);
      // THE SECURE-FIELD EXCLUSION. Focus is in a field whose content is secret (or in a subtree the
      // app marked hidden): withhold the keystroke ENTIRELY, not just its character. Even named keys
      // leak here — the Tab/Enter/Backspace rhythm inside a password box describes what was typed, and
      // `masked` already means "we may report nothing about this element's content".
      if (desc.masked === true) return undefined;
      return {
        // Android's InputEventStage (interception/input/InputEventStage.java) carries a dedicated
        // 'keydown' stage, distinct from the pointer 'begin'/'end' stages, precisely so a consumer can
        // tell a key press apart from a pointer-down without inspecting `tool`. Emitting 'begin' here
        // collided the two.
        type: 'keydown',
        tool: InputTool.Key,
        // Each press is its own interaction. The viewer types `RecordingTouchEvent.id` as REQUIRED and
        // groups by it, so a key entry without one is a malformed member of the stream it shares with
        // touches — it used to have none at all.
        id: this.#keyId(),
        key: e.key,
        keyCode: androidKeyCode(e.key),
        metaState: androidMetaState(e),
        ...targetFields(desc),
      };
    }),
  };

  constructor(
    target: InputEventTarget | undefined,
    mask: string,
    now: () => number,
    scheduleFrame: (callback: () => void) => void,
  ) {
    super();
    this.#target = target;
    this.#mask = mask;
    this.#now = now;
    this.#scheduleFrame = scheduleFrame;
  }

  /** A fresh id for one key press — it shares the gesture-id sequence so no key entry can collide with
   *  a pointer gesture in the same stream. */
  #keyId(): string {
    return String(this.#nextGestureId++);
  }

  /** The gesture id for this stage: reuse the open one, else mint a new one (an `up` whose `down`
   *  predates our listeners still gets a well-formed, unique gesture). `end` releases it. */
  #gestureId(pointerId: unknown, stage: 'begin' | 'end'): string {
    const open = this.#openGestures.get(pointerId);
    const id = open ?? String(this.#nextGestureId++);
    if (stage === 'end') this.#openGestures.delete(pointerId);
    else this.#openGestures.set(pointerId, id);
    return id;
  }

  #pointer(event: Event, stage: 'begin' | 'end'): InputEventDetail {
    const e = event as PointerEventLike;
    const tool = toolFor(e.pointerType);
    const isMouse = tool === InputTool.Mouse;
    const desc = describeTarget(e.target, this.#mask);
    const detail: InputEventDetail = {
      id: this.#gestureId(e.pointerId, stage),
      type: stage,
      ...contact(e, tool),
      tool,
      // button/buttonMask/metaState: mouse begin/end only — pen and touch never carry a button field.
      ...(isMouse ? mouseButtonFields(e) : {}),
      ...(isMouse ? { metaState: metaStateFor(e) } : {}),
      ...targetFields(desc),
    };
    if (stage === 'end') {
      this.#penPaths.delete(e.pointerId);
      this.#mouseDragPaths.delete(e.pointerId);
    } else {
      if (tool === InputTool.Pen && desc.masked !== true) this.#penPaths.set(e.pointerId, detail);
      if (isMouse) {
        // A press ENDS whatever hover run was in progress for this pointer. Cleared here, at `begin`
        // (not `end`): every move for the rest of the press goes through the drag path, never hover, so
        // clearing once, up front, is enough for the next hover sample — after release — to always open
        // a fresh id.
        this.#hoverIds.delete(e.pointerId);
        this.#lastHoverSampleAt.delete(e.pointerId);
        if (desc.masked !== true) this.#mouseDragPaths.set(e.pointerId, detail);
      }
    }
    return detail;
  }

  /** Routes a `pointermove` to the pen-stroke or mouse (drag/hover) path; every other tool (touch,
   *  unknown, other) records no moves, unchanged from before version 3. */
  #move(event: Event): InputEventDetail | undefined {
    const e = event as PointerEventLike;
    const tool = toolFor(e.pointerType);
    if (tool === InputTool.Pen) return this.#penMove(e);
    if (tool === InputTool.Mouse) return this.#mouseMove(e);
    return undefined;
  }

  /** A move of an open, unmasked pen gesture — or `undefined` when there is none, or nothing changed. */
  #penMove(e: PointerEventLike): InputEventDetail | undefined {
    // Every pen move in the document lands here, so the common case must cost one size check.
    if (this.#penPaths.size === 0) return undefined;
    const last = this.#penPaths.get(e.pointerId);
    if (last === undefined) return undefined;
    const detail: InputEventDetail = {
      id: last.id,
      type: 'move',
      ...contact(e, InputTool.Pen),
      tool: InputTool.Pen,
    };
    if (MOVE_FIELDS.every((field) => detail[field] === last[field])) return undefined;
    this.#penPaths.set(e.pointerId, detail);
    return detail;
  }

  /** A mouse `pointermove`: a DRAG move while any button is held, else a sampled HOVER move. */
  #mouseMove(e: PointerEventLike): InputEventDetail | undefined {
    const buttonsHeld = typeof e.buttons === 'number' && e.buttons !== 0;
    return buttonsHeld ? this.#mouseDragMove(e) : this.#mouseHoverMove(e);
  }

  /** A move of an open, unmasked mouse drag — same change-gating as a pen move (see {@link #penMove}). */
  #mouseDragMove(e: PointerEventLike): InputEventDetail | undefined {
    if (this.#mouseDragPaths.size === 0) return undefined;
    const last = this.#mouseDragPaths.get(e.pointerId);
    if (last === undefined) return undefined;
    const detail: InputEventDetail = {
      id: last.id,
      type: 'move',
      ...contact(e, InputTool.Mouse),
      tool: InputTool.Mouse,
    };
    if (MOVE_FIELDS.every((field) => detail[field] === last[field])) return undefined;
    this.#mouseDragPaths.set(e.pointerId, detail);
    return detail;
  }

  /** A sampled hover move (no button held): throttled to ~{@link HOVER_SAMPLE_INTERVAL_MS}, carrying no
   *  target and no button — same shape as a pen move. */
  #mouseHoverMove(e: PointerEventLike): InputEventDetail | undefined {
    const now = this.#now();
    const lastSampleAt = this.#lastHoverSampleAt.get(e.pointerId);
    if (lastSampleAt !== undefined && now - lastSampleAt < HOVER_SAMPLE_INTERVAL_MS)
      return undefined;
    this.#lastHoverSampleAt.set(e.pointerId, now);
    const id = this.#hoverIds.get(e.pointerId) ?? String(this.#nextGestureId++);
    this.#hoverIds.set(e.pointerId, id);
    return { id, type: 'move', ...contact(e, InputTool.Mouse), tool: InputTool.Mouse };
  }

  /** The passive, capture-phase `wheel` listener: accumulates this frame's deltas (never emits directly)
   *  and schedules {@link #flushWheel} once per frame. Not routed through {@link #dispatch} — it never
   *  emits synchronously — but the same observe-only guarantee applies via its own try/catch. */
  readonly #onWheel = (event: Event): void => {
    try {
      const e = event as WheelEventLike;
      const dx = typeof e.deltaX === 'number' && Number.isFinite(e.deltaX) ? e.deltaX : 0;
      const dy = typeof e.deltaY === 'number' && Number.isFinite(e.deltaY) ? e.deltaY : 0;
      if (dx === 0 && dy === 0) return; // nothing to coalesce — also guards a hostile/empty event
      const unit =
        typeof e.deltaMode === 'number' ? (SCROLL_UNIT_BY_MODE[e.deltaMode] ?? 'pixel') : 'pixel';
      const acc: WheelAccumulator = this.#wheelAccum ?? {
        scrollX: 0,
        scrollY: 0,
        scrollUnit: unit,
        metaState: 0,
      };
      acc.scrollX += dx;
      acc.scrollY += dy;
      acc.scrollUnit = unit;
      acc.metaState = metaStateFor(e);
      const xField = coord(e.clientX, 'x');
      const yField = coord(e.clientY, 'y');
      if ('x' in xField) acc.x = xField.x;
      if ('y' in yField) acc.y = yField.y;
      this.#wheelAccum = acc;
      if (!this.#wheelFrameScheduled) {
        this.#wheelFrameScheduled = true;
        this.#scheduleFrame(this.#flushWheel);
      }
    } catch {
      // Observe-only: a throwing event must never disrupt the application.
    }
  };

  /** Emits one coalesced `scroll` entry for the frame's accumulated deltas, if any. */
  readonly #flushWheel = (): void => {
    this.#wheelFrameScheduled = false;
    const acc = this.#wheelAccum;
    this.#wheelAccum = null;
    if (acc === null) return;
    this.emit('input', {
      type: 'scroll',
      ...(acc.x !== undefined ? { x: acc.x } : {}),
      ...(acc.y !== undefined ? { y: acc.y } : {}),
      scrollX: acc.scrollX,
      scrollY: acc.scrollY,
      scrollUnit: acc.scrollUnit,
      tool: InputTool.Mouse,
      metaState: acc.metaState,
    });
  };

  #dispatch(build: (event: Event) => InputEventDetail | undefined): (event: Event) => void {
    return (event) => {
      try {
        const detail = build(event);
        if (detail !== undefined) this.emit('input', detail);
      } catch {
        // Observe-only: a throwing event/target/selector must never disrupt the application.
      }
    };
  }

  protected onActivate(): void {
    for (const type of INTERACTIONS) {
      this.#target?.addEventListener(type, this.#handlers[type], ADD_OPTIONS);
    }
    this.#target?.addEventListener('wheel', this.#onWheel, ADD_OPTIONS);
  }

  protected override onDeactivate(): void {
    for (const type of INTERACTIONS) {
      this.#target?.removeEventListener(type, this.#handlers[type], REMOVE_OPTIONS);
    }
    this.#target?.removeEventListener('wheel', this.#onWheel, REMOVE_OPTIONS);
    // Gestures cannot span a deactivation: their `up` will never be observed, so holding the ids would
    // leak one Map entry per pointer and let a stale id resurface on the next activation. A pending wheel
    // accumulator is dropped the same way — no listener can feed it again until the next activate(), and
    // a stale already-scheduled frame callback finds it `null` and flushes nothing.
    this.#openGestures.clear();
    this.#penPaths.clear();
    this.#mouseDragPaths.clear();
    this.#hoverIds.clear();
    this.#lastHoverSampleAt.clear();
    this.#wheelAccum = null;
  }
}

export function createBrowserInputSource(
  env: BrowserInputEnv = {},
): Interceptor<{ input: InputEventDetail }> {
  const target =
    env.target ?? (typeof document !== 'undefined' ? (document as InputEventTarget) : undefined);
  return new BrowserInputSource(
    target,
    env.maskSelector ?? '[data-bugsee-hidden]',
    env.now ?? (() => Date.now()),
    env.scheduleFrame ?? defaultScheduleFrame,
  );
}
