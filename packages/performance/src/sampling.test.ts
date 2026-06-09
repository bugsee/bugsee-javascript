import { describe, expect, it } from 'vitest';
import { createRateSampler } from './sampling';

describe('createRateSampler', () => {
  it('samples everything at rate >= 1 (without consulting the RNG)', () => {
    let consulted = false;
    const sample = createRateSampler(1, () => {
      consulted = true;
      return 0;
    });
    expect(sample()).toBe(true);
    expect(sample()).toBe(true);
    expect(consulted).toBe(false);
    expect(createRateSampler(2)()).toBe(true); // clamped: >1 still always-on
  });

  it('samples nothing at rate <= 0 (without consulting the RNG)', () => {
    let consulted = false;
    const sample = createRateSampler(0, () => {
      consulted = true;
      return 0;
    });
    expect(sample()).toBe(false);
    expect(consulted).toBe(false);
    expect(createRateSampler(-1)()).toBe(false);
  });

  it('samples in iff random() < rate (the head-sampling decision)', () => {
    const queue = [0.1, 0.25, 0.5, 0.9];
    const sample = createRateSampler(0.25, () => queue.shift() ?? 1);
    expect(sample()).toBe(true); // 0.1 < 0.25
    expect(sample()).toBe(false); // 0.25 NOT < 0.25 (boundary)
    expect(sample()).toBe(false); // 0.5
    expect(sample()).toBe(false); // 0.9
  });

  it('defaults to Math.random and stays within [false,true] over many draws', () => {
    const sample = createRateSampler(0.5);
    for (let i = 0; i < 50; i++) expect(typeof sample()).toBe('boolean');
  });
});
