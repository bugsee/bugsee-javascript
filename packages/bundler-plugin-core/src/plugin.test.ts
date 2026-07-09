import type { UnpluginOptions } from 'unplugin';
import { describe, expect, it } from 'vitest';
import { bugseeUnplugin, bugseeUnpluginFactory, resolveOutputDir } from './plugin';
import type { BugseePluginOptions } from './resolve';

/** Invoke the factory (which requires a meta arg) and narrow its single-object result. */
const makePlugin = (options?: BugseePluginOptions): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework: 'rollup' }) as UnpluginOptions;

describe('resolveOutputDir', () => {
  it('uses `dir` when present', () => {
    expect(resolveOutputDir({ dir: '/build/dist' })).toBe('/build/dist');
  });

  it('derives the directory from `file` when there is no `dir`', () => {
    expect(resolveOutputDir({ file: '/build/dist/app.js' })).toBe('/build/dist');
  });

  it('returns undefined when neither dir nor file is set (or empty)', () => {
    expect(resolveOutputDir({})).toBeUndefined();
    expect(resolveOutputDir({ dir: '', file: '' })).toBeUndefined();
  });
});

describe('bugseeUnpluginFactory', () => {
  it('produces a plugin named "bugsee" with vite/rollup/webpack entries', () => {
    const plugin = makePlugin({ disabled: true });
    expect(plugin.name).toBe('bugsee');
    expect(plugin.vite).toBeDefined();
    expect(plugin.rollup).toBeDefined();
    expect(typeof plugin.webpack).toBe('function');
  });

  it('vite/rollup writeBundle resolve without error when the plugin is disabled (no upload)', async () => {
    const plugin = makePlugin({ disabled: true });
    const vite = plugin.vite as { writeBundle: (o: { dir?: string }) => Promise<void> };
    const rollup = plugin.rollup as { writeBundle: (o: { file?: string }) => Promise<void> };
    await expect(vite.writeBundle({ dir: '/out' })).resolves.toBeUndefined();
    await expect(rollup.writeBundle({ file: '/out/app.js' })).resolves.toBeUndefined();
  });

  it('writeBundle with no resolvable output dir is a no-op (does not throw)', async () => {
    const plugin = makePlugin({ disabled: true });
    const vite = plugin.vite as { writeBundle: (o: object) => Promise<void> };
    await expect(vite.writeBundle({})).resolves.toBeUndefined();
  });
});

describe('bugseeUnplugin', () => {
  it('exposes per-bundler factories (vite, webpack, rollup, …)', () => {
    expect(typeof bugseeUnplugin.vite).toBe('function');
    expect(typeof bugseeUnplugin.webpack).toBe('function');
    expect(typeof bugseeUnplugin.rollup).toBe('function');
  });
});
