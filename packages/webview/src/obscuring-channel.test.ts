import { describe, expect, it } from 'vitest';
import { createObscuringChannel } from './obscuring-channel';
import type { SecureMessage } from './protocol';

const el = (top: number) => ({
  getBoundingClientRect: () => ({ top, left: top + 1, bottom: top + 2, right: top + 3 }),
});

// A fake DOM document/window: querySelectorAll by selector + an event-listener registry (so we can `fire`
// events). Listeners take an optional event arg (the composer's `message` handler does) so it satisfies the
// ComposerDocument/ComposerWindow seams. No iframes here — the channel's own + child composition is covered by
// obscuring-composer.test.ts; these tests pin the channel's native serialization (seq/time/secure post).
function fakeDoc(bySelector: Record<string, ReturnType<typeof el>[]>) {
  const listeners = new Map<string, Set<(e?: unknown) => void>>();
  return {
    querySelectorAll: (sel: string) => bySelector[sel] ?? [],
    addEventListener: (type: string, l: (e?: unknown) => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(l);
    },
    removeEventListener: (type: string, l: (e?: unknown) => void) => listeners.get(type)?.delete(l),
    body: {},
    fire: (type: string, e?: unknown) => {
      for (const l of [...(listeners.get(type) ?? [])]) l(e);
    },
  };
}

const HIDE = '.bugsee-hide';

function fakeBridge() {
  const posted: string[] = [];
  return { available: true, post: (raw: string) => posted.push(raw), posted };
}

function setup(docAreas: Record<string, ReturnType<typeof el>[]>) {
  const bridge = fakeBridge();
  const doc = fakeDoc(docAreas);
  let seqN = 100;
  const channel = createObscuringChannel({
    bridge,
    document: doc,
    seq: () => seqN++,
    wallNow: () => 5000,
    now: () => 1.5,
    timeOrigin: 200,
    mutationObserver: undefined, // no observer → only the focus/blur listeners drive change
  });
  return { bridge, doc, channel };
}

describe('createObscuringChannel', () => {
  it('posts a secure message with the serialized rects + time/seq frame on change', () => {
    const { bridge, doc, channel } = setup({ [HIDE]: [el(10)] });
    channel.start();
    doc.fire('focus'); // a tracked change
    // EXACT, not `>= 1`. These were `toHaveLength(1)` until start() gained an unconditional initial
    // push; relaxing them to `>= 1` made them unable to fail — see the stop() test below.
    expect(bridge.posted).toHaveLength(2); // [0] initial push from start(), [1] the focus-driven change
    // Asserted on [1], the CHANGE — the title says "on change", and reading [0] tested the initial push
    // instead, so the focus path this test exists for was never checked. The sequence number distinguishes
    // them: [0] took 100, so a message that is really the change carries 101.
    const initial = JSON.parse(bridge.posted[0] as string) as SecureMessage;
    expect(initial.s).toBe(100);
    const m = JSON.parse(bridge.posted[1] as string) as SecureMessage;
    expect(m).toEqual({
      b: 1,
      k: 'secure',
      s: 101,
      ts: 5000,
      mono: 1.5,
      o: 200,
      p: [{ type: 'hidden', top: 10, left: 11, bottom: 12, right: 13 }], // inline array on the wire
    });
  });

  it('snapshot() returns the serialized current rects WITHOUT posting (sync native pull)', () => {
    const { bridge, channel } = setup({ [HIDE]: [el(7)] });
    expect(channel.snapshot()).toBe(
      JSON.stringify([{ type: 'hidden', top: 7, left: 8, bottom: 9, right: 10 }]),
    );
    expect(bridge.posted).toHaveLength(0); // a pull never crosses the bridge
  });

  it('emit() posts the current rects (the native `snapshot` command path)', () => {
    const { bridge, channel } = setup({ [HIDE]: [el(0)] });
    channel.emit();
    expect(bridge.posted).toHaveLength(1); // emit() only — start() was never called
    const m = JSON.parse(bridge.posted[0] as string) as SecureMessage;
    expect(m.k).toBe('secure');
    expect(m.p).toEqual([{ type: 'hidden', top: 0, left: 1, bottom: 2, right: 3 }]);
  });

  it('stop() detaches — no further posts after stop', () => {
    const { bridge, doc, channel } = setup({ [HIDE]: [el(0)] });
    channel.start();
    doc.fire('focus');
    expect(bridge.posted).toHaveLength(2); // [0] initial push, [1] the focus-driven change
    channel.stop();
    doc.fire('focus');
    expect(bridge.posted).toHaveLength(2); // STILL 2 — detached. `>= 1` here asserted nothing at all.
  });

  it('defaults wallNow/now/timeOrigin to the ambient clock when omitted (real values, not constants)', () => {
    const bridge = fakeBridge();
    const channel = createObscuringChannel({
      bridge,
      document: fakeDoc({ [HIDE]: [el(1)] }),
      seq: () => 1,
    });
    const before = Date.now();
    channel.emit();
    const after = Date.now();
    const m = JSON.parse(bridge.posted[0] as string) as SecureMessage;
    // `ts` is a real wall clock between two Date.now() reads — a `() => 0` default would fail this bracket.
    expect(m.ts).toBeGreaterThanOrEqual(before);
    expect(m.ts).toBeLessThanOrEqual(after);
    // `mono`/`o` come from a running process's performance clock — both strictly > 0 (a `0` default would fail).
    expect(m.mono).toBeGreaterThan(0);
    expect(m.o).toBeGreaterThan(0);
  });

  it('forwards an injected MutationObserver to the source (a DOM mutation drives a secure post)', () => {
    const bridge = fakeBridge();
    const doc = fakeDoc({ [HIDE]: [el(3)] });
    let mutate: () => void = () => {};
    class MO {
      constructor(cb: () => void) {
        mutate = cb;
      }
      observe() {}
      disconnect() {}
    }
    const channel = createObscuringChannel({
      bridge,
      document: doc,
      seq: () => 1,
      mutationObserver: MO as never,
    });
    channel.start();
    mutate(); // a DOM change observed via the injected observer
    expect(bridge.posted).toHaveLength(2); // [0] initial push, [1] the mutation-driven change
    channel.stop();
  });

  it('passes the window through for scroll/resize tracking', () => {
    const bridge = fakeBridge();
    const doc = fakeDoc({ [HIDE]: [el(0)] });
    const win = fakeDoc({});
    const channel = createObscuringChannel({
      bridge,
      document: doc,
      window: win,
      seq: () => 1,
      mutationObserver: undefined,
    });
    channel.start();
    win.fire('scroll');
    expect(bridge.posted).toHaveLength(2); // [0] initial push, [1] the scroll-driven change
    channel.stop();
  });
});
