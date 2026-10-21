import { describe, expect, it } from 'vitest';
import * as nodeEntry from './index';

// Kept beside the entry (not in ../index.test.ts): the portable typecheck program must never reach src/node.
describe('@bugsee/trackers/node public surface', () => {
  it('exports the node tracker values', () => {
    expect(Object.keys(nodeEntry).sort()).toEqual([
      'ProcessTracker',
      'StorageTracker',
      'createGcSource',
      'createGuardedElu',
      'createGuardedEventLoopSource',
      'createMemoryLimitReader',
      'createProcMeminfoReader',
      'createSystemFreeReader',
      'createV8HeapReader',
      'eluUnavailable',
      'parseMemAvailable',
      'processTrackerFor',
      'realPerfHooks',
      'resetProcessTracker',
      'resetStorageTracker',
      'storageTrackerFor',
    ]);
  });
});
