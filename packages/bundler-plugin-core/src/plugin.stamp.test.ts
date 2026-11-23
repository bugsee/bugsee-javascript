import type { UnpluginOptions } from 'unplugin';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugseePluginOptions } from './resolve';

// Hook wiring for stamping INSIDE the build on Rspack (processAssets), and on Vite / Rollup
// (generateBundle). The stamp itself is stubbed: stamp-assets.test.ts runs the real CLI and
// plugin.in-build.real-build.test.ts runs real Vite / Rollup / Rspack builds end to end.
const { uploadSpy } = vi.hoisted(() => ({
  uploadSpy: vi.fn(async (_resolved: unknown, _outDir: string, _deps?: unknown) => undefined),
}));
vi.mock('./resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve')>()),
  runPluginUpload: uploadSpy,
}));
const { stampSpy } = vi.hoisted(() => ({
  stampSpy: vi.fn(async (_store: unknown, _options?: unknown) => ({ stamped: [] as string[] })),
}));
vi.mock('./stamp-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stamp-assets')>()),
  stampAssets: stampSpy,
}));

const { bugseeUnpluginFactory } = await import('./plugin');
const makePlugin = (options?: BugseePluginOptions, framework = 'rollup'): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework } as never) as UnpluginOptions;

const depsOf = (call: number) =>
  uploadSpy.mock.calls[call]?.[2] as
    | { preStamped?: boolean; bundler?: unknown; stampedBundles?: string[] }
    | undefined;

beforeEach(() => {
  uploadSpy.mockClear();
  stampSpy.mockReset();
  stampSpy.mockImplementation(async () => ({ stamped: [] }));
});

describe('rspack: stamps inside the compilation', () => {
  const DEV_TOOLING = 500;
  class RawSource {
    constructor(readonly bytes: Buffer) {}
  }

  function rspackCompiler(options: { mode?: string; withApi?: boolean } = {}) {
    const afterEmit: Array<() => Promise<void>> = [];
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
      getAsset: (name: string) => ({ source: { buffer: () => Buffer.from(`content of ${name}`) } }),
      updateAsset: (name: string, source: unknown) => {
        updated.push({ name, source });
      },
    };
    const compilations: Array<(c: unknown) => void> = [];
    const compiler = {
      options: {
        output: { path: '/build/out' },
        mode: options.mode ?? 'production',
        devtool: 'source-map',
      },
      hooks: {
        afterEmit: { tapPromise: (_n: string, fn: () => Promise<void>) => afterEmit.push(fn) },
        thisCompilation: { tap: (_n: string, fn: (c: unknown) => void) => compilations.push(fn) },
      },
      ...(options.withApi === false
        ? {}
        : {
            rspack: {
              Compilation: { PROCESS_ASSETS_STAGE_DEV_TOOLING: DEV_TOOLING },
              sources: { RawSource },
              DefinePlugin: class {
                apply() {}
              },
            },
          }),
    };
    return {
      compiler,
      processAssets,
      updated,
      afterEmit: () => afterEmit[0]?.(),
      compile: async () => {
        for (const fn of compilations) {
          fn(compilation);
        }
        for (const tap of processAssets) {
          await tap.fn();
        }
      },
      /** A compilation that starts but never reaches its processAssets stage (an earlier error). */
      startOnly: () => {
        for (const fn of compilations) {
          fn(compilation);
        }
      },
    };
  }
  const apply = (options: BugseePluginOptions, compiler: unknown): void =>
    (makePlugin(options, 'rspack').rspack as (c: unknown) => void)(compiler);

  it('taps processAssets one stage after the maps are emitted, before an SRI plugin hashes', async () => {
    const r = rspackCompiler();
    apply({ appToken: 'tok' }, r.compiler);
    await r.compile();
    expect(r.processAssets).toHaveLength(1);
    expect(r.processAssets[0]?.stage).toBe(DEV_TOOLING + 1);
    expect(r.processAssets[0]?.name).toBe('bugsee');
    expect(stampSpy).toHaveBeenCalledOnce();
  });

  it('uploads without re-injecting after emit (preStamped), naming the bundles it stamped', async () => {
    stampSpy.mockImplementation(async () => ({ stamped: ['main.js'] }));
    const r = rspackCompiler();
    apply({ appToken: 'tok' }, r.compiler);
    await r.compile();
    await r.afterEmit();
    expect(depsOf(0)?.preStamped).toBe(true);
    expect(depsOf(0)?.stampedBundles).toEqual(['main.js']);
  });

  it('reads and writes the compilation asset table, through rspack own RawSource', async () => {
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
    const r = rspackCompiler();
    apply({ appToken: 'tok' }, r.compiler);
    await r.compile();
    expect(r.updated[0]?.source).toBeInstanceOf(RawSource);
    expect((r.updated[0]?.source as RawSource).bytes.toString()).toBe('stamped');
  });

  it('passes the dry-run flag on', async () => {
    const r = rspackCompiler();
    apply({ appToken: 'tok', dryRun: true }, r.compiler);
    await r.compile();
    expect(stampSpy.mock.calls[0]?.[1]).toEqual({ dryRun: true });
  });

  it('falls back to the post-emit path (SRI refusal included) when the stamp fails', async () => {
    stampSpy.mockImplementation(async () => {
      throw new Error('bugsee-cli exited 20');
    });
    const onError = vi.fn();
    const r = rspackCompiler();
    apply({ appToken: 'tok', onError }, r.compiler);
    await r.compile();
    await r.afterEmit();
    expect(onError).toHaveBeenCalledOnce();
    expect(depsOf(0)?.preStamped).toBe(false);
  });

  it('fails the compilation under failOnError', async () => {
    stampSpy.mockImplementation(async () => {
      throw new Error('bugsee-cli exited 20');
    });
    const r = rspackCompiler();
    apply({ appToken: 'tok', failOnError: true }, r.compiler);
    await expect(r.compile()).rejects.toThrow(/exited 20/);
  });

  it('starts each compilation unstamped (watch mode)', async () => {
    const r = rspackCompiler();
    apply({ appToken: 'tok', onError: () => undefined }, r.compiler);
    await r.compile();
    await r.afterEmit();
    stampSpy.mockImplementation(async () => {
      throw new Error('second build failed to stamp');
    });
    await r.compile();
    await r.afterEmit();
    expect(depsOf(1)?.preStamped).toBe(false);
  });

  it('a compilation that never reaches the stamp stage is not vouched for by the previous one', async () => {
    const r = rspackCompiler();
    apply({ appToken: 'tok' }, r.compiler);
    await r.compile();
    r.startOnly();
    await r.afterEmit();
    expect(depsOf(0)?.preStamped).toBe(false);
  });

  it('does not stamp a development build that is not uploaded (rspack serve/watch), and does when uploadInDevelopment is set', async () => {
    const dev = rspackCompiler({ mode: 'development' });
    apply({ appToken: 'tok', onNotice: () => undefined }, dev.compiler);
    await dev.compile();
    expect(dev.processAssets).toHaveLength(0);
    expect(stampSpy).not.toHaveBeenCalled();

    const optIn = rspackCompiler({ mode: 'development' });
    apply({ appToken: 'tok', uploadInDevelopment: true }, optIn.compiler);
    await optIn.compile();
    expect(optIn.processAssets).toHaveLength(1);

    for (const mode of ['production', 'none']) {
      const r = rspackCompiler({ mode });
      apply({ appToken: 'tok' }, r.compiler);
      await r.compile();
      expect(r.processAssets).toHaveLength(1);
    }
  });

  it('does not stamp for a disabled plugin', async () => {
    const r = rspackCompiler();
    apply({ disabled: true }, r.compiler);
    await r.compile();
    expect(r.processAssets).toHaveLength(0);
  });

  it('keeps the post-emit path on a compiler without the rspack API or thisCompilation', async () => {
    const r = rspackCompiler({ withApi: false });
    apply({ appToken: 'tok' }, r.compiler);
    await r.compile();
    await r.afterEmit();
    expect(stampSpy).not.toHaveBeenCalled();
    expect(depsOf(0)?.preStamped).toBe(false);
  });
});

describe('vite / rollup: stamps in generateBundle, before anything is written or hashed', () => {
  type Handler = (
    output: { dir?: string; file?: string },
    bundle: Record<string, unknown>,
  ) => Promise<void>;
  type Hook = { order?: string; handler: Handler };
  const hooksOf = (p: UnpluginOptions, kind: 'vite' | 'rollup') =>
    p[kind] as unknown as { generateBundle: Hook; writeBundle: (o: object) => Promise<void> };

  const bundle = (): Record<string, unknown> => ({
    'a.js': { type: 'chunk', fileName: 'a.js', code: 'x', map: {} },
    'a.js.map': { type: 'asset', fileName: 'a.js.map', source: '{}' },
  });

  for (const kind of ['vite', 'rollup'] as const) {
    describe(kind, () => {
      it('runs FIRST (order: pre), so Vite html build and later SRI hashing see stamped bytes', () => {
        expect(hooksOf(makePlugin({ appToken: 'tok' }), kind).generateBundle.order).toBe('pre');
      });

      it('stamps the output bundle through a store over it', async () => {
        stampSpy.mockImplementation(async (store) => {
          const s = store as {
            names(): string[];
            read(n: string): Buffer;
            update(n: string, c: Buffer): void;
          };
          expect(s.names()).toEqual(['a.js', 'a.js.map']);
          expect(s.read('a.js').toString()).toBe('x');
          s.update('a.js', Buffer.from('stamped'));
          return { stamped: ['a.js'] };
        });
        const b = bundle();
        await hooksOf(makePlugin({ appToken: 'tok' }), kind).generateBundle.handler(
          { dir: '/out' },
          b,
        );
        expect((b['a.js'] as { code: string }).code).toBe('stamped');
      });

      it('then uploads without re-injecting, once: the flag is consumed by the write', async () => {
        stampSpy.mockImplementation(async () => ({ stamped: ['a.js'] }));
        const p = makePlugin({ appToken: 'tok' });
        const h = hooksOf(p, kind);
        const output = { dir: '/out' };
        await h.generateBundle.handler(output, bundle());
        await h.writeBundle(output);
        await h.writeBundle(output); // a write with no generateBundle before it: not stamped
        expect(depsOf(0)?.preStamped).toBe(true);
        // The on-disk re-check is told exactly which bundles the stamp wrote.
        expect(depsOf(0)?.stampedBundles).toEqual(['a.js']);
        expect(depsOf(1)?.preStamped).toBeUndefined();
        expect(depsOf(1)?.stampedBundles).toBeUndefined();
      });

      it('tracks each output on its own', async () => {
        stampSpy.mockImplementationOnce(async () => ({ stamped: [] }));
        stampSpy.mockImplementationOnce(async () => {
          throw new Error('second output failed');
        });
        const p = makePlugin({ appToken: 'tok', onError: () => undefined });
        const h = hooksOf(p, kind);
        const [first, second] = [{ dir: '/a' }, { file: '/b/out.js' }];
        await h.generateBundle.handler(first, bundle());
        await h.generateBundle.handler(second, bundle());
        await h.writeBundle(first);
        await h.writeBundle(second);
        expect(depsOf(0)?.preStamped).toBe(true);
        expect(depsOf(1)?.preStamped).toBeUndefined();
      });

      it("two outputs written CONCURRENTLY into one directory never consume each other's answer", async () => {
        // A stamped output beside one that could not be stamped (inline maps), same folder.
        const p = makePlugin({ appToken: 'tok', onNotice: () => undefined });
        const h = hooksOf(p, kind);
        const [stamped, unstamped] = [{ file: '/out/a.js' }, { file: '/out/b.js' }];
        const inline = bundle();
        delete inline['a.js.map'];
        await h.generateBundle.handler(stamped, bundle());
        await h.generateBundle.handler(unstamped, inline);
        // Writes land in the opposite order of the generateBundles.
        await h.writeBundle(unstamped);
        await h.writeBundle(stamped);
        expect(depsOf(0)?.preStamped).toBeUndefined(); // the unstamped output keeps the post-emit path + SRI refusal
        expect(depsOf(1)?.preStamped).toBe(true);
      });

      it('a write whose generateBundle used a different options object is not vouched for', async () => {
        const h = hooksOf(makePlugin({ appToken: 'tok' }), kind);
        await h.generateBundle.handler({ dir: '/out' }, bundle());
        await h.writeBundle({ dir: '/out' });
        expect(depsOf(0)?.preStamped).toBeUndefined();
      });

      it('a stale success never vouches for the next build of the same output', async () => {
        const p = makePlugin({ appToken: 'tok', onError: () => undefined });
        const h = hooksOf(p, kind);
        const output = { dir: '/out' };
        await h.generateBundle.handler(output, bundle());
        // (the write of build 1 never happened) build 2's stamp fails:
        stampSpy.mockImplementationOnce(async () => {
          throw new Error('boom');
        });
        await h.generateBundle.handler(output, bundle());
        await h.writeBundle(output);
        expect(depsOf(0)?.preStamped).toBeUndefined();
      });

      it('a build that cannot be stamped in memory is not vouched for by the previous stamp either', async () => {
        const h = hooksOf(makePlugin({ appToken: 'tok', onNotice: () => undefined }), kind);
        const output = { dir: '/out' };
        await h.generateBundle.handler(output, bundle()); // stamped; its write never happened
        const unstampable = bundle();
        delete unstampable['a.js.map'];
        await h.generateBundle.handler(output, unstampable);
        await h.writeBundle(output);
        expect(depsOf(0)?.preStamped).toBeUndefined();
      });

      it('falls back to the post-emit path, reported, when the stamp fails', async () => {
        stampSpy.mockImplementation(async () => {
          throw new Error('bugsee-cli exited 20');
        });
        const onError = vi.fn();
        const h = hooksOf(makePlugin({ appToken: 'tok', onError }), kind);
        const output = { dir: '/out' };
        await h.generateBundle.handler(output, bundle());
        await h.writeBundle(output);
        expect(onError).toHaveBeenCalledOnce();
        expect(depsOf(0)?.preStamped).toBeUndefined();
      });

      it('says what happens next when a stamp fails and no handler is set', async () => {
        stampSpy.mockImplementation(async () => {
          throw new Error('bugsee-cli exited 20');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          await hooksOf(makePlugin({ appToken: 'tok' }), kind).generateBundle.handler(
            { dir: '/out' },
            bundle(),
          );
          expect(String(warn.mock.calls[0]?.[0])).toMatch(
            /in-build debug-ID stamping failed; falling back to stamping after emit: .*exited 20/,
          );
        } finally {
          warn.mockRestore();
        }
      });

      it('fails the build under failOnError', async () => {
        stampSpy.mockImplementation(async () => {
          throw new Error('bugsee-cli exited 20');
        });
        await expect(
          hooksOf(makePlugin({ appToken: 'tok', failOnError: true }), kind).generateBundle.handler(
            { dir: '/out' },
            bundle(),
          ),
        ).rejects.toThrow(/exited 20/);
      });

      it('passes the dry-run flag on', async () => {
        await hooksOf(makePlugin({ appToken: 'tok', dryRun: true }), kind).generateBundle.handler(
          { dir: '/out' },
          bundle(),
        );
        expect(stampSpy.mock.calls[0]?.[1]).toEqual({ dryRun: true });
      });

      it('does nothing for a disabled plugin, or an output with no directory', async () => {
        await hooksOf(makePlugin({ disabled: true }), kind).generateBundle.handler(
          { dir: '/out' },
          bundle(),
        );
        await hooksOf(makePlugin({ appToken: 'tok' }), kind).generateBundle.handler({}, bundle());
        expect(stampSpy).not.toHaveBeenCalled();
      });

      it('a chunk whose map is not a bundle asset cannot be stamped in memory: post-emit fallback, said once', async () => {
        const notices: string[] = [];
        const h = hooksOf(
          makePlugin({ appToken: 'tok', onNotice: (m: string) => notices.push(m) }),
          kind,
        );
        const b = bundle();
        delete b['a.js.map'];
        const output = { dir: '/out' };
        await h.generateBundle.handler(output, b);
        await h.generateBundle.handler(output, b);
        await h.writeBundle(output);
        expect(stampSpy).not.toHaveBeenCalled();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('a.js');
        expect(notices[0]).toContain('after emit');
        expect(depsOf(0)?.preStamped).toBeUndefined();
      });
    });
  }
});
