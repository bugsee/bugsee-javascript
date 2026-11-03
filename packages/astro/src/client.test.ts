import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch, listen, flush, order } = vi.hoisted(() => ({
  launch: vi.fn(),
  listen: vi.fn(),
  flush: vi.fn(),
  order: [] as string[],
}));
vi.mock('@bugsee/bugsee', () => ({ launch }));
vi.mock('./hydration', () => ({
  listenForAstroHydrationErrors: listen,
  flushQueuedAstroHydrationErrors: flush,
}));

import { registerClient } from './client';

describe('registerClient', () => {
  afterEach(() => {
    launch.mockReset();
    listen.mockReset();
    flush.mockReset();
    order.length = 0;
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

  it('listens BEFORE the launch (an island error during launch is queued) and flushes the queue once the client exists', async () => {
    listen.mockImplementation(() => order.push('listen'));
    launch.mockImplementation(async () => {
      order.push('launch');
      return {};
    });
    flush.mockImplementation(() => order.push('flush'));
    await registerClient('tok');
    expect(order).toEqual(['listen', 'launch', 'flush']);
  });

  it('ends the queueing window even when the launch fails, and still rejects with the launch error', async () => {
    const failure = new Error('launch failed');
    launch.mockRejectedValue(failure);
    await expect(registerClient('tok')).rejects.toBe(failure);
    expect(flush).toHaveBeenCalledTimes(1);
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
