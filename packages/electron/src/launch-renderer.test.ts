import type { Bugsee, BugseeLaunchOptions } from '@bugsee/browser';
import type { CaptureStore, StoredEntry } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchRenderer, resolveRendererPost } from './launch-renderer';
import { decodeStreamEntry } from './protocol';

/** A fake browser launchCore that records the options it was called with + returns a stub client. */
function fakeLaunch() {
  const client = { stop: vi.fn() } as unknown as Bugsee;
  let received: { appToken: string; options: BugseeLaunchOptions } | undefined;
  const launch = vi.fn((appToken: string, options: BugseeLaunchOptions) => {
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

describe('launchRenderer', () => {
  it('runs the browser launch with a streaming captureStore injected + forwards options', () => {
    const f = fakeLaunch();
    const client = launchRenderer('tok', { launch: f.launch, post: () => {}, replay: true });

    expect(client).toBe(f.client);
    expect(f.received?.appToken).toBe('tok');
    expect(f.received?.options.replay).toBe(true); // browser options forwarded
    // a CaptureStore was injected (not the caller's business — `post`/`launch` are stripped)
    const store = f.received?.options.captureStore as CaptureStore;
    expect(typeof store.add).toBe('function');
    expect('post' in (f.received?.options ?? {})).toBe(false);
    expect('launch' in (f.received?.options ?? {})).toBe(false);
  });

  it("the injected store streams capture to the caller's post (encoded)", () => {
    const f = fakeLaunch();
    const posted: string[] = [];
    launchRenderer('tok', { launch: f.launch, post: (raw: string) => posted.push(raw) });
    const store = f.received?.options.captureStore as CaptureStore;
    store.add({ type: 'log', timestamp: 42, serialized: '{"m":1}' } as StoredEntry);
    expect(decodeStreamEntry(posted[0] as string)).toMatchObject({
      type: 'log',
      timestamp: 42,
      payload: '{"m":1}',
    });
  });

  it('falls back to the preload sink (default post) when none is given', () => {
    const f = fakeLaunch();
    const g = globalThis as { __bugseeElectron?: { post?: (raw: string) => void } };
    const seen: string[] = [];
    g.__bugseeElectron = { post: (raw) => seen.push(raw) };
    try {
      launchRenderer('tok', { launch: f.launch });
      const store = f.received?.options.captureStore as CaptureStore;
      store.add({ type: 'log', timestamp: 1, serialized: '{}' } as StoredEntry);
      expect(seen).toHaveLength(1);
    } finally {
      delete g.__bugseeElectron;
    }
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
