import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnpluginOptions } from 'unplugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The upload STEP (the CLI driver) is stubbed separately so the retry around it can be driven precisely.
const { orchSpy } = vi.hoisted(() => ({
  orchSpy: vi.fn(async (_options: unknown) => ({
    injected: true,
    uploaded: true,
    deletedMaps: [] as string[],
  })),
}));
vi.mock('./orchestrate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orchestrate')>()),
  uploadSourcemaps: orchSpy,
}));

const { uploadTuning } = await import('./upload-tuning');
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
  onStart: (cb: () => void) => void;
  onEnd: (cb: (result: EndResult) => Promise<void>) => void;
};
function esbuildRun(options: BugseePluginOptions, initialOptions: FakeBuild['initialOptions']) {
  const ends: Array<(result: EndResult) => Promise<void>> = [];
  const starts: Array<() => void> = [];
  const build: FakeBuild = {
    initialOptions,
    onStart: (cb) => starts.push(cb),
    onEnd: (cb) => ends.push(cb),
  };
  const hooks = makePlugin(options).esbuild as unknown as {
    config: (o: FakeBuild['initialOptions']) => void;
    setup: (b: FakeBuild) => void;
  };
  hooks.config(initialOptions);
  hooks.setup(build);
  return {
    ends,
    start: () => starts[0]?.(),
    end: (result: EndResult = { errors: [] }) => ends[0]?.(result),
  };
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

  it('does nothing for a build with no outdir/outfile', async () => {
    await esbuildRun({ appToken: 'tok' }, {}).end();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('write:false (tsup always sets it): nothing is uploaded, and a notice says why, once', async () => {
    const notices: string[] = [];
    const run = esbuildRun(
      { appToken: 'tok', onNotice: (m) => notices.push(m) },
      { outdir: '/abs/dist', write: false },
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
      { outdir: '/abs/dist', write: false },
    ).end();
    expect(notices).toEqual([]);
  });

  it('an explicit sourcemap:false is left alone but explained', () => {
    const notices: string[] = [];
    const own: FakeBuild['initialOptions'] = { outdir: '/abs/dist', sourcemap: false };
    esbuildRun({ appToken: 'tok', onNotice: (m) => notices.push(m) }, own);
    expect(own.sourcemap).toBe(false);
    expect(notices.some((m) => m.includes('sourcemap: false'))).toBe(true);
    const quiet: string[] = [];
    esbuildRun(
      { appToken: 'tok', disabled: true, onNotice: (m) => quiet.push(m) },
      {
        outdir: '/abs/dist',
        sourcemap: false,
      },
    );
    expect(quiet).toEqual([]);
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

  it('a disabled or token-less plugin does not even queue the upload', async () => {
    await esbuildRun({ appToken: 'tok', disabled: true }, { outdir: '/abs/dist' }).end();
    const saved = process.env.BUGSEE_APP_TOKEN;
    delete process.env.BUGSEE_APP_TOKEN;
    try {
      await esbuildRun({}, { outdir: '/abs/dist' }).end();
    } finally {
      if (saved !== undefined) {
        process.env.BUGSEE_APP_TOKEN = saved;
      }
    }
    expect(uploadSpy).not.toHaveBeenCalled();
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
          onStart: () => undefined,
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
          onStart: () => undefined,
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
          onStart: () => undefined,
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

  it('an outfile in a SUBdirectory still uploads; outdir "." (the whole project) is refused too', async () => {
    await esbuildRun(
      { appToken: 'tok', onNotice: () => undefined },
      { outfile: 'dist/bundle.js', absWorkingDir: '/proj/app' },
    ).end();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const notices: string[] = [];
    await esbuildRun(
      { appToken: 'tok', onNotice: (m) => notices.push(m) },
      { outdir: '.', absWorkingDir: '/proj/app' },
    ).end();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(notices.some((m) => m.includes('Nothing was uploaded'))).toBe(true);
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
    const ours = notices.filter((m) => m.includes('project directory itself'));
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

describe('esbuild: builds into one directory settle around an upload', () => {
  const failure = () => new Error('exit 11: map has no debug_id');
  const failed = { injected: false, uploaded: false, deletedMaps: [] as string[] };
  const ok = { injected: true, uploaded: true, deletedMaps: [] as string[] };

  beforeEach(() => {
    uploadSpy.mockReset();
    orchSpy.mockReset();
    orchSpy.mockImplementation(async () => ok);
    // `runPluginUpload` is replaced by one that drives the dependency it is handed, as the real one does.
    uploadSpy.mockImplementation(async (resolved: unknown, outDir: string, deps: unknown) => {
      const r = resolved as ResolvedPluginOptions;
      await (deps as { uploadSourcemaps: (o: unknown) => Promise<unknown> }).uploadSourcemaps({
        outDir,
        appToken: 't',
        appVersion: '1',
        appBuild: '1',
        endpoint: undefined,
        deleteMaps: true,
        dryRun: false,
        stripSourcesContent: false,
        failOnError: r.failOnError,
        onError: r.onError,
      });
      return undefined;
    });
    uploadTuning.idleWaitMs = 200;
    uploadTuning.pollMs = 5;
  });
  afterEach(() => {
    uploadTuning.idleWaitMs = 5000;
    uploadTuning.pollMs = 25;
  });

  /** An upload step that fails with `error` (contained, or thrown under failOnError), as the real one does. */
  const failWith = (error: Error, before?: () => void) => async (o: unknown) => {
    before?.();
    const options = o as { failOnError?: boolean; onError: (e: unknown) => void };
    if (options.failOnError === true) {
      throw error;
    }
    options.onError(error);
    return failed;
  };

  it('the user failOnError reaches the upload step (it also decides --allow-empty)', async () => {
    const run = esbuildRun({ appToken: 'tok', failOnError: true }, { outdir: '/abs/fo' });
    run.start();
    await run.end();
    expect((orchSpy.mock.calls[0]?.[0] as { failOnError?: boolean }).failOnError).toBe(true);
    const lax = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/fo2' });
    lax.start();
    await lax.end();
    expect((orchSpy.mock.calls[1]?.[0] as { failOnError?: boolean }).failOnError).toBe(false);
  });

  it('a failure while another build started is retried, not reported', async () => {
    const seen: unknown[] = [];
    const a = esbuildRun({ appToken: 'tok', onError: (e) => seen.push(e) }, { outdir: '/abs/r1' });
    const b = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r1' });
    a.start();
    orchSpy.mockImplementationOnce(
      failWith(failure(), () => {
        b.start();
        setTimeout(() => void b.end(), 30);
      }),
    );
    await a.end();
    expect(orchSpy).toHaveBeenCalledTimes(3); // a: fail + retry ok; b's own run
    expect(seen).toEqual([]);
  });

  it('a retry WAITS for the other build to finish before scanning again', async () => {
    const order: string[] = [];
    const a = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r2' });
    const b = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r2' });
    a.start();
    orchSpy.mockImplementationOnce(
      failWith(failure(), () => {
        b.start();
        setTimeout(() => {
          order.push('b-ended');
          void b.end();
        }, 60);
      }),
    );
    orchSpy.mockImplementationOnce(async () => {
      order.push('retry');
      return ok;
    });
    await a.end();
    expect(order).toEqual(['b-ended', 'retry']);
  });

  it('a failure with NO concurrent build is reported as configured', async () => {
    orchSpy.mockImplementation(failWith(failure()));
    const strict = esbuildRun({ appToken: 'tok', failOnError: true }, { outdir: '/abs/r3' });
    strict.start();
    await expect(strict.end()).rejects.toThrow('exit 11');
    const seen: unknown[] = [];
    const lax = esbuildRun(
      { appToken: 'tok', onError: (e) => seen.push(e) },
      { outdir: '/abs/r4' },
    );
    lax.start();
    await lax.end();
    expect(String(seen[0])).toContain('exit 11');
    expect(orchSpy).toHaveBeenCalledTimes(2); // no retry in either case
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const quiet = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r5' });
      quiet.start();
      await quiet.end();
      expect(warn.mock.calls.join()).toContain('source-map upload skipped');
    } finally {
      warn.mockRestore();
    }
  });

  it('exactly three attempts for a lone run whose failures keep coinciding with new builds', async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const a = esbuildRun({ appToken: 'tok', onError: (e) => seen.push(e) }, { outdir: '/abs/r7' });
    a.start();
    const bump = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r7' });
    orchSpy.mockImplementation(async (o: unknown) => {
      calls++;
      bump.start(); // another build starts during every attempt...
      (o as { onError: (e: unknown) => void }).onError(failure());
      return failed;
    });
    await a.end();
    expect(calls).toBe(3);
    expect(seen).toHaveLength(1);
  });

  it('a build that started BEFORE the run and never ends (hung) still lets the failure be retried, after the cap', async () => {
    const hung = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r8' });
    hung.start(); // never ends
    const a = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r8' });
    a.start();
    orchSpy.mockImplementationOnce(failWith(failure()));
    const t0 = Date.now();
    await a.end();
    expect(orchSpy).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(uploadTuning.idleWaitMs - 50);
  });

  it('a build nested inside another (outer still in flight) is not stalled waiting for it', async () => {
    const outer = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r9' });
    const inner = esbuildRun({ appToken: 'tok' }, { outdir: '/abs/r9' });
    outer.start();
    inner.start();
    uploadTuning.idleWaitMs = 60_000;
    const t0 = Date.now();
    await inner.end();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(orchSpy).toHaveBeenCalledTimes(1);
    await outer.end();
  });

  it('a disabled plugin in a nested build does not stall either', async () => {
    const outer = esbuildRun({ disabled: true }, { outdir: '/abs/r10' });
    const inner = esbuildRun({ disabled: true }, { outdir: '/abs/r10' });
    outer.start();
    inner.start();
    const t0 = Date.now();
    await inner.end();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(orchSpy).not.toHaveBeenCalled();
  });

  it('three overlapping builds stay strictly one after another (the queue tail guard)', async () => {
    const gates: Array<() => void> = [];
    const order: string[] = [];
    uploadSpy.mockImplementation(async () => {
      const n = gates.length;
      order.push(`start${n}`);
      await new Promise<void>((r) => gates.push(r));
      order.push(`end${n}`);
      return undefined;
    });
    const runs = [1, 2, 3].map(() => esbuildRun({ appToken: 'tok' }, { outdir: '/abs/race7' }));
    const done = [runs[0]?.end(), runs[1]?.end()];
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start0']);
    gates[0]?.();
    await done[0];
    await new Promise((r) => setTimeout(r, 20));
    // Build 1's queue slot has settled but build 2 is still running: build 3 must queue behind build 2.
    expect(order).toEqual(['start0', 'end0', 'start1']);
    const third = runs[2]?.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start0', 'end0', 'start1']);
    gates[1]?.();
    await done[1];
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start0', 'end0', 'start1', 'end1', 'start2']);
    gates[2]?.();
    await third;
  });
});

describe('guards and notices (review round 3)', () => {
  beforeEach(() => {
    uploadSpy.mockReset();
    uploadSpy.mockImplementation(async () => undefined);
  });

  it('an outfile directly in a PACKAGE root (monorepo root build) is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bugsee-pkgroot-'));
    try {
      mkdirSync(join(root, 'packages', 'a'), { recursive: true });
      writeFileSync(join(root, 'packages', 'a', 'package.json'), '{}');
      const notices: string[] = [];
      await esbuildRun(
        { appToken: 'tok', onNotice: (m) => notices.push(m) },
        { outfile: 'packages/a/index.js', absWorkingDir: root },
      ).end();
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(notices.some((m) => m.includes('Nothing was uploaded'))).toBe(true);
      // The same directory is fine as an `outdir` target (a package may hold a dist with its own package.json).
      await esbuildRun({ appToken: 'tok' }, { outdir: 'packages/a', absWorkingDir: root }).end();
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      // And an outfile in a package-free subdirectory still uploads.
      mkdirSync(join(root, 'out'), { recursive: true });
      await esbuildRun(
        { appToken: 'tok', onNotice: () => undefined },
        { outfile: 'out/bundle.js', absWorkingDir: root },
      ).end();
      expect(uploadSpy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the project-directory test is segment-aware: a project named "..cache" is below its parent', async () => {
    const notices: string[] = [];
    await esbuildRun(
      { appToken: 'tok', onNotice: (m) => notices.push(m) },
      { outfile: '/proj/bundle.js', absWorkingDir: '/proj/..cache' },
    ).end();
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(notices.some((m) => m.includes('Nothing was uploaded'))).toBe(true);
  });

  it('rspack: a build with devtool off says nothing is emitted (once, only when enabled)', () => {
    const notices: string[] = [];
    const off = rspackCompiler('/out', 'production');
    applyRspack({ appToken: 'tok', onNotice: (m) => notices.push(m) }, off.compiler);
    applyRspack({ appToken: 'tok', onNotice: (m) => notices.push(m) }, off.compiler);
    expect(notices.filter((m) => m.includes('devtool'))).toHaveLength(2); // one per plugin instance
    const withMaps = rspackCompiler('/out', 'production');
    (withMaps.compiler.options as { devtool?: string }).devtool = 'source-map';
    const quiet: string[] = [];
    applyRspack({ appToken: 'tok', onNotice: (m) => quiet.push(m) }, withMaps.compiler);
    applyRspack({ appToken: 'tok', disabled: true, onNotice: (m) => quiet.push(m) }, off.compiler);
    expect(quiet.filter((m) => m.includes('devtool'))).toEqual([]);
  });
});
