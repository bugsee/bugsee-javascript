import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('bugsee', () => ({ launch }));

import { registerClient } from './client';

describe('registerClient', () => {
  afterEach(() => launch.mockReset());

  it('launches the browser SDK with the appToken + options, returns the client', () => {
    const client = { id: 'browser' };
    launch.mockReturnValue(client);
    expect(registerClient('tok', { captureLogs: false })).toBe(client);
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false });
  });

  it('defaults options to an empty object', () => {
    registerClient('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });
});
