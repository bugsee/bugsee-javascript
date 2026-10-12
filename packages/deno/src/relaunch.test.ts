import { setCarrierClient, setCarrierLastLaunch } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `relaunch` must re-run THIS package's launch (Deno system probe + runtime gates), not the one re-exported from the layer below
// (review R2D-4). The launch is replaced by a spy; the carrier carries the remembered token like a real one.
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('./launch', () => ({ launch }));

import { relaunch } from './relaunch';

afterEach(() => launch.mockReset());

describe('@bugsee/deno relaunch', () => {
  it('rejects while nothing has been launched (there is no token to reuse)', async () => {
    await expect(relaunch({ carrier: {} })).rejects.toThrow(/before launch/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('stops the running client, then launches again through this package with the remembered token', async () => {
    const carrier = {};
    const order: string[] = [];
    const old = {
      stop: vi.fn(async () => {
        order.push('stop');
        return true;
      }),
    };
    const next = { stop: vi.fn() };
    launch.mockImplementation(() => {
      order.push('launch');
      return next;
    });
    setCarrierClient(old, carrier);
    setCarrierLastLaunch('tok-1', { carrier }, carrier);

    await expect(relaunch({ carrier, captureNetwork: false })).resolves.toBe(next);

    expect(order).toEqual(['stop', 'launch']);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      'tok-1',
      expect.objectContaining({ carrier, captureNetwork: false }),
    );
  });
});
