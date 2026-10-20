import { describe, expect, it } from 'vitest';
import * as electronEntry from './index';

// Kept beside the entry (not in ../index.test.ts): the portable typecheck program must never reach src/electron.
describe('@bugsee/trackers/electron public surface', () => {
  it('exports the electron tracker values', () => {
    expect(Object.keys(electronEntry).sort()).toEqual([
      'ElectronProcessTracker',
      'electronProcessTrackerFor',
      'mapGpuInfo',
      'resetElectronProcessTracker',
    ]);
  });
});
