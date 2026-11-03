import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch, listen } = vi.hoisted(() => ({ launch: vi.fn(), listen: vi.fn() }));
vi.mock('@bugsee/bugsee', () => ({ launch }));
vi.mock('./hydration', () => ({ listenForAstroHydrationErrors: listen }));

import { registerClient } from './client';

describe('registerClient', () => {
  afterEach(() => {
    launch.mockReset();
    listen.mockReset();
  });

  it('launches the browser SDK with the appToken + options, returns the client', async () => {
    const client = { id: 'browser' };
    launch.mockReturnValue(client);
    await expect(registerClient('tok', { captureLogs: false })).resolves.toBe(client);
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false });
  });

  it('defaults options to an empty object', async () => {
    await registerClient('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });

  it('listens for astro:hydration-error after the launch, passing the onError sink along', async () => {
    const onError = vi.fn();
    await registerClient('tok', { onError });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith({ onError });
    await registerClient('tok');
    expect(listen).toHaveBeenLastCalledWith({});
  });
});
