import { describe, expect, it } from 'vitest';
import * as main from './main';

describe('@bugsee/electron/main entry', () => {
  it('re-exports the main-process API', () => {
    expect(typeof main.launchMain).toBe('function');
    expect(typeof main.createElectronMainReceiver).toBe('function');
  });
});
