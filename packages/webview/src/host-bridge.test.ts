import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostBridge } from './host-bridge';

// A fake Android @JavascriptInterface global: `window.BugseeBridge.post(raw)`.
const withBridge = (post: (raw: string) => void) => ({ BugseeBridge: { post } });

afterEach(() => vi.unstubAllGlobals());

describe('createHostBridge', () => {
  it('posts the raw wire string to the native BugseeBridge.post', () => {
    const posted: string[] = [];
    const bridge = createHostBridge({ global: withBridge((r) => posted.push(r)) });
    expect(bridge.available).toBe(true);
    bridge.post('{"k":"hello"}');
    expect(posted).toEqual(['{"k":"hello"}']);
  });

  it('reports unavailable + buffers when no native bridge is attached yet', () => {
    const global: { BugseeBridge?: { post(raw: string): void } } = {};
    const bridge = createHostBridge({ global });
    expect(bridge.available).toBe(false);
    expect(() => bridge.post('a')).not.toThrow(); // buffered, never throws
  });

  it('flushes buffered messages (in order) the moment the bridge attaches', () => {
    const global: { BugseeBridge?: { post(raw: string): void } } = {};
    const bridge = createHostBridge({ global });
    bridge.post('a');
    bridge.post('b');
    const posted: string[] = [];
    global.BugseeBridge = { post: (r) => posted.push(r) }; // native attaches late
    bridge.post('c');
    expect(posted).toEqual(['a', 'b', 'c']); // backlog flushed first, then the new one
  });

  it('bounds the buffer, evicting the OLDEST when full (FIFO)', () => {
    const global: { BugseeBridge?: { post(raw: string): void } } = {};
    const bridge = createHostBridge({ global, maxBuffer: 2 });
    bridge.post('a');
    bridge.post('b');
    bridge.post('c'); // overflow → 'a' evicted
    const posted: string[] = [];
    global.BugseeBridge = { post: (r) => posted.push(r) };
    bridge.post('d');
    expect(posted).toEqual(['b', 'c', 'd']); // 'a' dropped
  });

  it('routes a native post failure to onError without throwing', () => {
    const onError = vi.fn();
    const bridge = createHostBridge({
      global: withBridge(() => {
        throw new Error('jni boom');
      }),
      onError,
    });
    expect(() => bridge.post('a')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('jni boom');
  });

  it('swallows a post failure with the default no-op onError (no onError supplied)', () => {
    const bridge = createHostBridge({
      global: withBridge(() => {
        throw new Error('boom');
      }),
    });
    expect(() => bridge.post('a')).not.toThrow();
  });

  it('defaults the global to globalThis', () => {
    const posted: string[] = [];
    vi.stubGlobal('BugseeBridge', { post: (r: string) => posted.push(r) });
    const bridge = createHostBridge();
    bridge.post('x');
    expect(posted).toEqual(['x']);
  });
});

// WAVE 0.3 / D-A4 — the sink is pinned on FIRST resolve (docs/design/webview-bridge-auth.md).
//
// SEV1-3: `resolve()` re-read `global.BugseeBridge` inside every `post()`, so any script loading after the
// SDK — an ad tag, an analytics snippet, a chat widget — could assign its own `{post}` and receive 100% of
// subsequent capture: console logs, full request URLs, request/response bodies. The SDK kept working, so
// nothing looked wrong. It is a data-exfiltration primitive with the SDK as the collector, and it is not
// theoretical: JS-side redaction is OFF by default (native re-redacts on receipt), which protects the
// stored bundle and does nothing for someone reading the wire inside the page.
//
// The re-resolution existed for a real reason — native may register the interface AFTER the script starts —
// so the fix is not to resolve at construction. It is to resolve once, LAZILY, and never look again.
describe('createHostBridge — the native sink is pinned (Wave 0.3)', () => {
  /** A global whose `BugseeBridge` can be swapped, as a page script would. */
  const swappable = (): {
    global: { BugseeBridge?: { post(raw: string): void } };
    real: string[];
    attacker: string[];
    attach(): void;
    hijack(): void;
  } => {
    const real: string[] = [];
    const attacker: string[] = [];
    const global: { BugseeBridge?: { post(raw: string): void } } = {};
    return {
      global,
      real,
      attacker,
      attach: () => {
        global.BugseeBridge = { post: (r) => real.push(r) };
      },
      hijack: () => {
        global.BugseeBridge = { post: (r) => attacker.push(r) };
      },
    };
  };

  it('keeps delivering to the ORIGINAL sink after the page swaps the global', () => {
    const s = swappable();
    s.attach();
    const bridge = createHostBridge({ global: s.global });
    bridge.post('before');
    s.hijack();
    bridge.post('after');

    expect(s.real, 'the real native sink lost traffic after the swap').toEqual(['before', 'after']);
    expect(s.attacker, 'a page script that swapped the global received capture').toEqual([]);
  });

  it('still resolves LAZILY — a bridge attached after construction is found and the backlog drains', () => {
    // The behaviour the re-resolution existed for, which pinning must not regress.
    const s = swappable();
    const bridge = createHostBridge({ global: s.global });
    expect(bridge.available).toBe(false);
    bridge.post('buffered');
    s.attach();
    expect(bridge.available).toBe(true);
    bridge.post('live');
    expect(s.real).toEqual(['buffered', 'live']);
  });

  it('pins at the first POST, and reading `available` does not pin', () => {
    // `available` used to call resolve(), so a mere read pinned the sink. Round 1 flagged the mutating
    // getter; it now reports without binding anything. Pinning happens at the first message instead —
    // which in `launch()` is the synchronous hello, so no page script can run in between.
    const s = swappable();
    s.attach();
    const bridge = createHostBridge({ global: s.global });
    expect(bridge.available).toBe(true); // pure read — must NOT pin
    bridge.post('x');
    s.hijack();
    bridge.post('y');
    expect(s.real).toEqual(['x', 'y']);
    expect(s.attacker).toEqual([]);
  });

  it('keeps sending to the pinned METHOD after the page overwrites `post` on the object', () => {
    // Round 1, SEV2: pinning the OBJECT still dereferenced `.post` on every send, so a page script could
    // leave the binding alone — the thing pinning watches — and just overwrite the method:
    //   window.BugseeBridge.post = evil
    // and receive the entire capture stream. The bound method is captured once instead.
    const real: string[] = [];
    const attacker: string[] = [];
    const bridgeObj = { post: (r: string) => real.push(r) };
    const global = { BugseeBridge: bridgeObj };
    const bridge = createHostBridge({ global });
    bridge.post('before');

    bridgeObj.post = (r: string) => attacker.push(r); // mutate the METHOD, not the binding
    bridge.post('after');

    expect(real, 'the real sink lost traffic when `post` was overwritten').toEqual([
      'before',
      'after',
    ]);
    expect(attacker, 'overwriting `post` captured the stream').toEqual([]);
  });

  it('calls the native sink with the bridge object as receiver', () => {
    // A Java @JavascriptInterface is a host object: `post` must be called WITH it as receiver. Binding is
    // what preserves that; a bare function reference would lose it and throw at the JNI boundary.
    let receiver: unknown;
    const bridgeObj = {
      post(this: unknown, _raw: string) {
        receiver = this;
      },
    };
    createHostBridge({ global: { BugseeBridge: bridgeObj } }).post('x');
    expect(receiver).toBe(bridgeObj);
  });

  it('hands the whole BACKLOG to whichever sink pins first — which is why secrets must not be buffered', () => {
    // Round 1 raised this as a token leak. Verified precisely: pinning and draining happen in the SAME
    // synchronous `post()`, so nothing can interleave between them, and re-reading the global at drain
    // time is not separately exploitable. The real hazard is upstream and is REAL: anything already in the
    // buffer is delivered to whatever sink turns up later. `hello` is the first message, so if it carried
    // the control token while native had not yet attached, a page script that attaches after the SDK
    // receives that token.
    //
    // This test pins the behaviour so the mitigation cannot be quietly undone: the fix is in `launch()`,
    // which withholds the token unless a sink is ALREADY present (see launch.test.ts).
    const s = swappable();
    const bridge = createHostBridge({ global: s.global });
    bridge.post('buffered-secret');
    s.hijack(); // a page script, not native, is what turns up
    bridge.post('live');
    expect(s.attacker).toEqual(['buffered-secret', 'live']);
    expect(s.real).toEqual([]);
  });

  it('does not pin a malformed bridge — a non-function post is not a sink', () => {
    // Guards against pinning garbage and then never re-looking, which would be worse than re-resolving:
    // the SDK would be permanently unable to reach a native bridge that attached correctly afterwards.
    const global: { BugseeBridge?: unknown } = { BugseeBridge: { post: 'not a function' } };
    const bridge = createHostBridge({ global: global as object });
    expect(bridge.available).toBe(false);
    bridge.post('buffered');

    const real: string[] = [];
    global.BugseeBridge = { post: (r: string) => real.push(r) };
    bridge.post('live');
    expect(real).toEqual(['buffered', 'live']);
  });
});

describe('nonce stamping (D-A11)', () => {
  const sink = (): { got: string[]; global: object } => {
    const got: string[] = [];
    return { got, global: { BugseeBridge: { post: (raw: string) => got.push(raw) } } };
  };

  it('stamps every outgoing message with the native-minted nonce', () => {
    // Native cannot tell the SDK's `entry`/`batch` from a page script's — both arrive on the same
    // @JavascriptInterface. Unstamped, any frame can inject fabricated log/network entries into the
    // customer's session, and (with no rate limit) flood the ring buffer until the REAL capture of the bug
    // being reported is evicted. Stamping is what lets native drop them.
    const s = sink();
    const bridge = createHostBridge({ global: s.global, nonce: 'n-123' });

    bridge.post('{"b":1,"k":"entry","t":"log"}');

    expect(JSON.parse(s.got[0] as string)).toMatchObject({ n: 'n-123', b: 1, k: 'entry' });
  });

  it('stamps buffered messages too, when they drain', () => {
    // The backlog is posted BEFORE the bridge attaches. If drain skipped stamping, everything captured
    // during startup would be dropped by native as forged — the messages most likely to matter.
    const s = sink();
    const detached = {} as { BugseeBridge?: unknown };
    const bridge = createHostBridge({ global: detached, nonce: 'n-123' });
    bridge.post('{"b":1,"k":"hello"}');

    (detached as { BugseeBridge?: unknown }).BugseeBridge = s.global as never;
    Object.assign(detached, s.global);
    bridge.post('{"b":1,"k":"entry"}');

    expect(s.got).toHaveLength(2);
    for (const raw of s.got) expect(JSON.parse(raw)).toMatchObject({ n: 'n-123' });
  });

  it('escapes the nonce rather than splicing it raw', () => {
    // The nonce reaches the wire inside a JSON string. An unescaped quote would corrupt every message.
    const s = sink();
    createHostBridge({ global: s.global, nonce: 'a"b\\c' }).post('{"b":1,"k":"entry"}');

    expect(JSON.parse(s.got[0] as string)).toMatchObject({ n: 'a"b\\c' });
  });

  it('leaves messages untouched when no nonce was issued', () => {
    // Backward compatible: a host that mints no nonce must still produce exactly the previous wire bytes.
    const s = sink();
    createHostBridge({ global: s.global }).post('{"b":1,"k":"entry"}');

    expect(s.got[0]).toBe('{"b":1,"k":"entry"}');
  });
});
