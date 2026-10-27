import type { Bugsee, BugseeLaunchOptions } from '@bugsee/browser';
import {
  ELECTRON_RENDERER_HOST_OWNED_TRACES,
  isTraceSuppression,
  type TraceSuppression,
} from '@bugsee/capture';
import {
  BlackoutToken,
  type CaptureStore,
  createBlackoutState,
  resolveFailOnBoolean,
  type StoredEntry,
  setCarrierBlackout,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchRenderer, resolveRendererBridge, resolveRendererPost } from './launch-renderer';
import type { BugseeElectronBridge } from './preload-bridge';
import { decodeStreamEntry, encodeControl, isHello } from './protocol';

/** A fake browser launchCore that records the options it was called with + returns a stub client. */
function fakeLaunch() {
  const blackout = createBlackoutState();
  const lifecycle: string[] = [];
  const client = {
    stop: vi.fn(() => Promise.resolve(true)),
    flush: vi.fn(() => Promise.resolve(true)),
    getService: vi.fn((token: unknown) => (token === BlackoutToken ? blackout : undefined)),
    // What the real client does: refused while not launched; the core state change; events from the
    // state change unless it is silent.
    isLaunched: () => true,
    // The core client's own methods: start is refused while not launched (end is allowed).
    startBlackout: () => {
      if (client.isLaunched()) blackout.start();
    },
    endBlackout: () => blackout.end(),
    isBlackout: () => blackout.isActive(),
    emitLifecycleEvent: (type: string) => lifecycle.push(type.replace(/^.*Blackout/, '')),
  } as unknown as Bugsee;
  // The real client emits BlackoutStarted/Ended for non-silent state changes.
  blackout.onChange((active) => {
    if (!blackout.isChangeSilent()) lifecycle.push(active ? 'Started' : 'Ended');
  });
  let received: { appToken: string; options: BugseeLaunchOptions } | undefined;
  const launch = vi.fn(async (appToken: string, options: BugseeLaunchOptions) => {
    received = { appToken, options };
    // What the real @bugsee/browser launch does with its options: dark BEFORE any provider starts; the hold
    // is silent, an explicit startInBlackout announces itself after launch.
    const was = blackout.isActive();
    const startDark = resolveFailOnBoolean(options.startInBlackout, false); // the browser's normaliser
    if (options.holdBlackout === true || startDark) {
      blackout.start({ silent: true });
    }
    if (startDark && !was) lifecycle.push('Started');
    return { client, internals: undefined };
  });
  return {
    launch: launch as never,
    client,
    blackout,
    lifecycle,
    get received() {
      return received;
    },
  };
}

/** The least a launched renderer client must offer for launchRenderer's blackout wiring to run. */
function minimalClient(): Bugsee {
  const blackout = createBlackoutState();
  return {
    stop: () => Promise.resolve(true),
    getService: (token: unknown) => (token === BlackoutToken ? blackout : undefined),
    isLaunched: () => true,
    startBlackout: () => {},
    endBlackout: () => {},
    emitLifecycleEvent: () => {},
  } as unknown as Bugsee;
}

/** A fake renderer↔main bridge that records posts/hellos and holds the control handler for driving. */
function fakeBridge() {
  const posted: string[] = [];
  const hellos: string[] = [];
  let control: ((raw: string) => void) | undefined;
  const bridge: BugseeElectronBridge = {
    post: (raw) => posted.push(raw),
    sendHello: (raw) => hellos.push(raw),
    onControl: (handler) => {
      control = handler;
    },
  };
  return {
    bridge,
    posted,
    hellos,
    drive(raw: string): void {
      control?.(raw);
    },
  };
}

// The one-instance-per-page slot lives on globalThis so a hot-reloaded module sees it; every test starts
// from an empty page.
const RENDERER_SLOT = Symbol.for('bugsee.electron.renderer');
afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[RENDERER_SLOT];
});

describe('launchRenderer', () => {
  it('runs the browser launch with a streaming captureStore injected + forwards options', async () => {
    const f = fakeLaunch();
    const client = await launchRenderer('tok', { launch: f.launch, post: () => {}, replay: true });

    expect(client).toBe(f.client);
    expect(f.received?.appToken).toBe('tok');
    expect(f.received?.options.replay).toBe(true); // browser options forwarded
    // a CaptureStore was injected (not the caller's business — `post`/`launch` are stripped)
    const store = f.received?.options.captureStore as CaptureStore;
    expect(typeof store.add).toBe('function');
    expect('post' in (f.received?.options ?? {})).toBe(false);
    expect('launch' in (f.received?.options ?? {})).toBe(false);
  });

  it('tells the browser launch which names the host owns (displays, capture, ram_js_heap_*: main writes them) as a LIVE suppression, and a caller cannot switch that back off', async () => {
    const f = fakeLaunch();
    await launchRenderer('tok', {
      launch: f.launch,
      post: () => {},
      hostOwnedTraces: [],
    } as never);
    const owned = f.received?.options.hostOwnedTraces as unknown as TraceSuppression;
    expect(isTraceSuppression(owned)).toBe(true);
    for (const name of ELECTRON_RENDERER_HOST_OWNED_TRACES) expect(owned.has(name)).toBe(true);
    expect(owned.has('battery')).toBe(false);
  });

  it('the session handshake REPLACES the built-in names with what main declares (and an old main that declares nothing leaves the default)', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    const owned = f.received?.options.hostOwnedTraces as unknown as TraceSuppression;
    b.drive(encodeControl({ command: 'session', sessionId: 's' })); // no `ho`: keep the default
    expect(owned.has('displays')).toBe(true);
    b.drive(
      encodeControl({
        command: 'session',
        sessionId: 's',
        hostOwnedTraces: ['connection', 'displays'],
      }),
    );
    expect(owned.has('connection')).toBe(true);
    expect(owned.has('ram_js_heap_total')).toBe(false);
    expect(owned.has('capture')).toBe(false);
  });

  it('a session reply for a client that is no longer launched does not touch the suppression', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    const owned = f.received?.options.hostOwnedTraces as unknown as TraceSuppression;
    (f.client as unknown as { isLaunched: () => boolean }).isLaunched = () => false;
    b.drive(encodeControl({ command: 'session', sessionId: 's', hostOwnedTraces: [] }));
    expect(owned.has('displays')).toBe(true);
  });

  it("the injected store streams capture to the caller's post (encoded)", async () => {
    const f = fakeLaunch();
    const posted: string[] = [];
    await launchRenderer('tok', { launch: f.launch, post: (raw: string) => posted.push(raw) });
    const store = f.received?.options.captureStore as CaptureStore;
    store.add({ type: 'log', timestamp: 42, serialized: '{"m":1}' } as StoredEntry);
    expect(decodeStreamEntry(posted[0] as string)).toMatchObject({
      type: 'log',
      timestamp: 42,
      payload: '{"m":1}',
    });
  });

  it('falls back to the preload sink (default post) when none is given', async () => {
    const f = fakeLaunch();
    const g = globalThis as { __bugseeElectron?: { post?: (raw: string) => void } };
    const seen: string[] = [];
    g.__bugseeElectron = { post: (raw) => seen.push(raw) };
    try {
      await launchRenderer('tok', { launch: f.launch });
      const store = f.received?.options.captureStore as CaptureStore;
      store.add({ type: 'log', timestamp: 1, serialized: '{}' } as StoredEntry);
      expect(seen).toHaveLength(1);
    } finally {
      delete g.__bugseeElectron;
    }
  });

  it('announces itself with a hello handshake on launch', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    expect(b.hellos).toHaveLength(1);
    expect(isHello(b.hellos[0] as string)).toBe(true);
  });

  it('a main→renderer pause drops the UP stream; resume restores it', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    const store = f.received?.options.captureStore as CaptureStore;
    const entry = { type: 'log', timestamp: 1, serialized: '{}' } as StoredEntry;

    b.drive(encodeControl({ command: 'pause' }));
    store.add(entry);
    expect(b.posted).toHaveLength(0); // paused → nothing streamed up

    b.drive(encodeControl({ command: 'resume' }));
    store.add(entry);
    expect(b.posted).toHaveLength(1); // resumed → streaming again
  });

  it('a main→renderer stop stops the renderer client', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(encodeControl({ command: 'stop' }));
    expect(f.client.stop).toHaveBeenCalledTimes(1);
  });

  it('a main→renderer flush flushes the renderer client', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(encodeControl({ command: 'flush' }));
    expect(f.client.flush).toHaveBeenCalledTimes(1);
  });

  it('the session handshake reply is delivered to onSessionId', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const onSessionId = vi.fn();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge, onSessionId });
    b.drive(encodeControl({ command: 'session', sessionId: 'owner-sess' }));
    expect(onSessionId).toHaveBeenCalledWith('owner-sess');
  });
});

describe('resolveRendererPost', () => {
  const g = globalThis as { __bugseeElectron?: { post?: (raw: string) => void } };
  afterEach(() => {
    delete g.__bugseeElectron;
  });

  it('posts to the preload-exposed __bugseeElectron.post when present', () => {
    const seen: string[] = [];
    g.__bugseeElectron = { post: (raw) => seen.push(raw) };
    resolveRendererPost()('hello');
    expect(seen).toEqual(['hello']);
  });

  it('is a safe no-op when the bridge is not attached', () => {
    expect(() => resolveRendererPost()('x')).not.toThrow();
  });
});

describe('resolveRendererBridge', () => {
  const g = globalThis as {
    __bugseeElectron?: Partial<BugseeElectronBridge>;
  };
  afterEach(() => {
    delete g.__bugseeElectron;
  });

  it('re-resolves __bugseeElectron per call, forwarding post/sendHello/onControl', () => {
    const posts: string[] = [];
    const hellos: string[] = [];
    const handlers: Array<(raw: string) => void> = [];
    g.__bugseeElectron = {
      post: (raw) => posts.push(raw),
      sendHello: (raw) => hellos.push(raw),
      onControl: (h) => {
        handlers.push(h);
      },
    };
    const b = resolveRendererBridge();
    b.post('p');
    b.sendHello('h');
    const handler = (): void => {};
    b.onControl(handler);
    expect(posts).toEqual(['p']);
    expect(hellos).toEqual(['h']);
    expect(handlers).toEqual([handler]);
  });

  it('every method is a safe no-op when the bridge (or a method) is absent', () => {
    const b = resolveRendererBridge();
    expect(() => {
      b.post('p');
      b.sendHello('h');
      b.onControl(() => {});
    }).not.toThrow();
    g.__bugseeElectron = {}; // present but missing methods
    expect(() => {
      b.post('p');
      b.sendHello('h');
      b.onControl(() => {});
    }).not.toThrow();
  });
});

describe('launchRenderer — incidents forward instead of uploading', () => {
  it('injects a forwarding triggerPipeline into the browser launch', async () => {
    let injected: { triggerPipeline?: { report: (r: unknown) => Promise<unknown> } } | undefined;
    const fakeLaunch = (async (_t: string, o: never) => {
      injected = o as never;
      return { client: minimalClient(), internals: undefined };
    }) as never;
    await launchRenderer('tok', {
      bridge: fakeBridge().bridge,
      launch: fakeLaunch,
      post: () => {},
    });
    expect(typeof injected?.triggerPipeline?.report).toBe('function');
  });

  it('IGNORES a caller-supplied triggerPipeline — it would restore the broken local-upload path', async () => {
    const mine = { report: () => Promise.resolve({ ok: true }) };
    let injected: { triggerPipeline?: unknown } | undefined;
    const fakeLaunch = (async (_t: string, o: never) => {
      injected = o as never;
      return { client: minimalClient(), internals: undefined };
    }) as never;
    await launchRenderer('tok', {
      bridge: fakeBridge().bridge,
      launch: fakeLaunch,
      post: () => {},
      triggerPipeline: mine,
    } as never);
    // Guaranteed by spread ORDER (ours lands after the caller's options), which is what this pins. An
    // earlier version also destructured the caller's value away; that was redundant, and this test passed
    // because of the ordering either way — so the ordering is what it now asserts.
    expect(injected?.triggerPipeline).not.toBe(mine);
    expect(typeof (injected?.triggerPipeline as { report?: unknown })?.report).toBe('function');
  });

  it('cannot deliver before the session handshake, and can after', async () => {
    // Before the handshake there is no converged session to attribute an incident to.
    const posted: string[] = [];
    let injected:
      | { triggerPipeline: { report: (r: unknown) => Promise<{ ok: boolean }> } }
      | undefined;
    const fakeLaunch = (async (_t: string, o: never) => {
      injected = o as never;
      return { client: minimalClient(), internals: undefined };
    }) as never;
    const harness = fakeBridge();
    await launchRenderer('tok', {
      bridge: harness.bridge,
      launch: fakeLaunch,
      post: (raw) => posted.push(raw),
    });
    const req = { source: { type: 'crash', mechanism: 'uncaught' }, report: { summary: 'boom' } };

    expect(await injected?.triggerPipeline.report(req)).toEqual({ ok: false });
    expect(posted).toEqual([]);

    harness.drive(JSON.stringify({ k: 'control', c: 'session', sid: 'main-session' }));
    expect(await injected?.triggerPipeline.report(req)).toEqual({ ok: true });
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0] as string).k).toBe('report');
  });
});

describe('launchRenderer — default post path', () => {
  it('posts through the resolved bridge when no explicit post is supplied', async () => {
    // Covers the default `post` closure: without an override the pipeline must reach the bridge itself.
    let injected: { triggerPipeline: { report: (r: unknown) => Promise<unknown> } } | undefined;
    const fakeLaunch = (async (_t: string, o: never) => {
      injected = o as never;
      return { client: minimalClient(), internals: undefined };
    }) as never;
    const harness = fakeBridge();
    await launchRenderer('tok', { bridge: harness.bridge, launch: fakeLaunch });
    harness.drive(JSON.stringify({ k: 'control', c: 'session', sid: 's' }));
    await injected?.triggerPipeline.report({ source: {}, report: { summary: 'x' } });
    expect(harness.posted.some((raw) => JSON.parse(raw).k === 'report')).toBe(true);
  });
});

describe('launchRenderer - follows the main blackout (privacy: fail closed)', () => {
  const session = (blackout?: boolean) =>
    encodeControl({
      command: 'session',
      sessionId: 's',
      ...(blackout !== undefined ? { blackout } : {}),
    });

  it('launches in a silent HOLD regardless of the caller, so nothing is captured before the handshake', async () => {
    const f = fakeLaunch();
    await launchRenderer('tok', { launch: f.launch, bridge: fakeBridge().bridge });
    expect(f.received?.options.holdBlackout).toBe(true);
    expect(f.blackout.isActive()).toBe(true);
    delete (globalThis as unknown as Record<symbol, unknown>)[RENDERER_SLOT]; // a second page
    const g = fakeLaunch();
    await launchRenderer('tok', {
      launch: g.launch,
      bridge: fakeBridge().bridge,
      holdBlackout: false,
    } as never);
    expect(g.received?.options.holdBlackout).toBe(true); // a caller cannot switch this off
    expect(g.blackout.isActive()).toBe(true);
  });

  it('a session reply saying main is NOT blacked out releases the launch hold, silently', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session(false));
    expect(f.blackout.isActive()).toBe(false);
    expect(f.lifecycle).toEqual([]); // no Started before Launching, no Ended on release
  });

  it('a session reply WITHOUT a blackout flag still releases the hold (the handshake is the release)', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session());
    expect(f.blackout.isActive()).toBe(false);
  });

  it('a session reply saying main IS blacked out keeps this renderer dark with no flicker, announced once', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    const seen: boolean[] = [];
    f.blackout.onChange((a) => seen.push(a));
    b.drive(session(true));
    expect(f.blackout.isActive()).toBe(true);
    expect(seen).toEqual([]); // the hold never opened, even for an instant
    expect(f.lifecycle).toEqual(['Started']);
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(false);
    expect(f.lifecycle).toEqual(['Started', 'Ended']);
  });

  it('blackout-start / blackout-end control commands drive the BlackoutToken state and the events', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session(false));
    const seen: boolean[] = [];
    f.blackout.onChange((a) => seen.push(a));
    b.drive(encodeControl({ command: 'blackout-start' }));
    expect(f.blackout.isActive()).toBe(true);
    b.drive(encodeControl({ command: 'blackout-start' })); // idempotent
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(f.lifecycle).toEqual(['Started', 'Ended']);
  });

  it('startBlackout() right after launchRenderer() (before the handshake) survives a bo:false reply', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    client.startBlackout();
    expect(client.isBlackout()).toBe(true);
    b.drive(session(false));
    expect(f.blackout.isActive()).toBe(true); // the app asked for it; main does not get to end it
    expect(f.lifecycle).toEqual(['Started']); // announced at the app's call, once
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(false);
    expect(f.lifecycle).toEqual(['Started', 'Ended']);
  });

  it("an app-local blackout is not ended by main's blackout-end, and main's is not ended by endBlackout()", async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session(false));
    client.startBlackout();
    b.drive(encodeControl({ command: 'blackout-start' }));
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(true); // still the app's
    b.drive(encodeControl({ command: 'blackout-start' }));
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(true); // still main's
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(false);
    expect(f.lifecycle).toEqual(['Started', 'Ended']); // one visible span, not one per source
  });

  it('an explicit startInBlackout:true survives the handshake (bo:false) and is ended only by endBlackout()', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', {
      launch: f.launch,
      bridge: b.bridge,
      startInBlackout: true,
    });
    expect(f.received?.options.startInBlackout).toBe(true);
    b.drive(session(false));
    expect(f.blackout.isActive()).toBe(true);
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(true);
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(false);
    expect(f.lifecycle).toEqual(['Started', 'Ended']);
  });

  it('startBlackout()/endBlackout() on a client that is not launched are refused, as in core', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session(false));
    const setLaunched = (v: boolean) => {
      (f.client as unknown as { isLaunched: () => boolean }).isLaunched = () => v;
    };
    setLaunched(false);
    client.startBlackout();
    expect(f.blackout.isActive()).toBe(false);
    setLaunched(true);
    client.startBlackout();
    setLaunched(false);
    client.endBlackout(); // allowed while stopped (quietly), see the dedicated tests below
    expect(f.blackout.isActive()).toBe(false);
  });

  it('control traffic BEFORE the handshake cannot open the hold: a blackout-end (or app endBlackout) leaves it dark', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(encodeControl({ command: 'blackout-start' }));
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(true);
    client.startBlackout();
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(true);
    b.drive(session(false));
    expect(f.blackout.isActive()).toBe(false);
  });

  it('a repeated handshake (reply re-sent) never un-darkens an app blackout', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session(false));
    client.startBlackout();
    b.drive(session(false));
    expect(f.blackout.isActive()).toBe(true);
  });
});

describe('launchRenderer - one instance per page', () => {
  it('a second call in the same page is a no-op returning the existing instance: one launch, one hello, one control handler', async () => {
    const f = fakeLaunch();
    const hellos: string[] = [];
    const handlers: unknown[] = [];
    const bridge: BugseeElectronBridge = {
      post: () => {},
      sendHello: (raw) => hellos.push(raw),
      onControl: (h) => {
        handlers.push(h);
      },
    };
    const first = await launchRenderer('tok', { launch: f.launch, bridge });
    const second = await launchRenderer('tok', { launch: f.launch, bridge });
    expect(second).toBe(first);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(hellos).toHaveLength(1);
    expect(handlers).toHaveLength(1);
  });

  it('a call made while the first launch is still pending joins it', async () => {
    const f = fakeLaunch();
    const bridge = fakeBridge().bridge;
    const [a, b] = await Promise.all([
      launchRenderer('tok', { launch: f.launch, bridge }),
      launchRenderer('tok', { launch: f.launch, bridge }),
    ]);
    expect(a).toBe(b);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });

  it('once the client is no longer launched (main stopped it) a new call launches a fresh one', async () => {
    const f = fakeLaunch();
    const bridge = fakeBridge().bridge;
    await launchRenderer('tok', { launch: f.launch, bridge });
    (f.client as unknown as { isLaunched: () => boolean }).isLaunched = () => false;
    await launchRenderer('tok', { launch: f.launch, bridge });
    expect(f.launch).toHaveBeenCalledTimes(2);
  });

  it('a failed launch frees the slot: the next call tries again', async () => {
    const f = fakeLaunch();
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      launchRenderer('tok', { launch: failing as never, bridge: fakeBridge().bridge }),
    ).rejects.toThrow('boom');
    await launchRenderer('tok', { launch: f.launch, bridge: fakeBridge().bridge });
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
});

describe('launchRenderer - a re-run honours the carried blackout', () => {
  const session = (blackout?: boolean) =>
    encodeControl({
      command: 'session',
      sessionId: 's',
      ...(blackout !== undefined ? { blackout } : {}),
    });

  it('a blackout carried over from the previous client survives the handshake (bo:false) and is ended only by endBlackout()', async () => {
    const carrier = {};
    setCarrierBlackout(true, carrier);
    const f = fakeLaunch();
    f.blackout.start({ silent: true }); // what the real launch does: the new state starts in the carried state
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge, carrier });
    b.drive(session(false));
    expect(f.blackout.isActive()).toBe(true);
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(false);
  });

  it('with nothing carried the handshake still releases the hold', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    await launchRenderer('tok', { launch: f.launch, bridge: b.bridge, carrier: {} });
    b.drive(session(false));
    expect(f.blackout.isActive()).toBe(false);
  });

  it('endBlackout() on a STOPPED client lifts every reason (app, main, hold) so the next launch is not dark', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session(true)); // main dark, hold released
    client.startBlackout();
    (f.client as unknown as { isLaunched: () => boolean }).isLaunched = () => false;
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(false);
    // a late main message cannot re-darken a stopped client's state through a stale flag
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(false);
  });
});

describe('launchRenderer - stopped before the handshake', () => {
  it('endBlackout() on a stopped client also drops the launch hold: a late main message cannot re-darken it', async () => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    expect(f.blackout.isActive()).toBe(true); // the hold
    (f.client as unknown as { isLaunched: () => boolean }).isLaunched = () => false;
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(false);
    b.drive(encodeControl({ command: 'blackout-end' }));
    expect(f.blackout.isActive()).toBe(false);
  });
});

describe('launchRenderer - invalid startInBlackout is dark', () => {
  it.each([
    true,
    'true',
    1,
    'false',
    0,
    null,
    '',
  ])('startInBlackout=%j: the app is dark and stays dark through the handshake', async (value) => {
    const f = fakeLaunch();
    const b = fakeBridge();
    const client = await launchRenderer('tok', {
      launch: f.launch,
      bridge: b.bridge,
      startInBlackout: value as never,
    });
    b.drive(encodeControl({ command: 'session', sessionId: 's', blackout: false }));
    expect(f.blackout.isActive()).toBe(true);
    client.endBlackout();
    expect(f.blackout.isActive()).toBe(false);
  });

  it('false and absent are not dark after the handshake', async () => {
    for (const over of [{ startInBlackout: false }, {}]) {
      const f = fakeLaunch();
      const b = fakeBridge();
      await launchRenderer('tok', { launch: f.launch, bridge: b.bridge, ...over });
      b.drive(encodeControl({ command: 'session', sessionId: 's', blackout: false }));
      expect(f.blackout.isActive()).toBe(false);
      delete (globalThis as unknown as Record<symbol, unknown>)[RENDERER_SLOT];
    }
  });
});

// A renderer re-run (the old client was stopped by main, a new one launched) used to leave the OLD
// handler subscribed: every control message then ran twice (double onSessionId, BlackoutStarted twice) and a
// stale `A.startBlackout()` was swallowed while the live client B stayed un-dark.
describe("launchRenderer - a stopped client's handler is inert after a re-run", () => {
  const session = (blackout?: boolean) =>
    encodeControl({
      command: 'session',
      sessionId: 's',
      ...(blackout !== undefined ? { blackout } : {}),
    });
  const stop = (f: ReturnType<typeof fakeLaunch>) => {
    (f.client as unknown as { isLaunched: () => boolean }).isLaunched = () => false;
  };

  /** A bridge like Electron's ipcRenderer: every onControl ADDS a listener; the returned fn removes it. */
  function accumulatingBridge(options: { unsubscribable: boolean }) {
    const handlers: Array<(raw: string) => void> = [];
    const bridge: BugseeElectronBridge = {
      post: () => {},
      sendHello: () => {},
      onControl: (handler) => {
        handlers.push(handler);
        return options.unsubscribable
          ? () => {
              handlers.splice(handlers.indexOf(handler), 1);
            }
          : undefined;
      },
    };
    return {
      bridge,
      handlers,
      drive(raw: string): void {
        for (const handler of [...handlers]) handler(raw);
      },
    };
  }

  it.each([
    ['a bridge that returns an unsubscribe', true],
    ['an older bridge that cannot unsubscribe', false],
  ])('%s: after the re-run one session reply reaches onSessionId once, one BlackoutStarted fires', async (_n, unsubscribable) => {
    const b = accumulatingBridge({ unsubscribable });
    const a = fakeLaunch();
    const aSessions: string[] = [];
    await launchRenderer('tok', {
      launch: a.launch,
      bridge: b.bridge,
      onSessionId: (id) => aSessions.push(id),
    });
    b.drive(session(false));
    expect(aSessions).toEqual(['s']);
    stop(a); // main stopped A's client
    const next = fakeLaunch();
    const bSessions: string[] = [];
    await launchRenderer('tok', {
      launch: next.launch,
      bridge: b.bridge,
      onSessionId: (id) => bSessions.push(id),
    });
    b.drive(session(true)); // ONE reply from main for the new session
    expect(bSessions).toEqual(['s']);
    expect(aSessions).toEqual(['s']); // A heard nothing more
    b.drive(encodeControl({ command: 'blackout-end' }));
    b.drive(encodeControl({ command: 'blackout-start' }));
    expect(next.lifecycle.filter((e) => e === 'Started')).toHaveLength(2); // session bo:true, then start (after end)
    expect(a.lifecycle.filter((e) => e === 'Started' || e === 'Ended')).toEqual([]);
    // the stale client's blackout state was never driven by the new session's traffic
    expect(a.blackout.isActive()).toBe(false); // A's own state, released by ITS handshake, untouched since
    // the retired handler is really gone from the IPC object where the bridge can unsubscribe
    expect(b.handlers).toHaveLength(unsubscribable ? 1 : 2);
  });

  it('a stale handle: startBlackout() forwards to the core method (-> the current client), endBlackout() too', async () => {
    const f = fakeLaunch();
    const coreStart = vi.fn();
    const coreEnd = vi.fn();
    f.client.startBlackout = coreStart;
    f.client.endBlackout = coreEnd;
    const b = fakeBridge();
    const client = await launchRenderer('tok', { launch: f.launch, bridge: b.bridge });
    b.drive(session(false));
    client.startBlackout(); // launched: the renderer's own app flag, the core method is not involved
    client.endBlackout();
    expect(coreStart).not.toHaveBeenCalled();
    expect(coreEnd).not.toHaveBeenCalled();
    stop(f);
    client.startBlackout();
    expect(coreStart).toHaveBeenCalledTimes(1); // core decides: forwards to the live client or reports
    client.endBlackout();
    expect(coreEnd).toHaveBeenCalledTimes(1);
  });

  it('a stopped client ignores pause / flush / stop / session / blackout traffic entirely', async () => {
    const f = fakeLaunch();
    const sessions: string[] = [];
    const b = fakeBridge();
    await launchRenderer('tok', {
      launch: f.launch,
      bridge: b.bridge,
      onSessionId: (id) => sessions.push(id),
    });
    stop(f);
    f.blackout.end({ silent: true });
    b.drive(session(true));
    b.drive(encodeControl({ command: 'blackout-start' }));
    b.drive(encodeControl({ command: 'flush' }));
    b.drive(encodeControl({ command: 'stop' }));
    expect(sessions).toEqual([]);
    expect(f.blackout.isActive()).toBe(false);
    expect(f.client.flush).not.toHaveBeenCalled();
    expect(f.client.stop).not.toHaveBeenCalled();
    expect(f.lifecycle).toEqual([]);
  });
});
