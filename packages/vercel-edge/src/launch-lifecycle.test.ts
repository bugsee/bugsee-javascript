import {
  BugseeStatus,
  getCarrier,
  getProcessStatus,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  relaunchWith,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from './launch';

// Lifecycle parity with the node/browser tiers (review L9): the carrier slot is cleared only by the client
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

describe('vercel-edge launch options introspection (L9)', () => {
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
