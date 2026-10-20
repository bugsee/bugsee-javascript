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

  it('reserves the electron entry as an empty placeholder', async () => {
    expect(Object.keys(await import('./electron/index'))).toEqual([]);
  });

  it('exports the browser tracker values from ./browser', async () => {
    expect(Object.keys(await import('./browser/index')).sort()).toEqual([
      'ApplicationTracker',
      'ConnectivityTracker',
      'DEFAULT_PERMISSION_NAMES',
      'EnvironmentTracker',
      'NORMAL_QUOTA_FROM_BYTES',
      'PRIVATE_QUOTA_BELOW_BYTES',
      'PowerTracker',
      'ProcessTracker',
      'StorageTracker',
      'UiTracker',
      'applicationTrackerFor',
      'connectivityTrackerFor',
      'environmentTrackerFor',
      'hostRead',
      'powerTrackerFor',
      'processTrackerFor',
      'resetApplicationTracker',
      'resetConnectivityTracker',
      'resetEnvironmentTracker',
      'resetPowerTracker',
      'resetProcessTracker',
      'resetStorageTracker',
      'resetUiTracker',
      'storageTrackerFor',
      'uiTrackerFor',
    ]);
  });
});
