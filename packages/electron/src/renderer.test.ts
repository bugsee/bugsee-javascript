import { describe, expect, it } from 'vitest';
import * as renderer from './renderer';

describe('@bugsee/electron/renderer entry', () => {
  it('re-exports the renderer API', () => {
    expect(typeof renderer.launchRenderer).toBe('function');
    expect(typeof renderer.createElectronRendererCaptureStore).toBe('function');
    expect(typeof renderer.resolveRendererPost).toBe('function');
  });
});
