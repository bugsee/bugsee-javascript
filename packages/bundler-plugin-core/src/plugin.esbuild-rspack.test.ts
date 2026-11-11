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
  beforeEach(() => {
    uploadSpy.mockReset();
    uploadSpy.mockImplementation(async () => undefined);
  });

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

  it('an `outfile` build says, once, that the whole directory is uploaded', async () => {
    const notices: string[] = [];
    const run = esbuildRun(
      { appToken: 'tok', onNotice: (m) => notices.push(m) },
      { outfile: '/abs/public/app.js' },
    );
    await run.end();
    await run.end();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('/abs/public');
    expect(notices[0]).toContain('outdir');
    // outdir builds, and disabled plugins, say nothing.
    const quiet: string[] = [];
    await esbuildRun(
      { appToken: 'tok', onNotice: (m) => quiet.push(m) },
      { outdir: '/abs/dist' },
    ).end();
    await esbuildRun(
      { appToken: 'tok', disabled: true, onNotice: (m) => quiet.push(m) },
      { outfile: '/abs/public/app.js' },
    ).end();
    expect(quiet).toEqual([]);
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

  it('makes the build EMIT external maps when the user said nothing', () => {
    // `external`, not `true`: the map is deleted after upload, so a sourceMappingURL comment would dangle.
    const own: FakeBuild['initialOptions'] = { outdir: '/abs/dist' };
    esbuildRun({ appToken: 'tok' }, own);
    expect(own.sourcemap).toBe('external');
  });

  it("leaves any explicit sourcemap choice (false, 'external', 'inline', ...) and a disabled plugin alone", () => {
    for (const choice of [false, true, 'external', 'linked', 'inline', 'both']) {
      const own: FakeBuild['initialOptions'] = { outdir: '/abs/dist', sourcemap: choice };
      esbuildRun({ appToken: 'tok' }, own);
      expect(own.sourcemap).toBe(choice);
    }
    const disabled: FakeBuild['initialOptions'] = { outdir: '/abs/dist' };
    esbuildRun({ appToken: 'tok', disabled: true }, disabled);
    expect(disabled.sourcemap).toBeUndefined();
  });

  describe('builds sharing one outdir run their uploads one after another', () => {
    it('the second build waits for the first upload and then runs its own', async () => {
      const gates: Array<() => void> = [];
      const order: string[] = [];
      uploadSpy.mockImplementation(async () => {
        const n = gates.length;
        order.push(`start${n}`);
        await new Promise<void>((r) => gates.push(r));
        order.push(`end${n}`);
        return undefined;
      });
      const plugin = makePlugin({ appToken: 'tok' }).esbuild as unknown as {
        config: (o: FakeBuild['initialOptions']) => void;
        setup: (b: FakeBuild) => void;
      };
      const ends: Array<() => Promise<void> | undefined> = [];
      for (let i = 0; i < 2; i++) {
        const initialOptions = { outdir: '/abs/shared' };
        plugin.config(initialOptions);
        plugin.setup({
          initialOptions,
          onEnd: (cb) => ends.push(() => cb({ errors: [] })),
        });
      }
      const first = ends[0]?.();
      const second = ends[1]?.();
      await new Promise((r) => setTimeout(r, 10));
      // Only the first has started: the second must not join it and must not run yet.
      expect(order).toEqual(['start0']);
      gates[0]?.();
      await first;
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(['start0', 'end0', 'start1']);
      gates[1]?.();
      await second;
      expect(uploadSpy).toHaveBeenCalledTimes(2);
    });

    it('a failed upload does not block the next build, and rejects only its own', async () => {
      uploadSpy.mockImplementationOnce(async () => {
        throw new Error('boom');
      });
      uploadSpy.mockImplementationOnce(async () => undefined);
      const plugin = makePlugin({ appToken: 'tok' }).esbuild as unknown as {
        setup: (b: FakeBuild) => void;
      };
      const ends: Array<() => Promise<void> | undefined> = [];
      for (let i = 0; i < 2; i++) {
        plugin.setup({
          initialOptions: { outdir: '/abs/failing' },
          onEnd: (cb) => ends.push(() => cb({ errors: [] })),
        });
      }
      const first = ends[0]?.();
      const second = ends[1]?.();
      await expect(first).rejects.toThrow('boom');
      await expect(second).resolves.toBeUndefined();
      expect(uploadSpy).toHaveBeenCalledTimes(2);
    });

    it('different output directories do not wait for each other', async () => {
      let release: () => void = () => undefined;
      uploadSpy.mockImplementationOnce(
        () => new Promise<undefined>((r) => (release = () => r(undefined))),
      );
      const plugin = makePlugin({ appToken: 'tok' }).esbuild as unknown as {
        setup: (b: FakeBuild) => void;
      };
      const ends: Array<() => Promise<void> | undefined> = [];
      for (const outdir of ['/abs/a', '/abs/b']) {
        plugin.setup({
          initialOptions: { outdir },
          onEnd: (cb) => ends.push(() => cb({ errors: [] })),
        });
      }
      const slow = ends[0]?.();
      await ends[1]?.();
      expect(uploadSpy).toHaveBeenCalledTimes(2);
      release();
      await slow;
    });
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
    applyRspack({ appToken: 'tok', uploadInDevelopment: true }, dev.compiler);
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

describe('development builds do not upload (and do not delete the local maps) by default', () => {
  beforeEach(() => {
    uploadSpy.mockReset();
    uploadSpy.mockImplementation(async () => undefined);
  });

  it('rspack: mode development is skipped, with one notice; production and an unset mode are not', async () => {
    const notices: string[] = [];
    const dev = rspackCompiler('/out', 'development');
    applyRspack({ appToken: 'tok', onNotice: (m) => notices.push(m) }, dev.compiler);
    await dev.taps[0]?.fn();
    await dev.taps[0]?.fn();
    expect(uploadSpy).not.toHaveBeenCalled();
    // Said once (other notices, e.g. about an unbakeable identity on this fake compiler, are not ours).
    const devNotices = notices.filter((m) => m.includes('uploadInDevelopment'));
    expect(devNotices).toHaveLength(1);
    for (const mode of ['production', undefined]) {
      const c = rspackCompiler('/out', mode);
      applyRspack({ appToken: 'tok' }, c.compiler);
      await c.taps[0]?.fn();
    }
    expect(uploadSpy).toHaveBeenCalledTimes(2);
  });

  it('rspack: uploadInDevelopment opts back in', async () => {
    const c = rspackCompiler('/out', 'development');
    applyRspack({ appToken: 'tok', uploadInDevelopment: true }, c.compiler);
    await c.taps[0]?.fn();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });

  it('esbuild: NODE_ENV=development is skipped; any other value uploads', async () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      const notices: string[] = [];
      await esbuildRun(
        { appToken: 'tok', onNotice: (m) => notices.push(m) },
        { outdir: '/abs/dist' },
      ).end();
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(notices[0]).toContain('esbuild development build');
      await esbuildRun(
        { appToken: 'tok', uploadInDevelopment: true },
        { outdir: '/abs/dist' },
      ).end();
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      process.env.NODE_ENV = 'production';
      await esbuildRun({ appToken: 'tok' }, { outdir: '/abs/dist' }).end();
      expect(uploadSpy).toHaveBeenCalledTimes(2);
    } finally {
      if (saved === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = saved;
      }
    }
  });

  it('a disabled plugin says nothing about development builds', async () => {
    const notices: string[] = [];
    const c = rspackCompiler('/out', 'development');
    applyRspack({ appToken: 'tok', disabled: true, onNotice: (m) => notices.push(m) }, c.compiler);
    await c.taps[0]?.fn();
    expect(notices).toEqual([]);
  });
});

describe('esbuild: a bare outfile in the project directory is refused', () => {
  beforeEach(() => {
    uploadSpy.mockReset();
    uploadSpy.mockImplementation(async () => undefined);
  });

  it('uploads nothing and says why (outfile: "bundle.js" would make the whole project the output dir)', async () => {
    const notices: string[] = [];
    await esbuildRun(
      { appToken: 'tok', onNotice: (m) => notices.push(m) },
      { outfile: 'bundle.js', absWorkingDir: '/proj/app' },
    ).end();
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(notices.some((m) => m.includes('project directory itself'))).toBe(true);
  });

  it('also against the cwd when there is no absWorkingDir', async () => {
    await esbuildRun(
      { appToken: 'tok', onNotice: () => undefined },
      { outfile: 'bundle.js' },
    ).end();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('an outfile in a SUBdirectory, and any outdir (even the project dir), still upload', async () => {
    await esbuildRun(
      { appToken: 'tok', onNotice: () => undefined },
      { outfile: 'dist/bundle.js', absWorkingDir: '/proj/app' },
    ).end();
    await esbuildRun({ appToken: 'tok' }, { outdir: '.', absWorkingDir: '/proj/app' }).end();
    expect(uploadSpy).toHaveBeenCalledTimes(2);
  });
});

describe('review follow-ups', () => {
  beforeEach(() => {
    uploadSpy.mockReset();
    uploadSpy.mockImplementation(async () => undefined);
  });

  it("rspack: mode 'none' is a release setting and still uploads", async () => {
    const c = rspackCompiler('/out', 'none');
    applyRspack({ appToken: 'tok' }, c.compiler);
    await c.taps[0]?.fn();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });

  it('esbuild: a development build does not force maps on (unless it uploads in dev)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const dev: FakeBuild['initialOptions'] = { outdir: '/abs/dist' };
      esbuildRun({ appToken: 'tok' }, dev);
      expect(dev.sourcemap).toBeUndefined();
      const optIn: FakeBuild['initialOptions'] = { outdir: '/abs/dist' };
      esbuildRun({ appToken: 'tok', uploadInDevelopment: true }, optIn);
      expect(optIn.sourcemap).toBe('external');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('esbuild: an outfile ABOVE the project is refused too, and gets one notice, not two', async () => {
    const notices: string[] = [];
    await esbuildRun(
      { appToken: 'tok', onNotice: (m) => notices.push(m) },
      { outfile: '/proj/bundle.js', absWorkingDir: '/proj/app' },
    ).end();
    expect(uploadSpy).not.toHaveBeenCalled();
    const ours = notices.filter((m) => m.includes('outfile'));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain('Nothing was uploaded');
  });

  it('esbuild: a development outfile build gets only the development notice', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const notices: string[] = [];
      await esbuildRun(
        { appToken: 'tok', onNotice: (m) => notices.push(m) },
        { outfile: '/abs/public/app.js' },
      ).end();
      expect(notices.filter((m) => m.includes('outfile'))).toEqual([]);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('esbuild: a sibling outfile directory (not an ancestor of the project) still uploads', async () => {
    await esbuildRun(
      { appToken: 'tok', onNotice: () => undefined },
      { outfile: '/proj/app2/out.js', absWorkingDir: '/proj/app' },
    ).end();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });
});
