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

  it('pins at the first POST', () => {
    const s = swappable();
    s.attach();
    const bridge = createHostBridge({ global: s.global });
    bridge.post('x');
    s.hijack();
    bridge.post('y');
    expect(s.real).toEqual(['x', 'y']);
    expect(s.attacker).toEqual([]);
  });

  it('reading `available` does not pin — the pin happens at the first message', () => {
    // `available` used to call resolve(), so a mere read pinned the sink. Round 1 flagged the mutating
    // getter; it now reports without binding anything. Pinning happens at the first message instead —
    // which in `launch()` is the synchronous hello, so no page script can run in between.
    //
    // Reading `available` BEFORE the swap is what makes the difference observable. The sibling test above
    // could not see it: it attached the real sink first, so a pinning getter pinned exactly what the test
    // then asserted, and the "does not pin" half of its name was never checked at all.
    const s = swappable();
    s.attach(); // sink A
    const bridge = createHostBridge({ global: s.global });
    expect(bridge.available).toBe(true); // pure read — must NOT bind A
    s.hijack(); // sink B replaces A before any message is sent
    bridge.post('first');

    expect(s.attacker, 'the getter pinned sink A, so the first message never reached B').toEqual([
      'first',
    ]);
    expect(s.real).toEqual([]);
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

// The WKWebView sink (iOS). Native registers a WKScriptMessageHandler under the SAME name Android uses for
// its @JavascriptInterface — `BugseeBridge` — so the wire, the nonce and the pinning discipline are identical
// and only the call shape differs: `window.webkit.messageHandlers.BugseeBridge.postMessage(raw)`.
//
// Deliberately the same name, and deliberately NOT the legacy `BugseeJsListener`: the two channels coexist
// during migration exactly as they do on Android, and the legacy one speaks a different protocol.
describe('createHostBridge — the WKWebView (iOS) sink', () => {
  /** A fake WKWebView global: `window.webkit.messageHandlers.BugseeBridge.postMessage(raw)`. */
  const withWebkit = (
    postMessage: (raw: string) => void,
  ): { webkit: { messageHandlers: { BugseeBridge: { postMessage(raw: string): void } } } } => ({
    webkit: { messageHandlers: { BugseeBridge: { postMessage } } },
  });

  it('posts the raw wire string to webkit.messageHandlers.BugseeBridge.postMessage', () => {
    const posted: string[] = [];
    const bridge = createHostBridge({ global: withWebkit((r) => posted.push(r)) });
    expect(bridge.available).toBe(true);
    bridge.post('{"b":1,"k":"hello"}');
    expect(posted).toEqual(['{"b":1,"k":"hello"}']);
  });

  it('reports unavailable when webkit is present but our handler is not registered', () => {
    // `window.webkit` exists in every WKWebView, so its mere presence proves nothing. Only OUR named
    // handler does — and native registers it solely on the gated advanced path.
    const bridge = createHostBridge({ global: { webkit: { messageHandlers: {} } } });
    expect(bridge.available).toBe(false);
    expect(() => bridge.post('a')).not.toThrow(); // buffered, never throws
  });

  it('reports unavailable when there is no webkit at all (a non-WKWebView realm)', () => {
    const bridge = createHostBridge({ global: {} });
    expect(bridge.available).toBe(false);
  });

  it('buffers until native registers the handler, then flushes the backlog in order', () => {
    // Native adds the handler in `WKWebViewConfiguration`, so it is normally there before page script —
    // but the runtime-injection path registers later, and the SDK must not lose that startup capture.
    const global: {
      webkit?: { messageHandlers: { BugseeBridge?: { postMessage(raw: string): void } } };
    } = {};
    const bridge = createHostBridge({ global });
    bridge.post('a');
    bridge.post('b');
    const posted: string[] = [];
    global.webkit = { messageHandlers: { BugseeBridge: { postMessage: (r) => posted.push(r) } } };
    bridge.post('c');
    expect(posted).toEqual(['a', 'b', 'c']);
  });

  it('calls postMessage with the message handler as receiver', () => {
    // `webkit.messageHandlers.X` is a host object on iOS exactly as an @JavascriptInterface is on Android:
    // `postMessage` must be invoked WITH it as receiver or WebKit throws. Binding is what preserves that.
    let receiver: unknown;
    const handler = {
      postMessage(this: unknown, _raw: string) {
        receiver = this;
      },
    };
    createHostBridge({
      global: { webkit: { messageHandlers: { BugseeBridge: handler } } },
    }).post('x');
    expect(receiver).toBe(handler);
  });

  it('keeps delivering to the pinned sink after the page swaps window.webkit', () => {
    // The SEV1-3 tap, in its iOS shape. `window.webkit` is an ordinary page-visible object, so a script
    // that runs after the SDK can replace the whole tree and receive 100% of subsequent capture — logs,
    // request URLs, bodies — with the SDK still apparently working. Pinning the bound method on first
    // resolve is what makes the swap unobservable.
    const real: string[] = [];
    const attacker: string[] = [];
    const global: {
      webkit?: { messageHandlers: { BugseeBridge: { postMessage(raw: string): void } } };
    } = { webkit: { messageHandlers: { BugseeBridge: { postMessage: (r) => real.push(r) } } } };
    const bridge = createHostBridge({ global });
    bridge.post('before');
    global.webkit = {
      messageHandlers: { BugseeBridge: { postMessage: (r) => attacker.push(r) } },
    };
    bridge.post('after');

    expect(real, 'the real native sink lost traffic after the swap').toEqual(['before', 'after']);
    expect(attacker, 'a page script that swapped window.webkit received capture').toEqual([]);
  });

  it('keeps sending to the pinned METHOD after the page overwrites postMessage', () => {
    // The same round-1 SEV2 hole as Android's: pinning the OBJECT would still dereference `.postMessage`
    // on every send, so leaving the tree alone and overwriting just the method reroutes the stream.
    const real: string[] = [];
    const attacker: string[] = [];
    const handler = { postMessage: (r: string) => real.push(r) };
    const bridge = createHostBridge({
      global: { webkit: { messageHandlers: { BugseeBridge: handler } } },
    });
    bridge.post('before');

    handler.postMessage = (r: string) => attacker.push(r);
    bridge.post('after');

    expect(real, 'the real sink lost traffic when postMessage was overwritten').toEqual([
      'before',
      'after',
    ]);
    expect(attacker, 'overwriting postMessage captured the stream').toEqual([]);
  });

  it('does not pin a malformed handler — a non-function postMessage is not a sink', () => {
    const global: { webkit?: unknown } = {
      webkit: { messageHandlers: { BugseeBridge: { postMessage: 'not a function' } } },
    };
    const bridge = createHostBridge({ global: global as object });
    expect(bridge.available).toBe(false);
    bridge.post('buffered');

    const real: string[] = [];
    global.webkit = {
      messageHandlers: { BugseeBridge: { postMessage: (r: string) => real.push(r) } },
    };
    bridge.post('live');
    expect(real).toEqual(['buffered', 'live']);
  });

  it('routes a WebKit postMessage failure to onError without throwing', () => {
    // WebKit throws if the handler was removed (navigation, `removeScriptMessageHandler`). Capture must
    // never alter host-app behaviour, so that surfaces as an SDK error and nothing else.
    const onError = vi.fn();
    const bridge = createHostBridge({
      global: withWebkit(() => {
        throw new Error('handler removed');
      }),
      onError,
    });
    expect(() => bridge.post('a')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stamps the capture nonce over the WebKit sink too', () => {
    // D-A11 is enforced at the single stamping choke point, so it must hold for every transport. A sink
    // that bypassed it would have 100% of its capture dropped by native as forged.
    const posted: string[] = [];
    createHostBridge({ global: withWebkit((r) => posted.push(r)), nonce: 'n-ios' }).post(
      '{"b":1,"k":"entry","t":"log"}',
    );
    expect(JSON.parse(posted[0] as string)).toMatchObject({ n: 'n-ios', b: 1, k: 'entry' });
  });

  it('sends ONLY to the transport native declared, ignoring a well-formed plant at the other name', () => {
    // THE hazard of supporting two sinks, and it is not the same as the malformed case below.
    //
    // Each native populates exactly one of these names and leaves the other permanently VACANT: Android's
    // `addJavascriptInterface` creates `window.BugseeBridge` and never `window.webkit`; iOS's
    // `addScriptMessageHandler:name:` creates `webkit.messageHandlers.BugseeBridge` and never
    // `window.BugseeBridge`. A vacant name is a page-writable slot, so probing by preference order means a
    // page script that plants a WELL-FORMED sink at whichever name its platform leaves empty receives 100%
    // of the capture stream — logs, request URLs, bodies, all un-redacted — plus the capture nonce stamped
    // on every message, while the real handler gets nothing and the SDK reports no error. On iOS it needs
    // no race at all: `window.BugseeBridge` is never occupied.
    //
    // No probe ORDER fixes this; order only chooses which platform is exposed. Native declares the
    // transport instead — it knows which one it registered, and says so over the same out-of-band route
    // that already carries the nonces.
    const real: string[] = [];
    const planted: string[] = [];
    const both = {
      BugseeBridge: { post: (r: string) => planted.push(r) },
      webkit: { messageHandlers: { BugseeBridge: { postMessage: (r: string) => real.push(r) } } },
    };

    createHostBridge({ global: both, transport: 'webkit' }).post('x');
    expect(real, 'the declared WebKit sink did not receive the message').toEqual(['x']);
    expect(planted, 'a plant at the vacant Android name captured the stream').toEqual([]);
  });

  it('a declared ANDROID transport that is absent never falls back either', () => {
    // The android half needs its own no-fallback case, and it must be one where PROBING would give the
    // wrong answer. Asserting "declared android reaches the android sink" proves nothing: the probe
    // fallback tries android first anyway, so that test passes with the declaration ignored entirely —
    // which is exactly the mutation it was supposed to catch.
    const planted: string[] = [];
    const bridge = createHostBridge({
      global: {
        webkit: {
          messageHandlers: { BugseeBridge: { postMessage: (r: string) => planted.push(r) } },
        },
      },
      transport: 'android',
    });
    expect(bridge.available).toBe(false);
    bridge.post('x');
    expect(planted, 'a declared android host fell back to a WebKit plant').toEqual([]);
  });

  it('a declared transport that is absent NEVER falls back to the other one', () => {
    // Falling back would reopen the hole exactly when it matters: native said "webkit", so anything at the
    // Android name is by definition not native's.
    const planted: string[] = [];
    const bridge = createHostBridge({
      global: { BugseeBridge: { post: (r: string) => planted.push(r) } },
      transport: 'webkit',
    });
    expect(bridge.available).toBe(false);
    bridge.post('x');
    expect(planted).toEqual([]);
  });

  it('still probes both when native declares no transport, for hosts that predate the option', () => {
    // Backward compatibility: an older bundle's bootstrap sends no transport. Probing is best-effort and
    // documented as such — it is precisely what the declared transport exists to replace.
    const android: string[] = [];
    createHostBridge({ global: { BugseeBridge: { post: (r: string) => android.push(r) } } }).post(
      'x',
    );
    expect(android).toEqual(['x']);

    const webkit: string[] = [];
    createHostBridge({
      global: {
        webkit: {
          messageHandlers: { BugseeBridge: { postMessage: (r: string) => webkit.push(r) } },
        },
      },
    }).post('y');
    expect(webkit).toEqual(['y']);
  });

  it('a throwing getter on the VACANT name cannot suppress the real sink', () => {
    // The sharper half of the previous test, and the one that has teeth. Under a single shared try/catch a
    // hostile getter on the name a platform does not use aborts resolution before the real sink is ever
    // consulted — upgrading "plant a `{}`", which the usable-sink fall-through defeats, into "plant a
    // thrower", which would defeat it. That is denial-of-capture at exactly the name the fall-through
    // exists to neutralise.
    //
    // The sibling below installs throwing getters on BOTH names, so it cannot tell the two designs apart.
    const real: string[] = [];
    const global = {
      webkit: { messageHandlers: { BugseeBridge: { postMessage: (r: string) => real.push(r) } } },
    };
    Object.defineProperty(global, 'BugseeBridge', {
      get() {
        throw new Error('hostile getter on the vacant name');
      },
    });

    const bridge = createHostBridge({ global });
    expect(bridge.available, 'a thrower at the vacant name hid the real sink').toBe(true);
    bridge.post('x');
    expect(real).toEqual(['x']);
  });

  it('an UNRECOGNISED transport fails closed rather than reverting to the probe', () => {
    // A typo, a trailing space, or a transport a newer native introduces must not silently restore the
    // insecure probe. An option whose entire purpose is to fail closed cannot fail open on a value it does
    // not recognise.
    const planted: string[] = [];
    const bridge = createHostBridge({
      global: { BugseeBridge: { post: (r: string) => planted.push(r) } },
      transport: 'ios' as unknown as 'webkit',
    });
    expect(bridge.available).toBe(false);
    bridge.post('x');
    expect(planted, 'an unrecognised transport fell back to probing').toEqual([]);
  });

  it('reports a hostile getter to onError rather than failing silently', () => {
    // Otherwise the bridge simply goes dark: no sink, no diagnostic, and capture buffers until evicted.
    const onError = vi.fn();
    const global = {};
    Object.defineProperty(global, 'BugseeBridge', {
      get() {
        throw new Error('hostile');
      },
    });
    createHostBridge({ global, onError }).post('x');
    expect(onError).toHaveBeenCalled();
  });

  it('never throws out of resolution when a page makes the host properties throw', () => {
    // `available` and `post` resolve OUTSIDE the send try/catch, and resolution performs page-controllable
    // property reads. A page can install a throwing getter on `window.webkit`, which would turn both
    // `launch()` and every later capture call into an exception inside the host app — the one thing
    // capture must never do.
    const global = {};
    for (const name of ['webkit', 'BugseeBridge']) {
      Object.defineProperty(global, name, {
        get() {
          throw new Error('hostile getter');
        },
      });
    }

    const bridge = createHostBridge({ global });
    expect(() => bridge.available).not.toThrow();
    expect(bridge.available).toBe(false);
    expect(() => bridge.post('x')).not.toThrow();
  });

  it('falls back to WebKit when the Android interface is present but malformed', () => {
    // A page script can plant `window.BugseeBridge = {}`. If that merely SHADOWED the real WebKit sink the
    // page would have a denial-of-capture primitive; preferring Android must mean preferring a USABLE one.
    const posted: string[] = [];
    const bridge = createHostBridge({
      global: {
        BugseeBridge: { post: 'not a function' },
        webkit: {
          messageHandlers: { BugseeBridge: { postMessage: (r: string) => posted.push(r) } },
        },
      } as object,
    });
    expect(bridge.available).toBe(true);
    bridge.post('x');
    expect(posted).toEqual(['x']);
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
