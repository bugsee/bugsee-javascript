import {
  type Bugsee,
  type BugseeEdgeLaunchOptions,
  BugseeStatus,
  getStatus,
  launchEdge,
} from '@bugsee/vercel-edge';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `relaunch` must re-run THE CLOUDFLARE launch (workers identity, AsyncLocalStorage, tenant partitioning), not
// the plain edge one re-exported from `@bugsee/vercel-edge`. The Cloudflare `launch` is replaced
// by a spy that forwards to the real edge launch; the first client is a real one so the carrier holds a real
// remembered token and a real client to stop.
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('./launch', () => ({ launch }));

import { relaunch } from './relaunch';

const okTransport = () =>
  vi.fn(async () => ({
    status: 200,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
  }));
const opts = (carrier: object): BugseeEdgeLaunchOptions => ({
  transport: okTransport(),
  carrier,
  detectCrashes: false,
});

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
  launch.mockReset();
});

describe('@bugsee/cloudflare relaunch', () => {
  it('rejects while nothing has been launched (there is no token to reuse)', async () => {
    await expect(relaunch(opts({}))).rejects.toThrow(/before launch/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('stops the running client, then launches again through the Cloudflare launch with the remembered token', async () => {
    const carrier = {};
    const first = launchEdge('tok-1', opts(carrier));
    live.push(first);
    launch.mockImplementation((token: string, options: BugseeEdgeLaunchOptions) => {
      const client = launchEdge(token, options);
      live.push(client);
      return client;
    });

    const second = await relaunch(opts(carrier));

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toBe('tok-1');
    expect(launch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ carrier }));
    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(getStatus(carrier)).toBe(BugseeStatus.Launched);
  });
});
