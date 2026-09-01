import type { InputEventDetail } from '@bugsee/capture';
import { InputTool } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserInputEnv, createBrowserInputSource, describeTarget } from './input-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

// A fake element. `attrs` backs getAttribute; `masked` makes closest('[data-bugsee-hidden]') hit;
// `component` makes closest('[data-bugsee-component]') resolve to an annotated ancestor; `matches`
// answers the shared sensitive-input selector from `type`/`autocomplete`/`data-rr-is-password`.
function el(props: {
  tag: string;
  id?: string;
  attrs?: Record<string, string>;
  type?: string;
  text?: string;
  contentEditable?: boolean;
  masked?: boolean;
  component?: string;
}) {
  const attrs = props.attrs ?? {};
  const sensitive =
    props.type?.toLowerCase() === 'password' ||
    props.type?.toLowerCase() === 'tel' ||
    /password|cc-|one-time-code/i.test((attrs.autocomplete as string | undefined) ?? '') ||
    'data-rr-is-password' in attrs;
  return {
    tagName: props.tag.toUpperCase(),
    id: props.id ?? '',
    type: props.type,
    textContent: props.text,
    isContentEditable: props.contentEditable === true,
    getAttribute: (name: string) => attrs[name] ?? null,
    matches: () => sensitive,
    closest: (selector: string) => {
      if (selector === '[data-bugsee-hidden]') return props.masked ? { marker: true } : null;
      if (selector === '[data-bugsee-component]' && props.component !== undefined) {
        return { getAttribute: () => props.component };
      }
      return null;
    },
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

  // Was: "fully masks a password input". It still must — but the rule is no longer a local
  // `type === 'password'` test: describeTarget now asks the SHARED sensitive-input definition, so the
  // whole class (tel, cc-*, one-time-code, rrweb's stamp) masks with it and cannot drift apart.
  it.each([
    ['password input', { tag: 'input', type: 'password', id: 'pw' }],
    ['phone input', { tag: 'input', type: 'tel', id: 'ph' }],
    ['card-number input', { tag: 'input', attrs: { autocomplete: 'CC-NUMBER' }, id: 'cc' }],
    ['one-time-code input', { tag: 'input', attrs: { autocomplete: 'webauthn one-time-code' } }],
    [
      'a field rrweb remembers was a password',
      { tag: 'input', attrs: { 'data-rr-is-password': '' } },
    ],
  ])('fully masks a %s (the shared sensitive definition, no explicit marker)', (_l, props) => {
    expect(describeTarget(el(props as Parameters<typeof el>[0]), MASK)).toEqual({
      tag: 'input',
      masked: true,
    });
  });

  it('attaches the nearest annotated component name (data-bugsee-component, D2)', () => {
    expect(describeTarget(el({ tag: 'button', id: 'go', component: 'Toolbar' }), MASK)).toEqual({
      tag: 'button',
      id: 'go',
      selector: 'button#go',
      component: 'Toolbar',
    });
  });

  it('reports the component name even for a MASKED target (the name is not PII)', () => {
    expect(
      describeTarget(el({ tag: 'input', type: 'password', component: 'LoginForm' }), MASK),
    ).toEqual({ tag: 'input', masked: true, component: 'LoginForm' });
  });

  it('treats role=button as labelish', () => {
    expect(
      describeTarget(el({ tag: 'span', attrs: { role: 'button' }, text: 'Go' }), MASK),
    ).toEqual({ tag: 'span', text: 'Go', selector: 'span' });
  });

  it('never reads the text of a contentEditable element, even if it is labelish', () => {
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

const ALL_INTERACTIONS = ['pointerdown', 'pointerup', 'pointercancel', 'keydown'];
/** The state-change DOM signals this source deliberately does NOT observe (they are breadcrumbs). */
const NOT_INPUT = ['change', 'submit', 'focusin'];

function activate(env: BrowserInputEnv) {
  const source = createBrowserInputSource(env);
  const events: InputEventDetail[] = [];
  const off = source.onAny((_stage, event) => events.push(event));
  return { events, off };
}

/** A pointerdown/up-shaped fake event. */
const ptr = (over: Record<string, unknown> = {}) => ({
  pointerId: 1,
  pointerType: 'mouse',
  clientX: 12,
  clientY: 34,
  button: 0,
  pressure: 0.5,
  width: 1,
  height: 1,
  target: el({ tag: 'button', text: 'OK' }),
  ...over,
});

describe('createBrowserInputSource', () => {
  it('registers a capture-phase, passive listener for every interaction on activate', () => {
    const target = fakeTarget();
    activate({ target });
    for (const type of ALL_INTERACTIONS) {
      expect(target.count(type)).toBe(1);
      // capture phase (observe before the app's bubbling handlers) + passive (never preventDefault).
      expect(target.optionsFor(type)).toEqual({ capture: true, passive: true });
    }
  });

  // Pointer Events, not click/mousedown+touchstart: ONE listener pair yields pointerType (so a
  // touchpad correctly reports Mouse), pointerId (the gesture key), button, pressure and contact
  // geometry, with no touch-vs-mouse double counting.
  it('does NOT listen for click / mousedown / touchstart (superseded by pointer events)', () => {
    const target = fakeTarget();
    activate({ target });
    for (const type of ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'pointermove']) {
      expect(target.count(type)).toBe(0);
    }
  });

  it('maps a mouse pointerdown/up to a begin/end pair sharing one gesture id', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr());
    target.emit('pointerup', ptr({ pressure: 0 }));
    expect(events).toStrictEqual([
      {
        id: '1',
        type: 'begin',
        x: 12,
        y: 34,
        force: 0.5,
        tool: InputTool.Mouse,
        button: 0,
        view_tag: 'button',
        target: { text: 'OK', selector: 'button' },
      },
      {
        id: '1',
        type: 'end',
        x: 12,
        y: 34,
        force: 0,
        tool: InputTool.Mouse,
        button: 0,
        view_tag: 'button',
        target: { text: 'OK', selector: 'button' },
      },
    ]);
  });

  it('gives each successive gesture on the same pointerId its own id (mouse is always pointerId 1)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr());
    target.emit('pointerup', ptr());
    target.emit('pointerdown', ptr());
    target.emit('pointerup', ptr());
    expect(events.map((e) => e.id)).toStrictEqual(['1', '1', '2', '2']);
  });

  it('keeps concurrent touch pointers on separate gesture ids', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ pointerId: 7, pointerType: 'touch' }));
    target.emit('pointerdown', ptr({ pointerId: 8, pointerType: 'touch' }));
    target.emit('pointerup', ptr({ pointerId: 8, pointerType: 'touch' }));
    target.emit('pointerup', ptr({ pointerId: 7, pointerType: 'touch' }));
    expect(events.map((e) => e.id)).toStrictEqual(['1', '2', '2', '1']);
  });

  it('mints an id for an up with no matching down (listeners attached mid-gesture)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerup', ptr());
    expect(events[0]?.id).toBe('1');
    expect(events[0]?.type).toBe('end');
  });

  it('ends the gesture on pointercancel, releasing the id', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ pointerType: 'touch' }));
    target.emit('pointercancel', ptr({ pointerType: 'touch' }));
    target.emit('pointerdown', ptr({ pointerType: 'touch' }));
    expect(events.map((e) => [e.type, e.id])).toStrictEqual([
      ['begin', '1'],
      ['end', '1'],
      ['begin', '2'],
    ]);
  });

  it.each([
    ['touch', InputTool.Touch],
    // A touchpad reports pointerType 'mouse' — it IS a mouse as far as the wire contract goes.
    ['mouse', InputTool.Mouse],
    ['pen', InputTool.Pen],
    ['gamepad', InputTool.Other],
    [undefined, InputTool.Unknown],
  ])('maps pointerType %s to tool %i', (pointerType, tool) => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ pointerType }));
    expect(events[0]?.tool).toBe(tool);
  });

  it('reports contact geometry for touch/pen (radii = half the contact box) but not for a mouse', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ pointerType: 'touch', width: 30, height: 20 }));
    target.emit('pointerdown', ptr({ pointerId: 2, pointerType: 'mouse', width: 30, height: 20 }));
    expect(events[0]?.majorRadius).toBe(15);
    expect(events[0]?.minorRadius).toBe(10);
    expect(events[1]?.majorRadius).toBeUndefined();
    expect(events[1]?.minorRadius).toBeUndefined();
  });

  it('passes the actual device button through (secondary and middle, not a hardcoded 0)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ button: 2 })); // secondary / right
    target.emit('pointerdown', ptr({ pointerId: 2, button: 1 })); // middle
    expect(events.map((e) => e.button)).toStrictEqual([2, 1]);
  });

  it('rounds coordinates and omits non-finite ones', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ clientX: 12.6, clientY: 34.4 }));
    target.emit('pointerdown', ptr({ pointerId: 2, clientX: undefined, clientY: undefined }));
    expect([events[0]?.x, events[0]?.y]).toStrictEqual([13, 34]);
    expect([events[1]?.x, events[1]?.y]).toStrictEqual([undefined, undefined]);
    expect(events[1]).not.toHaveProperty('x');
  });

  it('omits force when the device does not report a usable pressure', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ pressure: undefined }));
    expect(events[0]).not.toHaveProperty('force');
  });

  it('carries the target identity in the view* contract fields (class/id/tag)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit(
      'pointerdown',
      ptr({ target: el({ tag: 'a', id: 'go', attrs: { class: 'x y' } }) }),
    );
    expect(events[0]).toMatchObject({ view: 'x y', view_id: 'go', view_tag: 'a' });
    // ...and never DUPLICATES them inside the richer `target` descriptor.
    expect(events[0]?.target).toStrictEqual({ selector: 'a#go.x.y' });
  });

  it('reduces a bare element to its tag plus the derived selector', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ target: { tagName: 'DIV' } }));
    expect(events[0]).toStrictEqual({
      id: '1',
      type: 'begin',
      x: 12,
      y: 34,
      force: 0.5,
      tool: InputTool.Mouse,
      button: 0,
      view_tag: 'div',
      target: { selector: 'div' },
    });
  });

  // A pointer press whose target is not an Element at all (the document, the window, a detached text
  // node): there is nothing to describe, so no `view*` and no `target` — but the PRESS is still real and
  // must still be recorded with its coordinates.
  it('records a press on a non-element target with no view* or target fields', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ target: null }));
    expect(events[0]).toStrictEqual({
      id: '1',
      type: 'begin',
      x: 12,
      y: 34,
      force: 0.5,
      tool: InputTool.Mouse,
      button: 0,
    });
  });

  // Not every pointer event carries `button` (a synthetic or partially-implemented event). Emitting the
  // key anyway would put `"button": null` on the wire, which reads as "button 0 was not pressed".
  it('omits button when the event does not report one', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ button: undefined }));
    expect(events[0]).not.toHaveProperty('button');
  });

  it('masks via the DEFAULT mask selector ([data-bugsee-hidden]) when none is configured', () => {
    const target = fakeTarget();
    const { events } = activate({ target }); // no maskSelector → default
    target.emit('pointerdown', ptr({ target: el({ tag: 'span', id: 's', masked: true }) }));
    expect(events[0]?.view_tag).toBe('span');
    expect(events[0]?.view_id).toBeUndefined();
    expect(events[0]?.target).toStrictEqual({ masked: true });
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
    target.emit('pointerdown', ptr({ target: node }));
    expect(events[0]?.target).toStrictEqual({ masked: true });
    expect(events[0]?.view_tag).toBe('div');
  });

  // ---- keyboard ----

  it('maps a control key to a Key-tool "keydown" entry (Android InputEventStage) with no coordinates', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'input', type: 'text' });
    target.emit('keydown', { target: t, key: 'a' }); // printable, no modifier → dropped (PII)
    target.emit('keydown', { target: t, key: 'Enter' }); // named control key → captured
    expect(events).toStrictEqual([
      {
        type: 'keydown',
        tool: InputTool.Key,
        key: 'Enter',
        view_tag: 'input',
        target: { type: 'text', selector: 'input' },
      },
    ]);
    expect(events[0]).not.toHaveProperty('x');
  });

  it('captures a printable key when a shortcut modifier is held, with the modifier flags', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('keydown', {
      target: el({ tag: 'body' }),
      key: 'c',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(events[0]).toMatchObject({ key: 'c', ctrl: true, shift: true, tool: InputTool.Key });
    expect(events[0]).not.toHaveProperty('meta');
    expect(events[0]).not.toHaveProperty('alt');
  });

  it('records meta and alt shortcut modifiers', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'k', metaKey: true });
    target.emit('keydown', { target: t, key: 'ArrowDown', altKey: true });
    expect(events.map((e) => [e.key, e.meta, e.alt])).toStrictEqual([
      ['k', true, undefined],
      ['ArrowDown', undefined, true],
    ]);
  });

  it('never captures typed text via Shift, Alt, AltGr, IME, or supplementary-plane keys (PII)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'input', type: 'text' });
    target.emit('keydown', { target: t, key: 'A', shiftKey: true });
    target.emit('keydown', { target: t, key: 'å', altKey: true });
    target.emit('keydown', {
      target: t,
      key: '€',
      altKey: true,
      getModifierState: (m: string) => m === 'AltGraph',
    });
    target.emit('keydown', {
      target: t,
      key: '@',
      ctrlKey: true,
      altKey: true,
      getModifierState: (m: string) => m === 'AltGraph',
    });
    target.emit('keydown', { target: t, key: '😀' });
    target.emit('keydown', { target: t, key: 'Process', isComposing: true });
    target.emit('keydown', { target: t, key: 'を', isComposing: true });
    expect(events).toStrictEqual([]); // every one is typed text → dropped
  });

  it('still captures a genuine Ctrl shortcut (no AltGraph) and named keys', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'c', ctrlKey: true }); // real Ctrl+C
    target.emit('keydown', { target: t, key: 'Escape' }); // named key
    expect(events.map((e) => e.key)).toStrictEqual(['c', 'Escape']);
  });

  // ---- THE SECURE-FIELD EXCLUSION ----

  it.each([
    ['password', { tag: 'input', type: 'password' }],
    ['phone', { tag: 'input', type: 'tel' }],
    ['card number', { tag: 'input', attrs: { autocomplete: 'cc-number' } }],
    ['one-time code', { tag: 'input', attrs: { autocomplete: 'webauthn one-time-code' } }],
    ['was-a-password (rrweb stamp)', { tag: 'input', attrs: { 'data-rr-is-password': '' } }],
    ['app-declared hidden subtree', { tag: 'input', type: 'text', masked: true }],
  ])('drops EVERY keystroke while focus is in a %s field', (_label, props) => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const secure = el(props as Parameters<typeof el>[0]);
    // Named keys and shortcuts alike: inside a secure field even a key IDENTITY is withheld, because
    // Tab/Enter/Backspace order leaks the shape of what was typed.
    target.emit('keydown', { target: secure, key: 'Enter' });
    target.emit('keydown', { target: secure, key: 'Backspace' });
    target.emit('keydown', { target: secure, key: 'Tab' });
    target.emit('keydown', { target: secure, key: 'v', metaKey: true });
    expect(events).toStrictEqual([]);
  });

  it('still records the keystroke once focus leaves the secure field', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('keydown', { target: el({ tag: 'input', type: 'password' }), key: 'Enter' });
    target.emit('keydown', { target: el({ tag: 'input', type: 'text' }), key: 'Enter' });
    expect(events.map((e) => e.view_tag)).toStrictEqual(['input']);
    expect(events).toHaveLength(1);
  });

  // The deliberate asymmetry: a POINTER over a secure field is still recorded with its coordinates.
  // On the web the keypad is the OS keyboard, not page pixels, so (x,y) on a password box says only
  // "the person clicked the password box" — no content. (Android drops the pointer too, because a
  // mobile PIN pad IS rendered on screen and its coordinates spell out the digits.) The TARGET is
  // still collapsed to `{ masked: true }`, so no id/class/label of the secure field escapes.
  it('KEEPS pointer coordinates over a secure field, with the target collapsed to masked', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const secure = el({ tag: 'input', type: 'password', id: 'pw', attrs: { class: 'login-pw' } });
    target.emit('pointerdown', ptr({ target: secure }));
    expect(events[0]).toStrictEqual({
      id: '1',
      type: 'begin',
      x: 12,
      y: 34,
      force: 0.5,
      tool: InputTool.Mouse,
      button: 0,
      view_tag: 'input',
      target: { masked: true },
    });
    expect(JSON.stringify(events)).not.toContain('login-pw');
    expect(JSON.stringify(events)).not.toContain('"pw"');
  });

  // ---- state-change DOM signals are NOT input ----

  // `change`/`submit`/`focus` are not device presses and are not members of Android's InputEventStage
  // (`unknown|begin|move|end|scroll|keydown|keyup`), which `InputEvent.type` is. They moved to the
  // breadcrumb trail (`ui-breadcrumb-source.ts`); this source must not observe them at all.
  it('does not observe change / submit / focusin — they are breadcrumbs, not device input', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    for (const type of NOT_INPUT) {
      expect(target.count(type)).toBe(0); // no listener attached at all
    }
    const secret = el({ tag: 'input', type: 'password', id: 'pw' });
    target.emit('change', { target: secret });
    target.emit('submit', { target: el({ tag: 'form', id: 'f' }) });
    target.emit('focusin', { target: secret });
    expect(events).toStrictEqual([]); // ...and nothing reaches the input stream if one ever fired
  });

  // ---- observe-only ----

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
    expect(() => target.emit('pointerdown', ptr({ target: hostile }))).not.toThrow();
    expect(events).toStrictEqual([]); // swallowed AND nothing captured (fail-safe, no partial leak)
  });

  it('removes every listener on deactivate, matching the capture phase used on add', () => {
    const target = fakeTarget();
    const { off } = activate({ target });
    off();
    for (const type of ALL_INTERACTIONS) {
      expect(target.count(type)).toBe(0);
      // removeEventListener must pass capture:true (matches the add) or the real DOM never detaches.
      expect(target.removeOptionsFor(type)).toEqual({ capture: true });
    }
  });

  it('forgets in-flight gestures on deactivate, so a re-activation starts a clean id space', () => {
    const target = fakeTarget();
    const source = createBrowserInputSource({ target });
    const events: InputEventDetail[] = [];
    const off = source.onAny((_s, e) => events.push(e));
    target.emit('pointerdown', ptr());
    off();
    const off2 = source.onAny((_s, e) => events.push(e));
    target.emit('pointerup', ptr()); // its 'down' belongs to the previous activation
    off2();
    expect(events.map((e) => [e.type, e.id])).toStrictEqual([
      ['begin', '1'],
      ['end', '2'],
    ]);
  });

  it('activates but registers nothing when no DOM target is available (non-DOM context)', () => {
    const source = createBrowserInputSource();
    const events: InputEventDetail[] = [];
    source.onAny((_stage, event) => events.push(event)); // activates without throwing
    expect(events).toStrictEqual([]); // no document → no listeners → no events
  });

  it('defaults to the global document', () => {
    const target = fakeTarget();
    vi.stubGlobal('document', target);
    const source = createBrowserInputSource();
    const off = source.onAny(() => {});
    expect(target.count('pointerdown')).toBe(1);
    off();
  });
});
