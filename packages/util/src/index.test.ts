import { describe, expect, it } from 'vitest';
import * as util from './index';

// Validates the public surface (and gives the re-export barrel real coverage instead of an
// exclusion). If a re-export is dropped or renamed, this fails.
describe('@bugsee/util public surface', () => {
  it('exports every documented function', () => {
    const expected = [
      'toBase64',
      'fromBase64',
      'computeBackoff',
      'deepMerge',
      'createDeferred',
      'isBrowser',
      'isBun',
      'isCloudflareWorker',
      'isDeno',
      'isElectronMain',
      'isElectronRenderer',
      'isNode',
      'isServiceWorker',
      'isVercelEdge',
      'isWebWorker',
      'gunzipSync',
      'gzipSync',
      'strFromU8',
      'strToU8',
      'unzipSync',
      'zipSync',
      'jsonSafeStringify',
      'sha256Hex',
    ];
    const surface = util as Record<string, unknown>;
    for (const name of expected) {
      expect(typeof surface[name]).toBe('function');
    }
  });
});
