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

  it('pins the FIRST bridge it sees, not one that replaces it before the first post', () => {
    // The window between "native attached" and "the SDK posted" is still a window. Whoever is there when
    // the SDK first looks is the sink for the session.
    const s = swappable();
    s.attach();
    const bridge = createHostBridge({ global: s.global });
    expect(bridge.available).toBe(true); // <- first look happens here
    s.hijack();
    bridge.post('x');
    expect(s.real).toEqual(['x']);
    expect(s.attacker).toEqual([]);
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
