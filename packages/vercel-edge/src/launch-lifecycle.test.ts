import {
  BugseeStatus,
  getCarrier,
  getProcessStatus,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  LifecycleEvents,
  relaunchWith,
  setProcessLifecycleEventsListener,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from './launch';

// Lifecycle parity with the node/browser tiers: the carrier slot is cleared only by the client
// that still owns it, status and the relaunch record are published, and the introspectable launch options
// work (they returned {} here).

const okTransport = (): HttpTransport =>
  vi.fn(
    async (_url: string, _options: HttpRequestOptions = {}): Promise<HttpResponse> => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
    }),
  );

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const opts = (over: Partial<BugseeEdgeLaunchOptions> = {}): BugseeEdgeLaunchOptions => ({
  transport: okTransport(),
  carrier: {},
  detectCrashes: false,
  ...over,
});
const track = (options: BugseeEdgeLaunchOptions, token = 'tok'): Bugsee => {
  const client = launchEdge(token, options);
  live.push(client);
  return client;
};

describe('vercel-edge carrier slot', () => {
  it('stop() clears the slot it owns and reports Stopped', async () => {
    const carrier = {};
    const client = track(opts({ carrier }));
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Launched);
    const stopping = client.stop();
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Stopping);
    await stopping;
    expect(getCarrier(carrier).client).toBeUndefined();
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Stopped);
  });

  it('a stale stop() does not clear a relaunched client from the slot', async () => {
    const carrier = {};
    const first = track(opts({ carrier }));
    await first.stop();
    const second = track(opts({ carrier }));
    await first.stop(); // stale, repeated
    expect(getCarrier(carrier).client).toBe(second);
    expect(getCarrier(carrier).status).toBe(BugseeStatus.Launched);
  });

  it('a relaunch while the previous stop is draining keeps its own client and status', async () => {
    const carrier = {};
    const first = track(opts({ carrier }));
    const stopping = first.stop();
    const second = track(opts({ carrier }));
    await stopping;
    expect(getCarrier(carrier).client).toBe(second);
    expect(getCarrier(carrier).status).toBe(BugseeStatus.Launched);
  });

  it('records the launch so relaunchWith() can start a fresh client with the same token', async () => {
    const carrier = {};
    const first = track(opts({ carrier }), 'tok-1');
    expect(getCarrier(carrier).lastLaunch?.appToken).toBe('tok-1');
    const second = await relaunchWith(launchEdge, opts({ carrier }), carrier);
    live.push(second);
    expect(second).not.toBe(first);
    expect(getCarrier(carrier).client).toBe(second);
  });

  it('a repeat launch while launched returns the singleton and leaves the status alone', () => {
    const carrier = {};
    const first = track(opts({ carrier, onError: () => {} }));
    expect(launchEdge('tok', opts({ carrier, onError: () => {} }))).toBe(first);
    expect(getCarrier(carrier).status).toBe(BugseeStatus.Launched);
  });
});

describe('vercel-edge launch options introspection', () => {
  it('getLaunchOptions is host over defaults by canonical key; getHostLaunchOptions only what the host set', () => {
    const client = track(opts({ captureLogs: false, maxRecordingTime: 30 }));
    const effective = client.getLaunchOptions();
    expect(effective[BugseeOption.CaptureLogs]).toBe(false);
    expect(effective[BugseeOption.Duration]).toBe(30);
    expect(client.getHostLaunchOptions()).toMatchObject({
      [BugseeOption.CaptureLogs]: false,
      [BugseeOption.Duration]: 30,
    });
    expect(client.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureSystemEvents]);
  });
});

describe('launch() on a stopped edge client is refused', () => {
  it('reports through onError, starts nothing, leaves the carrier slot free for a NEW client', async () => {
    const carrier = {};
    const onError = vi.fn();
    const first = track(opts({ carrier, onError }));
    await first.stop();
    first.launch();
    expect(first.isLaunched()).toBe(false);
    expect(getCarrier(carrier).client).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/) }),
    );
    const second = track(opts({ carrier }));
    expect(getCarrier(carrier).client).toBe(second);
  });
});

describe('the edge isolate observes its own lifecycle', () => {
  it('the lifecycleEventsListener option sees Launching and Launched', () => {
    const seen: string[] = [];
    track(opts({ lifecycleEventsListener: (type) => seen.push(type) }));
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('without a carrier option the isolate carrier is globalThis: a listener set BEFORE launch sees it, and survives a relaunch', async () => {
    const seen: string[] = [];
    setProcessLifecycleEventsListener((type) => seen.push(type));
    track({ transport: okTransport(), detectCrashes: false });
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
    seen.length = 0;
    const second = await relaunchWith(launchEdge, {
      transport: okTransport(),
      detectCrashes: false,
    });
    live.push(second);
    expect(seen).toEqual([
      LifecycleEvents.Stopping,
      LifecycleEvents.Stopped,
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
    ]);
  });

  it('a blackout carries across a relaunch instead of ending at the new client', async () => {
    const carrier = {};
    const first = track(opts({ carrier }));
    first.startBlackout();
    const second = await relaunchWith(launchEdge, opts({ carrier }), carrier);
    live.push(second);
    expect(second.isBlackout()).toBe(true);
  });

  it('RelaunchedAfterCrash is never emitted on an edge isolate (nothing durable to find evidence in)', () => {
    const seen: string[] = [];
    track(opts({ lifecycleEventsListener: (type) => seen.push(type) }));
    expect(seen).not.toContain(LifecycleEvents.RelaunchedAfterCrash);
  });
});
