import type { BreadcrumbInput, CaptureProviderInit, OptionsContainer } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createUiBreadcrumbProvider,
  createUiBreadcrumbSource,
  type UiBreadcrumbEnv,
} from './ui-breadcrumb-source';

const MASK = '[data-bugsee-hidden]';
const SIGNALS = ['change', 'submit', 'focusin'];

/** A minimal element fake accepted by `describeTarget`. */
function el(props: {
  tag: string;
  id?: string;
  class?: string;
  type?: string;
  hidden?: boolean;
  autocomplete?: string;
}): unknown {
  return {
    tagName: props.tag.toUpperCase(),
    id: props.id ?? '',
    type: props.type,
    getAttribute: (name: string) =>
      name === 'class'
        ? (props.class ?? null)
        : name === 'autocomplete'
          ? (props.autocomplete ?? null)
          : null,
    closest: (selector: string) => (props.hidden === true && selector === MASK ? {} : null),
  };
}

function fakeTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const addOptions = new Map<string, unknown>();
  const removeOptions = new Map<string, unknown>();
  return {
    addEventListener(type: string, listener: (event: Event) => void, options?: unknown) {
      const set = listeners.get(type) ?? new Set<(event: Event) => void>();
      set.add(listener);
      listeners.set(type, set);
      addOptions.set(type, options);
    },
    removeEventListener(type: string, listener: (event: Event) => void, options?: unknown) {
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

/** Subscribe (which activates the source) and collect the emitted breadcrumbs. */
function activate(env: UiBreadcrumbEnv) {
  const source = createUiBreadcrumbSource(env);
  const crumbs: BreadcrumbInput[] = [];
  const off = source.on('breadcrumb', (c) => crumbs.push(c));
  return { source, crumbs, off };
}

describe('createUiBreadcrumbSource', () => {
  it('registers a capture-phase, passive listener for each state-change signal on activate', () => {
    const target = fakeTarget();
    activate({ target, maskSelector: MASK });
    for (const type of SIGNALS) {
      expect(target.count(type)).toBe(1);
      expect(target.optionsFor(type)).toEqual({ capture: true, passive: true });
    }
  });

  it('attaches nothing until something subscribes (subscriber-presence activation)', () => {
    const target = fakeTarget();
    createUiBreadcrumbSource({ target, maskSelector: MASK });
    for (const type of SIGNALS) expect(target.count(type)).toBe(0);
  });

  it('maps change to a user-typed ui.change breadcrumb carrying the Android view.* data keys', () => {
    const target = fakeTarget();
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 1_000 });
    target.emit('change', {
      target: el({ tag: 'input', id: 'qty', class: 'field lg', type: 'number' }),
    });
    expect(crumbs).toStrictEqual([
      {
        type: 'user',
        category: 'ui.change',
        level: 'info',
        timestamp: 1_000,
        data: { 'view.id': 'qty', 'view.class': 'field lg', 'view.tag': 'input' },
      },
    ]);
  });

  it('maps submit to ui.submit and focusin to ui.focus', () => {
    const target = fakeTarget();
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 7 });
    target.emit('submit', { target: el({ tag: 'form', id: 'checkout' }) });
    target.emit('focusin', { target: el({ tag: 'textarea', class: 'note' }) });
    expect(crumbs.map((c) => [c.category, c.data])).toStrictEqual([
      ['ui.submit', { 'view.id': 'checkout', 'view.tag': 'form' }],
      ['ui.focus', { 'view.class': 'note', 'view.tag': 'textarea' }],
    ]);
  });

  it('omits data entirely when the target is not an element (nothing describable)', () => {
    const target = fakeTarget();
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 5 });
    target.emit('change', { target: null });
    expect(crumbs).toStrictEqual([
      { type: 'user', category: 'ui.change', level: 'info', timestamp: 5 },
    ]);
  });

  it('DROPS the breadcrumb outright when the target is sensitive (secure-field exclusion)', () => {
    const target = fakeTarget();
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 5 });
    const secret = el({ tag: 'input', type: 'password', id: 'pw', class: 'field' });
    target.emit('change', { target: secret });
    target.emit('focusin', { target: secret });
    expect(crumbs).toStrictEqual([]);
    expect(JSON.stringify(crumbs)).not.toContain('pw');
  });

  it('DROPS the breadcrumb when the target sits in an app-masked subtree', () => {
    const target = fakeTarget();
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 5 });
    target.emit('focusin', { target: el({ tag: 'input', id: 'ssn', hidden: true }) });
    expect(crumbs).toStrictEqual([]);
  });

  it('still records a non-sensitive field, so the exclusion is falsifiable in both directions', () => {
    const target = fakeTarget();
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 5 });
    target.emit('focusin', { target: el({ tag: 'input', id: 'email', type: 'email' }) });
    expect(crumbs.map((c) => c.data)).toStrictEqual([{ 'view.id': 'email', 'view.tag': 'input' }]);
  });

  // ---- the timestamp is the DOM event's own moment, not the emit moment ----

  it('stamps the breadcrumb from timeOrigin + Event.timeStamp (when the event happened)', () => {
    const target = fakeTarget();
    const { crumbs } = activate({
      target,
      maskSelector: MASK,
      now: () => 1_000_500,
      timeOrigin: 1_000_000,
    });
    target.emit('change', { target: el({ tag: 'input' }), timeStamp: 250 });
    expect(crumbs[0]?.timestamp).toBe(1_000_250); // 1_000_000 + 250, NOT now() = 1_000_500
  });

  it('falls back to now() when the event carries no usable timeStamp', () => {
    const target = fakeTarget();
    const { crumbs } = activate({
      target,
      maskSelector: MASK,
      now: () => 1_000_500,
      timeOrigin: 1_000_000,
    });
    target.emit('change', { target: el({ tag: 'input' }) }); // undefined
    target.emit('submit', { target: el({ tag: 'form' }), timeStamp: Number.NaN });
    target.emit('focusin', { target: el({ tag: 'input' }), timeStamp: '250' }); // legacy/non-number
    expect(crumbs.map((c) => c.timestamp)).toStrictEqual([1_000_500, 1_000_500, 1_000_500]);
  });

  it('falls back to now() when the host exposes no time origin to anchor the event clock to', () => {
    const target = fakeTarget();
    // No `timeOrigin` in env AND none on the host: `performance.timeOrigin` is absent on some embedded
    // engines, and `undefined + timeStamp` would silently stamp every breadcrumb NaN.
    vi.stubGlobal('performance', {});
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 42 });
    target.emit('change', { target: el({ tag: 'input' }), timeStamp: 250 });
    vi.unstubAllGlobals();
    expect(crumbs[0]?.timestamp).toBe(42);
    expect(Number.isNaN(crumbs[0]?.timestamp)).toBe(false);
  });

  it('falls back to now() when the injected timeOrigin is NaN, rather than propagating the arithmetic NaN', () => {
    const target = fakeTarget();
    const { crumbs } = activate({
      target,
      maskSelector: MASK,
      now: () => 1_000_500,
      timeOrigin: Number.NaN,
    });
    target.emit('change', { target: el({ tag: 'input' }), timeStamp: 250 });
    expect(crumbs[0]?.timestamp).toBe(1_000_500);
    expect(Number.isNaN(crumbs[0]?.timestamp)).toBe(false);
  });

  it('falls back to now() when the host exposes a non-number performance.timeOrigin', () => {
    const target = fakeTarget();
    // The default path reads `performance.timeOrigin` through an unchecked cast in
    // createUiBreadcrumbSource; a non-compliant host exposing it as e.g. a string must not poison
    // every breadcrumb timestamp with a NaN.
    vi.stubGlobal('performance', { timeOrigin: 'not-a-number' });
    const { crumbs } = activate({ target, maskSelector: MASK, now: () => 42 });
    target.emit('change', { target: el({ tag: 'input' }), timeStamp: 250 });
    vi.unstubAllGlobals();
    expect(crumbs[0]?.timestamp).toBe(42);
    expect(Number.isNaN(crumbs[0]?.timestamp)).toBe(false);
  });

  it('falls back to now() for a timeOrigin of exactly 0 (falsy-but-defined), not ~1970 values', () => {
    // No spec-compliant host ever anchors a real page's clock at the Unix epoch itself, so a literal 0
    // is treated the same as "no usable origin" rather than as a legitimate (if minimal) anchor — the
    // alternative (accepting it) would silently stamp breadcrumbs decades in the past and corrupt trail
    // ordering exactly as badly as the future-value case below.
    const target = fakeTarget();
    const { crumbs } = activate({
      target,
      maskSelector: MASK,
      now: () => 1_000_500,
      timeOrigin: 0,
    });
    target.emit('change', { target: el({ tag: 'input' }), timeStamp: 250 });
    expect(crumbs[0]?.timestamp).toBe(1_000_500);
  });

  it('never stamps the future: a legacy epoch-valued timeStamp is clamped to now()', () => {
    const target = fakeTarget();
    const { crumbs } = activate({
      target,
      maskSelector: MASK,
      now: () => 1_000_500,
      timeOrigin: 1_000_000,
    });
    target.emit('change', { target: el({ tag: 'input' }), timeStamp: 1_756_000_000_000 });
    expect(crumbs[0]?.timestamp).toBe(1_000_500);
  });

  // ---- observe-only ----

  it('never lets a throwing target/selector escape into the app dispatch', () => {
    const target = fakeTarget();
    const { crumbs } = activate({ target, maskSelector: MASK });
    const hostile = {
      tagName: 'DIV',
      getAttribute: () => null,
      closest: () => {
        throw new SyntaxError('invalid selector / instrumented DOM');
      },
    };
    expect(() => target.emit('change', { target: hostile })).not.toThrow();
    expect(crumbs).toStrictEqual([]); // swallowed AND nothing captured (fail-safe)
  });

  it('removes every listener on deactivate, matching the capture phase used on add', () => {
    const target = fakeTarget();
    const { off } = activate({ target, maskSelector: MASK });
    off();
    for (const type of SIGNALS) {
      expect(target.count(type)).toBe(0);
      expect(target.removeOptionsFor(type)).toEqual({ capture: true });
    }
  });

  it('activates but registers nothing when no DOM target is available (SSR / non-DOM host)', () => {
    const source = createUiBreadcrumbSource();
    const crumbs: BreadcrumbInput[] = [];
    expect(() => source.on('breadcrumb', (c) => crumbs.push(c))).not.toThrow();
    expect(crumbs).toStrictEqual([]);
  });

  it('defaults to the global document and the canonical mask attribute', () => {
    const target = fakeTarget();
    vi.stubGlobal('document', target);
    const { crumbs } = activate({});
    target.emit('focusin', { target: el({ tag: 'input', id: 'ssn', hidden: true }) });
    target.emit('focusin', { target: el({ tag: 'input', id: 'plain' }) });
    expect(crumbs.map((c) => c.data)).toStrictEqual([{ 'view.id': 'plain', 'view.tag': 'input' }]);
    vi.unstubAllGlobals();
  });

  it('defaults its clock to the real performance time origin + Date.now', () => {
    const target = fakeTarget();
    const before = Date.now();
    const { crumbs } = activate({ target, maskSelector: MASK });
    target.emit('change', { target: el({ tag: 'input' }), timeStamp: 0 });
    const stamped = crumbs[0]?.timestamp ?? 0;
    // timeOrigin + 0 is the page's start instant: a real wall-clock ms in the past, never the future.
    expect(stamped).toBeGreaterThan(before - 86_400_000);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });
});

describe('createUiBreadcrumbProvider', () => {
  const init = { captureAggregator: { addEntry: vi.fn() } } as unknown as CaptureProviderInit;
  const noOptions = {} as OptionsContainer;

  it('is gated by captureInteractions and names itself', () => {
    const p = createUiBreadcrumbProvider(createUiBreadcrumbSource({}), () => {});
    expect(p.name).toBe('ui-breadcrumbs');
    expect(p.controllingOption).toBe(BugseeOption.CaptureInteractions);
  });

  it('forwards each emitted breadcrumb to the sink only while started', () => {
    const target = fakeTarget();
    const source = createUiBreadcrumbSource({ target, maskSelector: MASK, now: () => 3 });
    const sink = vi.fn();
    const provider = createUiBreadcrumbProvider(source, sink);
    provider.init(init);

    target.emit('change', { target: el({ tag: 'input', id: 'a' }) }); // before start → nothing
    expect(sink).not.toHaveBeenCalled();
    expect(target.count('change')).toBe(0); // ...and the DOM was never touched

    provider.start(noOptions);
    target.emit('change', { target: el({ tag: 'input', id: 'a' }) });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      type: 'user',
      category: 'ui.change',
      level: 'info',
      timestamp: 3,
      data: { 'view.id': 'a', 'view.tag': 'input' },
    });

    provider.stop();
    expect(target.count('change')).toBe(0); // the source deactivated with its last subscriber
    target.emit('change', { target: el({ tag: 'input', id: 'a' }) });
    expect(sink).toHaveBeenCalledTimes(1); // still 1 — stop() really unsubscribed
  });

  it('tolerates a stop() without a start() (idempotent teardown)', () => {
    const provider = createUiBreadcrumbProvider(createUiBreadcrumbSource({}), () => {});
    provider.init(init);
    expect(() => {
      provider.stop();
      provider.stop();
    }).not.toThrow();
  });
});
