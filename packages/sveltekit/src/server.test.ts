import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('bugsee/node', () => ({ launch }));

import { registerServer } from './server';

describe('registerServer', () => {
  afterEach(() => launch.mockReset());

  it('launches the node SDK with the appToken + options, returns the client', () => {
    const client = { id: 'node-client' };
    launch.mockReturnValue(client);
    const result = registerServer('tok', { captureNetwork: false });
    expect(launch).toHaveBeenCalledWith('tok', { captureNetwork: false });
    expect(result).toBe(client);
  });

  it('defaults options to an empty object', () => {
    registerServer('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });
});
