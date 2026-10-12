import { type Bugsee, BugseeStatus, getStatus, launchEdge } from '@bugsee/vercel-edge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBugseeNitroEdge, relaunch } from './nitro-edge';

// R3P-9: the `/edge` entry's `relaunch` used to be the plain vercel-edge one, which re-runs `launchEdge` and
// ignored the `launch` seam `registerServerEdge` accepts (e.g. Cloudflare's launch). It now takes the same seam.
const okTransport = () =>
  vi.fn(async () => ({
    status: 200,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
  }));
const opts = (carrier: object) => ({ transport: okTransport(), carrier, detectCrashes: false });

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
});

describe('@bugsee/nuxt/edge relaunch', () => {
  it('rejects while nothing has been launched', async () => {
    await expect(relaunch(opts({}))).rejects.toThrow(/before launch/);
  });

  it('re-runs the launch SEAM with the remembered token, not the plain edge launch', async () => {
    const carrier = {};
    const first = installBugseeNitroEdge(
      { hooks: { hook() {} } },
      { appToken: 'tok-1', ...opts(carrier) },
    );
    live.push(first);
    const launch = vi.fn((token: string, options: Parameters<typeof launchEdge>[1]) => {
      const client = launchEdge(token, options);
      live.push(client);
      return client;
    });

    const second = await relaunch({ ...opts(carrier), launch });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toBe('tok-1');
    expect(launch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ carrier }));
    // The seam itself is not a launch option: it must not leak into what the launch receives.
    expect(launch.mock.calls[0]?.[1]).not.toHaveProperty('launch');
    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(getStatus(carrier)).toBe(BugseeStatus.Launched);
  });

  it('defaults to the plain edge launch when no seam is given', async () => {
    const carrier = {};
    live.push(
      installBugseeNitroEdge({ hooks: { hook() {} } }, { appToken: 'tok-2', ...opts(carrier) }),
    );
    const second = await relaunch(opts(carrier));
    live.push(second);
    expect(getStatus(carrier)).toBe(BugseeStatus.Launched);
  });

  // R4H-4: the install-time seam is the DEFAULT for a plain `relaunch()` (an explicit argument still wins).
  it('a plain relaunch() re-runs the custom launch the entry was INSTALLED with (R4H-4)', async () => {
    const carrier = {};
    const custom = vi.fn((token: string, options: Parameters<typeof launchEdge>[1]) => {
      const client = launchEdge(token, options);
      live.push(client);
      return client;
    });
    live.push(
      installBugseeNitroEdge(
        { hooks: { hook() {} } },
        { appToken: 'tok-3', ...opts(carrier), launch: custom },
      ),
    );
    expect(custom).toHaveBeenCalledTimes(1);
    const second = await relaunch(opts(carrier));
    live.push(second);
    expect(custom).toHaveBeenCalledTimes(2);
    expect(custom.mock.calls[1]?.[0]).toBe('tok-3');
    expect(getStatus(carrier)).toBe(BugseeStatus.Launched);
  });

  it('an explicit launch beats the install-time one (R4H-4)', async () => {
    const carrier = {};
    const installed = vi.fn((token: string, options: Parameters<typeof launchEdge>[1]) => {
      const client = launchEdge(token, options);
      live.push(client);
      return client;
    });
    const explicit = vi.fn((token: string, options: Parameters<typeof launchEdge>[1]) => {
      const client = launchEdge(token, options);
      live.push(client);
      return client;
    });
    live.push(
      installBugseeNitroEdge(
        { hooks: { hook() {} } },
        { appToken: 'tok-4', ...opts(carrier), launch: installed },
      ),
    );
    live.push(await relaunch({ ...opts(carrier), launch: explicit }));
    expect(explicit).toHaveBeenCalledTimes(1);
    expect(installed).toHaveBeenCalledTimes(1); // only the install
  });
});
