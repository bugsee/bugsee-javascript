import { describe, expect, it } from 'vitest';
import * as iife from './iife';
import { launch } from './launch';

// The IIFE entry is the surface that becomes the `BugseeWebView` global in the injectable build. The build
// itself (self-contained single-string, node-free, size-budgeted) is guarded in the e2e harness
// (instrumentation-tests/test/webview-bundle.e2e.ts), which bundles this entry with esbuild. Here we just pin
// the entry's exported surface — the global must expose `launch` + a version string.
describe('iife entry (the BugseeWebView global surface)', () => {
  it('re-exports the real launch function', () => {
    expect(iife.launch).toBe(launch);
  });

  it('exposes a version string', () => {
    expect(typeof iife.VERSION).toBe('string');
    expect(iife.VERSION.length).toBeGreaterThan(0);
  });
});
