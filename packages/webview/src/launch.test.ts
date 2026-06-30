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
const SECURE_INPUT =
  'input[type=password]:not(.bugsee-show), input[autocomplete*="cc-"]:not(.bugsee-show)';

const inertScheduler: Scheduler = {
  setInterval: () => 0 as unknown as ReturnType<Scheduler['setInterval']>,
  clearInterval: () => {},
};

// A fake window/document event target: records listeners + dispatches synthetic events (mirrors the browser tier).
function fakeEventTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target = {
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
  // The default-global test sets globalThis.__bugsee_bridge; fully remove it so no own-property leaks.
  delete (globalThis as { __bugsee_bridge?: unknown }).__bugsee_bridge;
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

  it('streams a captured console log across the bridge as a log entry', () => {
    const fake = fakeGlobal();
    track('tok', baseOptions({ global: fake.global }));
    console.log('webview-marker-7');
    const entries = fake.msgs().filter((m): m is EntryMessage => m.k === 'entry');
    const log = entries.find((e) => e.t === 'log' && e.p.includes('webview-marker-7'));
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
    expect(events.some((e) => e.p.includes('process_started'))).toBe(true);
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
    expect(events.some((e) => e.p.includes('click'))).toBe(true);
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
    expect(traces.some((e) => e.p.includes('wv_metric'))).toBe(true);
  });

  it('streams a logException as a crash ENTRY (always) but NO report trigger when the gate is off (D5)', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global }));
    await client.logException(new Error('boom-wv'));
    const crashes = entriesOfType(fake.msgs(), 'crash');
    expect(crashes.some((e) => e.p.includes('boom-wv'))).toBe(true); // incident in the timeline
    expect(fake.msgs().some((m) => m.k === 'report')).toBe(false); // no native bug opened (gate off)
  });

  it('ALSO emits a report trigger (crash, carrying the incident) for a logException when on', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global, reportTrigger: true }));
    await client.logException(new Error('kaboom-wv'));
    expect(entriesOfType(fake.msgs(), 'crash').some((e) => e.p.includes('kaboom-wv'))).toBe(true);
    const report = fake.msgs().find((m): m is ReportMessage => m.k === 'report');
    expect(report?.t).toBe('crash');
    expect(report?.p).toContain('kaboom-wv'); // the report carries the incident, not an empty trigger
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
    expect(entriesOfType(fake.msgs(), 'crash').some((e) => e.p.includes('detected-wv'))).toBe(true);
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
    expect(entriesOfType(fake.msgs(), 'crash').some((e) => e.p.includes('rejected-wv'))).toBe(true);
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
    expect(entriesOfType(fake.msgs(), 'log').some((e) => e.p.includes('while-paused-wv'))).toBe(
      false,
    ); // dropped while paused
    sendControl(fake.global, { command: 'resume' });
    console.log('after-resume-wv');
    expect(entriesOfType(fake.msgs(), 'log').some((e) => e.p.includes('after-resume-wv'))).toBe(
      true,
    ); // streaming again
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
      expect(hello.caps).toContain('obscuring'); // tells native to drop its legacy masking script
    });

    it('does NOT declare `obscuring` when there is no DOM (native keeps legacy masking)', () => {
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

    it('does NOT declare `obscuring` in a SUB-frame (window.top !== window.self) — native keeps legacy', () => {
      const fake = fakeGlobal();
      const dom = fakeDomDocument({ [SECURE_INPUT]: [secureEl(1)] });
      const win = fakeEventTarget();
      // A sub-frame: top is some OTHER window, not self → obscuring must not run/declare here.
      Object.assign(win.target, { self: win.target, top: { other: true } });
      track(
        'tok',
        baseOptions({
          global: fake.global,
          document: dom.document as unknown as Document,
          window: win.target as unknown as WindowEvents,
        }),
      );
      expect((fake.msgs()[0] as HelloMessage).caps).not.toContain('obscuring');
      expect(fake.global.__bugsee_bridge?.snapshot()).toBe('[]'); // no obscuring channel in a sub-frame
      dom.emit('focus');
      expect(fake.msgs().some((m) => m.k === 'secure')).toBe(false); // not tracking in a sub-frame
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
        .find((e) => e.p.includes('seq-before-secure'));
      const secure = fake.msgs().find((m): m is SecureMessage => m.k === 'secure');
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
      expect(secure?.p).toBe(
        JSON.stringify([{ type: 'text', top: 10, left: 11, bottom: 12, right: 13 }]),
      );
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
      expect(secure.at(-1)?.p).toBe(
        JSON.stringify([{ type: 'text', top: 1, left: 2, bottom: 3, right: 4 }]),
      );
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
    // real tick timer + globalThis.__bugsee_bridge.
    const client = track('tok', { captureNetwork: false, carrier: {} });
    expect(client.isLaunched()).toBe(true);
    expect(typeof (globalThis as { __bugsee_bridge?: unknown }).__bugsee_bridge).toBe('object');
  });

  it('stop() posts a bye, clears the carrier + removes __bugsee_bridge so a later launch starts fresh', async () => {
    const fake = fakeGlobal();
    const carrier = {};
    const client = launch('tok', baseOptions({ global: fake.global, carrier }));
    await client.stop();
    expect(fake.msgs().some((m) => m.k === 'bye')).toBe(true); // teardown signalled to native
    expect(fake.global.__bugsee_bridge).toBeUndefined(); // control global removed
    const again = track('tok', baseOptions({ global: fake.global, carrier }));
    expect(again).not.toBe(client); // a fresh client (carrier slot was cleared)
    expect(again.isLaunched()).toBe(true);
  });
});
