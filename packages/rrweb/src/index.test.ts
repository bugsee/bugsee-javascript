import { describe, expect, it } from 'vitest';
import { record } from './index';

describe('@bugsee/rrweb wrapper', () => {
  it('re-exports the rrweb record function (the single record-path import point)', () => {
    // The wrapper decouples @bugsee/replay from rrweb's packaging — swapping npm → the Bugsee fork touches
    // only this module. Assert the value it forwards is rrweb's callable record().
    expect(typeof record).toBe('function');
  });
});
