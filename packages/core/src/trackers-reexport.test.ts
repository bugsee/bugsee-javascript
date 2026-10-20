import * as trackers from '@bugsee/trackers';
import { describe, expect, it } from 'vitest';
import * as core from './index';

// Core re-exports the tracker foundation; downstream packages keep importing these names from
// @bugsee/core, so they must BE the trackers package's values (not copies).
describe('@bugsee/core re-exports @bugsee/trackers', () => {
  it.each([
    'InterceptorBase',
    'MultiKeyEmitterBase',
    'createMultiKeyEmitter',
    'createTrackerRegistry',
  ] as const)('%s is the identical binding', (name) => {
    expect(core[name]).toBe(trackers[name]);
  });
});
