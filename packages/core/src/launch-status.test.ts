import { describe, expect, it } from 'vitest';
import { BugseeStatus } from './launch-status';

describe('BugseeStatus', () => {
  it('uses the mobile numeric values (BugseeStatus / Bugsee.Status)', () => {
    expect(BugseeStatus.Stopped).toBe(0);
    expect(BugseeStatus.Launching).toBe(1);
    expect(BugseeStatus.Launched).toBe(2);
    expect(BugseeStatus.Stopping).toBe(3);
  });
});
