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

  it('reserves the node/electron entries as empty placeholders', async () => {
    for (const entry of ['./node/index', './electron/index']) {
      expect(Object.keys(await import(entry))).toEqual([]);
    }
  });

  it('exports the browser tracker values from ./browser', async () => {
    expect(Object.keys(await import('./browser/index')).sort()).toEqual([
      'PowerTracker',
      'UiTracker',
      'hostRead',
      'powerTrackerFor',
      'resetPowerTracker',
      'resetUiTracker',
      'uiTrackerFor',
    ]);
  });
});
