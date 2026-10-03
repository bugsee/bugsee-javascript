import type { Bugsee, BugseeLaunchOptions } from '@bugsee/browser';
import type { CaptureStore, StoredEntry } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchRenderer, resolveRendererBridge, resolveRendererPost } from './launch-renderer';
import type { BugseeElectronBridge } from './preload-bridge';
import { decodeStreamEntry, encodeControl, isHello } from './protocol';

/** A fake browser launchCore that records the options it was called with + returns a stub client. */
function fakeLaunch() {
  const client = {
    stop: vi.fn(() => Promise.resolve(true)),
    flush: vi.fn(() => Promise.resolve(true)),
  } as unknown as Bugsee;
  let received: { appToken: string; options: BugseeLaunchOptions } | undefined;
  const launch = vi.fn(async (appToken: string, options: BugseeLaunchOptions) => {
    received = { appToken, options };
    return { client, internals: undefined };
  });
  return {
    launch: launch as never,
    client,
    get received() {
      return received;
    },
  };
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
      onControl: (h) => handlers.push(h),
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

describe('launchRenderer — incidents forward instead of uploading (R2)', () => {
  it('injects a forwarding triggerPipeline into the browser launch', async () => {
    let injected: { triggerPipeline?: { report: (r: unknown) => Promise<unknown> } } | undefined;
    const fakeLaunch = (async (_t: string, o: never) => {
      injected = o as never;
      return { client: { stop: () => Promise.resolve(true) }, internals: undefined };
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
      return { client: { stop: () => Promise.resolve(true) }, internals: undefined };
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
      return { client: { stop: () => Promise.resolve(true) }, internals: undefined };
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
      return { client: { stop: () => Promise.resolve(true) }, internals: undefined };
    }) as never;
    const harness = fakeBridge();
    await launchRenderer('tok', { bridge: harness.bridge, launch: fakeLaunch });
    harness.drive(JSON.stringify({ k: 'control', c: 'session', sid: 's' }));
    await injected?.triggerPipeline.report({ source: {}, report: { summary: 'x' } });
    expect(harness.posted.some((raw) => JSON.parse(raw).k === 'report')).toBe(true);
  });
});
