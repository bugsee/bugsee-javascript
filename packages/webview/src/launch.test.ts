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
} from './protocol';

type AnyMsg = HelloMessage | EntryMessage | ReportMessage | BatchMessage | ByeMessage;

// A fake WebView global: the native `@JavascriptInterface` post sink + the slot the launch sets `__bugsee_bridge`.
function fakeGlobal() {
  const posted: string[] = [];
  const global: {
    BugseeBridge: { post(raw: string): void };
    __bugsee_bridge?: { control(raw: string): void };
  } = { BugseeBridge: { post: (r) => posted.push(r) } };
  return { global, msgs: (): AnyMsg[] => posted.map((r) => JSON.parse(r) as AnyMsg) };
}

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
    expect(hello.caps).toEqual(expect.arrayContaining(['log', 'network']));
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
    track('tok', baseOptions({ global: fake.global, document: doc.target as unknown as Document }));
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

  it('ALSO emits a report trigger for a logException when reportTrigger is on', async () => {
    const fake = fakeGlobal();
    const client = track('tok', baseOptions({ global: fake.global, reportTrigger: true }));
    await client.logException(new Error('kaboom-wv'));
    expect(entriesOfType(fake.msgs(), 'crash').length).toBeGreaterThan(0); // still streams the entry
    expect(fake.msgs().some((m) => m.k === 'report')).toBe(true); // native opens a bug
  });

  it('wires window error detection — a window error streams a crash entry', () => {
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
    expect(entriesOfType(fake.msgs(), 'crash').length).toBeGreaterThan(0); // detection → report path streamed
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
