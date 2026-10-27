import { applicationTrackerFor, environmentTrackerFor, type WindowEvents } from '@bugsee/browser';
import {
  BUGSEE_SDK_VERSION,
  BugseeStatus,
  type CaptureStore,
  type Clock,
  clearCarrierClient,
  contributeServiceManifest,
  FiltersToken,
  getCarrierBlackout,
  getCarrierClient,
  getCarrierStatus,
  LifecycleEvents,
  type Scheduler,
  type StoredEntry,
  screenTrackerFor,
  setCarrierBlackout,
  setCarrierClient,
  setCarrierStatus,
  setProcessLifecycleEventsListener,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bridgeSchema from '../bridge-protocol.schema.json' with { type: 'json' };
import {
  type BugseeWebViewLaunchOptions,
  launchWithSeams as launch,
  launch as publicLaunch,
  SDK_VERSION,
} from './launch';
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
    count: (type: string) => listeners.get(type)?.size ?? 0,
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
  // The default-global test installs globalThis.__bugsee_bridge on a NON-CONFIGURABLE binding, so it cannot be deleted — `delete` here used to be the cleanup and now throws. It does not need
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

describe('launch (webview) goes through the ApplicationTracker registry', () => {
  const blockedDoc = () => {
    const doc = fakeEventTarget();
    const boom = new Error('visibilityState blocked');
    const state = { armed: false };
    Object.defineProperty(doc.target, 'visibilityState', {
      get() {
        if (state.armed) throw boom;
        return 'visible';
      },
    });
    return { doc, boom, state, document: doc.target as unknown as Document };
  };

  it('shares ONE tracker per document: a lookup for the launched document sees the launch listeners', () => {
    const win = fakeEventTarget();
    const { document } = blockedDoc();
    track('tok', baseOptions({ window: win.target as unknown as WindowEvents, document }));
    // online/offline are the ConnectivityTracker's alone: the ApplicationTracker no longer binds them
    expect(win.count('online')).toBe(1);
    const before = win.count('pagehide');
    expect(before).toBeGreaterThan(0);
    const shared = applicationTrackerFor({ window: win.target as never, document });
    const off = shared.on('pagehide', () => {});
    expect(win.count('pagehide')).toBe(before); // the SAME tracker: no second listener set
    off();
  });

  it('shares the browser system-events source: launch goes through the per-window EnvironmentTracker (private mode off)', () => {
    const win = fakeEventTarget();
    const { document } = blockedDoc();
    Object.assign(win.target, { navigator: { language: 'pl-PL' } });
    try {
      track('tok', baseOptions({ window: win.target as unknown as WindowEvents, document }));
      const tracker = environmentTrackerFor({ window: win.target as never });
      expect(tracker.current().language).toEqual({ language: 'pl-PL' });
      expect(tracker.current().privateMode).toBeUndefined();
    } finally {
      environmentTrackerFor({ window: win.target as never }).reset();
    }
  });

  it('the environment tracker runs over the launch document and scheduler: slow tick re-reads the zone, hidden ticks and visibility changes follow the document', () => {
    const win = fakeEventTarget();
    const doc = fakeEventTarget();
    const vis = { state: 'visible' };
    Object.defineProperty(doc.target, 'visibilityState', { get: () => vis.state });
    Object.assign(win.target, { navigator: { language: 'pl-PL' } });
    const ticks: Array<{ cb: () => void; ms: number }> = [];
    const real = new Date().getTimezoneOffset();
    const offset = (minutesEast: number) =>
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-minutesEast);
    try {
      track(
        'tok',
        baseOptions({
          window: win.target as unknown as WindowEvents,
          document: doc.target as unknown as Document,
          scheduler: {
            setInterval: (cb, ms) => {
              ticks.push({ cb, ms });
              return ticks.length;
            },
            clearInterval: () => {},
          },
        }),
      );
      const tracker = environmentTrackerFor({ window: win.target as never });
      const slow = ticks.filter((t) => t.ms === 60_000);
      expect(slow).toHaveLength(1); // the launch scheduler reached the tracker
      expect(doc.count('visibilitychange')).toBeGreaterThan(0); // and its document
      expect(tracker.current().timeZone?.utcOffsetMinutes).toBe(-real + 0);
      offset(-real + 90);
      vis.state = 'hidden';
      slow[0]?.cb();
      expect(tracker.current().timeZone?.utcOffsetMinutes).toBe(-real + 0); // hidden: tick skipped
      doc.emit('visibilitychange', {}); // still hidden: no re-read
      expect(tracker.current().timeZone?.utcOffsetMinutes).toBe(-real + 0);
      vis.state = 'visible';
      doc.emit('visibilitychange', {});
      expect(tracker.current().timeZone?.utcOffsetMinutes).toBe(-real + 90); // visible: re-read
    } finally {
      vi.restoreAllMocks();
      environmentTrackerFor({ window: win.target as never }).reset();
    }
  });

  it('never turns private-mode detection on, even when an earlier launch on the same window had it on', async () => {
    const win = fakeEventTarget();
    const { document } = blockedDoc();
    const estimate = vi.fn(() => Promise.resolve({ quota: 1 }));
    const navigator = { language: 'en', storage: { estimate } };
    Object.assign(win.target, { navigator });
    try {
      environmentTrackerFor({ window: win.target as never, navigator, detectPrivateMode: true });
      track('tok', baseOptions({ window: win.target as unknown as WindowEvents, document }));
      await new Promise((r) => setTimeout(r, 0));
      expect(estimate).toHaveBeenCalled(); // the storage trace probes it; private mode must not be inferred
      expect(
        environmentTrackerFor({ window: win.target as never }).current().privateMode,
      ).toBeUndefined();
    } finally {
      environmentTrackerFor({ window: win.target as never }).reset();
    }
  });

  it("the latest launch's onError becomes the reporter; a relaunch without one keeps it", () => {
    const win = fakeEventTarget();
    const { doc, boom, state, document } = blockedDoc();
    const first = vi.fn();
    const second = vi.fn();
    const fireBlocked = () => {
      state.armed = true;
      try {
        doc.emit('visibilitychange', {});
      } catch {
        /* a real DOM dispatch never propagates a listener's throw */
      } finally {
        state.armed = false;
      }
    };
    const run = (onError?: (e: unknown) => void) =>
      launch(
        'tok',
        baseOptions({
          window: win.target as unknown as WindowEvents,
          document,
          ...(onError !== undefined ? { onError } : {}),
        }),
      );
    run(first).stop();
    run(second).stop();
    first.mockClear();
    second.mockClear();
    const live = run(second);
    clients.push(live);
    fireBlocked();
    expect(second).toHaveBeenCalledWith(boom);
    expect(first).not.toHaveBeenCalledWith(boom);
    live.stop();
    second.mockClear();
    clients.push(run()); // no onError: must NOT silence the earlier launch's sink
    fireBlocked();
    expect(second).toHaveBeenCalledWith(boom);
  });
});

describe('launch (webview)', () => {
  it('returns a started client', () => {
    const client = track('tok', baseOptions());
    expect(client.isLaunched()).toBe(true);
  });

  it('getLaunchOptions / getHostLaunchOptions report the options in effect, not {}', () => {
    const client = track('tok', baseOptions({ captureLogs: false }));
    expect(client.getLaunchOptions()['com.bugsee.option.capture.logs']).toBe(false);
    expect(client.getHostLaunchOptions()).toMatchObject({
      'com.bugsee.option.capture.logs': false,
    });
    expect(client.getHostLaunchOptions()).not.toHaveProperty([
      'com.bugsee.option.capture.system.events',
    ]);
  });

  it('opens with a hello handshake declaring sdk + capabilities + a session', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    const hello = fake.msgs()[0] as HelloMessage;
    expect(hello.k).toBe('hello');
    expect(hello.sdk).toBe(SDK_VERSION); // the version the native receiver negotiates against
    expect([...hello.caps].sort()).toEqual(
      [
        'breadcrumbs',
        'crash',
        'events.system',
        'events.user',
        'input',
        'log',
        'network',
        'traces.system',
      ].sort(),
    ); // the full declared capability set (drives negotiation) — dropping any one fails this.
    // `input` joined it when SDK-captured interactions moved off `events.user`: native routes records
    // by fileType, so an undeclared stream is a stream native was never told to expect.
    expect(typeof hello.session).toBe('string');
    expect(hello.session.length).toBeGreaterThan(0);
  });

  // The hello's capabilities and the machine-checkable bridge schema are two hand-maintained lists of
  // the same thing. Nothing tied them together, so adding a stream to one and forgetting the other
  // shipped records native's schema rejects. This is that tie.
  it('declares no capability the bridge schema cannot route', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    const hello = fake.msgs()[0] as HelloMessage;
    const routable = new Set(bridgeSchema.definitions.fileType.enum);
    for (const cap of hello.caps) expect([cap, routable.has(cap)]).toStrictEqual([cap, true]);
  });

  it('handshakes and streams over a WKWebView (iOS) host, stamping the capture nonce', () => {
    // The whole composition over the iOS transport, not just the sink unit. `launch` builds the bridge, the
    // capture store, the obscuring channel and the report pipeline against one `global`; if any of them
    // reached for the Android interface directly rather than going through the host bridge, this fails.
    //
    // The nonce assertion is the load-bearing half: native drops every unstamped message, so a
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
    expect(hello?.sdk).toBe(SDK_VERSION);
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
    // none of which needs a sink to shadow, a race to win, or the control secret — it walks around
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

    // The other half, and the reason the facade exists at all: the REAL token still resolves. Without
    // this, a facade that answered `undefined` to everything would pass every assertion above while
    // silently cutting the capture pipeline off from the redaction filters — masking that fails open.
    expect(forge?.(FiltersToken), 'the genuine FiltersToken stopped resolving').toBeDefined();
    expect(
      forgeProvider?.(FiltersToken),
      'the genuine FiltersToken stopped resolving a provider',
    ).toBeDefined();
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

  it('streams display_mode_changed from the injected window matchMedia, through the shared browser events source', () => {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    let standalone = false;
    const win = fakeEventTarget();
    Object.assign(win.target, {
      matchMedia(q: string) {
        return {
          get matches() {
            return standalone && q === '(display-mode: standalone)';
          },
          addEventListener: (_t: string, f: (e: { matches: boolean }) => void) =>
            void listeners.add(f),
          removeEventListener: (_t: string, f: (e: { matches: boolean }) => void) =>
            void listeners.delete(f),
        };
      },
    });
    const fake = fakeGlobal();
    track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    standalone = true;
    for (const f of [...listeners]) f({ matches: true });
    const hits = entriesOfType(fake.msgs(), 'events.system').filter((e) =>
      JSON.stringify(e.p).includes('display_mode_changed'),
    );
    expect(hits).toHaveLength(1);
    expect(JSON.stringify(hits[0]?.p)).toContain('"previousMode":"browser"');
    expect(JSON.stringify(hits[0]?.p)).toContain('"mode":"standalone"');
  });

  it('streams DarkModeChanged from the injected window matchMedia (bound to it); none without matchMedia; a throwing matchMedia never fails launch', () => {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const thisSeen: unknown[] = [];
    const win = fakeEventTarget();
    Object.assign(win.target, {
      matchMedia(this: unknown) {
        thisSeen.push(this);
        return {
          matches: false,
          addEventListener: (_t: string, f: (e: { matches: boolean }) => void) =>
            void listeners.add(f),
          removeEventListener: (_t: string, f: (e: { matches: boolean }) => void) =>
            void listeners.delete(f),
        };
      },
    });
    const fake = fakeGlobal();
    track(
      'tok',
      baseOptions({ global: fake.global, window: win.target as unknown as WindowEvents }),
    );
    expect(thisSeen).toHaveLength(12); // dark: baseline read + watch (2); display mode: 3 queries x (baseline read + watch + previous-mode read) (9); the displays producer's resolution query (1: built even though the host owns the name, so a host that hands it back can have it)
    expect(thisSeen.every((t) => t === win.target)).toBe(true);
    for (const f of [...listeners]) f({ matches: true });
    const has = (msgs: ReturnType<typeof fakeGlobal>) =>
      entriesOfType(msgs.msgs(), 'events.system').some((e) =>
        JSON.stringify(e.p).includes('DarkModeChanged'),
      );
    expect(has(fake)).toBe(true);

    const plain = fakeGlobal();
    track(
      'tok2',
      baseOptions({
        global: plain.global,
        window: fakeEventTarget().target as unknown as WindowEvents,
      }),
    );
    expect(has(plain)).toBe(false);

    const onError = vi.fn();
    const hostile = fakeEventTarget();
    Object.assign(hostile.target, {
      matchMedia() {
        throw new Error('matchMedia blocked');
      },
    });
    expect(() =>
      track(
        'tok3',
        baseOptions({
          global: fakeGlobal().global,
          window: hostile.target as unknown as WindowEvents,
          onError,
        }),
      ),
    ).not.toThrow();
    expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toContain('matchMedia blocked');
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

  // Re-pointed from "streams a document interaction (click) as an events.user entry". What it was
  // protecting: launch() wires the DOM input source through to the NATIVE bridge, so an interaction in
  // the WebView reaches the host. Still true — but it must arrive on the `input` stream, because
  // `events.user` carries the embedded app's own `client.event()` data.
  it('streams a document interaction (pointer press) as an `input` record to native', () => {
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
    doc.emit('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      target: {
        tagName: 'BUTTON',
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
        textContent: 'Buy',
      },
      clientX: 3,
      clientY: 4,
      button: 0,
      pressure: 1,
    });
    const input = entriesOfType(fake.msgs(), 'input');
    expect(input).toHaveLength(1);
    // The bridge wraps each entry as `{ timestamp, data }` — the interaction itself is `p.data`.
    expect(input[0]?.p).toMatchObject({
      data: { type: 'begin', x: 3, y: 4, tool: 1, view_tag: 'button', target: { text: 'Buy' } },
    });
    // ...and NOT onto the app's own event stream.
    expect(entriesOfType(fake.msgs(), 'events.user')).toStrictEqual([]);
  });

  // The browser tier records the FRAME those coordinates belong to (`video.aux`), because a consumer
  // with no frame falls back to the device screen and draws the click off the frame. This tier must
  // NOT — and the symmetry with `@bugsee/browser` is exactly what makes it tempting to add.
  //
  // The page's frame is not the frame these coordinates end up in. The native receiver REWRITES every
  // point before it is stored: Android's `BridgeInputMapper` maps viewport-relative CSS px through the
  // WebView's origin on screen and its scale into native screen coordinates divided by the density.
  // By the time the entry reaches `input.json` it is in the HOST's frame, which the host's own
  // `video.aux` already describes. A page-frame record would therefore describe a coordinate space
  // that no longer exists, and if it ever reached the host's stream it would contradict the real one.
  //
  // Native drops what it was not told to expect (`BridgeCaptureRouter.route` has no else branch, and
  // `video.aux` is not in the hello capabilities), so today this would be silent dead weight on the
  // wire. That silence is the reason to pin it rather than rely on noticing.
  it('never streams the page frame (video.aux) — native owns the frame here', () => {
    const fake = fakeGlobal();
    const doc = fakeEventTarget();
    const win = fakeEventTarget();
    // A MEASURABLE window: without these the viewport source would decline to emit even if it were
    // wired, and this test would pass for the wrong reason.
    Object.assign(win.target, { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 });
    track(
      'tok',
      baseOptions({
        global: fake.global,
        window: win.target as unknown as WindowEvents,
        document: doc.target as unknown as Document,
      }),
    );

    win.emit('resize', {});

    expect(entriesOfType(fake.msgs(), 'video.aux' as EntryMessage['t'])).toStrictEqual([]);
  });

  // The other half of the input/state-change split: `change`/`submit`/`focus` are not device presses and
  // are not members of Android's InputEventStage, so BOTH native receivers now DROP them off the `input`
  // stream (bugsee-android#9, bugsee-cocoa#19). Without this source the WebView loses them entirely —
  // and the WebView is precisely the surface native cannot see inside, where a native screen WOULD get
  // an equivalent `ui.*` gesture breadcrumb.
  it('streams change / submit / focus to native as ui.* breadcrumb records', () => {
    const fake = fakeGlobal();
    const doc = fakeEventTarget();
    const win = fakeEventTarget();
    track(
      'tok',
      baseOptions({
        global: fake.global,
        window: win.target as unknown as WindowEvents,
        document: doc.target as unknown as Document,
      }),
    );
    doc.emit('change', {
      target: {
        tagName: 'INPUT',
        id: 'qty',
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
      },
    });
    const crumbs = entriesOfType(fake.msgs(), 'breadcrumbs');
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]?.p).toMatchObject({
      data: {
        type: 'user',
        category: 'ui.change',
        level: 'info',
        data: { 'view.id': 'qty', 'view.tag': 'input' },
      },
    });
    // ...and never onto the input stream, nor the embedded app's own event stream.
    expect(entriesOfType(fake.msgs(), 'input')).toStrictEqual([]);
    expect(entriesOfType(fake.msgs(), 'events.user')).toStrictEqual([]);
  });

  // V10: a blackout used to gate NOTHING in a WebView: the input and ui.* providers were built without the
  // client's blackout gate, so a blacked-out embedded page still streamed every press and field focus.
  describe('blackout gates the WebView interaction capture (V10)', () => {
    const field = {
      tagName: 'INPUT',
      id: 'qty',
      type: 'number',
      getAttribute: () => null,
      closest: () => null,
      matches: () => false,
    };
    const press = (doc: ReturnType<typeof fakeEventTarget>, id: number): void =>
      doc.emit('pointerdown', {
        pointerId: id,
        pointerType: 'touch',
        target: {
          tagName: 'BUTTON',
          getAttribute: () => null,
          closest: () => null,
          matches: () => false,
        },
        clientX: id,
        clientY: id,
        button: 0,
        pressure: 1,
      });
    const boot = () => {
      const fake = fakeGlobal();
      const doc = fakeEventTarget();
      const win = fakeEventTarget();
      const client = track(
        'tok',
        baseOptions({
          global: fake.global,
          window: win.target as unknown as WindowEvents,
          document: doc.target as unknown as Document,
        }),
      );
      return { fake, doc, client };
    };

    it('drops presses and ui.* breadcrumbs during the blackout, and only then', () => {
      const { fake, doc, client } = boot();
      press(doc, 1);
      doc.emit('focusin', { target: field });
      client.startBlackout();
      press(doc, 2);
      doc.emit('change', { target: field });
      client.endBlackout();
      press(doc, 3);
      doc.emit('change', { target: field });
      const xs = entriesOfType(fake.msgs(), 'input').map(
        (e) => (e.p as unknown as { data: { x: number } }).data.x,
      );
      expect(xs).toEqual([1, 3]);
      const categories = entriesOfType(fake.msgs(), 'breadcrumbs').map(
        (e) => (e.p as unknown as { data: { category: string } }).data.category,
      );
      expect(categories).toEqual(['ui.focus', 'ui.change']);
    });

    it('a wheel turn made during the blackout is never streamed, even if its frame flushes after it ended', async () => {
      const { fake, doc, client } = boot();
      doc.emit('wheel', {
        deltaX: 0,
        deltaY: 11,
        deltaMode: 0,
        clientX: 1,
        clientY: 1,
        buttons: 0,
      });
      client.startBlackout();
      doc.emit('wheel', {
        deltaX: 0,
        deltaY: 22,
        deltaMode: 0,
        clientX: 1,
        clientY: 1,
        buttons: 0,
      });
      client.endBlackout();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(entriesOfType(fake.msgs(), 'input')).toStrictEqual([]);
    });

    describe('the native host is told (its video is paused only by the host)', () => {
      const blackoutMsgs = (fake: ReturnType<typeof fakeGlobal>) =>
        fake.msgs().filter((m) => (m as { k: string }).k === 'blackout') as unknown as Array<{
          a: boolean;
          ts: number;
          b: number;
        }>;
      const bootWith = (over: Partial<BugseeWebViewLaunchOptions> = {}) => {
        const fake = fakeGlobal();
        const errors: unknown[] = [];
        const client = track(
          'tok',
          baseOptions({
            global: fake.global,
            onError: (e) => errors.push(e),
            ...over,
          }),
        );
        return { fake, client, errors };
      };

      it('startBlackout()/endBlackout() cross the bridge as blackout messages, schema-shaped', () => {
        const { fake, client } = bootWith();
        client.startBlackout();
        client.startBlackout(); // idempotent: no second message
        client.endBlackout();
        const msgs = blackoutMsgs(fake);
        expect(msgs.map((m) => m.a)).toEqual([false, true, false]); // the post-hello state, then the two changes
        expect(msgs[1]?.b).toBe(1);
        expect(typeof msgs[1]?.ts).toBe('number');
        expect(bridgeSchema.definitions.blackout.required).toEqual(['b', 'k', 'a', 'ts']);
      });

      it('warns ONCE through onError while native has not declared blackout support', () => {
        const { client, errors } = bootWith();
        client.startBlackout();
        client.endBlackout();
        client.startBlackout();
        const warnings = errors.filter(
          (e) => /native/i.test(String(e)) && /blackout/i.test(String(e)),
        );
        expect(warnings).toHaveLength(1);
      });

      it('does not warn once native declared blackout support in its control reply', () => {
        const { fake, client, errors } = bootWith();
        sendControl(fake.global, { config: { blackout: true } });
        client.startBlackout();
        client.endBlackout();
        expect(errors).toEqual([]);
        expect(blackoutMsgs(fake).map((m) => m.a)).toEqual([false, true, false]);
      });

      it('a native that later withdraws support is warned about again', () => {
        const { fake, client, errors } = bootWith();
        sendControl(fake.global, { config: { blackout: true } });
        client.startBlackout();
        sendControl(fake.global, { config: { blackout: false } });
        client.endBlackout();
        client.startBlackout();
        expect(errors).toHaveLength(1);
      });

      it('warns when there is no native bridge to deliver to (the message is buffered, not delivered)', () => {
        const errors: unknown[] = [];
        const client = track('tok', baseOptions({ global: {}, onError: (e) => errors.push(e) }));
        client.startBlackout();
        expect(errors.some((e) => /not delivered|no native bridge/i.test(String(e)))).toBe(true);
      });

      // A blackout CARRIED over a relaunch is active from the start, so no onChange ever fires for it:
      // native must still be told, and after `hello` (a receiver has no session to attach it to before that).
      it('a carried blackout is posted to native right after hello', () => {
        const carrier = {};
        setCarrierBlackout(true, carrier);
        const { fake } = bootWith({ carrier });
        const kinds = fake.msgs().map((m) => (m as { k: string }).k);
        expect(kinds.slice(0, 2)).toEqual(['hello', 'blackout']);
        expect(blackoutMsgs(fake)).toHaveLength(1);
        expect(blackoutMsgs(fake)[0]?.a).toBe(true);
      });

      // native resets the JS-reported flag on `bye`/`hello`, so the state is ALWAYS restated after `hello`,
      // `a:false` included: a client that never posts it can leave native paused for a session that is not dark.
      it('the current state is posted after hello even when no blackout is in force (a:false)', () => {
        const { fake } = bootWith({ carrier: {} });
        const kinds = fake.msgs().map((m) => (m as { k: string }).k);
        expect(kinds.slice(0, 2)).toEqual(['hello', 'blackout']);
        expect(blackoutMsgs(fake).map((m) => m.a)).toEqual([false]);
      });

      it('A dark -> A.stop() -> A.endBlackout() -> launch B: B tells native a:false right after its hello', async () => {
        const carrier = {};
        const fake = fakeGlobal();
        const a = launch('tok', baseOptions({ global: fake.global, carrier }));
        a.startBlackout();
        await a.stop(); // `bye` posted; native's flag reset by it, but a late/old receiver may not
        a.endBlackout(); // lifts the carried flag quietly: nothing may be posted toward native from the torn A
        const before = fake.msgs().length;
        track('tok', baseOptions({ global: fake.global, carrier }));
        const after = fake.msgs().slice(before) as Array<{ k: string; a?: boolean }>;
        expect(after.map((m) => m.k).slice(0, 2)).toEqual(['hello', 'blackout']);
        expect(after[1]?.a).toBe(false);
      });

      it('a launch without any bridge posts nothing and warns about nothing for an inactive blackout', () => {
        const errors: unknown[] = [];
        track('tok', baseOptions({ global: {}, onError: (e) => errors.push(e) }));
        expect(errors.filter((e) => /blackout/i.test(String(e)))).toEqual([]);
      });

      // The "native has not declared support" warning is judged AFTER native had a chance to answer
      // the handshake, not at the instant of the (launch-time) announcement.
      it('a carried blackout does not warn before the control reply, nor after a reply declaring support', () => {
        const carrier = {};
        setCarrierBlackout(true, carrier);
        const { fake, errors } = bootWith({ carrier });
        expect(errors).toEqual([]); // judged lazily: the reply may still be in flight
        sendControl(fake.global, { session: 'native-1', config: { blackout: true } });
        expect(errors).toEqual([]);
      });

      it('... and warns once the reply arrives WITHOUT declaring support', () => {
        const carrier = {};
        setCarrierBlackout(true, carrier);
        const { fake, errors } = bootWith({ carrier });
        sendControl(fake.global, { session: 'native-1', config: { reportTrigger: false } });
        expect(errors.filter((e) => /not declared blackout support/.test(String(e)))).toHaveLength(
          1,
        );
        sendControl(fake.global, { session: 'native-1' });
        expect(errors).toHaveLength(1); // once
      });

      it('once native HAS replied, the first blackout change is judged at once (nothing left to wait for)', () => {
        const { fake, client, errors } = bootWith({ carrier: {} });
        sendControl(fake.global, { session: 'native-1' }); // replied, no blackout support declared
        client.startBlackout();
        expect(errors.filter((e) => /not declared blackout support/.test(String(e)))).toHaveLength(
          1,
        );
      });

      it('a SECOND blackout change before any reply stops waiting and warns', () => {
        const { client, errors } = bootWith({ carrier: {} });
        client.startBlackout(); // first announcement: deferred to the reply
        expect(errors).toEqual([]);
        client.endBlackout(); // native has been silent through two announcements
        expect(errors.filter((e) => /not declared blackout support/.test(String(e)))).toHaveLength(
          1,
        );
      });

      // a legacy receiver that never answers the handshake used to leave the judgement pending for ever
      // (one blackout change, no reply): the integrator was never told the native video keeps running.
      describe('the "native has not declared support" judgement is bounded', () => {
        const notDeclared = (errors: unknown[]): number =>
          errors.filter((e) => /not declared blackout support/.test(String(e))).length;

        it('is judged at the deadline when native never replies (one change, then silence)', () => {
          vi.useFakeTimers();
          try {
            const { client, errors } = bootWith({ carrier: {} });
            client.startBlackout(); // first announcement: waits for the reply
            expect(notDeclared(errors)).toBe(0);
            vi.advanceTimersByTime(4_999);
            expect(notDeclared(errors)).toBe(0); // not before the deadline
            vi.advanceTimersByTime(1); // exactly the 5 s deadline
            expect(notDeclared(errors)).toBe(1);
            vi.advanceTimersByTime(60_000);
            expect(notDeclared(errors)).toBe(1); // once
          } finally {
            vi.useRealTimers();
          }
        });

        it('a reply that declares support before the deadline cancels the judgement', () => {
          vi.useFakeTimers();
          try {
            const { fake, client, errors } = bootWith({ carrier: {} });
            client.startBlackout();
            sendControl(fake.global, { session: 'native-1', config: { blackout: true } });
            vi.advanceTimersByTime(60_000);
            expect(notDeclared(errors)).toBe(0);
          } finally {
            vi.useRealTimers();
          }
        });

        it('is judged at stop() when it is still pending', async () => {
          const { client, errors } = bootWith({ carrier: {} });
          client.startBlackout();
          expect(notDeclared(errors)).toBe(0);
          await client.stop();
          expect(notDeclared(errors)).toBe(1);
        });
      });

      it('a throwing onError never breaks the call', () => {
        const fake = fakeGlobal();
        const client = track(
          'tok',
          baseOptions({
            global: fake.global,
            onError: () => {
              throw new Error('host handler');
            },
          }),
        );
        expect(() => client.startBlackout()).not.toThrow();
        expect(client.isBlackout()).toBe(true);
      });

      // only the client that owns the process blackout may change the flag or tell native.
      describe('a stale handle cannot change the blackout or speak to native', () => {
        const startStale = async (darkFirst: boolean) => {
          const carrier = {};
          const fake = fakeGlobal();
          const errors: unknown[] = [];
          const first = launch(
            'tok',
            baseOptions({ global: fake.global, carrier, onError: (e) => errors.push(e) }),
          );
          if (darkFirst) first.startBlackout();
          await first.stop();
          const second = track('tok', baseOptions({ global: fake.global, carrier }));
          return { carrier, fake, errors, first, second };
        };

        it('A dark + stop, B launches dark: A.endBlackout() leaves B dark, the flag set and native unmoved', async () => {
          const { carrier, fake, errors, first, second } = await startStale(true);
          expect(second.isBlackout()).toBe(true); // carried
          const before = blackoutMsgs(fake).length;
          first.endBlackout();
          expect(second.isBlackout()).toBe(true);
          expect(getCarrierBlackout(carrier)).toBe(true);
          expect(blackoutMsgs(fake)).toHaveLength(before); // no `a:false` to the host
          expect(errors.some((e) => /endBlackout/.test(String(e)))).toBe(true);
        });

        it('a stale startBlackout() is forwarded to the live client and announced to native once', async () => {
          const { carrier, fake, first, second } = await startStale(false);
          first.startBlackout();
          expect(second.isBlackout()).toBe(true);
          expect(getCarrierBlackout(carrier)).toBe(true);
          expect(blackoutMsgs(fake).map((m) => m.a)).toEqual([false, false, true]); // each launch's post-hello state, then the forwarded start once
        });

        it('a client whose carrier slot another client has taken tells native nothing', () => {
          const carrier = {};
          const fake = fakeGlobal();
          const client = track('tok', baseOptions({ global: fake.global, carrier }));
          setCarrierClient({ another: 'client' }, carrier);
          client.startBlackout();
          expect(blackoutMsgs(fake).map((m) => m.a)).toEqual([false]); // only the post-hello state; the start said nothing
        });

        it('a stopped client that is still the last owner lifts the carried flag quietly, posting nothing after bye', async () => {
          const carrier = {};
          const fake = fakeGlobal();
          const only = launch('tok', baseOptions({ global: fake.global, carrier }));
          only.startBlackout();
          await only.stop();
          const before = fake.msgs().length;
          only.endBlackout();
          expect(getCarrierBlackout(carrier)).toBe(false);
          expect(fake.msgs()).toHaveLength(before);
        });
      });
    });

    it('a relaunch on the same carrier gates the SHARED input source with the NEW client', async () => {
      const carrier = {};
      const doc = fakeEventTarget();
      const win = fakeEventTarget();
      const opts = (global: object) =>
        baseOptions({
          global,
          carrier,
          window: win.target as unknown as WindowEvents,
          document: doc.target as unknown as Document,
        });
      const first = launch('tok', opts(fakeGlobal().global));
      await first.stop();
      const fake = fakeGlobal();
      const second = track('tok', opts(fake.global));
      second.startBlackout();
      doc.emit('wheel', {
        deltaX: 0,
        deltaY: 22,
        deltaMode: 0,
        clientX: 1,
        clientY: 1,
        buttons: 0,
      });
      second.endBlackout();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(entriesOfType(fake.msgs(), 'input')).toStrictEqual([]);
    });

    it('does not suppress non-visual capture (an app breadcrumb still streams)', () => {
      const { fake, client } = boot();
      client.startBlackout();
      client.addBreadcrumb({ category: 'app.step', message: 'kept' });
      const categories = entriesOfType(fake.msgs(), 'breadcrumbs').map(
        (e) => (e.p as unknown as { data: { category: string } }).data.category,
      );
      expect(categories).toEqual(['app.step']);
    });
  });

  it('withholds a WebView ui.* breadcrumb for a sensitive field', () => {
    const fake = fakeGlobal();
    const doc = fakeEventTarget();
    const win = fakeEventTarget();
    track(
      'tok',
      baseOptions({
        global: fake.global,
        window: win.target as unknown as WindowEvents,
        document: doc.target as unknown as Document,
      }),
    );
    doc.emit('focusin', {
      target: {
        tagName: 'INPUT',
        type: 'password',
        id: 'pw',
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
      },
    });
    expect(entriesOfType(fake.msgs(), 'breadcrumbs')).toStrictEqual([]);
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

  describe('sensor traces from the tracker-backed producers', () => {
    const fakeWin = () => {
      const l = new Map<string, Set<(e: Event) => void>>();
      return {
        win: {
          // a real window IS the global scope: the traces read these from THIS window, not the host globals
          get navigator() {
            return (globalThis as { navigator?: unknown }).navigator;
          },
          get performance() {
            return (globalThis as { performance?: unknown }).performance;
          },
          get screen() {
            return (globalThis as { screen?: unknown }).screen;
          },
          addEventListener: (t: string, f: (e: Event) => void) => {
            const set = l.get(t) ?? new Set();
            set.add(f);
            l.set(t, set);
          },
          removeEventListener: (t: string, f: (e: Event) => void) => void l.get(t)?.delete(f),
        },
        count: (...types: string[]) => types.reduce((n, t) => n + (l.get(t)?.size ?? 0), 0),
      };
    };
    const stubSensors = (): void => {
      vi.stubGlobal('navigator', { onLine: true, connection: { type: 'cellular' } });
      vi.stubGlobal('performance', {
        now: () => Date.now(),
        memory: { usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 100 },
      });
      vi.stubGlobal('screen', { orientation: { type: 'landscape-primary', angle: 90 } });
    };

    // The webview events source ALSO listens for these three on the window: 3 events + 3 sensors by default.
    const listeners = (over: Partial<BugseeWebViewLaunchOptions>) => {
      const w = fakeWin();
      const client = track(
        'tok',
        baseOptions({ global: fakeGlobal().global, window: w.win, ...over }),
      );
      return { client, n: () => w.count('online', 'offline', 'orientationchange') };
    };

    it('streams the page heap (not the host-owned connection/orientation), and listens on the injected window only while capturing', async () => {
      stubSensors();
      try {
        const fake = fakeGlobal();
        const w = fakeWin();
        const client = track('tok', baseOptions({ global: fake.global, window: w.win }));
        await new Promise((r) => setTimeout(r, 0));
        const rows = new Map(
          entriesOfType(fake.msgs(), 'traces.system').map((e) => {
            const d = (e.p as unknown as { data: { name: string; value: unknown } }).data;
            return [d.name, d.value];
          }),
        );
        expect(rows.get('ram_js_heap_used')).toBe(10); // the page's OWN heap: page-owned, written by the WebView
        // `connection` and `orientation` are the native host's (spec host-owned table): the WebView writes neither
        expect(rows.has('connection')).toBe(false);
        expect(rows.has('orientation')).toBe(false);
        // ONE ConnectivityTracker (online + offline) and ONE UiTracker (orientationchange) serve traces AND events:
        // three listeners, none duplicated.
        expect(w.count('online', 'offline', 'orientationchange')).toBe(3);
        await client.stop();
        expect(w.count('online', 'offline', 'orientationchange')).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    describe('user_idle_state is opt-in (captureUserIdle) and needs an already-granted permission', () => {
      const idleRows = async (over: Partial<BugseeWebViewLaunchOptions>, permission: string) => {
        stubSensors();
        const query = vi.fn(() => Promise.resolve({ state: permission }));
        vi.stubGlobal('navigator', { onLine: true, permissions: { query } });
        try {
          const fake = fakeGlobal();
          const w = fakeWin();
          class FakeDetector {
            userState = 'idle';
            screenState = 'unlocked';
            start = () => Promise.resolve(undefined);
            addEventListener = () => {};
            removeEventListener = () => {};
          }
          Object.assign(w.win, {
            IdleDetector: FakeDetector,
            AbortController: class {
              signal = {};
              abort() {}
            },
          });
          track('tok', baseOptions({ global: fake.global, window: w.win, ...over }));
          await new Promise((r) => setTimeout(r, 0));
          const rows = new Map(
            entriesOfType(fake.msgs(), 'traces.system').map((e) => {
              const d = (e.p as unknown as { data: { name: string; value: unknown } }).data;
              return [d.name, d.value];
            }),
          );
          return { rows, query, w };
        } finally {
          vi.unstubAllGlobals();
        }
      };

      it('default: no user_idle_state and no permission query, though granted', async () => {
        const { rows, query } = await idleRows({}, 'granted');
        expect(rows.has('user_idle_state')).toBe(false);
        expect(query).not.toHaveBeenCalled();
      });

      it('captureUserIdle:true + already granted: user_idle_state is streamed', async () => {
        const { rows } = await idleRows({ captureUserIdle: true }, 'granted');
        expect(rows.get('user_idle_state')).toBe('idle');
      });

      it('captureUserIdle:true but not granted: no trace (never prompts)', async () => {
        const { rows, query } = await idleRows({ captureUserIdle: true }, 'prompt');
        expect(query).toHaveBeenCalled();
        expect(rows.has('user_idle_state')).toBe(false);
      });

      it.each([
        'true',
        1,
        0,
        '',
        null,
      ])('captureUserIdle=%j (invalid) stays OFF and reports', async (bad) => {
        const onError = vi.fn();
        const { rows, query } = await idleRows(
          { captureUserIdle: bad as never, onError },
          'granted',
        );
        expect(rows.has('user_idle_state')).toBe(false);
        expect(query).not.toHaveBeenCalled();
        expect(
          onError.mock.calls.filter((c) =>
            String((c[0] as Error).message).startsWith('captureUserIdle must be a boolean'),
          ),
        ).toHaveLength(1);
      });
    });

    describe('the route and view traces', () => {
      it('streams the route the page reports through client.setRoute, from the carrier-shared tracker, and NEVER a view (the native host owns it)', async () => {
        stubSensors();
        try {
          const fake = fakeGlobal();
          const carrier = {};
          screenTrackerFor(carrier).setRoute('/early/:id');
          const client = track(
            'tok',
            baseOptions({ global: fake.global, window: fakeWin().win, carrier }),
          );
          await new Promise((r) => setTimeout(r, 0));
          client.setView({ name: 'Detail', type: 'vue' });
          const rows = entriesOfType(fake.msgs(), 'traces.system')
            .map((e) => (e.p as unknown as { data: { name: string; value: unknown } }).data)
            .filter((d) => d.name === 'route' || d.name === 'view')
            .map((d) => [d.name, d.value]);
          // the native host owns `view` (spec host table: WebView writes no view); the page writes `route`
          expect(rows).toEqual([['route', '/early/:id']]);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    describe('the view trace can be handed back by native (the always-built producer is gated only by the live suppression)', () => {
      it('hostOwnedTraces: [] releases `view`: the held view is written at the handshake and later changes follow', async () => {
        stubSensors();
        try {
          const fake = fakeGlobal();
          const carrier = {};
          const client = track(
            'tok',
            baseOptions({ global: fake.global, window: fakeWin().win, carrier }),
          );
          await new Promise((r) => setTimeout(r, 0));
          client.setView({ name: 'Detail' });
          sendControl(fake.global, { config: { hostOwnedTraces: [] } });
          client.setView({ name: 'Other' });
          const views = entriesOfType(fake.msgs(), 'traces.system')
            .map((e) => (e.p as unknown as { data: { name: string; value: unknown } }).data)
            .filter((d) => d.name === 'view')
            .map((d) => d.value);
          expect(views).toEqual([{ name: 'Detail' }, { name: 'Other' }]);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    describe('the url trace (captureUrl / urlSanitizer)', () => {
      const urlRows = async (over: Partial<BugseeWebViewLaunchOptions>, href?: string) => {
        stubSensors();
        try {
          const fake = fakeGlobal();
          const w = fakeWin();
          if (href !== undefined) Object.assign(w.win, { location: { pathname: '/p', href } });
          track('tok', baseOptions({ global: fake.global, window: w.win, ...over }));
          await new Promise((r) => setTimeout(r, 0));
          return entriesOfType(fake.msgs(), 'traces.system')
            .map((e) => (e.p as unknown as { data: { name: string; value: unknown } }).data)
            .filter((d) => d.name === 'url')
            .map((d) => d.value);
        } finally {
          vi.unstubAllGlobals();
        }
      };

      it('default: streams the sanitized location of the embedded page', async () => {
        expect(await urlRows({}, 'https://a.com/o?token=abc&tab=1')).toEqual([
          'https://a.com/o?token=%3Credacted%3E&tab=1',
        ]);
      });

      it('captureUrl:false writes nothing', async () => {
        expect(await urlRows({ captureUrl: false }, 'https://a.com/o')).toEqual([]);
      });

      it.each([
        'false',
        1,
        0,
        '',
        null,
      ])('captureUrl=%j (invalid) is OFF and reports', async (bad) => {
        const onError = vi.fn();
        expect(await urlRows({ captureUrl: bad as never, onError }, 'https://a.com/o')).toEqual([]);
        expect(
          onError.mock.calls.filter((c) =>
            String((c[0] as Error).message).startsWith('captureUrl must be a boolean'),
          ),
        ).toHaveLength(1);
      });

      it('urlSanitizer refines the default result', async () => {
        expect(
          await urlRows({ urlSanitizer: (u) => u.replace('/o', '/x') }, 'https://a.com/o'),
        ).toEqual(['https://a.com/x']);
      });
    });

    it('a window whose getters throw (including its document) never fails launch: each is omitted and reported', () => {
      stubSensors();
      try {
        const w = fakeWin();
        for (const key of [
          'navigator',
          'performance',
          'screen',
          'requestAnimationFrame',
          'document',
        ]) {
          Object.defineProperty(w.win, key, {
            get(): never {
              throw new Error(`${key} blocked`);
            },
            configurable: true,
          });
        }
        const onError = vi.fn();
        expect(() => track('tok', baseOptions({ window: w.win, onError }))).not.toThrow();
        const messages = onError.mock.calls.map((c) => (c[0] as Error).message);
        expect(messages).toEqual(
          expect.arrayContaining([
            'navigator blocked',
            'performance blocked',
            'screen blocked',
            'requestAnimationFrame blocked',
            'document blocked',
          ]),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    describe('displays (host-owned: never written, though the producer exists so the host can hand it back) and main_thread_lag_ms (from the injected window)', () => {
      const rowsOf = (fake: ReturnType<typeof fakeGlobal>, name: string): unknown[] =>
        entriesOfType(fake.msgs(), 'traces.system')
          .map((e) => (e.p as unknown as { data: { name: string; value: unknown } }).data)
          .filter((d) => d.name === name)
          .map((d) => d.value);

      it('does NOT write the host-owned displays trace, and streams timer-drift lag from the INJECTED window; none from a hidden page', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 360, height: 640 });
        try {
          const fake = fakeGlobal();
          const w = fakeWin();
          let clock = 0;
          Object.defineProperty(w.win, 'performance', {
            value: { now: () => clock },
            configurable: true,
          });
          Object.assign(w.win, { devicePixelRatio: 3 });
          const dom = fakeDomDocument();
          Object.assign(dom.document, { visibilityState: 'visible' });
          const ticks: Array<() => void> = [];
          track(
            'tok',
            baseOptions({
              global: fake.global,
              window: w.win,
              document: dom.document as unknown as Document,
              scheduler: {
                setInterval: (cb, ms) => {
                  if (ms === 1000) ticks.push(cb as () => void);
                  return 0 as unknown as ReturnType<Scheduler['setInterval']>;
                },
                clearInterval: () => {},
              },
            }),
          );
          await new Promise((r) => setTimeout(r, 0));
          expect(rowsOf(fake, 'displays')).toEqual([]); // the native host owns it
          clock = 1000 + 25; // the first 1 s tick fires 25 ms late
          for (const t of ticks) t();
          expect(rowsOf(fake, 'main_thread_lag_ms')).toEqual([25]);

          // a hidden page never reads the clock for lag (no timer)
          let hiddenReads = 0;
          Object.defineProperty(w.win, 'performance', {
            value: {
              now: () => {
                hiddenReads += 1;
                return 0;
              },
            },
            configurable: true,
          });
          const hidden = fakeDomDocument();
          Object.assign(hidden.document, { visibilityState: 'hidden' });
          track(
            'tok2',
            baseOptions({
              global: fakeGlobal().global,
              window: w.win,
              document: hidden.document as unknown as Document,
            }),
          );
          expect(hiddenReads).toBe(0);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('native can HAND `displays` BACK (hostOwnedTraces: []): the held baseline list is written at the handshake', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 360, height: 640 });
        try {
          const fake = fakeGlobal();
          const w = fakeWin();
          Object.assign(w.win, { devicePixelRatio: 2 });
          track('tok', baseOptions({ global: fake.global, window: w.win }));
          await new Promise((r) => setTimeout(r, 0));
          expect(rowsOf(fake, 'displays')).toEqual([]); // the host owns it until it says otherwise
          sendControl(fake.global, { config: { hostOwnedTraces: [] } });
          expect(rowsOf(fake, 'displays')).toEqual([
            [{ id: 0, state: 'on', width: 720, height: 1280, scale: 2 }],
          ]);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('a hostile devicePixelRatio getter never fails launch: the failure is REPORTED, and (the host owns it) no displays row is written', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 360, height: 640 });
        try {
          const fake = fakeGlobal();
          const w = fakeWin();
          Object.defineProperty(w.win, 'devicePixelRatio', {
            get(): never {
              throw new Error('devicePixelRatio blocked');
            },
            configurable: true,
          });
          const onError = vi.fn();
          expect(() =>
            track('tok', baseOptions({ global: fake.global, window: w.win, onError })),
          ).not.toThrow();
          await new Promise((r) => setTimeout(r, 0));
          expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toContain(
            'devicePixelRatio blocked',
          );
          expect(rowsOf(fake, 'displays')).toEqual([]);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    it('the document comes from the INJECTED window, not the host global (a blocked host document is never even read)', () => {
      stubSensors();
      try {
        const w = fakeWin();
        const doc = fakeDomDocument().document;
        Object.assign(w.win, { document: doc });
        Object.defineProperty(globalThis, 'document', {
          get(): never {
            throw new Error('host document blocked');
          },
          configurable: true,
        });
        const onError = vi.fn();
        expect(() => track('tok', baseOptions({ window: w.win, onError }))).not.toThrow();
        expect(onError.mock.calls.map((c) => (c[0] as Error).message)).not.toContain(
          'host document blocked',
        );
      } finally {
        delete (globalThis as { document?: unknown }).document;
        vi.unstubAllGlobals();
      }
    });

    it('with no window at all, a blocked host document never fails launch and is reported', () => {
      stubSensors();
      try {
        Object.defineProperty(globalThis, 'document', {
          get(): never {
            throw new Error('host document blocked');
          },
          configurable: true,
        });
        const onError = vi.fn();
        expect(() => track('tok', baseOptions({ onError }))).not.toThrow();
        expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toContain(
          'host document blocked',
        );
      } finally {
        delete (globalThis as { document?: unknown }).document;
        vi.unstubAllGlobals();
      }
    });

    it('a window whose self/top relationship is unreadable counts as the top frame and is reported', () => {
      stubSensors();
      try {
        const w = fakeWin();
        for (const key of ['self', 'top']) {
          Object.defineProperty(w.win, key, {
            get(): never {
              throw new Error(`${key} blocked`);
            },
            configurable: true,
          });
        }
        const onError = vi.fn();
        expect(() => track('tok', baseOptions({ window: w.win, onError }))).not.toThrow();
        const messages = onError.mock.calls.map((c) => (c[0] as Error).message);
        expect(messages).toContain('top blocked');
        // top frame: the full stack started, so the lifecycle listeners are attached
        expect(w.count('online', 'offline', 'orientationchange')).toBeGreaterThan(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('a systemMetricsSampler replaces the sensor traces', () => {
      stubSensors();
      try {
        const replaced = listeners({
          systemMetricsSampler: () => [{ name: 'wv_metric', value: 7 }],
        }).n();
        expect(replaced).toBe(3); // only the events source
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  const batteryGlobals = () => {
    const getBattery = vi.fn(() =>
      Promise.resolve({
        level: 1,
        charging: true,
        addEventListener() {},
        removeEventListener() {},
      }),
    );
    vi.stubGlobal('navigator', { getBattery });
    return getBattery;
  };
  const tracesOf = (fake: ReturnType<typeof fakeGlobal>) =>
    entriesOfType(fake.msgs(), 'traces.system').map(
      (e) => (e.p as unknown as { data: { name: string; value: unknown } }).data,
    );

  it('writes NO battery/charging: the native host owns them (C22), with or without a handshake reply', async () => {
    const fake = fakeGlobal();
    batteryGlobals();
    try {
      track('tok', baseOptions({ global: fake.global }));
      await new Promise((r) => setTimeout(r, 0));
      sendControl(fake.global, { session: 'native-1', config: { reportTrigger: false } }); // a reply that declares nothing
      await new Promise((r) => setTimeout(r, 0));
      expect(tracesOf(fake).filter((t) => t.name === 'battery' || t.name === 'charging')).toEqual(
        [],
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('streams battery/charging ({state}) from the browser battery producer once native declares it owns none of them', async () => {
    const fake = fakeGlobal();
    const getBattery = batteryGlobals();
    try {
      track('tok', baseOptions({ global: fake.global }));
      sendControl(fake.global, { config: { hostOwnedTraces: [] } }); // the handshake reply hands every name back
      await new Promise((r) => setTimeout(r, 0));
      expect(getBattery).toHaveBeenCalledTimes(1);
      const traces = tracesOf(fake);
      expect(traces).toContainEqual(expect.objectContaining({ name: 'battery', value: 100 }));
      expect(traces).toContainEqual(
        expect.objectContaining({ name: 'charging', value: { state: 3 } }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('native can declare a DIFFERENT owned set: only the names it lists are dropped (live, on the next value)', async () => {
    const fake = fakeGlobal();
    batteryGlobals();
    try {
      track('tok', baseOptions({ global: fake.global }));
      sendControl(fake.global, { config: { hostOwnedTraces: ['charging'] } }); // native owns charging only
      await new Promise((r) => setTimeout(r, 0));
      const names = tracesOf(fake).map((t) => t.name);
      expect(names).toContain('battery');
      expect(names).not.toContain('charging');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a malformed hostOwnedTraces leaves the built-in list in force', async () => {
    const fake = fakeGlobal();
    batteryGlobals();
    try {
      track('tok', baseOptions({ global: fake.global }));
      sendControl(fake.global, { config: { hostOwnedTraces: 'none' } });
      sendControl(fake.global, { config: { hostOwnedTraces: [7] } });
      await new Promise((r) => setTimeout(r, 0));
      expect(tracesOf(fake).some((t) => t.name === 'battery')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { maxRecordingTime: 2, refreshMs: 2000 }, // 0.5s clamped up to the 2s floor
    { maxRecordingTime: 20, refreshMs: 5000 }, // 20s/4 = 5s
  ])('refreshes the held battery trace after $refreshMs ms (recording window $maxRecordingTime s)', async ({
    maxRecordingTime,
    refreshMs,
  }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fake = fakeGlobal();
    vi.stubGlobal('navigator', {
      getBattery: () =>
        Promise.resolve({
          level: 1,
          charging: true,
          addEventListener() {},
          removeEventListener() {},
        }),
    });
    try {
      vi.setSystemTime(0);
      const ticks: Array<{ cb: () => void; ms: number }> = [];
      track(
        'tok',
        baseOptions({
          global: fake.global,
          maxRecordingTime,
          scheduler: {
            setInterval: (cb, ms) => {
              ticks.push({ cb, ms });
              return 0 as unknown as ReturnType<Scheduler['setInterval']>;
            },
            clearInterval: () => {},
          },
        } as Partial<BugseeWebViewLaunchOptions>),
      );
      sendControl(fake.global, { config: { hostOwnedTraces: [] } }); // battery is the host's by default
      await new Promise((r) => setTimeout(r, 0));
      const battery = () =>
        entriesOfType(fake.msgs(), 'traces.system').filter(
          (e) => (e.p as unknown as { data: { name: string } }).data.name === 'battery',
        ).length;
      const tick = () => {
        for (const t of ticks.filter((x) => x.ms === 1000)) t.cb();
      };
      expect(battery()).toBe(1);
      vi.setSystemTime(refreshMs - 1);
      tick();
      expect(battery()).toBe(1);
      vi.setSystemTime(refreshMs);
      tick();
      expect(battery()).toBe(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('a battery manager that throws after getBattery resolves reaches options.onError', async () => {
    const fake = fakeGlobal();
    const getBattery = vi.fn(() =>
      Promise.resolve({
        level: 1,
        charging: true,
        addEventListener() {
          throw new Error('battery add refused');
        },
        removeEventListener() {},
      }),
    );
    vi.stubGlobal('navigator', { getBattery });
    const onError = vi.fn();
    try {
      track('tok', baseOptions({ global: fake.global, onError }));
      await new Promise((r) => setTimeout(r, 0));
      expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toContain(
        'battery add refused',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('streams a logException as a crash ENTRY (always) but NO report trigger when the gate is off', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global }));
    await client.logException(new Error('boom-wv'));
    const crashes = entriesOfType(fake.msgs(), 'crash');
    expect(crashes.some((e) => JSON.stringify(e.p).includes('boom-wv'))).toBe(true); // incident in the timeline
    expect(fake.msgs().some((m) => m.k === 'report')).toBe(false); // no native bug opened (gate off)
  });

  it.each([
    [
      'JavaScriptCore (iOS WebView, recorded from jsc)',
      'applicationCode@https://app.example.com/main.js:12:30\nglobal code@https://app.example.com/main.js:20:11',
    ],
    [
      'SpiderMonkey (Firefox)',
      'applicationCode@https://app.example.com/main.js:12:30\nasync*go@https://app.example.com/main.js:20:11',
    ],
  ])('crash.json frames are parsed from a %s stack, not left empty', async (_engine, stack) => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global, reportTrigger: true }));
    const error = new Error('non-v8-stack');
    error.stack = stack;
    await client.logException(error);
    const report = fake.msgs().find((m): m is ReportMessage => m.k === 'report');
    const frames = (
      report?.p as unknown as {
        report: { crash: { exception: { frames: { data: { member: string } }[] } } };
      }
    ).report.crash.exception.frames;
    expect(frames[0]?.data.member).toBe('applicationCode');
    expect(frames).toHaveLength(2);
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

  it('detectHttpErrors: a 5xx fetch triggers a native report; off by default and for 4xx', async () => {
    // The interceptor wraps whatever `fetch` is at activation: switch the status through a variable.
    let status = 503;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status })),
    );
    try {
      const off = fakeGlobal();
      track('tok', baseOptions({ global: off.global, reportTrigger: true, carrier: {} }));
      await fetch('https://api.example.com/orders');
      expect(off.msgs().some((m) => m.k === 'report')).toBe(false); // option off

      const on = fakeGlobal();
      track(
        'tok',
        baseOptions({
          global: on.global,
          reportTrigger: true,
          detectHttpErrors: true,
          carrier: {},
        }),
      );
      status = 404;
      await fetch('https://api.example.com/orders');
      expect(on.msgs().some((m) => m.k === 'report')).toBe(false); // 4xx is not a server error
      status = 503;
      await fetch('https://api.example.com/orders');
      const report = on.msgs().find((m): m is ReportMessage => m.k === 'report');
      expect(JSON.stringify(report?.p)).toContain('HTTP 503');
    } finally {
      vi.unstubAllGlobals();
    }
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

  describe('obscuring', () => {
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

    it('does NOT declare `obscuring` when collection is already failing', () => {
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

    // `captureObscuring ?? true` made `0`, `''` and `null` (nullish aside) switch the masking OFF. It is a
    // PROTECTIVE option, so an invalid value keeps it ON (fail-on) and tells onError; only boolean false opts out.
    it.each([
      0,
      '',
      'false',
      'true',
      1,
      null,
    ])('captureObscuring=%j (invalid) keeps obscuring ON and reports', (bad) => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(5)] });
      const onError = vi.fn();
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          captureObscuring: bad as never,
          onError,
        }),
      );
      expect((fake.msgs()[0] as HelloMessage).caps).toContain('obscuring');
      expect(
        onError.mock.calls.filter((c) =>
          String((c[0] as Error).message).startsWith('captureObscuring must be a boolean'),
        ),
      ).toHaveLength(1);
    });

    it('captureObscuring=true / absent keep obscuring on without reporting', () => {
      for (const over of [{ captureObscuring: true }, {}]) {
        const fake = fakeGlobal();
        const onError = vi.fn();
        track(
          'tok',
          baseOptions({
            global: fake.global,
            document: fakeDomDocument().document as unknown as Document,
            onError,
            ...over,
          }),
        );
        expect((fake.msgs()[0] as HelloMessage).caps).toContain('obscuring');
        expect(onError).not.toHaveBeenCalled();
      }
    });

    it('a SUB-frame with an invalid captureObscuring still runs its composer (bubbles to the parent)', () => {
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(1)] });
      const win = fakeEventTarget();
      const parentPost = vi.fn();
      Object.assign(win.target, {
        self: win.target,
        top: { other: true },
        parent: { postMessage: parentPost },
      });
      track(
        'tok',
        baseOptions({
          document: dom.document as unknown as Document,
          window: win.target as unknown as WindowEvents,
          captureObscuring: 0 as never,
        }),
      );
      expect(parentPost).toHaveBeenCalled();
    });

    it('a SUB-frame does NOT declare `obscuring`/post to native, but BUBBLES its rects to the parent', () => {
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
    expect(second).not.toBe(first);
    expect(second.isLaunched()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a repeat launch can still report the route and view (the page-safe live half forwards them)', () => {
    const carrier = {};
    const opts = baseOptions({ carrier });
    track('tok', opts);
    const second = launch('tok', opts);
    second.setRoute('/r/:id');
    second.setView({ name: 'Detail' });
    expect(screenTrackerFor(carrier).currentRoute()).toBe('/r/:id');
    expect(screenTrackerFor(carrier).currentView()).toEqual({ name: 'Detail' });
  });

  it('a repeat launch cannot reach redaction, lifetime or the container', () => {
    // `launch` is a page global (the IIFE publishes `BugseeWebView.launch`, injected into the page
    // world), so a repeat call is a page-reachable request for the live client. Returning the real one
    // handed over `setNetworkEventFilter` — a capture tap that also disables the default sanitizer —
    // plus `stop()` and the DI container, which made moving the client off the carrier pointless.
    //
    // The previous version of this test asserted `second === first`, pinning exactly that.
    const onError = vi.fn();
    const opts = baseOptions({ onError });
    const first = track('tok', opts);
    const repeat = launch('tok', opts);

    const filter = vi.fn((e: unknown) => e) as never;
    const refused = (name: string): boolean =>
      onError.mock.calls.some(([e]) => e instanceof Error && e.message.includes(`\`${name}\``));

    // Asserted per method, not in bulk: an earlier version of this test CALLED each one and checked
    // nothing, so deleting `setNetworkEventFilter` from the blocked set — restoring the exact capture
    // tap this test exists to prevent — left it green.
    repeat.setNetworkEventFilter(filter);
    expect(refused('setNetworkEventFilter')).toBe(true);
    repeat.setLogEventFilter(filter);
    expect(refused('setLogEventFilter')).toBe(true);
    repeat.setBreadcrumbFilter(filter);
    expect(refused('setBreadcrumbFilter')).toBe(true);
    repeat.setReportHandler(filter);
    expect(refused('setReportHandler')).toBe(true);
    expect(() => repeat.getService({ name: 'filters' } as never)).toThrow();
    expect(() => repeat.getServiceProvider({ name: 'filters' } as never)).toThrow();
    repeat.addService({ name: 'filters' } as never);
    expect(refused('addService')).toBe(true);
    repeat.registerExt('x' as never, {} as never);
    expect(refused('registerExt')).toBe(true);

    // The blocked setters are inert, not merely noisy: the real client never received the filter.
    expect(filter).not.toHaveBeenCalled();
    expect(first).not.toBe(repeat);
    // Capture entry points stay live — page script can already produce captured content by other means,
    // so refusing them would cost function without buying safety.
    expect(() => repeat.log('still allowed')).not.toThrow();
    expect(() => repeat.event('still allowed')).not.toThrow();
  });

  // a page must not gain control over REDACTION. Ending a blackout un-redacts the visual capture
  // and a lifecycle listener observes the session's internals; `startBlackout` only fails closed, so it stays.
  it('a repeat launch cannot end the blackout or install a lifecycle listener, but may still start one', () => {
    const onError = vi.fn();
    const carrier = {};
    const opts = baseOptions({ onError, carrier });
    const first = track('tok', opts);
    const events: string[] = [];
    first.startBlackout();
    const repeat = launch('tok', opts);
    const said = (n: string): boolean =>
      onError.mock.calls.some(([e]) => e instanceof Error && e.message.includes(`\`${n}\``));

    repeat.endBlackout();
    expect(said('endBlackout')).toBe(true);
    expect(first.isBlackout()).toBe(true); // the blackout was NOT lifted from the page
    expect(getCarrierBlackout(carrier)).toBe(true);

    repeat.setLifecycleEventsListener(((type: string) => events.push(type)) as never);
    expect(said('setLifecycleEventsListener')).toBe(true);
    first.endBlackout(); // the owner may still end it: the page's listener must not hear anything
    first.startBlackout();
    expect(events).toEqual([]);

    first.endBlackout();
    repeat.startBlackout(); // fails closed: allowed
    expect(first.isBlackout()).toBe(true);
    expect(said('startBlackout')).toBe(false);
  });

  // the facade is built from an explicit allow-list, and the lifecycle slot is not page-writable.
  it('page script cannot install a lifecycle listener through the carrier', () => {
    const carrier = {};
    const owner: string[] = [];
    const first = track(
      'tok',
      baseOptions({ carrier, lifecycleEventsListener: (type) => owner.push(type) }),
    );
    const page = vi.fn();
    const view = (carrier as { __BUGSEE__: Record<string, Record<string, unknown>> }).__BUGSEE__[
      BUGSEE_SDK_VERSION
    ] as Record<string, unknown>;
    try {
      view.lifecycleListener = page; // what `window.__BUGSEE__[v].lifecycleListener = fn` does
    } catch {
      // strict mode throws; sloppy page script is silently ignored — either way nothing is installed
    }
    expect(view.lifecycleListener).toBeUndefined();
    owner.length = 0;
    first.startBlackout();
    first.endBlackout();
    expect(page).not.toHaveBeenCalled();
    expect(owner).toContain(LifecycleEvents.BlackoutStarted); // the legitimate host listener still hears
  });

  it('the repeat-launch client is an allow-list: no internal-client brand, no emit, no unstripped wire methods', async () => {
    const onError = vi.fn();
    const opts = baseOptions({ onError });
    track('tok', opts);
    const repeat = launch('tok', opts) as unknown as Record<string | symbol, unknown>;
    expect(Reflect.ownKeys(repeat).filter((k) => typeof k === 'symbol')).toEqual([]);
    expect(Object.getOwnPropertySymbols(repeat)).toEqual([]);
    expect(repeat.emitLifecycleEvent).toBeUndefined();
    expect(repeat.deferBlackoutStarted).toBeUndefined();
    // the page-facing upload strips the wire `trigger`: a forged code_dialog source is not reachable
    const brand = Symbol.for('com.bugsee.internal-client');
    expect(repeat[brand]).toBeUndefined();
    // still a working client for the allowed surface
    expect(() => (repeat.log as (m: string) => void)('x')).not.toThrow();
    // methods the old spread passed live are refused now (no capture-provider/ span-filter/ launch control)
    for (const name of [
      'setSpanFilter',
      'addCaptureProvider',
      'addDetectionProvider',
      'ext',
      'launch',
    ]) {
      onError.mockClear();
      try {
        (repeat[name] as (...a: unknown[]) => unknown)({});
      } catch {
        // `ext` throws as well as reports
      }
      expect(
        onError.mock.calls.some(([e]) => e instanceof Error && e.message.includes(`\`${name}\``)),
      ).toBe(true);
    }
    await expect((repeat.upload as () => Promise<unknown>)()).resolves.toBeDefined();
  });

  it('a repeat launch cannot end or drain the session the embedder owns', async () => {
    // `stop()` from page script is a kill switch on the host app's capture; `flush()` forces an upload
    // the embedder did not ask for. Both report and return false rather than throwing, so an embedder who
    // genuinely double-launched sees a diagnosable no-op instead of an exception.
    const onError = vi.fn();
    const opts = baseOptions({ onError });
    const first = track('tok', opts);
    const repeat = launch('tok', opts);

    await expect(repeat.stop()).resolves.toBe(false);
    await expect(repeat.flush()).resolves.toBe(false);
    const said = (n: string): boolean =>
      onError.mock.calls.some(([e]) => e instanceof Error && e.message.includes(`\`${n}\``));
    expect(said('stop')).toBe(true);
    expect(said('flush')).toBe(true);
    // The real session is still running — the refusal was not merely cosmetic.
    expect(first.isLaunched()).toBe(true);
  });

  it('a repeat launch from a FOREIGN module copy returns an inert client, never undefined', () => {
    // Two copies of @bugsee/webview can end up in one page (a host bundle and an injected one). The copy
    // that did not perform the launch sees an occupied carrier but holds no client of its own, and the
    // carrier deliberately no longer stores one — it stores a resolver-only facade. Handing back
    // `undefined as Bugsee` there would make the caller's FIRST method call a TypeError inside the host
    // page. An inert client is diagnosable; a crash in someone else's page is not.
    const carrier: Record<string, unknown> = {};
    setCarrierClient({ isLaunched: () => true } as never, carrier);
    setCarrierStatus(BugseeStatus.Launched, carrier);
    const onError = vi.fn();
    const inert = launch('tok', baseOptions({ carrier, onError })) as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;

    expect(inert).toBeDefined();
    // Both facts are reported, because they are different diagnoses: "you launched twice" points at the
    // call site, "another module copy owns the session" points at the bundle. A count assertion alone
    // would pass with either one missing.
    const messages = onError.mock.calls.map(([e]) => (e as Error).message);
    expect(messages.some((m) => m.includes('more than once'))).toBe(true);
    expect(messages.some((m) => m.includes('another module copy'))).toBe(true);
    expect(inert.isLaunched?.()).toBe(true);

    // Every method the facade declares is present and safe to call. A missing one is not a cosmetic gap:
    // it is the TypeError this fallback exists to prevent, so the whole surface is exercised.
    const surface = [
      'launch',
      'log',
      'event',
      'trace',
      'addBreadcrumb',
      'setUserIdentifier',
      'clearUserIdentifier',
      'setAttribute',
      'clearAttribute',
      'clearAllAttributes',
      'setNetworkEventFilter',
      'setLogEventFilter',
      'setBreadcrumbFilter',
      'setReportHandler',
    ];
    for (const name of surface) {
      expect(typeof inert[name], name).toBe('function');
      expect(() => inert[name]?.('x' as never), name).not.toThrow();
    }
    expect(inert.getUserIdentifier?.()).toBeNull();
    expect(inert.getAttribute?.('k')).toBeUndefined();
    expect(inert.getAllAttributes?.()).toEqual({});
  });

  // the inert client lacked `startBlackout`/`endBlackout`/`isBlackout`/`getStatus`/
  // `setLifecycleEventsListener` (and whatever else the real client grew): the TypeError this fallback exists to
  // prevent. The whole surface of a real client must exist, and the blackout/status ones must report, not throw.
  it('the inert client has EVERY method of a real client; blackout/status/listener calls report through onError', async () => {
    const carrier: Record<string, unknown> = {};
    setCarrierClient({ isLaunched: () => true } as never, carrier);
    setCarrierStatus(BugseeStatus.Launched, carrier);
    const onError = vi.fn();
    const inert = launch('tok', baseOptions({ carrier, onError })) as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const real = track('tok', baseOptions({ carrier: {} })) as unknown as Record<string, unknown>;
    const missing = Object.keys(real).filter(
      (key) => typeof real[key] === 'function' && typeof inert[key] !== 'function',
    );
    expect(missing).toEqual([]);

    onError.mockClear();
    expect(() => inert.startBlackout?.()).not.toThrow();
    expect(() => inert.endBlackout?.()).not.toThrow();
    expect(inert.isBlackout?.()).toBe(false);
    expect(inert.getStatus?.()).toBe(BugseeStatus.Launched); // the owner's published state; consistent with isLaunched()
    expect(() => inert.setLifecycleEventsListener?.(() => {})).not.toThrow();
    expect(inert.getLaunchOptions?.()).toEqual({});
    expect(inert.getHostLaunchOptions?.()).toEqual({});
    expect(() => inert.setSpanFilter?.(() => null)).not.toThrow();
    expect(() => inert.notify?.('title')).not.toThrow();
    expect(() => inert.registerExt?.('performance', {})).not.toThrow();
    expect(() => inert.addService?.({})).not.toThrow();
    expect(() => inert.addCaptureProvider?.({})).not.toThrow();
    expect(() => inert.addDetectionProvider?.({})).not.toThrow();
    expect(inert.prepareUpload?.()).toBeNull();
    expect(() => inert.ext?.('performance')).toThrow(/not available/);
    expect(() => inert.getService?.({})).toThrow(/not available/);
    expect(() => inert.getServiceProvider?.({})).toThrow(/not available/);
    inert.startBlackout?.(); // a repeat is not re-reported
    const messages = onError.mock.calls.map(([e]) => (e as Error).message);
    for (const method of [
      'startBlackout',
      'endBlackout',
      'setLifecycleEventsListener',
      'setSpanFilter',
      'notify',
      'registerExt',
      'addService',
      'addCaptureProvider',
      'addDetectionProvider',
      'prepareUpload',
      'ext',
      'getService',
      'getServiceProvider',
    ]) {
      expect(
        messages.filter((m) => m.includes(`\`${method}\``)),
        method,
      ).toHaveLength(1);
    }
    await expect(inert.logException?.(new Error('x'))).resolves.toEqual({ ok: false });
    await expect(inert.upload?.()).resolves.toEqual({ ok: false });
    expect(
      onError.mock.calls
        .map(([e]) => (e as Error).message)
        .filter((m) => /logException|upload/.test(m)),
    ).toHaveLength(2);
  });

  it('the inert client reads the shared carrier: isBlackout() is the process flag, getStatus() follows the owner', () => {
    const carrier: Record<string, unknown> = {};
    const owner = { isLaunched: () => true } as never;
    setCarrierClient(owner, carrier);
    setCarrierStatus(BugseeStatus.Launched, carrier);
    const inert = launch('tok', baseOptions({ carrier }));
    expect(inert.isBlackout()).toBe(false);
    setCarrierBlackout(true, carrier);
    expect(inert.isBlackout()).toBe(true);
    setCarrierBlackout(false, carrier);
    expect(inert.isBlackout()).toBe(false);
    expect(inert.getStatus()).toBe(BugseeStatus.Launched);
    expect(inert.isLaunched()).toBe(true);
    setCarrierStatus(BugseeStatus.Stopping, carrier);
    expect(inert.getStatus()).toBe(BugseeStatus.Stopping);
    expect(inert.isLaunched()).toBe(false);
    clearCarrierClient(owner, carrier);
    setCarrierStatus(BugseeStatus.Stopped, carrier);
    expect(inert.getStatus()).toBe(BugseeStatus.Stopped); // the owner has stopped: no more "Launched"
  });

  it('a real WebView launch publishes Launched on the carrier and Stopped after stop()', async () => {
    const carrier = {};
    const client = launch('tok', baseOptions({ carrier }));
    expect(getCarrierStatus(carrier)).toBe(BugseeStatus.Launched);
    await client.stop();
    expect(getCarrierStatus(carrier)).toBe(BugseeStatus.Stopped);
  });

  it('the inert client refuses to end a session it does not own', async () => {
    const carrier: Record<string, unknown> = {};
    setCarrierClient({ isLaunched: () => true } as never, carrier);
    const inert = launch('tok', baseOptions({ carrier }));
    await expect(inert.stop()).resolves.toBe(false);
    await expect(inert.flush()).resolves.toBe(false);
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
    // design, so it persists and goes inert instead.
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
    // The binding is non-configurable so it cannot be removed; INERT is the teardown
    // state instead — which is the stronger property anyway, since a removable global was replaceable.
    expect(fake.global.__bugsee_bridge?.snapshot()).toBe('[]');
    const again = track('tok', baseOptions({ global: fake.global, carrier }));
    expect(again).not.toBe(client); // a fresh client (carrier slot was cleared)
    expect(again.isLaunched()).toBe(true);
  });

  describe('redaction', () => {
    it('streams log entries un-redacted (red:false) when no JS filter is set — native redacts', () => {
      const fake = fakeGlobal();
      track('tok', baseOptions({ global: fake.global }));
      console.log('redact-none');
      const log = entriesOfType(fake.msgs(), 'log').find((e) =>
        JSON.stringify(e.p).includes('redact-none'),
      );
      expect(log?.red).toBe(false);
    });

    it('RUNS the log filter (scrubs content) AND stamps red:true (run⟺red)', () => {
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

  it('launch survives a sub-frame whose `parent.postMessage` throws', () => {
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

// The control global's BINDING is closed, not just its object.
//
// `global.__bugsee_bridge = Object.freeze({…})` froze the OBJECT while leaving the BINDING
// `{writable:true, configurable:true}`. A page script replaced the whole binding with
// `{control(){}, snapshot(){return '[]'}}`; native's frame-capture pull then returned no rects while real
// secure areas existed, so password / cc-* fields rendered legibly in the captured video — and native had
// already stood its own masking script down, because declaring the `obscuring` capability is what tells it
// to. The same binding can be used the other way: any script could call `control('{…"command":
// "stop"}')` and tear the SDK down silently.
//
// Closing the binding needs NO protocol change, which is why it ships ahead of the token work.
describe('the __bugsee_bridge binding is not replaceable', () => {
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
    // already fixed once.
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
    // control message (the report gate flipping on), not by the call not throwing: an inert no-op also
    // does not throw, so that would assert nothing.
    await again.logException(new Error('while-gated'));
    expect(fake.msgs().some((m) => m.k === 'report')).toBe(false);
    sendControl(fake.global, { config: { reportTrigger: true } });
    await again.logException(new Error('after-ungating'));
    expect(fake.msgs().filter((m) => m.k === 'report')).toHaveLength(1);
  });
});

// End to end through the real launch: the token is published on `hello`, and once
// native proves it knows it, the page can no longer drive the SDK. The unit tests in
// host-bridge-control.test.ts cover the state machine; these assert the WIRING, which is what a page script
// actually meets.
describe('the control channel authenticates end to end', () => {
  const tokenOf = (fake: ReturnType<typeof fakeGlobal>): string => {
    const hello = fake.msgs().find((m): m is HelloMessage => m.k === 'hello');
    return (hello as unknown as { tok: string }).tok;
  };

  it('never puts a NATIVE-minted nonce on the wire, and mints no token of its own', () => {
    // The whole value of a native-minted secret is that the page never sees it. Publishing it in
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
    // The only assertions here were "non-empty string" and "different per launch", both of
    // which a module-level counter (`bugsee-1`, `bugsee-2`, …) satisfies. Nothing stands between the page
    // and the control channel except the token being unguessable, and `admits` has no attempt limit — so
    // the FORMAT is pinned, and control-token.test.ts pins the source of the bytes.
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    expect(tokenOf(fake)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('withholds the token when no native sink is attached yet', () => {
    // With no sink, `hello` goes into the host bridge's backlog and is delivered to
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

describe('the control global when the page got there first', () => {
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

// Three defects in the same seam: the slot, the latch, and teardown.
describe('the control surface fails closed and cannot be reset by the page', () => {
  const preOwn = (global: object): void => {
    Object.defineProperty(global, '__bugsee_bridge', {
      value: { control: () => {}, snapshot: () => '[]' },
      configurable: false,
    });
  };

  it('does NOT declare `obscuring` when the control binding could not be installed', () => {
    // `caps` was computed from the obscuring probe alone. A page script that pre-owns the name makes
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
    // The slot is shared per-global, and stop reverted it with no ownership check. A framework
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

  it('the page-reachable launch() ignores every injectable seam, so a fresh global/carrier cannot look like a first launch', async () => {
    const fake = fakeGlobal();
    const client = publicLaunch('tok', {
      global: fake.global,
      carrier: {},
      captureNetwork: false,
    } as BugseeWebViewLaunchOptions);
    // The seam global was never used: no handshake went to it.
    expect(fake.msgs().filter((m) => m.k === 'hello')).toHaveLength(0);
    expect(() => publicLaunch('tok', null as unknown as BugseeWebViewLaunchOptions)).not.toThrow();
    await client.stop();
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__; // this launch used the REAL globalThis carrier
  });

  it('a seam planted on Object.prototype cannot re-enter through the page-reachable launch()', async () => {
    const fake = fakeGlobal();
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.global = fake.global;
    proto.carrier = {};
    try {
      const client = publicLaunch('tok', { captureNetwork: false });
      expect(fake.msgs().filter((m) => m.k === 'hello')).toHaveLength(0);
      await client.stop();
    } finally {
      delete proto.global;
      delete proto.carrier;
      delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
    }
  });

  it('accessor plants on Object.prototype (getter+setter, getter-only) and inherited non-seam options do not re-enter', async () => {
    const fake = fakeGlobal();
    const proto = Object.prototype as unknown as Record<string, unknown>;
    const seen: string[] = [];
    Object.defineProperty(Object.prototype, 'global', {
      get: () => fake.global,
      set: () => {},
      configurable: true,
    });
    Object.defineProperty(Object.prototype, 'carrier', { get: () => ({}), configurable: true });
    Object.defineProperty(Object.prototype, 'lifecycleEventsListener', {
      get: () => (type: string) => seen.push(type),
      configurable: true,
    });
    try {
      const client = publicLaunch('tok', { captureNetwork: false });
      expect(fake.msgs().filter((m) => m.k === 'hello')).toHaveLength(0);
      expect(seen).toEqual([]);
      await client.stop();
    } finally {
      delete proto.global;
      delete proto.carrier;
      delete proto.lifecycleEventsListener;
      delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
    }
  });

  it('a page-supplied fresh carrier (or global) cannot mint a second live client', () => {
    const fake = fakeGlobal();
    const first = track('tok', baseOptions({ global: fake.global, carrier: {} }));
    expect(first).toBeDefined();
    const viaCarrier = launch(
      'tok',
      baseOptions({ global: fake.global, carrier: {} }),
    ) as unknown as Record<string | symbol, unknown>;
    expect(fake.msgs().filter((m) => m.k === 'hello')).toHaveLength(1);
    expect(Object.getOwnPropertySymbols(viaCarrier)).toEqual([]);
    expect(typeof viaCarrier.stop).toBe('function');
    const sameCarrier = {};
    const firstOnShared = track(
      'tok2',
      baseOptions({ global: fakeGlobal().global, carrier: sameCarrier }),
    );
    expect(firstOnShared).toBeDefined();
    const viaGlobal = launch(
      'tok2',
      baseOptions({ global: fakeGlobal().global, carrier: sameCarrier }),
    ) as unknown as Record<string | symbol, unknown>;
    expect(Object.getOwnPropertySymbols(viaGlobal)).toEqual([]);
  });

  it('a page-forced RELAUNCH cannot un-latch the control channel', async () => {
    // `authenticated` lived in the per-launch closure, and `BugseeWebView.launch` is a page global
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
    const relaunched = launch(
      'tok',
      baseOptions({ global: fake.global, carrier, onError }),
    ) as unknown as Record<string | symbol, unknown>;
    expect(
      fake.msgs().filter((m) => m.k === 'hello').length,
      'the module-private launched marker must refuse the relaunch (no second handshake)',
    ).toBe(1);
    // ...and what it hands back is the RESTRICTED facade, never the live client (page-reachable `launch`).
    expect(Object.getOwnPropertySymbols(relaunched)).toEqual([]);
    expect(relaunched[Symbol.for('com.bugsee.internal-client')]).toBeUndefined();
    onError.mockClear();
    (relaunched.setNetworkEventFilter as (f: unknown) => void)(() => null);
    (relaunched.setReportHandler as (f: unknown) => void)(() => null);
    await expect((relaunched.stop as () => Promise<boolean>)()).resolves.toBe(false);
    expect(onError.mock.calls.map(([e]) => (e as Error).message).join('\n')).toMatch(
      /`setNetworkEventFilter`[\s\S]*`setReportHandler`[\s\S]*`stop`/,
    );

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
//    nothing from a hello and mints its own secret, and `caps` decides nothing.)
//  - A sub-frame can never RECEIVE control: `evaluateJavascript` targets the top frame, so a sub-frame
//    that opened a session cannot be paused, flushed or stopped.
//  - Each frame keeps its own `seq` counter from 0, so entries from different frames collide in ordering.
//  - The design keeps Bugsee OUT of third-party content: running full capture in
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
describe('secure views from a SUB-frame still reach native (the frame chain, through launch)', () => {
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

describe('webview launch lifecycle', () => {
  it('a stale stop() leaves a NEWER launch its carrier slot and its repeat-launch handle', async () => {
    const fake = fakeGlobal();
    const carrier = {};
    const onError = vi.fn();
    const a = launch('tok', baseOptions({ global: fake.global, carrier }));
    await a.stop();
    const b = track('tok', baseOptions({ global: fake.global, carrier, onError }));
    expect(getCarrierClient(carrier)).toBeDefined();

    await a.stop(); // the stale handle fires again

    expect(
      getCarrierClient(carrier),
      'a stale stop() evicted the newer carrier slot',
    ).toBeDefined();
    // …and a repeat launch still gets the RESTRICTED live client, not an inert one
    const repeat = launch('tok', baseOptions({ global: fake.global, carrier, onError }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(repeat.isLaunched()).toBe(b.isLaunched());
    expect(repeat.isLaunched()).toBe(true);
  });

  it('the owning stop() still clears the slot', async () => {
    const carrier = {};
    const a = launch('tok', baseOptions({ carrier }));
    expect(getCarrierClient(carrier)).toBeDefined();
    await a.stop();
    expect(getCarrierClient(carrier)).toBeUndefined();
  });

  it('client.launch() on a stopped WebView client is refused and says so', async () => {
    const onError = vi.fn();
    const carrier = {};
    const client = launch('tok', baseOptions({ carrier, onError }));
    await client.stop();
    client.launch();
    expect(client.isLaunched()).toBe(false);
    expect(getCarrierClient(carrier)).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/) }),
    );
  });

  it('the lifecycleEventsListener option sees Launching and Launched', () => {
    const seen: string[] = [];
    track('tok', baseOptions({ lifecycleEventsListener: (type) => seen.push(type) }));
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('without a carrier option the WebView carrier is globalThis; a listener set BEFORE launch is page-reachable, so it is discarded at the seal', async () => {
    // The carrier is page-writable until sealed, so a pre-launch listener cannot be told from a planted one.
    const seen: string[] = [];
    setProcessLifecycleEventsListener((type) => seen.push(type));
    const { carrier: _omitted, ...withoutCarrier } = baseOptions();
    const client = launch('tok', withoutCarrier);
    expect(seen).toEqual([]);
    await client.stop();
    setProcessLifecycleEventsListener(null);
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('ReportHandler.after runs for a WebView report (an injected report pipeline), before it crosses the bridge', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global }));
    const order: string[] = [];
    client.setReportHandler({
      after: (request) => {
        order.push(`after:${fake.msgs().filter((m) => m.k === 'entry' && m.t === 'crash').length}`);
        request.report.labels = ['from-after'];
      },
    });
    await client.logException(new Error('boom-after'));
    expect(order).toEqual(['after:0']); // once, and BEFORE the crash entry reached native
    expect(entriesOfType(fake.msgs(), 'crash').length).toBeGreaterThan(0);
  });
});
