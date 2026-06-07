import type { UserEvent } from '@bugsee/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserInputEnv, createBrowserInputSource, describeTarget } from './input-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

// A fake element. `attrs` backs getAttribute; `masked` makes closest('[data-bugsee-hidden]') hit.
function el(props: {
  tag: string;
  id?: string;
  attrs?: Record<string, string>;
  type?: string;
  text?: string;
  contentEditable?: boolean;
  masked?: boolean;
}) {
  const attrs = props.attrs ?? {};
  return {
    tagName: props.tag.toUpperCase(),
    id: props.id ?? '',
    type: props.type,
    textContent: props.text,
    isContentEditable: props.contentEditable === true,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) =>
      selector === '[data-bugsee-hidden]' && props.masked ? { marker: true } : null,
  };
}

const MASK = '[data-bugsee-hidden]';

describe('describeTarget', () => {
  it('describes a plain element with tag/id/class/selector', () => {
    expect(describeTarget(el({ tag: 'div', id: 'box', attrs: { class: 'a b' } }), MASK)).toEqual({
      tag: 'div',
      id: 'box',
      class: 'a b',
      selector: 'div#box.a.b',
    });
  });

  it('captures the label text of a labelish element (button)', () => {
    expect(describeTarget(el({ tag: 'button', text: '  Save  changes ' }), MASK)).toEqual({
      tag: 'button',
      text: 'Save changes',
      selector: 'button',
    });
  });

  it('does NOT capture text of a generic (non-labelish) element', () => {
    expect(describeTarget(el({ tag: 'div', text: 'private content' }), MASK)).toEqual({
      tag: 'div',
      selector: 'div',
    });
  });

  it('captures an input type but never its text/value', () => {
    expect(describeTarget(el({ tag: 'input', type: 'email', text: 'a@b.com' }), MASK)).toEqual({
      tag: 'input',
      type: 'email',
      selector: 'input',
    });
  });

  it('prefers aria-label as the text, even for an editable element', () => {
    expect(
      describeTarget(
        el({
          tag: 'input',
          type: 'text',
          attrs: { 'aria-label': 'Email address' },
          text: 'secret',
        }),
        MASK,
      ),
    ).toEqual({ tag: 'input', type: 'text', text: 'Email address', selector: 'input' });
  });

  it('fully masks an element inside a data-bugsee-hidden subtree', () => {
    expect(
      describeTarget(el({ tag: 'span', id: 'x', attrs: { class: 'c' }, masked: true }), MASK),
    ).toEqual({ tag: 'span', masked: true });
  });

  it('fully masks a password input (even without an explicit marker)', () => {
    expect(describeTarget(el({ tag: 'input', type: 'password', id: 'pw' }), MASK)).toEqual({
      tag: 'input',
      masked: true,
    });
  });

  it('treats role=button as labelish', () => {
    expect(
      describeTarget(el({ tag: 'span', attrs: { role: 'button' }, text: 'Go' }), MASK),
    ).toEqual({ tag: 'span', text: 'Go', selector: 'span' });
  });

  it('never reads the text of a contentEditable element, even if it is labelish', () => {
    // A contentEditable div with role=button: its text is user-typed content (PII), not a label.
    expect(
      describeTarget(
        el({ tag: 'div', attrs: { role: 'button' }, contentEditable: true, text: 'typed secret' }),
        MASK,
      ),
    ).toEqual({ tag: 'div', selector: 'div' });
  });

  it("never reads a textarea's text (its textContent is the value), even with role=button", () => {
    expect(
      describeTarget(
        el({ tag: 'textarea', attrs: { role: 'button' }, text: 'secret value' }),
        MASK,
      ),
    ).toEqual({ tag: 'textarea', selector: 'textarea' });
  });

  it('emits a form-control type, but never a type on a non-form-control element', () => {
    // a <button type="submit"> is labelish, not a form control → its `type` must NOT be reported.
    expect(describeTarget(el({ tag: 'button', type: 'submit', text: 'Go' }), MASK)).toEqual({
      tag: 'button',
      text: 'Go',
      selector: 'button',
    });
  });

  it('captures the label text of every labelish tag (summary/label/option)', () => {
    expect(describeTarget(el({ tag: 'summary', text: 'More' }), MASK).text).toBe('More');
    expect(describeTarget(el({ tag: 'label', text: 'Name' }), MASK).text).toBe('Name');
    expect(describeTarget(el({ tag: 'option', text: 'Red' }), MASK).text).toBe('Red');
  });

  it('truncates long label text to 64 chars (both textContent and aria-label paths)', () => {
    const long = 'x'.repeat(100);
    expect(describeTarget(el({ tag: 'a', text: long }), MASK).text).toBe('x'.repeat(64));
    // aria-label path: a 100-char aria-label is also truncated to 64.
    expect(
      describeTarget(el({ tag: 'div', attrs: { 'aria-label': 'y'.repeat(100) } }), MASK).text,
    ).toBe('y'.repeat(64));
  });

  it('returns an empty descriptor for a non-element target', () => {
    expect(describeTarget(null, MASK)).toEqual({});
    expect(describeTarget({}, MASK)).toEqual({});
  });

  it('handles a minimal node lacking getAttribute/closest', () => {
    expect(describeTarget({ tagName: 'DIV' }, MASK)).toEqual({ tag: 'div', selector: 'div' });
  });

  it('omits text for a labelish element whose text is empty/whitespace', () => {
    expect(describeTarget(el({ tag: 'button', text: '   ' }), MASK)).toEqual({
      tag: 'button',
      selector: 'button',
    });
    expect(describeTarget(el({ tag: 'a' }), MASK)).toEqual({ tag: 'a', selector: 'a' });
  });
});

// ---- the source ----

function fakeTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const addOptions = new Map<string, AddEventListenerOptions | boolean | undefined>();
  const removeOptions = new Map<string, EventListenerOptions | boolean | undefined>();
  return {
    addEventListener(
      type: string,
      listener: (event: Event) => void,
      options?: AddEventListenerOptions | boolean,
    ) {
      const set = listeners.get(type) ?? new Set<(event: Event) => void>();
      set.add(listener);
      listeners.set(type, set);
      addOptions.set(type, options);
    },
    removeEventListener(
      type: string,
      listener: (event: Event) => void,
      options?: EventListenerOptions | boolean,
    ) {
      listeners.get(type)?.delete(listener);
      removeOptions.set(type, options);
    },
    emit(type: string, event: unknown) {
      for (const l of listeners.get(type) ?? []) l(event as Event);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
    optionsFor: (type: string) => addOptions.get(type),
    removeOptionsFor: (type: string) => removeOptions.get(type),
  };
}

function activate(env: BrowserInputEnv) {
  const source = createBrowserInputSource(env);
  const events: UserEvent[] = [];
  const off = source.onAny((_stage, event) => events.push(event));
  return { events, off };
}

describe('createBrowserInputSource', () => {
  it('registers a capture-phase, passive listener for every interaction on activate', () => {
    const target = fakeTarget();
    activate({ target });
    for (const type of ['click', 'keydown', 'change', 'submit', 'focusin']) {
      expect(target.count(type)).toBe(1);
      // capture phase (observe before the app's bubbling handlers) + passive (never preventDefault).
      expect(target.optionsFor(type)).toEqual({ capture: true, passive: true });
    }
  });

  it('maps a click to a click event with target + coords + button', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('click', {
      target: el({ tag: 'button', text: 'OK' }),
      clientX: 12,
      clientY: 34,
      button: 0,
    });
    expect(events).toEqual([
      {
        name: 'click',
        params: {
          target: { tag: 'button', text: 'OK', selector: 'button' },
          x: 12,
          y: 34,
          button: 0,
        },
      },
    ]);
  });

  it('passes the actual mouse button through (not a hardcoded 0)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('click', {
      target: el({ tag: 'div' }),
      clientX: 1,
      clientY: 2,
      button: 2, // right button
    });
    expect((events[0]?.params as { button: number }).button).toBe(2);
  });

  it('masks via the DEFAULT mask selector ([data-bugsee-hidden]) when none is configured', () => {
    const target = fakeTarget();
    const { events } = activate({ target }); // no maskSelector → default
    target.emit('click', {
      target: el({ tag: 'span', id: 's', masked: true }),
      clientX: 0,
      clientY: 0,
      button: 0,
    });
    expect((events[0]?.params as { target: unknown }).target).toEqual({
      tag: 'span',
      masked: true,
    });
  });

  it('captures control keys but never plain typed characters', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'input', type: 'text' });
    target.emit('keydown', { target: t, key: 'a' }); // printable, no modifier → dropped (PII)
    target.emit('keydown', { target: t, key: 'Enter' }); // named control key → captured
    expect(events).toEqual([
      {
        name: 'key',
        params: { target: { tag: 'input', type: 'text', selector: 'input' }, key: 'Enter' },
      },
    ]);
  });

  it('captures a printable key when a shortcut modifier is held, with the modifier flags', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'c', ctrlKey: true, shiftKey: true });
    expect(events).toEqual([
      {
        name: 'key',
        params: { target: { tag: 'body', selector: 'body' }, key: 'c', ctrl: true, shift: true },
      },
    ]);
  });

  it('never captures typed text via Shift, Alt, AltGr, IME, or supplementary-plane keys (PII)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'input', type: 'text' });
    // Shift alone produces a capital letter — typed text, not a shortcut.
    target.emit('keydown', { target: t, key: 'A', shiftKey: true });
    // Alt alone on macOS produces special characters (option key) — typed text.
    target.emit('keydown', { target: t, key: 'å', altKey: true });
    // AltGr on Linux: altKey set, and getModifierState('AltGraph') is true → a typed character (€).
    target.emit('keydown', {
      target: t,
      key: '€',
      altKey: true,
      getModifierState: (m: string) => m === 'AltGraph',
    });
    // AltGr on Windows: reported as ctrlKey+altKey (which would look like a Ctrl shortcut) — still typed.
    target.emit('keydown', {
      target: t,
      key: '@',
      ctrlKey: true,
      altKey: true,
      getModifierState: (m: string) => m === 'AltGraph',
    });
    // Supplementary-plane character (emoji): e.key is a surrogate pair (length 2) but ONE typed glyph.
    target.emit('keydown', { target: t, key: '😀' });
    // IME composition: keydown fires with isComposing true (key may be 'Process'/the composed glyph).
    target.emit('keydown', { target: t, key: 'Process', isComposing: true });
    target.emit('keydown', { target: t, key: 'を', isComposing: true });
    expect(events).toEqual([]); // every one is typed text → dropped
  });

  it('still captures a genuine Ctrl shortcut (no AltGraph) and named keys', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'c', ctrlKey: true }); // real Ctrl+C
    target.emit('keydown', { target: t, key: 'Escape' }); // named key
    expect(events.map((e) => (e.params as { key: string }).key)).toEqual(['c', 'Escape']);
  });

  it('never lets a throwing target/handler escape into the app dispatch (observe-only)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const hostile = {
      tagName: 'DIV',
      getAttribute: () => null,
      closest: () => {
        throw new SyntaxError('invalid selector / instrumented DOM');
      },
    };
    expect(() =>
      target.emit('click', { target: hostile, clientX: 0, clientY: 0, button: 0 }),
    ).not.toThrow();
    expect(events).toEqual([]); // the throw is swallowed AND nothing is captured (fail-safe, no partial leak)
  });

  it('records meta and alt shortcut modifiers', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'k', metaKey: true });
    target.emit('keydown', { target: t, key: 'ArrowDown', altKey: true });
    expect(events).toEqual([
      { name: 'key', params: { target: { tag: 'body', selector: 'body' }, key: 'k', meta: true } },
      {
        name: 'key',
        params: { target: { tag: 'body', selector: 'body' }, key: 'ArrowDown', alt: true },
      },
    ]);
  });

  it('emits change / submit / focus with the masked target descriptor', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const secret = el({ tag: 'input', type: 'password', id: 'pw' });
    target.emit('change', { target: secret });
    target.emit('submit', { target: el({ tag: 'form', id: 'f' }) });
    target.emit('focusin', { target: secret });
    expect(events).toEqual([
      { name: 'change', params: { target: { tag: 'input', masked: true } } },
      { name: 'submit', params: { target: { tag: 'form', id: 'f', selector: 'form#f' } } },
      { name: 'focus', params: { target: { tag: 'input', masked: true } } },
    ]);
  });

  it('removes every listener on deactivate, matching the capture phase used on add', () => {
    const target = fakeTarget();
    const { off } = activate({ target });
    off();
    for (const type of ['click', 'keydown', 'change', 'submit', 'focusin']) {
      expect(target.count(type)).toBe(0);
      // removeEventListener must pass capture:true (matches the add) or the real DOM never detaches.
      expect(target.removeOptionsFor(type)).toEqual({ capture: true });
    }
  });

  it('honors a custom mask selector', () => {
    const target = fakeTarget();
    const { events } = activate({ target, maskSelector: '.secret' });
    const node = {
      tagName: 'DIV',
      id: '',
      getAttribute: () => null,
      closest: (sel: string) => (sel === '.secret' ? { marker: true } : null),
    };
    target.emit('click', { target: node, clientX: 0, clientY: 0, button: 0 });
    expect(events[0]?.params?.target).toEqual({ tag: 'div', masked: true });
  });

  it('activates but registers nothing when no DOM target is available (non-DOM context)', () => {
    const source = createBrowserInputSource();
    const events: UserEvent[] = [];
    source.onAny((_stage, event) => events.push(event)); // activates without throwing
    expect(events).toEqual([]); // no document → no listeners → no events
  });

  it('defaults to the global document', () => {
    const target = fakeTarget();
    vi.stubGlobal('document', target);
    const source = createBrowserInputSource();
    const off = source.onAny(() => {});
    expect(target.count('click')).toBe(1);
    off();
  });
});
