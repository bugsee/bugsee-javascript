import { describe, expect, it } from 'vitest';
import * as trackers from './index';

describe('@bugsee/trackers public surface', () => {
  it('exports exactly the foundation runtime values', () => {
    expect(Object.keys(trackers).sort()).toEqual([
      'InterceptorBase',
      'MultiKeyEmitterBase',
      'createMultiKeyEmitter',
      'createTrackerRegistry',
    ]);
  });

  it('reserves the per-runtime entries as empty placeholders', async () => {
    for (const entry of ['./browser/index', './node/index', './electron/index']) {
      expect(Object.keys(await import(entry))).toEqual([]);
    }
  });
});
