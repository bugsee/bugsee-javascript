import type { UserEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import { componentNameFromElement } from './component-name';

// Browser INPUT SOURCE for @bugsee/capture's userEventsProvider (the DOM analog of the node lifecycle
// source). A listenable InterceptorBase: on activate it attaches capture-phase, passive listeners for the
// discrete interactions and maps each to an events.user entry; on deactivate it removes them. Captured
// (Android input/gesture parity, web-native — the DOM hands us the target element directly):
//   click     → click  { target, x, y, button }
//   keydown   → key    { target, key, ctrl?/meta?/alt?/shift? }  (control keys + shortcuts ONLY)
//   change    → change { target }                                (field committed — never its value)
//   submit    → submit { target }
//   focusin   → focus  { target }
// PII discipline (binding — never alter app behavior, never exfiltrate typed text): listeners are
// capture-phase + passive and never preventDefault/stopPropagation; plain typed characters are dropped
// (only named/modified keys survive); input VALUES and the text of editable/masked elements are never
// read. `describeTarget` masks a password field or anything under the mask selector to `{ tag, masked }`.

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
  /** True when the element was fully masked (password / mask-selector subtree); no value-bearing fields. */
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
  const masked =
    (typeof el.closest === 'function' && el.closest(maskSelector) != null) ||
    (tag === 'input' && type === 'password');
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
const INTERACTIONS = ['click', 'keydown', 'change', 'submit', 'focusin'] as const;

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

class BrowserInputSource extends InterceptorBase<{ event: UserEvent }> {
  readonly name = 'browser-input';
  readonly #target: InputEventTarget | undefined;
  readonly #mask: string;

  // Each handler is wrapped by #dispatch: it builds the UserEvent (returning undefined to skip) inside a
  // try/catch, so a malformed/exotic event, an instrumented DOM target, or an invalid app-supplied
  // maskSelector (Element.closest throws) can NEVER propagate out of the capture-phase listener into the
  // app's own dispatch. A build throw drops the whole event — fail-safe, never a partial/unmasked leak.
  readonly #handlers: Record<(typeof INTERACTIONS)[number], (event: Event) => void> = {
    click: this.#dispatch((event) => {
      const e = event as MouseEvent;
      return {
        name: 'click',
        params: {
          target: describeTarget(e.target, this.#mask),
          x: e.clientX,
          y: e.clientY,
          button: e.button,
        },
      };
    }),
    keydown: this.#dispatch((event) => {
      const e = event as KeyboardEvent;
      if (isTypedText(e)) return undefined; // typed text (incl. AltGr / emoji / IME) → never captured
      return {
        name: 'key',
        params: {
          target: describeTarget(e.target, this.#mask),
          key: e.key,
          ...(e.ctrlKey ? { ctrl: true } : {}),
          ...(e.metaKey ? { meta: true } : {}),
          ...(e.altKey ? { alt: true } : {}),
          ...(e.shiftKey ? { shift: true } : {}),
        },
      };
    }),
    change: this.#dispatch((event) => ({
      name: 'change',
      params: { target: describeTarget(event.target, this.#mask) },
    })),
    submit: this.#dispatch((event) => ({
      name: 'submit',
      params: { target: describeTarget(event.target, this.#mask) },
    })),
    focusin: this.#dispatch((event) => ({
      name: 'focus',
      params: { target: describeTarget(event.target, this.#mask) },
    })),
  };

  constructor(target: InputEventTarget | undefined, mask: string) {
    super();
    this.#target = target;
    this.#mask = mask;
  }

  #dispatch(build: (event: Event) => UserEvent | undefined): (event: Event) => void {
    return (event) => {
      try {
        const userEvent = build(event);
        if (userEvent !== undefined) this.emit('event', userEvent);
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
  }
}

export function createBrowserInputSource(
  env: BrowserInputEnv = {},
): Interceptor<{ event: UserEvent }> {
  const target =
    env.target ?? (typeof document !== 'undefined' ? (document as InputEventTarget) : undefined);
  return new BrowserInputSource(target, env.maskSelector ?? '[data-bugsee-hidden]');
}
