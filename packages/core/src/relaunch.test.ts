import { describe, expect, it, vi } from 'vitest';
import { getCarrier, setCarrierClient, setCarrierLastLaunch } from './carrier';
import { relaunchWith } from './relaunch';

describe('relaunchWith', () => {
  it('rejects when nothing was ever launched', async () => {
    const launch = vi.fn();
    await expect(relaunchWith(launch, undefined, {})).rejects.toThrow(/before launch/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('stops the running client FIRST, then launches with the same token and the previous options', async () => {
    const g = {};
    const order: string[] = [];
    const previous = { stop: vi.fn(async () => void order.push('stop')) };
    setCarrierClient(previous, g);
    setCarrierLastLaunch('tok', { endpoint: 'x' }, g);
    const next = { stop: vi.fn() };
    const launch = vi.fn(async () => {
      order.push('launch');
      return next;
    });
    const result = await relaunchWith(launch, undefined, g);
    expect(result).toBe(next);
    expect(order).toEqual(['stop', 'launch']);
    expect(launch).toHaveBeenCalledWith('tok', { endpoint: 'x' });
  });

  it('uses NEW options instead of the previous ones when given, and works with no client running', async () => {
    const g = {};
    setCarrierLastLaunch('tok', { endpoint: 'old' }, g);
    const next = { stop: vi.fn() };
    const launch = vi.fn(() => next);
    expect(await relaunchWith(launch, { endpoint: 'new' }, g)).toBe(next);
    expect(launch).toHaveBeenCalledWith('tok', { endpoint: 'new' });
    expect(getCarrier(g).lastLaunch?.options).toEqual({ endpoint: 'old' }); // recording is the launcher's job
  });

  it('defaults to the real globalThis carrier', async () => {
    setCarrierLastLaunch('g-tok', { a: 1 });
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined);
    expect(launch).toHaveBeenCalledWith('g-tok', { a: 1 });
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });
});
