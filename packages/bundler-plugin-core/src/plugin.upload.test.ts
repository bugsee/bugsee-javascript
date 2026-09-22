import type { UnpluginOptions } from 'unplugin';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugseePluginOptions, ResolvedPluginOptions } from './resolve';

// The upload call itself is stubbed — everything else (option resolution, output-dir resolution, the hook
// wiring) is the real code. This file is separate from plugin.test.ts precisely so that file keeps running
// against the unmocked module.
const { uploadSpy } = vi.hoisted(() => ({
  uploadSpy: vi.fn(async (_resolved: unknown, _outDir: string, _deps?: unknown) => undefined),
}));
vi.mock('./resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve')>()),
  runPluginUpload: uploadSpy,
}));
// The in-build stamp is stubbed here: this file tests the HOOK wiring. stamp-assets.test.ts runs the
// real CLI, and the SRI e2e runs the whole thing through a real webpack build.
const { stampSpy } = vi.hoisted(() => ({
  stampSpy: vi.fn(async (_store: unknown, _options?: unknown) => ({ stamped: [] as string[] })),
}));
vi.mock('./stamp-assets', () => ({ stampAssets: stampSpy }));

const { bugseeUnpluginFactory } = await import('./plugin');

const makePlugin = (options?: BugseePluginOptions): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework: 'rollup' }) as UnpluginOptions;

type WriteBundle = (output: { dir?: string; file?: string }) => Promise<void>;
const viteWriteBundle = (p: UnpluginOptions): WriteBundle =>
  (p.vite as unknown as { writeBundle: WriteBundle }).writeBundle;
const rollupWriteBundle = (p: UnpluginOptions): WriteBundle =>
  (p.rollup as unknown as { writeBundle: WriteBundle }).writeBundle;

/** The slice of a webpack compiler the plugin taps, with the registered hook captured. */
function fakeCompiler(outputPath: string | undefined, mode?: string) {
  const taps: Array<{ name: string; fn: () => Promise<void> }> = [];
  const compiler = {
    options: {
      output: outputPath === undefined ? undefined : { path: outputPath },
      ...(mode !== undefined ? { mode } : {}),
    },
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

  // What the BUNDLER says about the build is what decides whether it registers (D2) — the analog of
  // AGP's `isDebuggable`. Each bundler says it differently, so each hook has to pass it on.
  describe('hands the bundler’s own production signal to the run', () => {
    type ConfigResolved = (config: { isProduction: boolean; mode: string }) => void;
    const viteConfigResolved = (p: UnpluginOptions): ConfigResolved =>
      (p.vite as unknown as { configResolved: ConfigResolved }).configResolved;
    const bundlerOf = (call: number) =>
      (uploadSpy.mock.calls[call]?.[2] as { bundler?: unknown } | undefined)?.bundler;

    it('vite: its resolved isProduction and mode', async () => {
      // `isProduction`, not `mode === 'production'`: `vite build --mode staging` is a production
      // build, and a mode-name check would skip registering every staging release.
      const plugin = makePlugin({ appToken: 'tok' });
      viteConfigResolved(plugin)({ isProduction: true, mode: 'staging' });
      await viteWriteBundle(plugin)({ dir: '/out' });
      expect(bundlerOf(0)).toEqual({ isProduction: true, configuration: 'staging' });
    });

    it('vite: a dev-mode build says so', async () => {
      const plugin = makePlugin({ appToken: 'tok' });
      viteConfigResolved(plugin)({ isProduction: false, mode: 'development' });
      await viteWriteBundle(plugin)({ dir: '/out' });
      expect(bundlerOf(0)).toEqual({ isProduction: false, configuration: 'development' });
    });

    it('rollup: nothing, so the run falls back to NODE_ENV', async () => {
      await rollupWriteBundle(makePlugin({ appToken: 'tok' }))({ dir: '/out' });
      expect(bundlerOf(0)).toEqual({});
    });

    it('webpack: its mode, read when the build is emitted', async () => {
      const { compiler, taps } = fakeCompiler('/build/out', 'production');
      (makePlugin({ appToken: 'tok' }).webpack as (c: unknown) => void)(compiler);
      await taps[0]?.fn();
      expect(bundlerOf(0)).toEqual({ isProduction: true, configuration: 'production' });
    });

    it("webpack: 'development' and 'none' are not production", async () => {
      for (const mode of ['development', 'none']) {
        uploadSpy.mockClear();
        const { compiler, taps } = fakeCompiler('/build/out', mode);
        (makePlugin({ appToken: 'tok' }).webpack as (c: unknown) => void)(compiler);
        await taps[0]?.fn();
        expect(bundlerOf(0)).toEqual({ isProduction: false, configuration: mode });
      }
    });

    it('webpack: an UNSET mode is a production build, because webpack says so', async () => {
      // webpack never writes the default back — `compiler.options.mode` stays undefined — but it
      // BUILDS as production: `const production = mode === "production" || !mode`
      // (lib/config/defaults.js). Reading the field alone would skip registering exactly the builds
      // of a config that never set a mode, which webpack only warns about.
      const { compiler, taps } = fakeCompiler('/build/out');
      (makePlugin({ appToken: 'tok' }).webpack as (c: unknown) => void)(compiler);
      await taps[0]?.fn();
      expect(bundlerOf(0)).toEqual({ isProduction: true, configuration: 'production' });
    });
  });

  // The real SRI fix (stamp-assets.ts): on webpack 5 the bundles are stamped INSIDE the compilation,
  // at a stage after the maps exist and before webpack-subresource-integrity takes its hashes.
  describe('webpack 5: stamps inside the compilation', () => {
    const DEV_TOOLING = 500;

    class RawSource {
      constructor(readonly bytes: Buffer) {}
    }

    function webpack5Compiler(options: { mode?: string } = {}) {
      const base = fakeCompiler('/build/out', options.mode);
      const processAssets: Array<{ name: string; stage: number; fn: () => Promise<void> }> = [];
      const updated: Array<{ name: string; source: unknown }> = [];
      const compilation = {
        hooks: {
          processAssets: {
            tapPromise: (opts: { name: string; stage: number }, fn: () => Promise<void>) => {
              processAssets.push({ ...opts, fn });
            },
          },
        },
        getAssets: () => [{ name: 'main.js' }, { name: 'main.js.map' }],
        getAsset: (name: string) => ({
          source: { buffer: () => Buffer.from(`content of ${name}`) },
        }),
        updateAsset: (name: string, source: unknown) => {
          updated.push({ name, source });
        },
      };
      const compilations: Array<(c: unknown) => void> = [];
      const compiler = {
        ...base.compiler,
        webpack: {
          Compilation: { PROCESS_ASSETS_STAGE_DEV_TOOLING: DEV_TOOLING },
          sources: { RawSource },
        },
        hooks: {
          ...base.compiler.hooks,
          thisCompilation: {
            tap: (_name: string, fn: (c: unknown) => void) => {
              compilations.push(fn);
            },
          },
        },
      };
      const compile = async (): Promise<void> => {
        for (const fn of compilations) {
          fn(compilation);
        }
        for (const tap of processAssets) {
          await tap.fn();
        }
      };
      return { compiler, taps: base.taps, processAssets, updated, compile };
    }

    const apply = (options: BugseePluginOptions, compiler: unknown): void =>
      (makePlugin(options).webpack as (c: unknown) => void)(compiler);

    beforeEach(() => {
      stampSpy.mockReset();
      stampSpy.mockImplementation(async () => ({ stamped: [] }));
    });

    it('stamps after the maps are emitted and before SRI hashes', async () => {
      const w = webpack5Compiler();
      apply({ appToken: 'tok' }, w.compiler);
      await w.compile();

      expect(w.processAssets).toHaveLength(1);
      // Maps are emitted AT 500 (SourceMapDevToolPlugin); webpack-subresource-integrity hashes at 700
      // (PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE). Anything in between sees the final bytes AND is hashed.
      expect(w.processAssets[0]?.stage).toBe(DEV_TOOLING + 1);
      expect(w.processAssets[0]?.name).toBe('bugsee');
      expect(stampSpy).toHaveBeenCalledOnce();
    });

    it('then uploads WITHOUT re-injecting after emit', async () => {
      const w = webpack5Compiler({ mode: 'production' });
      apply({ appToken: 'tok' }, w.compiler);
      await w.compile();
      await w.taps[0]?.fn();

      const deps = uploadSpy.mock.calls[0]?.[2] as { preStamped?: boolean };
      expect(deps.preStamped).toBe(true);
    });

    it('reads and writes the compilation’s own asset table', async () => {
      stampSpy.mockImplementation(async (store) => {
        const s = store as {
          names(): string[];
          read(n: string): Buffer;
          update(n: string, c: Buffer): void;
        };
        expect(s.names()).toEqual(['main.js', 'main.js.map']);
        expect(s.read('main.js').toString()).toBe('content of main.js');
        s.update('main.js', Buffer.from('stamped'));
        return { stamped: ['main.js'] };
      });
      const w = webpack5Compiler();
      apply({ appToken: 'tok' }, w.compiler);
      await w.compile();

      // Replaced through webpack's API, as a RawSource from webpack's OWN `sources` — never a copy of
      // webpack-sources that could differ from the one the compilation uses.
      expect(w.updated).toHaveLength(1);
      expect(w.updated[0]?.name).toBe('main.js');
      expect(w.updated[0]?.source).toBeInstanceOf(RawSource);
      expect((w.updated[0]?.source as RawSource).bytes.toString()).toBe('stamped');
    });

    it('passes the dry-run flag to the stamp', async () => {
      const w = webpack5Compiler();
      apply({ appToken: 'tok', dryRun: true }, w.compiler);
      await w.compile();
      expect(stampSpy.mock.calls[0]?.[1]).toEqual({ dryRun: true });
    });

    it('falls back to the post-emit path when the in-build stamp fails', async () => {
      // The post-emit path still carries the SRI refusal, so a failed in-build stamp degrades to the
      // old, safe behaviour rather than to a page nobody checked.
      stampSpy.mockImplementation(async () => {
        throw new Error('bugsee-cli exited 20');
      });
      const onError = vi.fn();
      const w = webpack5Compiler();
      apply({ appToken: 'tok', onError }, w.compiler);
      await w.compile();
      await w.taps[0]?.fn();

      expect(onError).toHaveBeenCalledOnce();
      expect((uploadSpy.mock.calls[0]?.[2] as { preStamped?: boolean }).preStamped).toBe(false);
    });

    it('says what happens next when a stamp fails and no handler is set', async () => {
      // The fallback is not silent: the build is about to take the post-emit path instead.
      stampSpy.mockImplementation(async () => {
        throw new Error('bugsee-cli exited 20');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const w = webpack5Compiler();
        apply({ appToken: 'tok' }, w.compiler);
        await w.compile();
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]?.[0])).toMatch(
          /\[bugsee\] in-build debug-ID stamping failed; falling back to stamping after emit: .*exited 20/,
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('fails the compilation over a failed stamp under failOnError', async () => {
      stampSpy.mockImplementation(async () => {
        throw new Error('bugsee-cli exited 20');
      });
      const w = webpack5Compiler();
      apply({ appToken: 'tok', failOnError: true }, w.compiler);
      await expect(w.compile()).rejects.toThrow(/exited 20/);
    });

    it('starts each compilation unstamped (watch mode)', async () => {
      const w = webpack5Compiler();
      apply({ appToken: 'tok', onError: () => undefined }, w.compiler);
      await w.compile();
      await w.taps[0]?.fn();
      stampSpy.mockImplementation(async () => {
        throw new Error('second build failed to stamp');
      });
      await w.compile();
      await w.taps[0]?.fn();

      // A stamp from the PREVIOUS compilation must not vouch for this one.
      expect((uploadSpy.mock.calls[1]?.[2] as { preStamped?: boolean }).preStamped).toBe(false);
    });

    it('does not stamp at all for a disabled plugin', async () => {
      const w = webpack5Compiler();
      apply({ disabled: true }, w.compiler);
      await w.compile();
      expect(w.processAssets).toHaveLength(0);
      expect(stampSpy).not.toHaveBeenCalled();
    });

    it('keeps the post-emit path on a webpack without processAssets (webpack 4)', async () => {
      const { compiler, taps } = fakeCompiler('/build/out');
      apply({ appToken: 'tok' }, compiler);
      await taps[0]?.fn();
      expect(stampSpy).not.toHaveBeenCalled();
      expect((uploadSpy.mock.calls[0]?.[2] as { preStamped?: boolean }).preStamped).toBe(false);
    });
  });
});
