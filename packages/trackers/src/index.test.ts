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

  it('exposes the browser tracker implementations on ./browser', async () => {
    expect(Object.keys(await import('./browser/index')).sort()).toEqual([
      'ApplicationTracker',
      'PowerTracker',
      'applicationTrackerFor',
      'hostRead',
      'powerTrackerFor',
      'resetApplicationTracker',
      'resetPowerTracker',
    ]);
  });

  it('reserves the node and electron entries as empty placeholders', async () => {
    for (const entry of ['./node/index', './electron/index']) {
      expect(Object.keys(await import(entry))).toEqual([]);
    }
  });

  it('exports the browser tracker values from ./browser', async () => {
    expect(Object.keys(await import('./browser/index')).sort()).toEqual([
      'PowerTracker',
      'hostRead',
      'powerTrackerFor',
      'resetPowerTracker',
    ]);
  });
});
