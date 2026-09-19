import type { InputEventDetail } from '@bugsee/capture';
import { InputTool } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowserInputEnv,
  createBrowserInputSource,
  describeTarget,
  HOVER_SAMPLE_INTERVAL_MS,
} from './input-source';

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

const ALL_INTERACTIONS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'keydown',
  'wheel',
];
/** The state-change DOM signals this source deliberately does NOT observe (they are breadcrumbs). */
const NOT_INPUT = ['change', 'submit', 'focusin'];

function activate(env: BrowserInputEnv) {
  const source = createBrowserInputSource(env);
  const events: InputEventDetail[] = [];
  const off = source.onAny((_stage, event) => events.push(event));
  return { events, off };
}

/** A pointerdown/up-shaped fake event. `buttons: 1` (primary held) matches what a real PointerEvent
 *  reports on the down that just pressed it; override to `0` to model the mask AFTER a release. */
const ptr = (over: Record<string, unknown> = {}) => ({
  pointerId: 1,
  pointerType: 'mouse',
  clientX: 12,
  clientY: 34,
  button: 0,
  buttons: 1,
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
    for (const type of [
      'click',
      'mousedown',
      'mouseup',
      'touchstart',
      'touchend',
      'pointerrawupdate',
    ]) {
      expect(target.count(type)).toBe(0);
    }
  });

  it('maps a mouse pointerdown/up to a begin/end pair sharing one gesture id', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr());
    target.emit('pointerup', ptr({ pressure: 0, buttons: 0 })); // released: nothing held any more
    expect(events).toStrictEqual([
      {
        id: '1',
        type: 'begin',
        x: 12,
        y: 34,
        force: 0.5,
        tool: InputTool.Mouse,
        button: 0,
        buttonMask: 1,
        metaState: 0,
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
        buttonMask: 0,
        metaState: 0,
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

  // ---- pen moves ----
  // A pen stroke is its path: pressure and tilt vary along it, and the viewer's pen glyph draws that. So a
  // PEN gesture's `pointermove`s are recorded — Android-canonical: a `move` whenever something about the
  // contact changed (InputEventGenerationHelper.registerMoveEvent), at the browser's own frame-aligned
  // pointermove rate. Mouse and touch moves stay unrecorded; they are the volume the header warns about.
  describe('pen moves', () => {
    const pen = (over: Record<string, unknown> = {}) =>
      ptr({
        pointerType: 'pen',
        width: 2,
        height: 2,
        altitudeAngle: 1,
        azimuthAngle: 2,
        ...over,
      });

    it('records each move of an open pen gesture under that gesture id, without target or button', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen());
      target.emit('pointermove', pen({ clientX: 20.4, clientY: 40.6, pressure: 0.7, button: -1 }));
      target.emit('pointermove', pen({ clientX: 30, clientY: 50, altitudeAngle: 0.5 }));
      target.emit('pointerup', pen({ clientX: 30, clientY: 50 }));
      expect(events.map((e) => [e.type, e.id])).toStrictEqual([
        ['begin', '1'],
        ['move', '1'],
        ['move', '1'],
        ['end', '1'],
      ]);
      expect(events[1]).toStrictEqual({
        id: '1',
        type: 'move',
        x: 20,
        y: 41,
        force: 0.7,
        majorRadius: 1,
        minorRadius: 1,
        altitudeAngle: 1,
        azimuthAngle: 2,
        tool: InputTool.Pen,
      });
      expect(events[2]).toMatchObject({ x: 30, y: 50, altitudeAngle: 0.5, azimuthAngle: 2 });
    });

    // Touch still records no moves at all (unchanged by version 3 — see the dedicated "mouse moves"
    // describe block below for the mouse drag/hover cases version 3 adds).
    it('records no moves for a touch gesture', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr({ pointerType: 'touch' }));
      target.emit('pointermove', ptr({ pointerType: 'touch', clientX: 99 }));
      target.emit('pointerup', ptr({ pointerType: 'touch', clientX: 99 }));
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'end']);
    });

    it('records no moves for a HOVERING pen (no gesture open), nor after the gesture ends or is cancelled', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointermove', pen({ clientX: 1 })); // hover, before any contact
      target.emit('pointerdown', pen());
      target.emit('pointerup', pen());
      target.emit('pointermove', pen({ clientX: 2 })); // hover after lifting
      target.emit('pointerdown', pen({ pointerId: 2 }));
      target.emit('pointercancel', pen({ pointerId: 2 }));
      target.emit('pointermove', pen({ pointerId: 2, clientX: 3 }));
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'end', 'begin', 'end']);
    });

    // Distinct from "records no moves for a HOVERING pen" above: here penPaths is NOT empty (pointer 7's
    // gesture is open), so the fast size-check bail does not fire — the lookup for pointer 9 itself must
    // still come back empty and record nothing.
    it('records no move for a pen pointerId with no open gesture, even while a different pen gesture is open', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen({ pointerId: 7 }));
      target.emit('pointermove', pen({ pointerId: 9, clientX: 1 }));
      expect(events.map((e) => e.type)).toStrictEqual(['begin']);
    });

    it('skips a move that changes nothing recorded, measured against the last entry of that gesture', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen());
      target.emit('pointermove', pen()); // identical to the begin
      target.emit('pointermove', pen({ clientX: 12.2 })); // rounds to the same x
      target.emit('pointermove', pen({ tiltX: 30 })); // L3 angles win, so nothing recorded changed
      target.emit('pointermove', pen({ pressure: 0.6 })); // force changed
      target.emit('pointermove', pen({ pressure: 0.6 })); // same as the previous MOVE
      expect(events.map((e) => [e.type, e.force])).toStrictEqual([
        ['begin', 0.5],
        ['move', 0.6],
      ]);
    });

    it.each([
      ['x', { clientX: 13 }],
      ['y', { clientY: 35 }],
      ['force', { pressure: 0.51 }],
      ['majorRadius', { width: 4 }],
      ['minorRadius', { height: 4 }],
      ['altitudeAngle', { altitudeAngle: 1.01 }],
      ['azimuthAngle', { azimuthAngle: 2.01 }],
    ])('records a move when only %s changed', (field, over) => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen());
      target.emit('pointermove', pen(over));
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'move']);
      expect(events[1]?.[field as keyof InputEventDetail]).not.toStrictEqual(
        events[0]?.[field as keyof InputEventDetail],
      );
    });

    it('records a move when the angles disappear, and when they return', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen());
      target.emit('pointermove', pen({ altitudeAngle: Math.PI / 2, azimuthAngle: 0 })); // no-data defaults
      target.emit('pointermove', pen());
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'move', 'move']);
      expect(events[1]).not.toHaveProperty('altitudeAngle');
      expect(events[2]).toMatchObject({ altitudeAngle: 1, azimuthAngle: 2 });
    });

    it('never mixes pointer types that share a pointerId: a mouse move is not a pen move, nor the reverse', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen({ pointerId: 1 }));
      target.emit('pointermove', ptr({ pointerId: 1, pointerType: 'mouse', clientX: 90 }));
      target.emit('pointerup', pen({ pointerId: 1 }));
      target.emit('pointerdown', ptr({ pointerId: 5, pointerType: 'mouse' }));
      target.emit('pointermove', pen({ pointerId: 5, clientX: 91 }));
      expect(events.map((e) => [e.type, e.tool])).toStrictEqual([
        ['begin', InputTool.Pen],
        ['end', InputTool.Pen],
        ['begin', InputTool.Mouse],
      ]);
    });

    it('keeps concurrent pens apart: each move joins, and is compared against, its own gesture', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen({ pointerId: 7, clientX: 100 }));
      target.emit('pointerdown', pen({ pointerId: 8, clientX: 200 }));
      target.emit('pointermove', pen({ pointerId: 7, clientX: 200 })); // equals pen 8's state, not pen 7's
      target.emit('pointermove', pen({ pointerId: 8, clientX: 200 })); // unchanged for pen 8
      expect(events.map((e) => [e.type, e.id, e.x])).toStrictEqual([
        ['begin', '1', 100],
        ['begin', '2', 200],
        ['move', '1', 200],
      ]);
    });

    // A pen path over a secret field or an app-hidden subtree is handwriting — a signature, a PIN
    // drawn on a pad. The press itself stays as before (its target collapsed to masked); the path does not.
    it('records no moves for a gesture that began on a masked target', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen({ target: el({ tag: 'canvas', masked: true }) }));
      target.emit('pointermove', pen({ clientX: 50, target: el({ tag: 'canvas', masked: true }) }));
      target.emit('pointerup', pen({ clientX: 50, target: el({ tag: 'canvas', masked: true }) }));
      target.emit(
        'pointerdown',
        pen({ pointerId: 2, target: el({ tag: 'input', type: 'password' }) }),
      );
      target.emit('pointermove', pen({ pointerId: 2, clientX: 60 }));
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'end', 'begin']);
    });

    it('forgets move state on deactivate, so a re-activation records no moves for a stale gesture', () => {
      const target = fakeTarget();
      const source = createBrowserInputSource({ target });
      const events: InputEventDetail[] = [];
      const off = source.onAny((_s, e) => events.push(e));
      target.emit('pointerdown', pen());
      off();
      const off2 = source.onAny((_s, e) => events.push(e));
      target.emit('pointermove', pen({ clientX: 70 }));
      off2();
      expect(events.map((e) => e.type)).toStrictEqual(['begin']);
    });

    it('never lets a hostile move event reach the app', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', pen());
      const hostile = {
        pointerType: 'pen',
        pointerId: 1,
        get clientX(): number {
          throw new Error('instrumented event');
        },
      };
      expect(() => target.emit('pointermove', hostile)).not.toThrow();
      expect(events.map((e) => e.type)).toStrictEqual(['begin']);
    });
  });

  // ---- mouse moves (version 3): drag while a button is held, plus sampled hover ----
  describe('mouse moves', () => {
    /** A clock the test fully controls, for the hover sample throttle. */
    function fakeClock(start = 0) {
      let now = start;
      return { now: () => now, advance: (ms: number) => (now += ms) };
    }

    // buttonMask is written on a move too (every mouse stage the platform can read `buttons` on) — but
    // never `button`, since a move never changes which one is down.
    it('records a drag move of an open mouse gesture, with buttonMask but no target or button', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr()); // buttons: 1 (default) — a button is held
      target.emit('pointermove', ptr({ clientX: 20, clientY: 40, pressure: 0.7 }));
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'move']);
      expect(events[1]).toStrictEqual({
        id: '1',
        type: 'move',
        x: 20,
        y: 40,
        force: 0.7,
        tool: InputTool.Mouse,
        buttonMask: 1,
      });
      expect(events[1]).not.toHaveProperty('button');
    });

    it('reflects a chorded buttonMask on a drag move (a second button held mid-drag)', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr());
      target.emit('pointermove', ptr({ clientX: 20, buttons: 1 | 2 })); // primary + secondary now held
      expect(events[1]?.buttonMask).toBe(3);
    });

    it('keeps a drag move under the gesture id opened by its begin', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr());
      target.emit('pointermove', ptr({ clientX: 50 }));
      target.emit('pointerup', ptr({ buttons: 0 }));
      expect(events.map((e) => e.id)).toStrictEqual(['1', '1', '1']);
    });

    it('skips a drag move that changes nothing recorded (measured against the last entry)', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr());
      target.emit('pointermove', ptr()); // identical to the begin
      target.emit('pointermove', ptr({ clientX: 12.2 })); // rounds to the same x
      target.emit('pointermove', ptr({ clientX: 13 })); // x actually changed
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'move']);
      expect(events[1]?.x).toBe(13);
    });

    it('records no drag moves for a gesture that began on a masked target', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      const secure = el({ tag: 'input', type: 'password' });
      target.emit('pointerdown', ptr({ target: secure }));
      target.emit('pointermove', ptr({ clientX: 99, target: secure }));
      target.emit('pointerup', ptr({ buttons: 0, target: secure }));
      expect(events.map((e) => e.type)).toStrictEqual(['begin', 'end']);
    });

    it('records no drag move for a pointerId with no open mouse gesture', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointermove', ptr({ clientX: 99 })); // no preceding pointerdown at all
      expect(events).toStrictEqual([]);
    });

    // Distinct from the above: here mouseDragPaths is NOT empty (pointer 7's drag is open), so the fast
    // size-check bail does not fire — the lookup for pointer 9 itself must still come back empty.
    it('records no drag move for a pointerId with no open gesture, even while a different drag is open', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr({ pointerId: 7 }));
      target.emit('pointermove', ptr({ pointerId: 9, clientX: 1 }));
      expect(events.map((e) => e.type)).toStrictEqual(['begin']);
    });

    it('keeps concurrent mouse drags apart: each move joins, and is compared against, its own gesture', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr({ pointerId: 7, clientX: 100 }));
      target.emit('pointerdown', ptr({ pointerId: 8, clientX: 200 }));
      target.emit('pointermove', ptr({ pointerId: 7, clientX: 200 })); // equals pointer 8's state
      target.emit('pointermove', ptr({ pointerId: 8, clientX: 200 })); // unchanged for pointer 8
      expect(events.map((e) => [e.type, e.id, e.x])).toStrictEqual([
        ['begin', '1', 100],
        ['begin', '2', 200],
        ['move', '1', 200],
      ]);
    });

    it('forgets drag state on deactivate, so a re-activation records no move for a stale gesture', () => {
      const target = fakeTarget();
      const source = createBrowserInputSource({ target });
      const events: InputEventDetail[] = [];
      const off = source.onAny((_s, e) => events.push(e));
      target.emit('pointerdown', ptr());
      off();
      const off2 = source.onAny((_s, e) => events.push(e));
      target.emit('pointermove', ptr({ clientX: 70 }));
      off2();
      expect(events.map((e) => e.type)).toStrictEqual(['begin']);
    });

    it('samples a hovering mouse (no button held), with buttonMask 0 but no target and no button', () => {
      const target = fakeTarget();
      const clock = fakeClock();
      const { events } = activate({ target, now: clock.now });
      target.emit('pointermove', ptr({ buttons: 0, clientX: 15, clientY: 25 }));
      expect(events).toStrictEqual([
        { id: '1', type: 'move', x: 15, y: 25, force: 0.5, tool: InputTool.Mouse, buttonMask: 0 },
      ]);
    });

    it('throttles hover samples to the named interval, not faster', () => {
      const target = fakeTarget();
      const clock = fakeClock();
      const { events } = activate({ target, now: clock.now });
      target.emit('pointermove', ptr({ buttons: 0, clientX: 1 })); // sampled (first ever)
      clock.advance(50);
      target.emit('pointermove', ptr({ buttons: 0, clientX: 2 })); // too soon — dropped
      clock.advance(49);
      target.emit('pointermove', ptr({ buttons: 0, clientX: 3 })); // still too soon (99ms total)
      clock.advance(1);
      target.emit('pointermove', ptr({ buttons: 0, clientX: 4 })); // exactly the interval — sampled
      expect(events.map((e) => e.x)).toStrictEqual([1, 4]);
    });

    it('gives one continuous hover run a stable id across its samples', () => {
      const target = fakeTarget();
      const clock = fakeClock();
      const { events } = activate({ target, now: clock.now });
      target.emit('pointermove', ptr({ buttons: 0, clientX: 1 }));
      clock.advance(HOVER_SAMPLE_INTERVAL_MS);
      target.emit('pointermove', ptr({ buttons: 0, clientX: 2 }));
      expect(events.map((e) => e.id)).toStrictEqual(['1', '1']);
    });

    it('opens a fresh hover id after a press interrupts the run (never reuses the press id)', () => {
      const target = fakeTarget();
      const clock = fakeClock();
      const { events } = activate({ target, now: clock.now });
      target.emit('pointermove', ptr({ buttons: 0, clientX: 1 })); // hover id 'X'
      target.emit('pointerdown', ptr()); // a real press — its own id
      target.emit('pointerup', ptr({ buttons: 0 }));
      clock.advance(HOVER_SAMPLE_INTERVAL_MS);
      target.emit('pointermove', ptr({ buttons: 0, clientX: 2 })); // fresh hover id
      const ids = events.map((e) => e.id);
      const [hover1, press, release, hover2] = ids;
      expect(new Set([hover1, press, release, hover2]).size).toBe(3); // press === release; both != hovers
      expect(press).toBe(release);
      expect(hover1).not.toBe(hover2);
    });

    it('tracks separate hover runs per pointerId', () => {
      const target = fakeTarget();
      const clock = fakeClock();
      const { events } = activate({ target, now: clock.now });
      target.emit('pointermove', ptr({ pointerId: 7, buttons: 0, clientX: 1 }));
      target.emit('pointermove', ptr({ pointerId: 8, buttons: 0, clientX: 2 }));
      expect(events[0]?.id).not.toBe(events[1]?.id);
    });

    it('never lets a hostile mouse move event reach the app', () => {
      const target = fakeTarget();
      const { events } = activate({ target });
      target.emit('pointerdown', ptr());
      const hostile = {
        pointerType: 'mouse',
        pointerId: 1,
        buttons: 1,
        get clientX(): number {
          throw new Error('instrumented event');
        },
      };
      expect(() => target.emit('pointermove', hostile)).not.toThrow();
      expect(events.map((e) => e.type)).toStrictEqual(['begin']);
    });

    it('defaults the hover sample clock to Date.now when none is injected', () => {
      const target = fakeTarget();
      const { events } = activate({ target }); // no `now` → real Date.now
      target.emit('pointermove', ptr({ buttons: 0 }));
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('move');
    });
  });

  it('records stylus altitude/azimuth on every pen stage (begin, end, cancel)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const pen = { pointerType: 'pen', width: 2, height: 2, altitudeAngle: 0.8, azimuthAngle: 1.9 };
    target.emit('pointerdown', ptr(pen));
    target.emit('pointerup', ptr({ ...pen, altitudeAngle: 0.6, azimuthAngle: 2.1 }));
    target.emit('pointerdown', ptr({ ...pen, pointerId: 2 }));
    target.emit('pointercancel', ptr({ ...pen, pointerId: 2, altitudeAngle: 0.4 }));
    expect(events[0]).toStrictEqual({
      id: '1',
      type: 'begin',
      x: 12,
      y: 34,
      force: 0.5,
      majorRadius: 1,
      minorRadius: 1,
      altitudeAngle: 0.8,
      azimuthAngle: 1.9,
      tool: InputTool.Pen,
      // No button/buttonMask/metaState: version 3 writes those on a MOUSE begin/end only.
      view_tag: 'button',
      target: { text: 'OK', selector: 'button' },
    });
    expect(events.map((e) => [e.type, e.altitudeAngle, e.azimuthAngle])).toStrictEqual([
      ['begin', 0.8, 1.9],
      ['end', 0.6, 2.1],
      ['begin', 0.8, 1.9],
      ['end', 0.4, 1.9],
    ]);
  });

  it('derives pen angles from tiltX/tiltY when the browser has no Level 3 angles', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ pointerType: 'pen', tiltX: 0, tiltY: -45 }));
    expect(events[0]?.altitudeAngle).toBeCloseTo(Math.PI / 4, 12);
    expect(events[0]?.azimuthAngle).toBeCloseTo((3 * Math.PI) / 2, 12);
  });

  it('omits the pen angles when the pen reports no tilt data', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit(
      'pointerdown',
      ptr({ pointerType: 'pen', altitudeAngle: Math.PI / 2, azimuthAngle: 0, tiltX: 0, tiltY: 0 }),
    );
    expect(events[0]?.tool).toBe(InputTool.Pen);
    expect(events[0]).not.toHaveProperty('altitudeAngle');
    expect(events[0]).not.toHaveProperty('azimuthAngle');
  });

  it.each([
    'mouse',
    'touch',
    'eraser-ish-unknown',
    '',
  ])('never records angles for a non-pen pointer (%s), even when the event carries them', (pointerType) => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit(
      'pointerdown',
      ptr({ pointerType, altitudeAngle: 0.5, azimuthAngle: 1, tiltX: 30, tiltY: 20 }),
    );
    expect(events[0]).not.toHaveProperty('altitudeAngle');
    expect(events[0]).not.toHaveProperty('azimuthAngle');
  });

  // input.md v3: `button` is the button that changed, in the SHARED cross-platform numbering (0 primary,
  // 1 secondary, 2 middle, 3 back, 4 forward). The DOM numbers middle and secondary the other way round
  // (1 middle, 2 secondary), so this is a MAP, not a passthrough.
  it.each([
    [0, 0], // primary → primary
    [1, 2], // DOM middle → contract middle (2)
    [2, 1], // DOM secondary → contract secondary (1)
    [3, 3], // back → back
    [4, 4], // forward → forward
  ])('maps DOM button %i to the contract button %i', (domButton, contractButton) => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ button: domButton }));
    expect(events[0]?.button).toBe(contractButton);
  });

  it('omits button for a DOM value outside the known 0-4 range, never inventing 0', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ button: 5 }));
    expect(events[0]).not.toHaveProperty('button');
  });

  // buttonMask (v3): the buttons HELD, from the DOM's `MouseEvent.buttons` — already the wire's bit
  // layout (1 primary, 2 secondary, 4 middle, 8 back, 16 forward), so it passes through unchanged.
  it('passes buttonMask through unchanged (the DOM bit layout already matches the wire)', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ button: 0, buttons: 1 | 4 })); // primary + middle chorded
    expect(events[0]?.buttonMask).toBe(5);
  });

  it('omits buttonMask when the event does not report a usable buttons mask', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ buttons: undefined }));
    expect(events[0]).not.toHaveProperty('buttonMask');
  });

  // metaState (v3): written on a mouse begin/end too (previously key entries only), through the same
  // mapping the keydown path uses.
  it('writes metaState on a mouse begin/end from the held modifier keys', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ shiftKey: true, ctrlKey: true }));
    // META_CTRL_ON 4096 | META_SHIFT_ON 1
    expect(events[0]?.metaState).toBe(4096 | 1);
  });

  it('reports mouse metaState as 0 when no modifier is held, never as an absent field', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr());
    expect(events[0]?.metaState).toBe(0);
  });

  it('never writes button/buttonMask/metaState for a pen or touch pointer', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ pointerType: 'pen', button: 0, buttons: 1 }));
    target.emit('pointerdown', ptr({ pointerId: 2, pointerType: 'touch', button: 0, buttons: 1 }));
    for (const event of events) {
      expect(event).not.toHaveProperty('button');
      expect(event).not.toHaveProperty('buttonMask');
      expect(event).not.toHaveProperty('metaState');
    }
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
      buttonMask: 1,
      metaState: 0,
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
      buttonMask: 1,
      metaState: 0,
    });
  });

  // Not every pointer event carries `button` (a synthetic or partially-implemented event). Emitting the
  // key anyway would put `"button": null` on the wire, which reads as "button 0 was not pressed".
  it('omits button when the event does not report one, but still writes buttonMask/metaState', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('pointerdown', ptr({ button: undefined }));
    expect(events[0]).not.toHaveProperty('button');
    expect(events[0]?.buttonMask).toBe(1);
    expect(events[0]?.metaState).toBe(0);
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
        id: '1',
        key: 'Enter',
        keyCode: 66, // KEYCODE_ENTER
        metaState: 0,
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
    // Modifiers ride the Android `metaState` BITMASK (KeyEvent.META_CTRL_ON 4096 | META_SHIFT_ON 1),
    // not four bespoke booleans — both mobile SDKs already emit this field and the viewer reads it.
    expect(events[0]).toMatchObject({ key: 'c', metaState: 4096 | 1, tool: InputTool.Key });
    expect(events[0]).not.toHaveProperty('ctrl');
    expect(events[0]).not.toHaveProperty('shift');
  });

  it('emits the Android keyCode for a named key, and KEYCODE_REDACTED for a character key', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'Enter' });
    target.emit('keydown', { target: t, key: 'ArrowDown' });
    target.emit('keydown', { target: t, key: 'c', ctrlKey: true });

    // Verified against android.jar's real `android.view.KeyEvent`, not from memory.
    expect(events[0]).toMatchObject({ key: 'Enter', keyCode: 66 });
    expect(events[1]).toMatchObject({ key: 'ArrowDown', keyCode: 20 });
    // A character-producing key is REDACTED on the mobile SDKs however it was reached, shortcut or not.
    expect(events[2]).toMatchObject({ key: 'c', keyCode: -1 });
  });

  it('gives an unrecognised named key KEYCODE_REDACTED rather than inventing a code', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('keydown', { target: el({ tag: 'body' }), key: 'BrightnessUp' });
    expect(events[0]).toMatchObject({ key: 'BrightnessUp', keyCode: -1 });
  });

  it('gives every key entry a gesture id — the viewer types RecordingTouchEvent.id as REQUIRED', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'Enter' });
    target.emit('keydown', { target: t, key: 'Tab' });

    expect(typeof events[0]?.id).toBe('string');
    expect(events[0]?.id).not.toBe('');
    // Each press is its own interaction, so ids must not collide the way one gesture's stages share one.
    expect(events[1]?.id).not.toBe(events[0]?.id);
  });

  it('reports no modifiers as metaState 0, never as an absent field', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    target.emit('keydown', { target: el({ tag: 'body' }), key: 'Enter' });
    expect(events[0]?.metaState).toBe(0);
  });

  it('records meta and alt shortcut modifiers in the bitmask', () => {
    const target = fakeTarget();
    const { events } = activate({ target });
    const t = el({ tag: 'body' });
    target.emit('keydown', { target: t, key: 'k', metaKey: true });
    target.emit('keydown', { target: t, key: 'ArrowDown', altKey: true });
    // META_META_ON = 65536, META_ALT_ON = 2 (android.view.KeyEvent).
    expect(events.map((e) => [e.key, e.metaState])).toStrictEqual([
      ['k', 65536],
      ['ArrowDown', 2],
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
      buttonMask: 1,
      metaState: 0,
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

  // ---- wheel / scroll (version 3) ----
  describe('wheel', () => {
    /** A `scheduleFrame` the test drives by hand: captures the callback instead of using a real timer. */
    function fakeFrame() {
      const pending: Array<() => void> = [];
      return {
        scheduleFrame: (cb: () => void) => pending.push(cb),
        flush: () => {
          const cbs = pending.splice(0);
          for (const cb of cbs) cb();
        },
        pendingCount: () => pending.length,
      };
    }

    // `buttons: 0` (no button held) is the common case for a wheel turn; override to model a chorded one.
    const wheel = (over: Record<string, unknown> = {}) => ({
      deltaX: 0,
      deltaY: 10,
      deltaMode: 0,
      clientX: 5,
      clientY: 6,
      buttons: 0,
      ...over,
    });

    it('does not emit a wheel event synchronously — only once the frame is flushed', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel());
      expect(events).toStrictEqual([]);
      frame.flush();
      expect(events).toHaveLength(1);
    });

    it('emits one scroll entry: x/y, signed scrollX/scrollY (no flip), scrollUnit, tool, metaState, buttonMask — no id or button', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaX: -3, deltaY: 12, ctrlKey: true }));
      frame.flush();
      expect(events).toStrictEqual([
        {
          type: 'scroll',
          x: 5,
          y: 6,
          scrollX: -3,
          scrollY: 12,
          scrollUnit: 'pixel',
          tool: InputTool.Mouse,
          metaState: 4096, // META_CTRL_ON
          buttonMask: 0, // no button held — the common case
        },
      ]);
      expect(events[0]).not.toHaveProperty('id');
      expect(events[0]).not.toHaveProperty('button');
    });

    // The scenario the contract names explicitly: a non-zero mask on a `scroll` entry means only "a
    // button happened to be down while the wheel turned" — never a press, which only begin/end carries.
    it('carries buttonMask (not button) on a wheel turn with a button held', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ buttons: 1 })); // primary held while the wheel turns
      frame.flush();
      expect(events[0]?.buttonMask).toBe(1);
      expect(events[0]).not.toHaveProperty('button');
    });

    it('omits buttonMask on a scroll entry when no event in the window reports a usable buttons mask', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ buttons: undefined }));
      frame.flush();
      expect(events[0]).not.toHaveProperty('buttonMask');
    });

    it('uses the buttonMask of the LATEST event in the coalesced frame, like position and metaState', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ buttons: 1 }));
      target.emit('wheel', wheel({ buttons: 0 })); // released mid-frame
      frame.flush();
      expect(events[0]?.buttonMask).toBe(0);
    });

    it('sums same-frame wheel deltas into one coalesced entry', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaX: 1, deltaY: 2 }));
      target.emit('wheel', wheel({ deltaX: 3, deltaY: 4 }));
      target.emit('wheel', wheel({ deltaX: 5, deltaY: 6 }));
      frame.flush();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ scrollX: 9, scrollY: 12 });
    });

    it('uses the position and modifiers of the LATEST event in the coalesced frame', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ clientX: 1, clientY: 1, shiftKey: true }));
      target.emit('wheel', wheel({ clientX: 9, clientY: 9 })); // no modifier on the last event
      frame.flush();
      expect(events[0]).toMatchObject({ x: 9, y: 9, metaState: 0 });
    });

    it('schedules exactly one frame callback per coalescing window', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel());
      target.emit('wheel', wheel());
      target.emit('wheel', wheel());
      expect(frame.pendingCount()).toBe(1);
    });

    it('schedules a fresh frame for the deltas that follow a flush', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaY: 1 }));
      frame.flush();
      target.emit('wheel', wheel({ deltaY: 2 }));
      frame.flush();
      expect(events.map((e) => e.scrollY)).toStrictEqual([1, 2]);
    });

    it.each([
      [0, 'pixel'],
      [1, 'line'],
      [2, 'page'],
      [99, 'pixel'], // unrecognised deltaMode falls back to the DOM's own default
    ])('maps deltaMode %i to scrollUnit %s', (deltaMode, unit) => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaMode }));
      frame.flush();
      expect(events[0]?.scrollUnit).toBe(unit);
    });

    it('ignores a wheel event with no usable delta on either axis (nothing to coalesce)', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaX: 0, deltaY: 0 }));
      expect(frame.pendingCount()).toBe(0);
      frame.flush();
      expect(events).toStrictEqual([]);
    });

    it('treats a non-numeric deltaX as 0 and still coalesces deltaY', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaX: undefined, deltaY: 7 }));
      frame.flush();
      expect(events[0]).toMatchObject({ scrollX: 0, scrollY: 7 });
    });

    it('treats a non-numeric deltaY as 0 and still coalesces deltaX', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaX: 3, deltaY: Number.NaN }));
      frame.flush();
      expect(events[0]).toMatchObject({ scrollX: 3, scrollY: 0 });
    });

    it('falls back to pixel scrollUnit when deltaMode is not a number at all', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ deltaMode: undefined }));
      frame.flush();
      expect(events[0]?.scrollUnit).toBe('pixel');
    });

    it('omits x/y on the scroll entry when the wheel event reports no usable position', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      target.emit('wheel', wheel({ clientX: undefined, clientY: undefined }));
      frame.flush();
      expect(events[0]).not.toHaveProperty('x');
      expect(events[0]).not.toHaveProperty('y');
      expect(events[0]).toMatchObject({ scrollX: 0, scrollY: 10 });
    });

    it('never lets a hostile wheel event reach the app', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const { events } = activate({ target, scheduleFrame: frame.scheduleFrame });
      const hostile = {
        get deltaX(): number {
          throw new Error('instrumented event');
        },
      };
      expect(() => target.emit('wheel', hostile)).not.toThrow();
      frame.flush();
      expect(events).toStrictEqual([]);
    });

    it('drops a pending accumulation on deactivate — a stale flush emits nothing', () => {
      const target = fakeTarget();
      const frame = fakeFrame();
      const source = createBrowserInputSource({ target, scheduleFrame: frame.scheduleFrame });
      const events: InputEventDetail[] = [];
      const off = source.onAny((_s, e) => events.push(e));
      target.emit('wheel', wheel());
      off(); // deactivate with an un-flushed accumulator
      frame.flush(); // the stale rAF callback still fires — must be a no-op
      expect(events).toStrictEqual([]);
    });

    it('registers a capture-phase, passive wheel listener, removed on deactivate', () => {
      const target = fakeTarget();
      const { off } = activate({ target });
      expect(target.count('wheel')).toBe(1);
      expect(target.optionsFor('wheel')).toEqual({ capture: true, passive: true });
      off();
      expect(target.count('wheel')).toBe(0);
      expect(target.removeOptionsFor('wheel')).toEqual({ capture: true });
    });

    it('defaults scheduleFrame to requestAnimationFrame when the global exists', () => {
      const target = fakeTarget();
      const raf = vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
      vi.stubGlobal('requestAnimationFrame', raf);
      const { events } = activate({ target }); // no scheduleFrame injected → the real default
      target.emit('wheel', wheel());
      expect(raf).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
    });

    it('falls back to a timeout when requestAnimationFrame does not exist', () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('requestAnimationFrame', undefined);
        const target = fakeTarget();
        const { events } = activate({ target });
        target.emit('wheel', wheel());
        expect(events).toStrictEqual([]);
        vi.advanceTimersByTime(16);
        expect(events).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
