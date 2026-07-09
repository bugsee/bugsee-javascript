import { describe, expect, it } from 'vitest';
import defaultExport, { bugseeWebpackPlugin } from './index';

describe('@bugsee/webpack-plugin', () => {
  it('exposes a plugin factory (named + default export are the same)', () => {
    expect(typeof bugseeWebpackPlugin).toBe('function');
    expect(defaultExport).toBe(bugseeWebpackPlugin);
  });

  it('builds a Webpack plugin instance with an apply() method (disabled config → safe to construct)', () => {
    const plugin = bugseeWebpackPlugin({ disabled: true });
    expect(typeof plugin.apply).toBe('function');
  });
});
