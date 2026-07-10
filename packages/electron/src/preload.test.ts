import { describe, expect, it } from 'vitest';
import * as preload from './preload';

describe('@bugsee/electron/preload entry', () => {
  it('re-exports the preload API + shared constants', () => {
    expect(typeof preload.registerBugseePreload).toBe('function');
    expect(preload.BUGSEE_BRIDGE_KEY).toBe('__bugseeElectron');
    expect(preload.BUGSEE_STREAM_CHANNEL).toBe('bugsee:stream');
  });
});
