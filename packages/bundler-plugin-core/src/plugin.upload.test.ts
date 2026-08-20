import type { UnpluginOptions } from 'unplugin';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugseePluginOptions, ResolvedPluginOptions } from './resolve';

// The upload call itself is stubbed — everything else (option resolution, output-dir resolution, the hook
// wiring) is the real code. This file is separate from plugin.test.ts precisely so that file keeps running
// against the unmocked module.
const { uploadSpy } = vi.hoisted(() => ({
  uploadSpy: vi.fn(async (_resolved: unknown, _outDir: string) => undefined),
}));
vi.mock('./resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve')>()),
  runPluginUpload: uploadSpy,
}));

const { bugseeUnpluginFactory } = await import('./plugin');

const makePlugin = (options?: BugseePluginOptions): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework: 'rollup' }) as UnpluginOptions;

type WriteBundle = (output: { dir?: string; file?: string }) => Promise<void>;
const viteWriteBundle = (p: UnpluginOptions): WriteBundle =>
  (p.vite as unknown as { writeBundle: WriteBundle }).writeBundle;
const rollupWriteBundle = (p: UnpluginOptions): WriteBundle =>
  (p.rollup as unknown as { writeBundle: WriteBundle }).writeBundle;

/** The slice of a webpack compiler the plugin taps, with the registered hook captured. */
function fakeCompiler(outputPath: string | undefined) {
  const taps: Array<{ name: string; fn: () => Promise<void> }> = [];
  const compiler = {
    options: { output: outputPath === undefined ? undefined : { path: outputPath } },
    hooks: {
      afterEmit: {
        tapPromise: (name: string, fn: () => Promise<void>) => {
          taps.push({ name, fn });
        },
      },
    },
  };
  return { compiler, taps };
}

describe('the output hooks actually drive the upload', () => {
  beforeEach(() => {
    uploadSpy.mockClear();
  });

  it('vite writeBundle uploads for the resolved output directory', async () => {
    // The whole point of the plugin. Nothing asserted that the hook reached the upload at all — the
    // existing hook tests all ran with `disabled: true`, where a no-op is the correct behaviour.
    await viteWriteBundle(makePlugin({ appToken: 'tok', appVersion: '2.1.0' }))({ dir: '/out' });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [resolved, outDir] = uploadSpy.mock.calls[0] as [ResolvedPluginOptions, string];
    expect(outDir).toBe('/out');
    expect(resolved).toMatchObject({ enabled: true, appToken: 'tok', appVersion: '2.1.0' });
  });

  it('rollup writeBundle uploads for the DIRECTORY of a single-file output', async () => {
    await rollupWriteBundle(makePlugin({ appToken: 'tok' }))({ file: '/out/legacy/app.js' });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0]?.[1]).toBe('/out/legacy');
  });

  it('does NOT upload when the output has no resolvable directory', async () => {
    // The enabled plugin is what makes this discriminating: with a disabled one the no-op is free.
    await viteWriteBundle(makePlugin({ appToken: 'tok' }))({});
    await viteWriteBundle(makePlugin({ appToken: 'tok' }))({ dir: '', file: '' });
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('webpack taps afterEmit under the plugin name and uploads the compiler output path', async () => {
    const { compiler, taps } = fakeCompiler('/build/webpack-out');
    (makePlugin({ appToken: 'tok' }).webpack as (c: unknown) => void)(compiler);
    expect(taps).toHaveLength(1);
    expect(taps[0]?.name).toBe('bugsee');
    await taps[0]?.fn();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0]?.[1]).toBe('/build/webpack-out');
  });

  it('webpack afterEmit is a no-op when the compiler has no usable output path', async () => {
    for (const path of [undefined, '']) {
      const { compiler, taps } = fakeCompiler(path);
      (makePlugin({ appToken: 'tok' }).webpack as (c: unknown) => void)(compiler);
      await taps[0]?.fn();
    }
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});
