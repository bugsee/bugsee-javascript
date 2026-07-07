import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('bugsee/node', () => ({ launch }));

import { registerServer } from './server';

describe('registerServer', () => {
  afterEach(() => launch.mockReset());

  it('launches the node SDK with the appToken + options, returns the client', () => {
    const client = { id: 'node' };
    launch.mockReturnValue(client);
    expect(registerServer('tok', { captureNetwork: false })).toBe(client);
    expect(launch).toHaveBeenCalledWith('tok', { captureNetwork: false });
  });

  it('defaults options to an empty object', () => {
    registerServer('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });
});
