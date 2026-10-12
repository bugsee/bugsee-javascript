import {
  BugseeStatus,
  getCarrier,
  getCarrierClient,
  getProcessStatus,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from './launch';
import { relaunch, relaunchEdge, rememberEdgeLaunch } from './relaunch';

// `relaunch` is built on core's `relaunchWith` over THIS package's launch (review R2D-4), so an edge function that
// imports `@bugsee/vercel-edge` directly can restart without reaching into another entry.
const okTransport = (): HttpTransport =>
  vi.fn(
    async (): Promise<HttpResponse> => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
    }),
  );
const opts = (carrier: object): BugseeEdgeLaunchOptions => ({
  transport: okTransport(),
  carrier,
  detectCrashes: false,
});

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
});

describe('vercel-edge relaunch', () => {
  it('rejects while nothing has been launched (there is no token to reuse)', async () => {
    await expect(relaunch(opts({}))).rejects.toThrow(/before launch/);
  });

  it('stops the running client and starts a new one through the vercel-edge launch', async () => {
    const carrier = {};
    const first = launchEdge('tok', opts(carrier));
    live.push(first);
    const second = await relaunch(opts(carrier));
    live.push(second);
    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
    expect(getCarrierClient(carrier)).toBe(second);
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Launched);
  });
});

describe('vercel-edge relaunchEdge / rememberEdgeLaunch (R4H-4)', () => {
  const recordingLaunch = () =>
    vi.fn((token: string, options: BugseeEdgeLaunchOptions) => {
      const client = launchEdge(token, options);
      live.push(client);
      return client;
    });

  it('re-runs the REMEMBERED launch seam when none is given', async () => {
    const carrier = {};
    const custom = recordingLaunch();
    rememberEdgeLaunch(custom, carrier);
    live.push(launchEdge('tok-a', opts(carrier)));
    const second = await relaunchEdge(opts(carrier));
    live.push(second);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(custom.mock.calls[0]?.[0]).toBe('tok-a');
    expect(getCarrierClient(carrier)).toBe(second);
  });

  it('an explicit launch wins, does not leak into the launch options, and becomes the remembered one', async () => {
    const carrier = {};
    const remembered = recordingLaunch();
    const explicit = recordingLaunch();
    rememberEdgeLaunch(remembered, carrier);
    live.push(launchEdge('tok-b', opts(carrier)));
    live.push(await relaunchEdge({ ...opts(carrier), launch: explicit }));
    expect(explicit).toHaveBeenCalledTimes(1);
    expect(remembered).not.toHaveBeenCalled();
    expect(explicit.mock.calls[0]?.[1]).not.toHaveProperty('launch');
    live.push(await relaunchEdge(opts(carrier))); // plain: the explicit one is now the default
    expect(explicit).toHaveBeenCalledTimes(2);
    expect(remembered).not.toHaveBeenCalled();
  });

  it('a relaunch that rejects (nothing launched) remembers nothing', async () => {
    const carrier = {};
    await expect(relaunchEdge({ ...opts(carrier), launch: recordingLaunch() })).rejects.toThrow(
      /before launch/,
    );
    expect(getCarrier(carrier).edgeLaunch).toBeUndefined();
  });

  it('falls back to launchEdge when nothing was remembered', async () => {
    const carrier = {};
    live.push(launchEdge('tok-c', opts(carrier)));
    const second = await relaunchEdge(opts(carrier));
    live.push(second);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
  });

  it('finds the seam on the carrier of the last launch when relaunch is not told one', async () => {
    const carrier = {};
    const custom = recordingLaunch();
    rememberEdgeLaunch(custom, carrier);
    live.push(launchEdge('tok-d', opts(carrier)));
    live.push(await relaunchEdge({ transport: okTransport(), detectCrashes: false }));
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('a seam remembered on one carrier is not used for another', async () => {
    const a = {};
    const b = {};
    const custom = recordingLaunch();
    rememberEdgeLaunch(custom, a);
    live.push(launchEdge('tok-e', opts(b)));
    live.push(await relaunchEdge(opts(b)));
    expect(custom).not.toHaveBeenCalled();
  });

  it('remembers on globalThis when no carrier is given', async () => {
    const custom = recordingLaunch();
    rememberEdgeLaunch(custom);
    try {
      live.push(launchEdge('tok-f', { transport: okTransport(), detectCrashes: false }));
      live.push(await relaunchEdge({ transport: okTransport(), detectCrashes: false }));
      expect(custom).toHaveBeenCalledTimes(1);
    } finally {
      delete (getCarrier() as { edgeLaunch?: unknown }).edgeLaunch;
      await Promise.all(live.splice(0).map((c) => c.stop(0)));
      delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
    }
  });
});
