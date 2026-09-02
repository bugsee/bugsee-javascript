import type { InputEventDetail } from '@bugsee/capture';
import { InputTool, type Interceptor, InterceptorBase, isSensitiveInput } from '@bugsee/core';
import { componentNameFromElement } from './component-name';
import { androidKeyCode, androidMetaState } from './keycodes';

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
// DELIBERATELY NOT CAPTURED: `pointermove`. A move stream is orders of magnitude larger than the press
// stream and would dominate the capture ring; the viewer's gesture classification runs off the first
// and last event of a gesture, which down/up already provide. Drags therefore render as their two
// endpoints, not their path.
//
// `keyup` is a DELIBERATE divergence from the mobile SDKs, not an oversight: a press is recorded once, on
// the way down. Android emits both edges because it has them for free; on the web a keyup doubles the
// volume of the noisiest stream to say only "the finger came off", which no consumer renders. The stage
// exists in the vocabulary (`InputEventStage`) if that ever changes.
//
// Emitted per interaction:
//   pointerdown   → { type:'begin', id, x, y, force, majorRadius?, minorRadius?, tool, button, view* }
//   pointerup     → { type:'end',   …the same, closing the gesture id }
//   pointercancel → { type:'end',   …the gesture was aborted by the browser }
//   keydown       → { type:'keydown', tool:Key, id, key, keyCode, metaState, view* }
// `type:'keydown'` is Android's InputEventStage.KeyDown (interception/input/InputEventStage.java) —
// distinct from the pointer 'begin'/'end' stages, so a consumer can tell a key press apart from a
// pointer-down without inspecting `tool`.
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
}

// Capture phase so we observe before the app's bubbling handlers; passive so the browser knows we never
// preventDefault. We never call stopPropagation/preventDefault — the event reaches the app untouched.
const ADD_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };
const REMOVE_OPTIONS: EventListenerOptions = { capture: true };
const INTERACTIONS = ['pointerdown', 'pointerup', 'pointercancel', 'keydown'] as const;

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

interface PointerEventLike {
  pointerId?: unknown;
  pointerType?: unknown;
  clientX?: unknown;
  clientY?: unknown;
  button?: unknown;
  pressure?: unknown;
  width?: unknown;
  height?: unknown;
  target?: unknown;
}

class BrowserInputSource extends InterceptorBase<{ input: InputEventDetail }> {
  readonly name = 'browser-input';
  readonly #target: InputEventTarget | undefined;
  readonly #mask: string;
  /** Open gestures: pointerId → the wire `id` its stages share. */
  readonly #openGestures = new Map<unknown, string>();
  #nextGestureId = 1;

  // Each handler is wrapped by #dispatch: it builds the entry (returning undefined to skip) inside a
  // try/catch, so a malformed/exotic event, an instrumented DOM target, or an invalid app-supplied
  // maskSelector (Element.closest throws) can NEVER propagate out of the capture-phase listener into the
  // app's own dispatch. A build throw drops the whole event — fail-safe, never a partial/unmasked leak.
  readonly #handlers: Record<(typeof INTERACTIONS)[number], (event: Event) => void> = {
    pointerdown: this.#dispatch((event) => this.#pointer(event, 'begin')),
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

  constructor(target: InputEventTarget | undefined, mask: string) {
    super();
    this.#target = target;
    this.#mask = mask;
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
      id: this.#gestureId(e.pointerId, stage),
      type: stage,
      ...coord(e.clientX, 'x'),
      ...coord(e.clientY, 'y'),
      ...(typeof e.pressure === 'number' && Number.isFinite(e.pressure)
        ? { force: e.pressure }
        : {}),
      ...geometry,
      tool,
      ...(typeof e.button === 'number' ? { button: e.button } : {}),
      ...targetFields(describeTarget(e.target, this.#mask)),
    };
  }

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
  }

  protected override onDeactivate(): void {
    for (const type of INTERACTIONS) {
      this.#target?.removeEventListener(type, this.#handlers[type], REMOVE_OPTIONS);
    }
    // Gestures cannot span a deactivation: their `up` will never be observed, so holding the ids would
    // leak one Map entry per pointer and let a stale id resurface on the next activation.
    this.#openGestures.clear();
  }
}

export function createBrowserInputSource(
  env: BrowserInputEnv = {},
): Interceptor<{ input: InputEventDetail }> {
  const target =
    env.target ?? (typeof document !== 'undefined' ? (document as InputEventTarget) : undefined);
  return new BrowserInputSource(target, env.maskSelector ?? '[data-bugsee-hidden]');
}
