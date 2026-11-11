import { resolve } from 'node:path';
import type { UnpluginOptions } from 'unplugin';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugseePluginOptions, ResolvedPluginOptions } from './resolve';

// #184 hook wiring: esbuild `onEnd` and Rspack `afterEmit` reach `runPluginUpload` exactly as Vite/Rollup
// `writeBundle` and webpack `afterEmit` do. The upload itself (and its SRI guard) is `runPluginUpload`'s,
// covered in orchestrate/resolve tests; `plugin.real-build.test.ts` drives the same hooks through real
// esbuild and Rspack builds.
const { uploadSpy } = vi.hoisted(() => ({
  uploadSpy: vi.fn(async (_resolved: unknown, _outDir: string, _deps?: unknown) => undefined),
}));
vi.mock('./resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve')>()),
  runPluginUpload: uploadSpy,
}));

const { bugseeUnpluginFactory } = await import('./plugin');
const makePlugin = (options?: BugseePluginOptions, framework = 'esbuild'): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework } as never) as UnpluginOptions;

interface EndResult {
  errors: unknown[];
}
type FakeBuild = {
  initialOptions: {
    outdir?: string;
    outfile?: string;
    absWorkingDir?: string;
    write?: boolean;
    sourcemap?: boolean | string;
    define?: Record<string, string>;
  };
  onEnd: (cb: (result: EndResult) => Promise<void>) => void;
};
function esbuildRun(options: BugseePluginOptions, initialOptions: FakeBuild['initialOptions']) {
  const ends: Array<(result: EndResult) => Promise<void>> = [];
  const build: FakeBuild = { initialOptions, onEnd: (cb) => ends.push(cb) };
  const hooks = makePlugin(options).esbuild as unknown as {
    config: (o: FakeBuild['initialOptions']) => void;
    setup: (b: FakeBuild) => void;
  };
  hooks.config(initialOptions);
  hooks.setup(build);
  return { ends, end: (result: EndResult = { errors: [] }) => ends[0]?.(result) };
}

const bundlerOf = (call: number) =>
  (uploadSpy.mock.calls[call]?.[2] as { bundler?: unknown } | undefined)?.bundler;

describe('esbuild: upload at the end of the build', () => {
  beforeEach(() => uploadSpy.mockClear());

  it('registers ONE onEnd and uploads the outdir once the build is on disk', async () => {
    const run = esbuildRun({ appToken: 'tok', appVersion: '3.0.0' }, { outdir: '/abs/dist' });
    expect(run.ends).toHaveLength(1);
    expect(uploadSpy).not.toHaveBeenCalled();
    await run.end();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [resolved, outDir] = uploadSpy.mock.calls[0] as [ResolvedPluginOptions, string];
    expect(outDir).toBe('/abs/dist');
    expect(resolved).toMatchObject({ enabled: true, appToken: 'tok', appVersion: '3.0.0' });
    // esbuild states nothing about production, so the run falls back to NODE_ENV.
    expect(bundlerOf(0)).toEqual({});
  });

  it('resolves a relative outdir against absWorkingDir', async () => {
    await esbuildRun({ appToken: 'tok' }, { outdir: 'out', absWorkingDir: '/proj/app' }).end();
    expect(uploadSpy.mock.calls[0]?.[1]).toBe(resolve('/proj/app', 'out'));
  });

  it('uses the directory of a single outfile', async () => {
    await esbuildRun({ appToken: 'tok' }, { outfile: '/abs/dist/app.js' }).end();
    expect(uploadSpy.mock.calls[0]?.[1]).toBe('/abs/dist');
  });

  it('resolves a relative outdir against the cwd when there is no absWorkingDir', async () => {
    await esbuildRun({ appToken: 'tok' }, { outdir: 'rel-out' }).end();
    expect(uploadSpy.mock.calls[0]?.[1]).toBe(resolve('rel-out'));
  });

  it('does nothing for a relative outdir when the working directory is gone', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: uv_cwd');
    });
    try {
      await esbuildRun({ appToken: 'tok' }, { outdir: 'rel-out' }).end();
    } finally {
      cwd.mockRestore();
    }
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('does nothing for a build that writes nothing (no outdir/outfile, or write:false)', async () => {
    await esbuildRun({ appToken: 'tok' }, {}).end();
    await esbuildRun({ appToken: 'tok' }, { outdir: '/abs/dist', write: false }).end();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('does not upload a FAILED build', async () => {
    await esbuildRun({ appToken: 'tok' }, { outdir: '/abs/dist' }).end({ errors: [{}] });
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('uploads again on every rebuild (watch mode)', async () => {
    const run = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/dist' });
    await run.end();
    await run.end();
    expect(uploadSpy).toHaveBeenCalledTimes(2);
  });

  it('a disabled or token-less plugin hands the run on, where it is a no-op', async () => {
    // The enabled/disabled decision lives in runPluginUpload, as for webpack's afterEmit.
    await esbuildRun({ appToken: 'tok', disabled: true }, { outdir: '/abs/dist' }).end();
    expect(uploadSpy.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
  });

  it('makes the build EMIT maps when the user has not asked for any', () => {
    const own: FakeBuild['initialOptions'] = { outdir: '/abs/dist' };
    esbuildRun({ appToken: 'tok' }, own);
    expect(own.sourcemap).toBe(true);
    const off: FakeBuild['initialOptions'] = { outdir: '/abs/dist', sourcemap: false };
    esbuildRun({ appToken: 'tok' }, off);
    expect(off.sourcemap).toBe(true);
  });

  it("leaves a deliberate sourcemap choice ('external', 'inline', …) and a disabled plugin alone", () => {
    for (const choice of ['external', 'linked', 'inline', 'both']) {
      const own: FakeBuild['initialOptions'] = { outdir: '/abs/dist', sourcemap: choice };
      esbuildRun({ appToken: 'tok' }, own);
      expect(own.sourcemap).toBe(choice);
    }
    const disabled: FakeBuild['initialOptions'] = { outdir: '/abs/dist' };
    esbuildRun({ appToken: 'tok', disabled: true }, disabled);
    expect(disabled.sourcemap).toBeUndefined();
  });
});

/** The slice of a Rspack compiler the plugin taps. */
function rspackCompiler(outputPath: string | undefined, mode?: string) {
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
const applyRspack = (options: BugseePluginOptions, compiler: unknown) =>
  (makePlugin(options, 'rspack').rspack as (c: unknown) => void)(compiler);

describe('rspack: upload after emit', () => {
  beforeEach(() => uploadSpy.mockClear());

  it('taps afterEmit under the plugin name and uploads the compiler output path', async () => {
    const { compiler, taps } = rspackCompiler('/build/rspack-out', 'production');
    applyRspack({ appToken: 'tok' }, compiler);
    expect(taps).toHaveLength(1);
    expect(taps[0]?.name).toBe('bugsee');
    await taps[0]?.fn();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0]?.[1]).toBe('/build/rspack-out');
    expect(bundlerOf(0)).toEqual({ isProduction: true, configuration: 'production' });
  });

  it('passes the bundler mode on, and treats an unset mode as production (same as webpack)', async () => {
    const dev = rspackCompiler('/out', 'development');
    applyRspack({ appToken: 'tok' }, dev.compiler);
    await dev.taps[0]?.fn();
    expect(bundlerOf(0)).toEqual({ isProduction: false, configuration: 'development' });
    const unset = rspackCompiler('/out');
    applyRspack({ appToken: 'tok' }, unset.compiler);
    await unset.taps[0]?.fn();
    expect(bundlerOf(1)).toEqual({ isProduction: true, configuration: 'production' });
  });

  it('is not stamped in-build: the post-emit run carries no preStamped flag', async () => {
    const { compiler, taps } = rspackCompiler('/out');
    applyRspack({ appToken: 'tok' }, compiler);
    await taps[0]?.fn();
    expect((uploadSpy.mock.calls[0]?.[2] as { preStamped?: boolean }).preStamped).toBeUndefined();
  });

  it('is a no-op when the compiler has no usable output path', async () => {
    for (const path of [undefined, '']) {
      const { compiler, taps } = rspackCompiler(path);
      applyRspack({ appToken: 'tok' }, compiler);
      await taps[0]?.fn();
    }
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});
