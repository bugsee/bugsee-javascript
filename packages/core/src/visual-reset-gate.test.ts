import { describe, expect, it, vi } from 'vitest';
import { createVisualResetGate } from './visual-reset-gate';

const make = (over: { ready?: () => boolean } = {}) => {
  let now = 0;
  const restart = vi.fn();
  const gate = createVisualResetGate({ now: () => now, restart, ...over });
  return { gate, restart, at: (t: number) => (now = t) };
};

describe('createVisualResetGate', () => {
  it('restarts on the first reset', () => {
    const { gate, restart, at } = make();
    at(0);
    gate();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('does not restart again within the 5 s quiet period, and does once it has passed', () => {
    const { gate, restart, at } = make();
    at(0);
    gate();
    at(4_999);
    gate();
    expect(restart).toHaveBeenCalledTimes(1);
    at(5_000);
    gate();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('backs off (doubling, capped at 5 min) while resets keep coming', () => {
    const { gate, restart, at } = make();
    const times = [0, 5_000, 15_000, 35_000, 75_000, 155_000, 315_000, 615_000];
    const calls: number[] = [];
    for (const t of times) {
      at(t);
      const before = restart.mock.calls.length;
      gate();
      calls.push(restart.mock.calls.length - before);
    }
    // each gap equals the interval in force (5, 10, 20, 40, 80, 160, 300 s: capped)
    expect(calls).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    at(615_000 + 299_999);
    gate();
    expect(restart).toHaveBeenCalledTimes(8);
    at(615_000 + 300_000);
    gate();
    expect(restart).toHaveBeenCalledTimes(9);
  });

  it('starts over at 5 s after a quiet spell of more than ten minutes, but not after exactly ten', () => {
    const { gate, restart, at } = make();
    at(0);
    gate();
    at(5_000);
    gate(); // interval is now 10 s
    at(5_000 + 600_000); // exactly ten minutes: not yet "long enough"
    gate();
    expect(restart).toHaveBeenCalledTimes(3);
    at(5_000 + 600_000 + 9_999); // still inside the doubled (20 s) interval
    gate();
    expect(restart).toHaveBeenCalledTimes(3);
    at(5_000 + 600_000 + 600_001 + 10_000);
    gate(); // long quiet: back to 5 s
    expect(restart).toHaveBeenCalledTimes(4);
    at(5_000 + 600_000 + 600_001 + 10_000 + 5_000);
    gate();
    expect(restart).toHaveBeenCalledTimes(5);
  });

  it('does not spend the budget on a reset that arrives while not ready', () => {
    let ready = false;
    const { gate, restart, at } = make({ ready: () => ready });
    at(0);
    gate();
    expect(restart).not.toHaveBeenCalled();
    ready = true;
    at(1);
    gate(); // not held back by the earlier ignored reset
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('contains nothing a throwing restart could leave half-done: the budget is spent before it runs', () => {
    const restart = vi.fn(() => {
      throw new Error('boom');
    });
    let now = 0;
    const gate = createVisualResetGate({ now: () => now, restart });
    expect(() => gate()).toThrow('boom');
    now = 1;
    expect(() => gate()).not.toThrow(); // inside the quiet period: skipped, not retried
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
