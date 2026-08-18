import type { WindowEvents } from '@bugsee/browser';
import {
  type CaptureStore,
  type Clock,
  contributeServiceManifest,
  type Scheduler,
  type StoredEntry,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BugseeWebViewLaunchOptions, launch } from './launch';
import { SECURE_INPUT_SELECTOR } from './obscuring-source';
import type {
  BatchMessage,
  ByeMessage,
  EntryMessage,
  HelloMessage,
  ReportMessage,
  SecureMessage,
} from './protocol';

type AnyMsg =
  | HelloMessage
  | EntryMessage
  | ReportMessage
  | SecureMessage
  | BatchMessage
  | ByeMessage;

interface BridgeGlobalApi {
  control(raw: string): void;
  snapshot(): string;
}

// A fake WebView global: the native `@JavascriptInterface` post sink + the slot the launch sets `__bugsee_bridge`.
function fakeGlobal() {
  const posted: string[] = [];
  const global: {
    BugseeBridge: { post(raw: string): void };
    __bugsee_bridge?: BridgeGlobalApi;
  } = { BugseeBridge: { post: (r) => posted.push(r) } };
  return { global, msgs: (): AnyMsg[] => posted.map((r) => JSON.parse(r) as AnyMsg) };
}

// A fake DOM document for obscuring: querySelectorAll by selector + an event registry + a body. Satisfies both
// the input-source event target AND the obscuring source (querySelectorAll/body/focus-blur).
function fakeDomDocument(
  bySelector: Record<string, Array<{ getBoundingClientRect(): object }>> = {},
) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const document = {
    querySelectorAll: (sel: string) => bySelector[sel] ?? [],
    addEventListener(type: string, listener: (event: Event) => void) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
    body: {},
  };
  return {
    document,
    emit: (type: string, event?: unknown) => {
      for (const l of [...(listeners.get(type) ?? [])]) l(event as Event);
    },
  };
}

const secureEl = (top: number) => ({
  getBoundingClientRect: () => ({ top, left: top + 1, bottom: top + 2, right: top + 3 }),
});
const SECURE_INPUT = SECURE_INPUT_SELECTOR;

const inertScheduler: Scheduler = {
  setInterval: () => 0 as unknown as ReturnType<Scheduler['setInterval']>,
  clearInterval: () => {},
};

// A fake window/document event target: records listeners + dispatches synthetic events (mirrors the browser
// tier). Also a valid (empty) obscuring document — `querySelectorAll` returns nothing (no secure elements, no
// iframes) + a `body`, since the obscuring composer reads the document for its initial own-areas on start.
function fakeEventTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target = {
    querySelectorAll: () => [] as unknown[],
    body: {},
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    emit: (type: string, event: unknown) => {
      for (const l of [...(listeners.get(type) ?? [])]) l(event as Event);
    },
  };
}

const entriesOfType = (msgs: AnyMsg[], t: EntryMessage['t']): EntryMessage[] =>
  msgs.filter((m): m is EntryMessage => m.k === 'entry' && m.t === t);

// Send a native→JS control message through the exposed `__bugsee_bridge.control`.
const sendControl = (
  g: { __bugsee_bridge?: { control(raw: string): void } },
  msg: Record<string, unknown>,
) => g.__bugsee_bridge?.control(JSON.stringify({ b: 1, k: 'control', ...msg }));

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
  // The default-global test installs globalThis.__bugsee_bridge on a NON-CONFIGURABLE binding (Wave 0.3 /
  // D-A3), so it cannot be deleted — `delete` here used to be the cleanup and now throws. It does not need
  // to be: `stop()` above puts the session inert, which is the state a fresh launch starts from anyway.
});

const track = (token: string, options: BugseeWebViewLaunchOptions) => {
  const client = launch(token, options);
  clients.push(client);
  return client;
};

const baseOptions = (
  over: Partial<BugseeWebViewLaunchOptions> = {},
): BugseeWebViewLaunchOptions & { global: object } => ({
  global: fakeGlobal().global, // overridden per test when the posted stream is inspected
  scheduler: inertScheduler,
  captureNetwork: false, // don't patch the real fetch/XHR globals in unit tests
  carrier: {}, // a fresh per-WebView carrier so the singleton + interceptors are isolated
  ...over,
});

describe('launch (webview)', () => {
  it('returns a started client', () => {
    const client = track('tok', baseOptions());
    expect(client.isLaunched()).toBe(true);
  });

  it('opens with a hello handshake declaring sdk + capabilities + a session', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    const hello = fake.msgs()[0] as HelloMessage;
    expect(hello.k).toBe('hello');
    expect(hello.sdk).toBe('0.0.0');
    expect([...hello.caps].sort()).toEqual(
      ['crash', 'events.system', 'events.user', 'log', 'network', 'traces.system'].sort(),
    ); // the full declared capability set (drives D10 negotiation) — dropping any one fails this
    expect(typeof hello.session).toBe('string');
    expect(hello.session.length).toBeGreaterThan(0);
  });

  it('handshakes and streams over a WKWebView (iOS) host, stamping the capture nonce', () => {
    // The whole composition over the iOS transport, not just the sink unit. `launch` builds the bridge, the
    // capture store, the obscuring channel and the report pipeline against one `global`; if any of them
    // reached for the Android interface directly rather than going through the host bridge, this fails.
    //
    // The nonce assertion is the load-bearing half: native drops every unstamped message (D-A11), so a
    // transport that reached the wire without passing the stamping choke point would produce a session in
    // which 100% of WebView capture is silently discarded — the failure mode hardest to notice in the field.
    const posted: string[] = [];
    const global: {
      webkit: { messageHandlers: { BugseeBridge: { postMessage(raw: string): void } } };
      __bugsee_bridge?: BridgeGlobalApi;
    } = {
      webkit: { messageHandlers: { BugseeBridge: { postMessage: (r) => posted.push(r) } } },
    };
    track('tok', baseOptions({ global, captureNonce: 'cap-ios' }));
    console.log('webkit-marker-1');

    const msgs = posted.map((r) => JSON.parse(r) as AnyMsg);
    const hello = msgs.find((m): m is HelloMessage => m.k === 'hello');
    expect(hello?.sdk).toBe('0.0.0');
    expect(
      msgs.filter((m) => (m as { n?: unknown }).n !== 'cap-ios'),
      'a message reached the WKWebView sink without the capture nonce',
    ).toEqual([]);
    expect(
      msgs.some(
        (m) => m.k === 'entry' && JSON.stringify((m as EntryMessage).p).includes('webkit-marker-1'),
      ),
    ).toBe(true);
  });

  it('honours a DECLARED transport end to end, ignoring a plant at the vacant name', () => {
    // The unit tests cover `createHostBridge`; nothing covered the LAUNCH forwarding, so deleting that
    // one line left the whole suite green while the SDK silently reverted to probing — and hard-coding
    // the wrong transport there would make one platform capture nothing at all, just as silently.
    // Coverage does not catch it either: the line executes on its false branch in every other test.
    const real: string[] = [];
    const planted: string[] = [];
    const global: {
      BugseeBridge: { post(raw: string): void };
      webkit: { messageHandlers: { BugseeBridge: { postMessage(raw: string): void } } };
      __bugsee_bridge?: BridgeGlobalApi;
    } = {
      BugseeBridge: { post: (r) => planted.push(r) },
      webkit: { messageHandlers: { BugseeBridge: { postMessage: (r) => real.push(r) } } },
    };

    track('tok', baseOptions({ global, transport: 'webkit' }));

    expect(real.length, 'the declared WebKit sink received nothing').toBeGreaterThan(0);
    expect(planted, 'a plant at the vacant Android name captured the stream').toEqual([]);
  });

  it('captures NOTHING rather than falling back when the declared transport is absent', () => {
    // Fail-closed, end to end. Native said which handler it registered, so anything at the other name is
    // by definition not native's — and a silent fallback there is the whole hole this closes.
    const planted: string[] = [];
    track(
      'tok',
      baseOptions({
        global: { BugseeBridge: { post: (r: string) => planted.push(r) } },
        transport: 'webkit',
      }),
    );
    expect(planted).toEqual([]);
  });

  it('does NOT expose a mutation-capable client on the page-reachable carrier', () => {
    // In a WebView the page is not the app — native is. `window.__BUGSEE__` is an ordinary writable
    // property, so whatever is stored there is reachable by any page script, third-party tag or XSS.
    // A client there would be a capture tap, a suppressor and a kill switch at once:
    //
    //   const c = Object.values(window.__BUGSEE__)[0].client;
    //   c.setNetworkEventFilter(e => { exfiltrate(e); return e; });  // + disables default redaction
    //   c.setLogEventFilter(() => null);                             // suppress
    //   c.stop();                                                    // kill
    //
    // none of which needs a sink to shadow, a race to win, or the D-A10 control secret — it walks around
    // every defence the bridge has. So the carrier gets a resolver-only facade.
    const carrier = {} as { __BUGSEE__?: Record<string, { client?: Record<string, unknown> }> };
    const client = track('tok', baseOptions({ carrier }));

    const exposed = Object.values(carrier.__BUGSEE__ ?? {})[0]?.client;
    expect(exposed, 'nothing was published for the capture pipeline to resolve').toBeDefined();
    for (const method of [
      'setNetworkEventFilter',
      'setLogEventFilter',
      'setBreadcrumbFilter',
      'setReportHandler',
      'stop',
      'logException',
    ]) {
      expect(exposed?.[method], `\`${method}\` is reachable from page script`).toBeUndefined();
    }
    // The resolver IS still there — the capture pipeline reaches redaction filters through it.
    expect(typeof exposed?.getService).toBe('function');

    // And it resolves by token IDENTITY, not by name. The container keys providers on `token.name`, a
    // plain string, so a facade that forwarded any token let page script forge one and land on the very
    // same mutable FilterStore `setNetworkEventFilter` writes — the tap and the redaction bypass, back
    // through the facade meant to remove them.
    const forge = exposed?.getService as ((token: unknown) => unknown) | undefined;
    for (const name of ['filters', 'captureStore', 'transport', 'scheduler']) {
      expect(forge?.({ name }), `a forged \`${name}\` token resolved`).toBeUndefined();
    }
    const forgeProvider = exposed?.getServiceProvider as ((token: unknown) => unknown) | undefined;
    expect(
      forgeProvider?.({ name: 'filters' }),
      'a forged token resolved a provider',
    ).toBeUndefined();
    // And the real client, with the full surface, is what launch() hands back to its caller.
    expect(typeof client.stop).toBe('function');
  });

  it('streams a captured console log across the bridge as a log entry', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    console.log('webview-marker-7');
    const entries = fake.msgs().filter((m): m is EntryMessage => m.k === 'entry');
    const log = entries.find(
      (e) => e.t === 'log' && JSON.stringify(e.p).includes('webview-marker-7'),
    );
    expect(log).toBeDefined();
    expect(log?.s).toBeGreaterThanOrEqual(0); // carries a monotonic seq
  });

  it('streams the process_started system event when a window is present', () => {
    const fake = fakeGlobal();
    const win = fakeEventTarget();
    track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    const events = entriesOfType(fake.msgs(), 'events.system');
    expect(events.some((e) => JSON.stringify(e.p).includes('process_started'))).toBe(true);
  });

  it('streams a document interaction (click) as an events.user entry', () => {
    const fake = fakeGlobal();
    const doc = fakeEventTarget();
    const win = fakeEventTarget(); // also a window → the system-events source gets the injected document seam
    track(
      'tok',
      baseOptions({
        global: fake.global,
        window: win.target as unknown as WindowEvents,
        document: doc.target as unknown as Document,
      }),
    );
    doc.emit('click', {
      target: {
        tagName: 'BUTTON',
        getAttribute: () => null,
        closest: () => null,
        textContent: 'Buy',
      },
      clientX: 3,
      clientY: 4,
      button: 0,
    });
    const events = entriesOfType(fake.msgs(), 'events.user');
    expect(events.some((e) => JSON.stringify(e.p).includes('click'))).toBe(true);
  });

  it('streams a sampled system metric as a traces.system entry on a scheduler tick', () => {
    const fake = fakeGlobal();
    const tickCbs: Array<() => void> = [];
    const scheduler: Scheduler = {
      setInterval: (cb) => {
        tickCbs.push(cb as () => void);
        return 0 as unknown as ReturnType<Scheduler['setInterval']>;
      },
      clearInterval: () => {},
    };
    track(
      'tok',
      baseOptions({
        global: fake.global,
        scheduler,
        systemMetricsSampler: () => [{ name: 'wv_metric', value: 7 }],
      }),
    );
    for (const cb of tickCbs) cb(); // a tick samples the metrics
    const traces = entriesOfType(fake.msgs(), 'traces.system');
    expect(traces.some((e) => JSON.stringify(e.p).includes('wv_metric'))).toBe(true);
  });

  it('streams a logException as a crash ENTRY (always) but NO report trigger when the gate is off (D5)', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global }));
    await client.logException(new Error('boom-wv'));
    const crashes = entriesOfType(fake.msgs(), 'crash');
    expect(crashes.some((e) => JSON.stringify(e.p).includes('boom-wv'))).toBe(true); // incident in the timeline
    expect(fake.msgs().some((m) => m.k === 'report')).toBe(false); // no native bug opened (gate off)
  });

  it('ALSO emits a report trigger (crash, carrying the incident) for a logException when on', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global, reportTrigger: true }));
    await client.logException(new Error('kaboom-wv'));
    expect(
      entriesOfType(fake.msgs(), 'crash').some((e) => JSON.stringify(e.p).includes('kaboom-wv')),
    ).toBe(true);
    const report = fake.msgs().find((m): m is ReportMessage => m.k === 'report');
    expect(report?.t).toBe('crash');
    expect(JSON.stringify(report?.p)).toContain('kaboom-wv'); // the report carries the incident, not an empty trigger
  });

  it('uses ONE shared per-session seq across the capture stream AND the report path', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global, reportTrigger: true }));
    console.log('seq-log');
    await client.logException(new Error('seq-err')); // → a crash entry + a report
    const stream = fake
      .msgs()
      .filter((m): m is EntryMessage | ReportMessage => m.k === 'entry' || m.k === 'report');
    const seqs = stream.map((m) => m.s);
    expect(seqs.length).toBeGreaterThanOrEqual(3); // log entry + crash entry + report
    // A SHARED counter ⇒ strictly increasing across both paths; a separate report counter would RESET and
    // collide with the capture stream (crash seq == log seq).
    expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] as number))).toBe(true);
  });

  it('wires window error detection — a window error streams a crash entry carrying the error', () => {
    const fake = fakeGlobal();
    const win = fakeEventTarget();
    track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    win.emit('error', {
      message: 'detected-wv',
      error: new Error('detected-wv'),
      filename: 'a.js',
      lineno: 1,
      colno: 2,
    });
    expect(
      entriesOfType(fake.msgs(), 'crash').some((e) => JSON.stringify(e.p).includes('detected-wv')),
    ).toBe(true);
  });

  it('wires unhandledrejection detection — a rejection streams a crash entry', () => {
    const fake = fakeGlobal();
    const win = fakeEventTarget();
    track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    win.emit('unhandledrejection', {
      reason: new Error('rejected-wv'),
      promise: Promise.resolve(),
    });
    expect(
      entriesOfType(fake.msgs(), 'crash').some((e) => JSON.stringify(e.p).includes('rejected-wv')),
    ).toBe(true);
  });

  it('honors a native reportTrigger toggle via __bugsee_bridge.control (off→on), end to end', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global })); // gate defaults OFF
    await client.logException(new Error('first'));
    expect(fake.msgs().some((m) => m.k === 'report')).toBe(false); // no bug while off
    fake.global.__bugsee_bridge?.control(
      JSON.stringify({ b: 1, k: 'control', config: { reportTrigger: true } }),
    );
    await client.logException(new Error('second'));
    expect(fake.msgs().filter((m) => m.k === 'report')).toHaveLength(1); // only the second opened a bug
  });

  it('pause/resume control commands drop then resume the capture stream', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    sendControl(fake.global, { command: 'pause' });
    console.log('while-paused-wv');
    expect(
      entriesOfType(fake.msgs(), 'log').some((e) =>
        JSON.stringify(e.p).includes('while-paused-wv'),
      ),
    ).toBe(false); // dropped while paused
    sendControl(fake.global, { command: 'resume' });
    console.log('after-resume-wv');
    expect(
      entriesOfType(fake.msgs(), 'log').some((e) =>
        JSON.stringify(e.p).includes('after-resume-wv'),
      ),
    ).toBe(true); // streaming again
  });

  it('the flush control command awaits the client flush', () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global }));
    const spy = vi.spyOn(client, 'flush');
    sendControl(fake.global, { command: 'flush' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the stop control command stops the client and posts a bye', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global }));
    sendControl(fake.global, { command: 'stop' });
    await Promise.resolve(); // let the fire-and-forget stop settle
    expect(client.isLaunched()).toBe(false);
    expect(fake.msgs().some((m) => m.k === 'bye')).toBe(true);
  });

  it('ignores an unknown control command (forward-compatible) without effect', () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global }));
    const before = fake.msgs().length;
    expect(() => sendControl(fake.global, { command: 'a-future-command' })).not.toThrow();
    expect(fake.msgs().length).toBe(before); // no message produced
    expect(client.isLaunched()).toBe(true); // not stopped/paused/flushed
  });

  it('the snapshot command is a harmless no-op when obscuring is off (no DOM)', () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global })); // no document → no obscuring channel
    expect(() => sendControl(fake.global, { command: 'snapshot' })).not.toThrow();
    expect(fake.msgs().some((m) => m.k === 'secure')).toBe(false); // nothing to snapshot
    expect(client.isLaunched()).toBe(true);
  });

  describe('obscuring (D10)', () => {
    it('declares the `obscuring` capability in the hello when a DOM is present', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument();
      track(
        'tok',
        baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
      );
      const hello = fake.msgs()[0] as HelloMessage;
      expect(hello.caps).toContain('obscuring'); // tells native this SDK supplies the rects
    });

    it('does NOT declare `obscuring` when collection is already failing (Wave 1.4)', () => {
      // Declaring the capability tells native this SDK supplies the rects, and the protocol has no way to
      // retract it. On a page where collection throws — one line of script is enough — declaring anyway
      // promises rects that never arrive, and on the advanced path nothing else masks.
      const fake = fakeGlobal();
      const dom = fakeDomDocument();
      const broken = {
        ...(dom.document as unknown as Record<string, unknown>),
        querySelectorAll: () => {
          throw new Error('page broke the DOM');
        },
      };
      const onError = vi.fn();
      track(
        'tok',
        baseOptions({ global: fake.global, document: broken as unknown as Document, onError }),
      );
      expect((fake.msgs()[0] as HelloMessage).caps).not.toContain('obscuring');
      expect(onError).toHaveBeenCalled(); // and it is not silent
      // …and it must not POST either. Withholding the capability but still starting the channel sends
      // `secure` frames native never negotiated — under a protocol with no retraction message, on the exact
      // page whose collection we just declared broken. "Staying silent" has to mean silent on the wire.
      expect(fake.msgs().some((m) => (m as { k?: string }).k === 'secure')).toBe(false);
    });

    it('stays silent on the native `snapshot` COMMAND too when the probe failed', () => {
      // The `start()` path was gated; its sibling was not. `obscuring?.emit()` on the snapshot command ran
      // unconditionally, so native asking for a frame still got a `secure` message it had never negotiated
      // — on the page whose collection was just declared broken. "Silent on the wire" has to mean every
      // path that can reach the wire, not the one the fix happened to be looking at.
      const fake = fakeGlobal();
      const dom = fakeDomDocument();
      const broken = {
        ...(dom.document as unknown as Record<string, unknown>),
        querySelectorAll: () => {
          throw new Error('page broke the DOM');
        },
      };
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: broken as unknown as Document,
          onError: vi.fn(),
        }),
      );
      sendControl(fake.global, { command: 'snapshot' });
      expect(fake.msgs().some((m) => (m as { k?: string }).k === 'secure')).toBe(false);
    });

    it('DOES post on the native `snapshot` command when the probe succeeded', () => {
      // The canary for the test above. Without this, "no secure message" would also be satisfied by a
      // control channel that never routes `snapshot` at all, and the assertion would prove nothing.
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(5)] });
      track(
        'tok',
        baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
      );
      const before = fake.msgs().filter((m) => (m as { k?: string }).k === 'secure').length;
      sendControl(fake.global, { command: 'snapshot' });
      expect(fake.msgs().filter((m) => (m as { k?: string }).k === 'secure').length).toBe(
        before + 1,
      );
    });

    it('does NOT declare `obscuring` when there is no DOM — it promises rects it cannot supply', () => {
      const fake = fakeGlobal();
      track('tok', baseOptions({ global: fake.global })); // no document
      expect((fake.msgs()[0] as HelloMessage).caps).not.toContain('obscuring');
    });

    it('does NOT declare `obscuring` when opted out via captureObscuring:false', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument();
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          captureObscuring: false,
        }),
      );
      expect((fake.msgs()[0] as HelloMessage).caps).not.toContain('obscuring');
      expect(fake.global.__bugsee_bridge?.snapshot()).toBe('[]'); // pull returns empty when off
    });

    it('a SUB-frame does NOT declare `obscuring`/post to native, but BUBBLES its rects to the parent (D9)', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(1)] });
      const win = fakeEventTarget();
      const parentPost = vi.fn();
      // A sub-frame: top is some OTHER window (not self) + a parent to bubble to.
      Object.assign(win.target, {
        self: win.target,
        top: { other: true },
        parent: { postMessage: parentPost },
      });
      const client = launch(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          window: win.target as unknown as WindowEvents,
        }),
      );
      // A sub-frame posts NOTHING to native at all — stronger than the previous assertion, which only
      // checked that its hello omitted the `obscuring` cap. There is one session per WebView and the top
      // frame owns it, so a sub-frame never handshakes (see the sub-frame describe block below).
      expect(fake.msgs()).toEqual([]);
      expect(fake.global.__bugsee_bridge?.snapshot()).toBe('[]'); // no native obscuring pull from a sub-frame
      // ...instead it bubbles its VIEWPORT rects up to its parent (composed there into the whole-page mask).
      expect(parentPost).toHaveBeenCalledWith(
        {
          __bugsee_secure_bubble: 1,
          areas: [{ type: 'text', top: 1, left: 2, bottom: 3, right: 4 }],
        },
        '*',
      );
      // stop() must detach the child composer — a later change does NOT bubble (no leaked listener).
      void client.stop();
      parentPost.mockClear();
      dom.emit('focus');
      expect(parentPost).not.toHaveBeenCalled();
    });

    it('DOES declare `obscuring` in the top frame even when window.top === window.self', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument();
      const win = fakeEventTarget();
      Object.assign(win.target, { self: win.target, top: win.target }); // top === self → top frame
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          window: win.target as unknown as WindowEvents,
        }),
      );
      expect((fake.msgs()[0] as HelloMessage).caps).toContain('obscuring');
    });

    it('treats a window whose top points to itself (no self) as the top frame', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument();
      const win = fakeEventTarget();
      Object.assign(win.target, { top: win.target }); // top set, NO self → falls back to comparing top to window
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          window: win.target as unknown as WindowEvents,
        }),
      );
      expect((fake.msgs()[0] as HelloMessage).caps).toContain('obscuring');
    });

    it('stamps secure messages with the SHARED per-session seq (interleaves with the entry stream)', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(1)] });
      track(
        'tok',
        baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
      );
      console.log('seq-before-secure'); // advances the shared counter first
      dom.emit('focus'); // a secure post — must take the NEXT shared seq, not reset to 0
      const log = fake
        .msgs()
        .filter((m): m is EntryMessage => m.k === 'entry' && m.t === 'log')
        .find((e) => JSON.stringify(e.p).includes('seq-before-secure'));
      // The LAST secure message: [0] is now the initial push emitted at start(), which precedes the log line
      // — the seq claim is about the post driven by the focus event after it.
      const secures = fake.msgs().filter((m): m is SecureMessage => m.k === 'secure');
      const secure = secures[secures.length - 1];
      expect(log).toBeDefined();
      expect(secure).toBeDefined();
      // A SHARED counter ⇒ the secure seq is strictly greater than the prior log entry's; a private obscuring
      // counter would reset to 0 and collide with / precede the capture stream.
      expect(secure?.s).toBeGreaterThan(log?.s as number);
    });

    it('streams a secure message with the current rects when the DOM changes (focus)', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(10)] });
      track(
        'tok',
        baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
      );
      dom.emit('focus'); // a tracked change recomputes + posts
      const secure = fake.msgs().find((m): m is SecureMessage => m.k === 'secure');
      expect(secure?.p).toEqual([{ type: 'text', top: 10, left: 11, bottom: 12, right: 13 }]);
    });

    it('answers __bugsee_bridge.snapshot() synchronously with the serialized rects (native pull)', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(2)] });
      track(
        'tok',
        baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
      );
      expect(fake.global.__bugsee_bridge?.snapshot()).toBe(
        JSON.stringify([{ type: 'text', top: 2, left: 3, bottom: 4, right: 5 }]),
      );
    });

    it('the snapshot control command posts the current rects (async refresh path)', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(1)] });
      track(
        'tok',
        baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
      );
      const before = fake.msgs().filter((m) => m.k === 'secure').length;
      sendControl(fake.global, { command: 'snapshot' });
      const secure = fake.msgs().filter((m): m is SecureMessage => m.k === 'secure');
      expect(secure.length).toBe(before + 1);
      expect(secure.at(-1)?.p).toEqual([{ type: 'text', top: 1, left: 2, bottom: 3, right: 4 }]);
    });

    it('stop() detaches the obscuring source — a later DOM change posts nothing', async () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(0)] });
      const carrier = {};
      const client = launch(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          carrier,
        }),
      );
      dom.emit('focus');
      const afterStart = fake.msgs().filter((m) => m.k === 'secure').length;
      expect(afterStart).toBeGreaterThan(0);
      await client.stop();
      dom.emit('focus'); // listeners detached → no new secure post
      expect(fake.msgs().filter((m) => m.k === 'secure').length).toBe(afterStart);
    });
  });

  it('exposes __bugsee_bridge.control on the global for native→JS control (defensive)', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    expect(typeof fake.global.__bugsee_bridge?.control).toBe('function');
    expect(() =>
      fake.global.__bugsee_bridge?.control(
        JSON.stringify({ b: 1, k: 'control', session: 'native-1' }),
      ),
    ).not.toThrow();
    expect(() => fake.global.__bugsee_bridge?.control('garbage {')).not.toThrow();
  });

  it('is a per-WebView singleton — a repeat launch is ignored (and onError-warned)', () => {
    const onError = vi.fn();
    const opts = baseOptions({ onError });
    const first = track('tok', opts);
    const second = launch('tok', opts); // same carrier
    expect(second).toBe(first);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('runs contributed service manifests (extension wiring) at launch', () => {
    const carrier = {}; // fresh carrier so the manifest is isolated to this launch
    const ran = vi.fn();
    contributeServiceManifest(() => ran(), carrier);
    track('tok', baseOptions({ carrier }));
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('honors an injected captureStore override + clock (no bridge store; bridge still gets the hello)', () => {
    const fake = fakeGlobal();
    const added: StoredEntry[] = [];
    const captureStore: CaptureStore = {
      add: (r) => added.push(r),
      tick: () => {},
      snapshot: () => ({
        async *stream() {},
        drainAll: () => Promise.resolve(new Map()),
        release: () => {},
      }),
      clear: () => {},
    };
    const clock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };
    track('tok', baseOptions({ global: fake.global, captureStore, clock }));
    console.log('to-override');
    expect(added.some((e) => e.type === 'log' && e.serialized.includes('to-override'))).toBe(true);
    // The override receives entries; the bridge still gets the hello handshake.
    expect((fake.msgs()[0] as HelloMessage).k).toBe('hello');
  });

  it('defaults the global to globalThis and the scheduler to global timers', () => {
    // No `global` and no `scheduler` injected → exercises both defaults. stop() (afterEach) clears the
    // real tick timer; globalThis.__bugsee_bridge is NOT cleared — the binding is non-configurable by
    // design (Wave 0.3 / D-A3), so it persists and goes inert instead.
    const client = track('tok', { captureNetwork: false, carrier: {} });
    expect(client.isLaunched()).toBe(true);
    expect(typeof (globalThis as { __bugsee_bridge?: unknown }).__bugsee_bridge).toBe('object');
  });

  it('stop() posts a bye, clears the carrier + makes __bugsee_bridge inert so a later launch starts fresh', async () => {
    const fake = fakeGlobal();
    const carrier = {};
    const client = launch('tok', baseOptions({ global: fake.global, carrier }));
    await client.stop();
    expect(fake.msgs().some((m) => m.k === 'bye')).toBe(true); // teardown signalled to native
    // The binding is non-configurable (Wave 0.3 / D-A3) so it cannot be removed; INERT is the teardown
    // state instead — which is the stronger property anyway, since a removable global was replaceable.
    expect(fake.global.__bugsee_bridge?.snapshot()).toBe('[]');
    const again = track('tok', baseOptions({ global: fake.global, carrier }));
    expect(again).not.toBe(client); // a fresh client (carrier slot was cleared)
    expect(again.isLaunched()).toBe(true);
  });

  describe('redaction (D3)', () => {
    it('streams log entries un-redacted (red:false) when no JS filter is set — native redacts', () => {
      const fake = fakeGlobal();
      track('tok', baseOptions({ global: fake.global }));
      console.log('redact-none');
      const log = entriesOfType(fake.msgs(), 'log').find((e) =>
        JSON.stringify(e.p).includes('redact-none'),
      );
      expect(log?.red).toBe(false);
    });

    it('RUNS the log filter (scrubs content) AND stamps red:true (run⟺red, D3)', () => {
      const fake = fakeGlobal();
      // A MUTATING filter via client.log() (the closure path, carrier-independent) — proves the filter actually
      // ran (content scrubbed) AND the crossing is stamped red, not merely that a filter was configured.
      const client = track(
        'tok',
        baseOptions({
          global: fake.global,
          logFilter: (e) => ({ ...e, message: 'LOG-REDACTED' }),
        }),
      );
      client.log('log-secret');
      const log = entriesOfType(fake.msgs(), 'log').find((e) =>
        JSON.stringify(e.p).includes('LOG-REDACTED'),
      );
      expect(log).toBeDefined();
      expect(JSON.stringify(log?.p)).not.toContain('log-secret'); // the original content was scrubbed before crossing
      expect(log?.red).toBe(true); // ...and the crossing carries the JS-redacted provenance
    });

    it('does NOT cross-contaminate types — a networkFilter leaves log entries red:false', () => {
      const fake = fakeGlobal();
      track('tok', baseOptions({ global: fake.global, networkFilter: (e) => e }));
      console.log('redact-net-only');
      const log = entriesOfType(fake.msgs(), 'log').find((e) =>
        JSON.stringify(e.p).includes('redact-net-only'),
      );
      expect(log?.red).toBe(false); // a network filter does not redact logs
    });

    it('stamps red:true on the crash entry + report when a reportHandler is installed', async () => {
      const fake = fakeGlobal();
      const client = track(
        'tok',
        baseOptions({
          global: fake.global,
          reportTrigger: true,
          reportHandler: { before: (r) => r },
        }),
      );
      await client.logException(new Error('redact-crash'));
      const crash = entriesOfType(fake.msgs(), 'crash').find((e) =>
        JSON.stringify(e.p).includes('redact-crash'),
      );
      const report = fake.msgs().find((m): m is ReportMessage => m.k === 'report');
      expect(crash?.red).toBe(true); // the report handler's before pass ran
      expect(report?.red).toBe(true);
    });

    it('RUNS the breadcrumb filter (scrubs content) AND stamps red:true (run⟺red)', () => {
      const fake = fakeGlobal();
      const client = track(
        'tok',
        baseOptions({
          global: fake.global,
          breadcrumbFilter: (b) => ({ ...b, message: 'CRUMB-REDACTED' }),
        }),
      );
      client.addBreadcrumb({ message: 'crumb-secret', category: 'test' });
      const crumb = entriesOfType(fake.msgs(), 'breadcrumbs')[0];
      expect(JSON.stringify(crumb?.p)).toContain('CRUMB-REDACTED'); // the filter actually scrubbed the content
      expect(JSON.stringify(crumb?.p)).not.toContain('crumb-secret');
      expect(crumb?.red).toBe(true); // ...and the crossing is stamped JS-redacted
    });

    it('reads filters LIVE — a filter set on the returned client after launch takes effect', () => {
      const fake = fakeGlobal();
      const client = track('tok', baseOptions({ global: fake.global }));
      client.log('redact-before-set'); // no filter yet → un-redacted
      client.setLogEventFilter((e) => e); // set AFTER launch (lazy provenance must observe it)
      client.log('redact-after-set');
      const logs = entriesOfType(fake.msgs(), 'log');
      expect(logs.find((e) => JSON.stringify(e.p).includes('redact-before-set'))?.red).toBe(false);
      expect(logs.find((e) => JSON.stringify(e.p).includes('redact-after-set'))?.red).toBe(true);
    });
  });
});

describe('sub-frame obscuring failures never escape launch()', () => {
  // The original single test made BOTH `addEventListener` and `parent.postMessage` hostile. The listener
  // throws first, so the `parent.postMessage` path the comment named — the [Replaceable] `window.parent`
  // that motivated the guard — was never reached. Split, so each failure source is actually exercised.
  const subFrameWin = (hostile: 'listener' | 'parent') => ({
    top: {},
    self: {},
    addEventListener:
      hostile === 'listener'
        ? () => {
            throw new Error('hostile page');
          }
        : () => {},
    removeEventListener: () => {},
    parent: {
      postMessage:
        hostile === 'parent'
          ? () => {
              throw new Error('hostile parent');
            }
          : () => {},
    },
  });

  it('launch() survives a sub-frame whose `parent.postMessage` throws', () => {
    // `window.parent` is [Replaceable]; one line of page script makes postMessage throw. The channel guards
    // only the TOP frame, so the sub-frame path escaped launch() entirely (onError never fired).
    const fake = fakeGlobal();
    const dom = fakeDomDocument();
    const onError = vi.fn();
    const win = subFrameWin('parent');
    expect(() =>
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          window: win as never,
          onError,
        }),
      ),
    ).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('launch() survives a child composer whose start throws', () => {
    const fake = fakeGlobal();
    const dom = fakeDomDocument();
    const onError = vi.fn();
    const win = subFrameWin('listener');
    expect(() =>
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          window: win as never,
          onError,
        }),
      ),
    ).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});

// WAVE 0.3 / D-A3 — the control global's BINDING is closed, not just its object.
//
// SEV1-4(b): `global.__bugsee_bridge = Object.freeze({…})` froze the OBJECT while leaving the BINDING
// `{writable:true, configurable:true}`. A page script replaced the whole binding with
// `{control(){}, snapshot(){return '[]'}}`; native's frame-capture pull then returned no rects while real
// secure areas existed, so password / cc-* fields rendered legibly in the captured video — and native had
// already stood its own masking script down, because declaring the `obscuring` capability is what tells it
// to. SEV1-4(a) is the same binding used the other way: any script could call `control('{…"command":
// "stop"}')` and tear the SDK down silently.
//
// Closing the binding needs NO protocol change, which is why it ships ahead of the token work.
describe('the __bugsee_bridge binding is not replaceable (Wave 0.3)', () => {
  /** Attempt a page-script takeover. Assignment to a non-writable property throws in strict mode and is a
   *  silent no-op in sloppy mode, so the ATTEMPT is swallowed and the OUTCOME is what gets asserted. */
  const tryHijack = (global: Record<string, unknown>, replacement: unknown): void => {
    try {
      global.__bugsee_bridge = replacement;
    } catch {
      /* strict-mode TypeError — the defence working */
    }
  };

  it('survives a page script assigning over it', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    const real = fake.global.__bugsee_bridge;

    tryHijack(fake.global as unknown as Record<string, unknown>, {
      control: () => {},
      snapshot: () => '[]',
    });

    expect(fake.global.__bugsee_bridge, 'the page replaced the bridge global').toBe(real);
  });

  it('survives `delete`', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    try {
      delete (fake.global as { __bugsee_bridge?: unknown }).__bugsee_bridge;
    } catch {
      /* strict-mode TypeError — also the defence working */
    }
    expect(typeof fake.global.__bugsee_bridge?.control).toBe('function');
  });

  it('keeps answering native’s snapshot pull with the REAL rects after a hijack attempt', () => {
    // The spoof this closes, asserted on the observable native actually reads rather than on the binding.
    const fake = fakeGlobal();
    const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(2)] });
    track(
      'tok',
      baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
    );
    tryHijack(fake.global as unknown as Record<string, unknown>, { snapshot: () => '[]' });
    expect(fake.global.__bugsee_bridge?.snapshot()).toBe(
      JSON.stringify([{ type: 'text', top: 2, left: 3, bottom: 4, right: 5 }]),
    );
  });

  it('goes INERT on stop() rather than disappearing, and a later launch works through it', async () => {
    // A non-configurable binding cannot be deleted, so teardown switches the object to an inert state and a
    // later launch reuses the same binding. `'[]'` is the right inert snapshot: native pulls it at
    // frame-capture time, and returning nothing would throw into evaluateJavascript — the fail-open shape
    // already fixed once as SEV1-1.
    const fake = fakeGlobal();
    const carrier = {};
    // A document WITH a secure element, so "inert" is distinguishable from "nothing to report". Without it
    // `snapshot()` answers '[]' whether the session went inert or merely stopped, and the assertion is
    // vacuous — verified by deleting the inert assignment, which this test then failed to catch.
    const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(2)] });
    const client = launch(
      'tok',
      baseOptions({ global: fake.global, carrier, document: dom.document as unknown as Document }),
    );
    expect(fake.global.__bugsee_bridge?.snapshot()).not.toBe('[]'); // live: real rects
    await client.stop();

    expect(typeof fake.global.__bugsee_bridge?.control).toBe('function'); // still there
    expect(fake.global.__bugsee_bridge?.snapshot()).toBe('[]'); // but inert — no rects from a dead session
    // A stopped SDK must also not be drivable: `bye` has been sent, and a page-issued command that reached
    // the old session could put messages on the wire AFTER native was told the stream ended.
    const afterStop = fake.msgs().length;
    fake.global.__bugsee_bridge?.control('{"b":1,"k":"control","command":"snapshot"}');
    expect(fake.msgs().length, 'a stopped session still posted on command').toBe(afterStop);

    const again = track('tok', baseOptions({ global: fake.global, carrier }));
    expect(again).not.toBe(client);
    expect(again.isLaunched()).toBe(true);

    // The relaunched session must be reachable THROUGH the original binding — otherwise "inert" would mean
    // "permanently dead" and native could never drive a second launch. Proven by an OBSERVABLE effect of a
    // control message (the D5 report gate flipping on), not by the call not throwing: an inert no-op also
    // does not throw, so that would assert nothing.
    await again.logException(new Error('while-gated'));
    expect(fake.msgs().some((m) => m.k === 'report')).toBe(false);
    sendControl(fake.global, { config: { reportTrigger: true } });
    await again.logException(new Error('after-ungating'));
    expect(fake.msgs().filter((m) => m.k === 'report')).toHaveLength(1);
  });
});

// WAVE 0.3 / D-A1 + D-A2, end to end through the real launch: the token is published on `hello`, and once
// native proves it knows it, the page can no longer drive the SDK. The unit tests in
// host-bridge-control.test.ts cover the state machine; these assert the WIRING, which is what a page script
// actually meets.
describe('the control channel authenticates end to end (Wave 0.3)', () => {
  const tokenOf = (fake: ReturnType<typeof fakeGlobal>): string => {
    const hello = fake.msgs().find((m): m is HelloMessage => m.k === 'hello');
    return (hello as unknown as { tok: string }).tok;
  };

  it('never puts a NATIVE-minted nonce on the wire, and mints no token of its own', () => {
    // D-A10. The whole value of a native-minted secret is that the page never sees it. Publishing it in
    // `hello` — which is what the JS-minted token must do, so native can learn it — would hand it to
    // whatever sink is listening, including a page script that shadowed the bridge before us. Native
    // already has this one, so there is nobody to publish it to.
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global, controlNonce: 'minted-by-native' }));
    console.log('some-traffic'); // produce post-hello messages too

    const all = fake.msgs();
    expect(all.length).toBeGreaterThan(1); // else the assertion below is vacuous
    expect(all.some((m) => JSON.stringify(m).includes('minted-by-native'))).toBe(false);
    // And no JS-minted token is published either: two secrets would mean two ways in, and the weaker one
    // (page-mintable, wire-published) would set the real bar.
    expect(tokenOf(fake)).toBeUndefined();
  });

  it('stamps the CAPTURE nonce on the wire and never the CONTROL one', () => {
    // The two secrets are separate for a reason, and this is the assertion that keeps them that way.
    // The capture nonce must travel — that is how native tells our entries from a page script's. The
    // control nonce must not, ever: a script that shadowed `BugseeBridge` before we pinned it would read
    // anything we send, and knowing the control secret upgrades that tap into `cmd:"stop"`.
    const fake = fakeGlobal();
    track(
      'tok',
      baseOptions({ global: fake.global, controlNonce: 'ctl-secret', captureNonce: 'cap-secret' }),
    );
    console.log('some-traffic');

    const all = fake.msgs();
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((m) => (m as { n?: string }).n === 'cap-secret')).toBe(true);
    expect(all.some((m) => JSON.stringify(m).includes('ctl-secret'))).toBe(false);
  });

  it('publishes a token on hello, exactly once and nowhere else', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    console.log('some-traffic'); // produce post-hello messages to check

    expect(tokenOf(fake)).toMatch(/\S/);
    // The constraint the whole scheme rests on: a script that taps the bridge AFTER launch must never see
    // the token. If any later message carried it, a late-loading ad tag would learn it and could forge
    // control — which is the attack this exists to stop.
    const afterHello = fake.msgs().filter((m) => m.k !== 'hello');
    expect(afterHello.length).toBeGreaterThan(0); // else the assertion below is vacuous
    expect(afterHello.some((m) => JSON.stringify(m).includes(tokenOf(fake)))).toBe(false);
  });

  it('mints a token with CSPRNG shape, not a guessable one', () => {
    // Round 1, SEV1: the only assertions here were "non-empty string" and "different per launch", both of
    // which a module-level counter (`bugsee-1`, `bugsee-2`, …) satisfies. Nothing stands between the page
    // and the control channel except the token being unguessable, and `admits` has no attempt limit — so
    // the FORMAT is pinned, and control-token.test.ts pins the source of the bytes.
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    expect(tokenOf(fake)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('withholds the token when no native sink is attached yet', () => {
    // Round 1, SEV1: with no sink, `hello` goes into the host bridge's backlog and is delivered to
    // whichever sink turns up later — which can be a page script. Publishing the token there would hand
    // the attacker an authenticated channel AND let it arm the latch, locking real native out.
    const global: {
      BugseeBridge?: { post(raw: string): void };
      __bugsee_bridge?: BridgeGlobalApi;
    } = {};
    track('tok', baseOptions({ global }));

    const posted: string[] = [];
    global.BugseeBridge = { post: (r) => posted.push(r) }; // a late arrival drains the backlog
    console.log('flushes-the-backlog');
    const hello = posted.map((r) => JSON.parse(r) as AnyMsg).find((m) => m.k === 'hello');
    expect(hello, 'no hello reached the late sink').toBeDefined();
    expect(hello as unknown as { tok?: string }).not.toHaveProperty('tok');
  });

  it('mints a DIFFERENT token per launch', () => {
    const a = fakeGlobal();
    const b = fakeGlobal();
    track('tok', baseOptions({ global: a.global, carrier: {} }));
    track('tok', baseOptions({ global: b.global, carrier: {} }));
    expect(tokenOf(a)).not.toBe(tokenOf(b));
  });

  it('lets the page stop the SDK while the channel is still unauthenticated (today’s behaviour)', () => {
    // Recorded deliberately: the pre-upgrade window is NOT protected, and pretending otherwise would be the
    // more dangerous documentation. Against a receiver that never sends a token this is the steady state.
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    sendControl(fake.global, { command: 'pause' });
    console.log('while-paused');
    expect(
      entriesOfType(fake.msgs(), 'log').some((e) => JSON.stringify(e.p).includes('while-paused')),
    ).toBe(false);
  });

  it('locks the page out once native has proven it knows the token', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    // Native speaks: a correctly-tokened control latches the channel closed.
    sendControl(fake.global, { tok: tokenOf(fake), command: 'resume' });
    // The page now tries the same suppression that worked above.
    sendControl(fake.global, { command: 'pause' });
    console.log('after-lockout');
    expect(
      entriesOfType(fake.msgs(), 'log').some((e) => JSON.stringify(e.p).includes('after-lockout')),
      'a page script paused capture after the channel was authenticated',
    ).toBe(true);
  });

  it('surfaces the rejected attempt through onError', () => {
    const onError = vi.fn();
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global, onError }));
    sendControl(fake.global, { tok: tokenOf(fake), command: 'resume' });
    onError.mockClear();
    sendControl(fake.global, { command: 'stop' });
    expect(onError).toHaveBeenCalledTimes(1);
    // The report is not the point — the REJECTION is. Asserting only the count let a version that
    // reported and then applied the command pass.
    expect(client.isLaunched(), 'the rejected stop was applied anyway').toBe(true);
  });
});

describe('the control global when the page got there first (Wave 0.3)', () => {
  it('reports and keeps capturing when __bugsee_bridge is already locked by someone else', () => {
    // A page script that ran BEFORE document-start injection can pre-define the name non-configurably, so
    // `defineProperty` throws. Nothing can be reclaimed at that point — the page has already won — but
    // launch() must not throw out into the host app (capture must never alter app behaviour), and capture
    // itself is independent of the control entry, so it continues.
    const onError = vi.fn();
    const fake = fakeGlobal();
    Object.defineProperty(fake.global, '__bugsee_bridge', {
      value: { control: () => {}, snapshot: () => '[]' },
      writable: false,
      configurable: false,
    });

    const client = track('tok', baseOptions({ global: fake.global, onError }));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.isLaunched()).toBe(true);
    // Capture still crosses the bridge — losing the control entry must not lose the session.
    console.log('still-capturing');
    expect(
      entriesOfType(fake.msgs(), 'log').some((e) =>
        JSON.stringify(e.p).includes('still-capturing'),
      ),
    ).toBe(true);
  });

  it('does not throw out of launch() when no onError is supplied', () => {
    const fake = fakeGlobal();
    Object.defineProperty(fake.global, '__bugsee_bridge', {
      value: { control: () => {}, snapshot: () => '[]' },
      configurable: false,
    });
    expect(() =>
      track('tok', {
        global: fake.global,
        scheduler: inertScheduler,
        captureNetwork: false,
        carrier: {},
      }),
    ).not.toThrow();
  });
});

// WAVE 0.3 review round 1 — three defects in the same seam: the slot, the latch, and teardown.
describe('the control surface fails closed and cannot be reset by the page (round 1)', () => {
  const preOwn = (global: object): void => {
    Object.defineProperty(global, '__bugsee_bridge', {
      value: { control: () => {}, snapshot: () => '[]' },
      configurable: false,
    });
  };

  it('does NOT declare `obscuring` when the control binding could not be installed', () => {
    // SEV1: `caps` was computed from the obscuring probe alone. A page script that pre-owns the name makes
    // defineProperty throw, so the SDK holds no control surface — but it still told native "I mask
    // sensitive pixels myself", and native then DROPS its own masking script. Result: nothing masks, and
    // password fields render legibly in the captured video. The same fail-closed rule the probe already
    // has (`obscuringWorks`) has to cover this failure too.
    const fake = fakeGlobal();
    preOwn(fake.global);
    const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(2)] });
    track(
      'tok',
      baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
    );
    const hello = fake.msgs().find((m): m is HelloMessage => m.k === 'hello');
    expect(hello?.caps, 'declared obscuring with no control surface').not.toContain('obscuring');
  });

  it('still declares `obscuring` on the normal path — the canary', () => {
    // Without this, the assertion above is satisfied by never declaring the capability at all.
    const fake = fakeGlobal();
    const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(2)] });
    track(
      'tok',
      baseOptions({ global: fake.global, document: dom.document as unknown as Document }),
    );
    const hello = fake.msgs().find((m): m is HelloMessage => m.k === 'hello');
    expect(hello?.caps).toContain('obscuring');
  });

  it('a stale stop() does not kill a NEWER session', () => {
    // SEV2: the slot is shared per-global, and stop() reverted it with no ownership check. A framework
    // that unmounts late (or a plain double-stop) therefore made the LIVE session's control dead and
    // posted a spurious `bye` while capture was still flowing.
    const fake = fakeGlobal();
    const carrier = {};
    const a = launch('tok', baseOptions({ global: fake.global, carrier }));
    void a.stop();
    const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(2)] });
    const b = track(
      'tok',
      baseOptions({ global: fake.global, carrier, document: dom.document as unknown as Document }),
    );
    expect(fake.global.__bugsee_bridge?.snapshot()).not.toBe('[]'); // b is live — canary

    void a.stop(); // the stale handle fires again

    expect(b.isLaunched()).toBe(true);
    expect(
      fake.global.__bugsee_bridge?.snapshot(),
      'a stale stop() made the live session inert',
    ).not.toBe('[]');
  });

  it('a page-forced RELAUNCH cannot un-latch the control channel', () => {
    // SEV2: `authenticated` lived in the per-launch closure, and `BugseeWebView.launch` is a page global
    // whose singleton guard reads a mutable carrier field. So the page could clear the carrier, relaunch,
    // and get a fresh unlatched channel — defeating "one-way" entirely. The latch belongs to the GLOBAL.
    //
    // Asserted through onError (a rejected control reports) rather than through capture behaviour: two
    // clients on one carrier share the console interceptor, so a `pause` on the second is not a reliable
    // observable — an earlier draft of this test passed for that reason while proving nothing.
    const onError = vi.fn();
    const fake = fakeGlobal();
    const carrier: Record<string, Record<string, { client?: unknown }>> = {};
    track('tok', baseOptions({ global: fake.global, carrier, onError }));
    const first = fake.msgs().find((m): m is HelloMessage => m.k === 'hello');
    sendControl(fake.global, { tok: (first as unknown as { tok: string }).tok, command: 'resume' });

    // What a page script actually does: the carrier registry is a plain mutable object on the host, so
    // clearing the version slot's `client` defeats the singleton guard (carrier.ts `getCarrier().client`).
    for (const slot of Object.values(carrier.__BUGSEE__ ?? {})) {
      slot.client = undefined;
    }
    track('tok', baseOptions({ global: fake.global, carrier, onError }));
    expect(
      fake.msgs().filter((m) => m.k === 'hello').length,
      'the relaunch never happened — the guard swallowed it, so this asserts nothing',
    ).toBe(2);

    onError.mockClear();
    sendControl(fake.global, { command: 'pause' }); // untokened, from the page
    expect(
      onError,
      'the relaunch reset the latch — untokened control was accepted',
    ).toHaveBeenCalled();
  });
});

// STEP 1 of the document-start work — a SUB-FRAME contributes obscuring rects and nothing else.
//
// Today every injected frame runs a FULL SDK: `isTopFrame` gates only the obscuring path, while the
// handshake (`bridge.post(hello)`) and capture (`client.launch()` + the interceptors) run unconditionally.
// That is already live whenever `WebViewDomainAllowlist` is non-empty, and it is what makes registering
// the advanced bundle as an all-origins document-start script unsafe:
//
//  - N hellos per WebView. The protocol is ONE session per WebView, so N frames announcing themselves is
//    N sessions' worth of handshakes for one. (The sharper version of this — whichever frame's hello
//    native LATCHED decided the retained token and the obscuring capability — is gone: native retains
//    nothing from a hello and mints its own secret, D-A10, and `caps` decides nothing, D-A7.)
//  - A sub-frame can never RECEIVE control: `evaluateJavascript` targets the top frame, so a sub-frame
//    that opened a session cannot be paused, flushed or stopped.
//  - Each frame keeps its own `seq` counter from 0, so entries from different frames collide in ordering.
//  - D9 exists to keep Bugsee OUT of third-party content (webview-bridge.md:66). Running full capture in
//    every injected frame is the opposite of that.
describe('a sub-frame contributes obscuring only (document-start step 1)', () => {
  /** A window that reports itself as a SUB-frame (top is some other window). */
  const subFrameWindow = () => {
    const win = fakeEventTarget();
    const posted: unknown[] = [];
    Object.assign(win.target, {
      self: win.target,
      top: { other: true },
      parent: { postMessage: (m: unknown) => posted.push(m) },
    });
    return { win, posted };
  };

  const topFrameWindow = () => {
    const win = fakeEventTarget();
    Object.assign(win.target, { self: win.target, top: win.target });
    return win;
  };

  it('posts NO hello — the WebView has exactly one session, owned by the top frame', () => {
    const fake = fakeGlobal();
    const { win } = subFrameWindow();
    track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    expect(fake.msgs().filter((m) => m.k === 'hello')).toHaveLength(0);
  });

  it('installs NO capture — a third-party iframe’s console is not the app’s session', () => {
    const fake = fakeGlobal();
    const { win } = subFrameWindow();
    track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    console.log('iframe-noise-should-not-cross');
    expect(
      fake.msgs().some((m) => JSON.stringify(m).includes('iframe-noise-should-not-cross')),
    ).toBe(false);
  });

  it('does not report itself as launched', () => {
    const fake = fakeGlobal();
    const { win } = subFrameWindow();
    const client = track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    expect(client.isLaunched()).toBe(false);
  });

  it('STILL bubbles its secure rects to the parent — the one thing a sub-frame is for', () => {
    const fake = fakeGlobal();
    const { win, posted } = subFrameWindow();
    const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(2)] });
    track(
      'tok',
      baseOptions({
        global: fake.global,
        window: win.target as unknown as WindowEvents,
        document: dom.document as unknown as Document,
      }),
    );
    expect(posted.length, 'the sub-frame stopped composing obscuring rects').toBeGreaterThan(0);
  });

  it('TOP frame is unaffected — hello, capture and launch all still happen', () => {
    // The canary. Every assertion above is satisfied by an SDK that does nothing anywhere.
    const fake = fakeGlobal();
    const win = topFrameWindow();
    const client = track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    console.log('top-frame-capture-works');
    expect(fake.msgs().filter((m) => m.k === 'hello')).toHaveLength(1);
    expect(client.isLaunched()).toBe(true);
    expect(
      entriesOfType(fake.msgs(), 'log').some((e) =>
        JSON.stringify(e.p).includes('top-frame-capture-works'),
      ),
    ).toBe(true);
  });
});

// The whole point of a sub-frame running the composer: its secure views must still reach native. The
// composer unit tests cover the re-mapping arithmetic; NOTHING covered the chain through `launch()`, which
// is exactly the path the sub-frame change touched. This closes that.
describe('secure views from a SUB-frame still reach native (D9 chain, through launch)', () => {
  /** A document with one secure input of its own AND one <iframe> whose contentWindow is `childWin`. */
  const topDocument = (childWin: object) => {
    const iframe = {
      contentWindow: childWin,
      getBoundingClientRect: () => ({ top: 30, left: 40, bottom: 130, right: 240 }),
    };
    return fakeDomDocument({
      [SECURE_INPUT]: [secureEl(2)],
      iframe: [iframe as unknown as { getBoundingClientRect(): object }],
    });
  };

  it('composes the top frame’s own rects WITH a child frame’s bubbled rects into one `secure`', () => {
    const fake = fakeGlobal();
    const childWin = {};
    const dom = topDocument(childWin);
    const win = fakeEventTarget();
    Object.assign(win.target, { self: win.target, top: win.target }); // this IS the top frame
    track(
      'tok',
      baseOptions({
        global: fake.global,
        document: dom.document as unknown as Document,
        window: win.target as unknown as WindowEvents,
      }),
    );

    // The sub-frame's SDK bubbles its viewport rects up (postMessage). Replay that arrival.
    win.emit('message', {
      data: {
        __bugsee_secure_bubble: 1,
        areas: [{ type: 'text', top: 5, left: 6, bottom: 7, right: 8 }],
      },
      source: childWin,
    });

    const secure = fake.msgs().filter((m): m is SecureMessage => m.k === 'secure');
    expect(secure.length, 'no secure message reached native').toBeGreaterThan(0);
    expect(secure.at(-1)?.p).toEqual([
      { type: 'text', top: 2, left: 3, bottom: 4, right: 5 }, // the top frame's own input
      { type: 'text', top: 35, left: 46, bottom: 37, right: 48 }, // the child's, offset by the <iframe>
    ]);
  });

  it('ignores a bubble from a window that is NOT one of this frame’s iframes', () => {
    // The security half: `BugseeBridge` aside, `postMessage` is reachable by anyone. Only a verified child
    // iframe of THIS document may contribute rects — otherwise a hostile frame could inject or displace
    // the mask. (Removing rects is what would expose pixels.)
    const fake = fakeGlobal();
    const dom = topDocument({});
    const win = fakeEventTarget();
    Object.assign(win.target, { self: win.target, top: win.target });
    track(
      'tok',
      baseOptions({
        global: fake.global,
        document: dom.document as unknown as Document,
        window: win.target as unknown as WindowEvents,
      }),
    );
    const before = fake.msgs().filter((m) => m.k === 'secure').length;

    win.emit('message', {
      data: {
        __bugsee_secure_bubble: 1,
        areas: [{ type: 'text', top: 9, left: 9, bottom: 9, right: 9 }],
      },
      source: { imposter: true },
    });

    expect(fake.msgs().filter((m) => m.k === 'secure').length).toBe(before);
    expect(fake.global.__bugsee_bridge?.snapshot()).toBe(
      JSON.stringify([{ type: 'text', top: 2, left: 3, bottom: 4, right: 5 }]),
    );
  });
});
