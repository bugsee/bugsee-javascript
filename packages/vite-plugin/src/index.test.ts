import { describe, expect, it } from 'vitest';
import defaultExport, { bugseeVitePlugin } from './index';

describe('@bugsee/vite-plugin', () => {
  it('exposes a plugin factory (named + default export are the same)', () => {
    expect(typeof bugseeVitePlugin).toBe('function');
    expect(defaultExport).toBe(bugseeVitePlugin);
  });

  it('builds a Vite plugin named "bugsee" (disabled config → no-op, safe to construct)', () => {
    const plugin = bugseeVitePlugin({ disabled: true });
    const one = Array.isArray(plugin) ? plugin[0] : plugin;
    expect(one?.name).toBe('bugsee');
    expect(typeof (one as { writeBundle?: unknown }).writeBundle).toBe('function');
  });
});
