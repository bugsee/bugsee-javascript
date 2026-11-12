import { resolve } from 'node:path';
import type { UnpluginOptions } from 'unplugin';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugseePluginOptions, ResolvedPluginOptions } from './resolve';

// Hook wiring for the end-of-build upload: esbuild `onEnd` and Rspack `afterEmit` reach `runPluginUpload` as
// Vite/Rollup `writeBundle` and webpack `afterEmit` do. The upload itself (and its SRI guard) is
// `runPluginUpload`'s, covered in orchestrate/resolve tests; `plugin.real-build.test.ts` drives the same hooks
// through real esbuild, tsup and Rspack builds with the real CLI.
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
  metafile?: { outputs: Record<string, unknown> };
}
type FakeBuild = {
  initialOptions: {
    outdir?: string;
    outfile?: string;
    absWorkingDir?: string;
    write?: boolean;
    sourcemap?: boolean | string;
    metafile?: boolean;
    define?: Record<string, string>;
  };
  onEnd: (cb: (result: EndResult) => Promise<void>) => void;
};
const outputsOf = (...files: string[]): EndResult => ({
  errors: [],
  metafile: { outputs: Object.fromEntries(files.map((f) => [f, {}])) },
});
/** The default result: one bundle and its map. */
const okResult = outputsOf('dist/a.js', 'dist/a.js.map');

function esbuildRun(options: BugseePluginOptions, initialOptions: FakeBuild['initialOptions']) {
  const ends: Array<(result: EndResult) => Promise<void>> = [];
  const build: FakeBuild = { initialOptions, onEnd: (cb) => ends.push(cb) };
  const hooks = makePlugin(options).esbuild as unknown as {
    config: (o: FakeBuild['initialOptions']) => void;
    setup: (b: FakeBuild) => void;
  };
  hooks.config(initialOptions);
  hooks.setup(build);
  return { ends, end: (result: EndResult = okResult) => ends[0]?.(result) };
}

const bundlerOf = (call: number) =>
  (uploadSpy.mock.calls[call]?.[2] as { bundler?: unknown } | undefined)?.bundler;
const filesOf = (call: number) =>
  (uploadSpy.mock.calls[call]?.[2] as { files?: { scripts: string[]; maps: string[] } } | undefined)
    ?.files;

describe("esbuild: upload of the build's own files at the end of the build", () => {
  beforeEach(() => {
    uploadSpy.mockReset();
    uploadSpy.mockImplementation(async () => undefined);
  });

  it('uploads exactly the files the metafile lists, resolved against absWorkingDir', async () => {
    const run = esbuildRun(
      { appToken: 'tok', appVersion: '3.0.0' },
      { outdir: 'dist', absWorkingDir: '/proj/app' },
    );
    expect(run.ends).toHaveLength(1);
    expect(uploadSpy).not.toHaveBeenCalled();
    await run.end(
      outputsOf(
        'dist/a.js',
        'dist/a.js.map',
        'dist/b.mjs',
        'dist/b.mjs.map',
        'dist/c.cjs',
        'dist/style.css',
        'dist/style.css.map',
        'dist/orphan.txt.map',
      ),
    );
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [resolved, outDir] = uploadSpy.mock.calls[0] as [ResolvedPluginOptions, string];
    expect(outDir).toBe(resolve('/proj/app', 'dist'));
    expect(resolved).toMatchObject({ enabled: true, appToken: 'tok', appVersion: '3.0.0' });
    expect(filesOf(0)).toEqual({
      scripts: ['dist/a.js', 'dist/b.mjs', 'dist/c.cjs'].map((f) => resolve('/proj/app', f)),
      // Only the maps of the build's own scripts are named to the CLI: a stylesheet map has no debug-id and would
      // fail the whole call; it is deleted with the rest instead.
      maps: ['dist/a.js.map', 'dist/b.mjs.map'].map((f) => resolve('/proj/app', f)),
      stylesheetMaps: [resolve('/proj/app', 'dist/style.css.map')],
    });
    // esbuild states nothing about production, so the run falls back to NODE_ENV.
    expect(bundlerOf(0)).toEqual({});
  });

  it('resolves paths against the cwd when there is no absWorkingDir', async () => {
    await esbuildRun({ appToken: 'tok' }, { outdir: 'dist' }).end();
    expect(filesOf(0)?.maps).toEqual([resolve('dist/a.js.map')]);
  });

  it('works for an outfile in ANY directory, including the project directory: only its own files are named', async () => {
    await esbuildRun({ appToken: 'tok' }, { outfile: 'bundle.js', absWorkingDir: '/proj/app' }).end(
      outputsOf('bundle.js', 'bundle.js.map'),
    );
    expect(filesOf(0)).toEqual({
      scripts: [resolve('/proj/app', 'bundle.js')],
      maps: [resolve('/proj/app', 'bundle.js.map')],
      stylesheetMaps: [],
    });
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

  it('does nothing for a build with no outdir/outfile', async () => {
    await esbuildRun({ appToken: 'tok' }, {}).end();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('does not upload a FAILED build', async () => {
    await esbuildRun({ appToken: 'tok' }, { outdir: 'dist' }).end({ ...okResult, errors: [{}] });
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('uploads again on every rebuild, each with its own outputs (watch mode: no state)', async () => {
    const run = esbuildRun({ appToken: 'tok' }, { outdir: 'dist', absWorkingDir: '/p' });
    await run.end(outputsOf('dist/a.js', 'dist/a.js.map'));
    await run.end(outputsOf('dist/b.js', 'dist/b.js.map'));
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(filesOf(0)?.maps).toEqual([resolve('/p', 'dist/a.js.map')]);
    expect(filesOf(1)?.maps).toEqual([resolve('/p', 'dist/b.js.map')]);
  });

  it('a disabled or token-less plugin does not upload', async () => {
    await esbuildRun({ appToken: 'tok', disabled: true }, { outdir: 'dist' }).end();
    const saved = process.env.BUGSEE_APP_TOKEN;
    delete process.env.BUGSEE_APP_TOKEN;
    try {
      await esbuildRun({}, { outdir: 'dist' }).end();
    } finally {
      if (saved !== undefined) {
        process.env.BUGSEE_APP_TOKEN = saved;
      }
    }
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('asks esbuild for the metafile (and leaves a user metafile on), only when enabled', () => {
    const own: FakeBuild['initialOptions'] = { outdir: 'dist' };
    esbuildRun({ appToken: 'tok' }, own);
    expect(own.metafile).toBe(true);
    const off: FakeBuild['initialOptions'] = { outdir: 'dist' };
    esbuildRun({ appToken: 'tok', disabled: true }, off);
    expect(off.metafile).toBeUndefined();
  });

  describe('a build with no map among its own outputs', () => {
    const inline = outputsOf('dist/a.js');

    it('fails the build under failOnError, naming the directory (judged on THIS build only)', async () => {
      const run = esbuildRun({ appToken: 'tok', failOnError: true }, { outdir: 'dist' });
      await expect(run.end(inline)).rejects.toThrow(/emitted no \.map files/);
      expect(uploadSpy).not.toHaveBeenCalled();
    });

    it('is a notice (once) without failOnError, and uploads nothing', async () => {
      const notices: string[] = [];
      const run = esbuildRun(
        { appToken: 'tok', onNotice: (m) => notices.push(m) },
        { outdir: 'dist' },
      );
      await run.end(inline);
      await run.end(inline);
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(notices.filter((m) => m.includes('emitted no .map files'))).toHaveLength(1);
    });

    it('a stylesheet-only build (metafile present, no scripts) is a quiet no-op, even under failOnError', async () => {
      const notices: string[] = [];
      const run = esbuildRun(
        { appToken: 'tok', failOnError: true, onNotice: (m) => notices.push(m) },
        { outdir: 'dist' },
      );
      await run.end(outputsOf('dist/only.css', 'dist/only.css.map'));
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(notices.filter((m) => m.includes('esbuild'))).toEqual([]);
    });

    it('no metafile at all (another plugin turned it off) fails under failOnError, else one notice per build', async () => {
      await expect(
        esbuildRun({ appToken: 'tok', failOnError: true }, { outdir: 'dist' }).end({ errors: [] }),
      ).rejects.toThrow(/no metafile/);
      const notices: string[] = [];
      const run = esbuildRun(
        { appToken: 'tok', onNotice: (m) => notices.push(m) },
        { outdir: 'dist' },
      );
      await run.end({ errors: [] });
      await run.end({ errors: [] });
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(notices.filter((m) => m.includes('no metafile'))).toHaveLength(1);
    });

    it('maps without a recognised script (outExtension .bundle.jsx) are the same misconfiguration', async () => {
      const jsx = outputsOf('dist/index.bundle.jsx', 'dist/index.bundle.jsx.map');
      await expect(
        esbuildRun({ appToken: 'tok', failOnError: true }, { outdir: 'dist' }).end(jsx),
      ).rejects.toThrow(/unrecognised|\.js, \.mjs or \.cjs/);
      const notices: string[] = [];
      await esbuildRun(
        { appToken: 'tok', onNotice: (m) => notices.push(m) },
        { outdir: 'dist' },
      ).end(jsx);
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(notices.some((m) => m.includes('.js, .mjs or .cjs'))).toBe(true);
    });

    it('scripts whose only maps are stylesheet maps still count as no maps', async () => {
      const run = esbuildRun({ appToken: 'tok', failOnError: true }, { outdir: 'dist' });
      await expect(run.end(outputsOf('dist/a.js', 'dist/b.css', 'dist/b.css.map'))).rejects.toThrow(
        /emitted no \.map files/,
      );
    });
  });

  it('write:false (tsup always sets it): nothing is uploaded, and a notice says why, once', async () => {
    const notices: string[] = [];
    const run = esbuildRun(
      { appToken: 'tok', onNotice: (m) => notices.push(m) },
      { outdir: 'dist', write: false },
    );
    await run.end();
    await run.end();
    expect(uploadSpy).not.toHaveBeenCalled();
    const ours = notices.filter((m) => m.includes('write: false'));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain('tsup');
    expect(ours[0]).toContain('onSuccess');
  });

  it('write:false says nothing for a disabled or token-less plugin', async () => {
    const notices: string[] = [];
    await esbuildRun(
      { appToken: 'tok', disabled: true, onNotice: (m) => notices.push(m) },
      { outdir: 'dist', write: false },
    ).end();
    expect(notices).toEqual([]);
  });

  it('an explicit sourcemap:false is left alone but explained', () => {
    const notices: string[] = [];
    const own: FakeBuild['initialOptions'] = { outdir: 'dist', sourcemap: false };
    esbuildRun({ appToken: 'tok', onNotice: (m) => notices.push(m) }, own);
    expect(own.sourcemap).toBe(false);
    expect(notices.some((m) => m.includes('sourcemap: false'))).toBe(true);
    const quiet: string[] = [];
    esbuildRun(
      { appToken: 'tok', disabled: true, onNotice: (m) => quiet.push(m) },
      { outdir: 'dist', sourcemap: false },
    );
    expect(quiet).toEqual([]);
  });

  it('makes the build EMIT external maps when the user said nothing', () => {
    // `external`, not `true`: the map is deleted after upload, so a sourceMappingURL comment would dangle.
    const own: FakeBuild['initialOptions'] = { outdir: 'dist' };
    esbuildRun({ appToken: 'tok' }, own);
    expect(own.sourcemap).toBe('external');
  });

  it("leaves any explicit sourcemap choice (false, 'external', 'inline', ...) and a disabled plugin alone", () => {
    for (const choice of [false, true, 'external', 'linked', 'inline', 'both']) {
      const own: FakeBuild['initialOptions'] = { outdir: 'dist', sourcemap: choice };
      esbuildRun({ appToken: 'tok' }, own);
      expect(own.sourcemap).toBe(choice);
    }
    const disabled: FakeBuild['initialOptions'] = { outdir: 'dist' };
    esbuildRun({ appToken: 'tok', disabled: true }, disabled);
    expect(disabled.sourcemap).toBeUndefined();
  });

  describe('development builds (NODE_ENV=development) do not upload', () => {
    const withNodeEnv = async (value: string, run: () => Promise<void>) => {
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = value;
      try {
        await run();
      } finally {
        process.env.NODE_ENV = saved;
      }
    };

    it('is skipped with one notice; uploadInDevelopment opts back in; production uploads', async () => {
      await withNodeEnv('development', async () => {
        const notices: string[] = [];
        const run = esbuildRun(
          { appToken: 'tok', onNotice: (m) => notices.push(m) },
          { outdir: 'dist' },
        );
        await run.end();
        await run.end();
        expect(uploadSpy).not.toHaveBeenCalled();
        const ours = notices.filter((m) => m.includes('esbuild development build'));
        expect(ours).toHaveLength(1);
        expect(ours[0]).toContain('nothing was uploaded');
        await esbuildRun({ appToken: 'tok', uploadInDevelopment: true }, { outdir: 'dist' }).end();
        expect(uploadSpy).toHaveBeenCalledTimes(1);
      });
      await withNodeEnv('production', async () => {
        await esbuildRun({ appToken: 'tok' }, { outdir: 'dist' }).end();
        expect(uploadSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('does not force maps on for a development build (unless it uploads in dev)', async () => {
      await withNodeEnv('development', async () => {
        const dev: FakeBuild['initialOptions'] = { outdir: 'dist' };
        esbuildRun({ appToken: 'tok' }, dev);
        expect(dev.sourcemap).toBeUndefined();
        const optIn: FakeBuild['initialOptions'] = { outdir: 'dist' };
        esbuildRun({ appToken: 'tok', uploadInDevelopment: true }, optIn);
        expect(optIn.sourcemap).toBe('external');
      });
    });

    it('says nothing for a disabled plugin', async () => {
      await withNodeEnv('development', async () => {
        const notices: string[] = [];
        await esbuildRun(
          { appToken: 'tok', disabled: true, onNotice: (m) => notices.push(m) },
          { outdir: 'dist' },
        ).end();
        expect(notices).toEqual([]);
      });
    });
  });

  it('builds sharing one outdir never wait for or join each other (no per-directory state)', async () => {
    // Two builds end while the first upload is still running: the second starts at once, with its own files.
    let release: () => void = () => undefined;
    uploadSpy.mockImplementationOnce(
      () => new Promise<undefined>((r) => (release = () => r(undefined))),
    );
    const a = esbuildRun({ appToken: 'tok' }, { outdir: 'dist', absWorkingDir: '/p' });
    const b = esbuildRun({ appToken: 'tok' }, { outdir: 'dist', absWorkingDir: '/p' });
    const first = a.end(outputsOf('dist/a.mjs', 'dist/a.mjs.map'));
    await b.end(outputsOf('dist/b.cjs', 'dist/b.cjs.map'));
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(filesOf(0)?.maps).toEqual([resolve('/p', 'dist/a.mjs.map')]);
    expect(filesOf(1)?.maps).toEqual([resolve('/p', 'dist/b.cjs.map')]);
    release();
    await first;
  });

  it('two plugin instances over one outdir each upload only their own build, with their own options', async () => {
    const a = esbuildRun(
      { appToken: 'tok-a', deleteMaps: true },
      { outdir: 'dist', absWorkingDir: '/p' },
    );
    const b = esbuildRun(
      { appToken: 'tok-b', deleteMaps: false },
      { outdir: 'dist', absWorkingDir: '/p' },
    );
    await a.end(outputsOf('dist/a.js', 'dist/a.js.map'));
    await b.end(outputsOf('dist/b.js', 'dist/b.js.map'));
    const [ra] = uploadSpy.mock.calls[0] as unknown as [ResolvedPluginOptions];
    const [rb] = uploadSpy.mock.calls[1] as unknown as [ResolvedPluginOptions];
    expect(ra).toMatchObject({ appToken: 'tok-a', deleteMaps: true });
    expect(rb).toMatchObject({ appToken: 'tok-b', deleteMaps: false });
    expect(filesOf(0)?.maps).toEqual([resolve('/p', 'dist/a.js.map')]);
    expect(filesOf(1)?.maps).toEqual([resolve('/p', 'dist/b.js.map')]);
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

describe('rspack development builds do not upload (and do not delete the local maps) by default', () => {
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

  it('a disabled plugin says nothing about development builds', async () => {
    const notices: string[] = [];
    const c = rspackCompiler('/out', 'development');
    applyRspack({ appToken: 'tok', disabled: true, onNotice: (m) => notices.push(m) }, c.compiler);
    await c.taps[0]?.fn();
    expect(notices).toEqual([]);
  });
});

describe('rspack: a build with devtool off', () => {
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

  it('rspack: a build with devtool off says nothing is emitted (once, only when enabled)', () => {
    const notices: string[] = [];
    const off = rspackCompiler('/out', 'production');
    applyRspack({ appToken: 'tok', onNotice: (m) => notices.push(m) }, off.compiler);
    applyRspack({ appToken: 'tok', onNotice: (m) => notices.push(m) }, off.compiler);
    expect(notices.filter((m) => m.includes('devtool'))).toHaveLength(2); // one per plugin instance
    // A development build with devtool unset gets only the dev-skip notice (its default is eval), not this one.
    const devNotices: string[] = [];
    const dev = rspackCompiler('/out', 'development');
    applyRspack({ appToken: 'tok', onNotice: (m) => devNotices.push(m) }, dev.compiler);
    expect(devNotices.filter((m) => m.includes('devtool'))).toEqual([]);
    const withMaps = rspackCompiler('/out', 'production');
    (withMaps.compiler.options as { devtool?: string }).devtool = 'source-map';
    const quiet: string[] = [];
    applyRspack({ appToken: 'tok', onNotice: (m) => quiet.push(m) }, withMaps.compiler);
    applyRspack({ appToken: 'tok', disabled: true, onNotice: (m) => quiet.push(m) }, off.compiler);
    expect(quiet.filter((m) => m.includes('devtool'))).toEqual([]);
  });
});
