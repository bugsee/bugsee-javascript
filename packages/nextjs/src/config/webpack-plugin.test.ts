import { describe, expect, it, vi } from 'vitest';
import type { BugseeNextContext } from './context';
import {
  type CompilerLike,
  createNextWebpackPlugin,
  nextAssetStore,
  type WebpackPluginDeps,
} from './webpack-plugin';

class RawSource {
  constructor(readonly content: Buffer) {}
}

type Processor = () => Promise<void>;

/** A fake webpack compilation holding named assets, recording updates. */
function fakeCompilation(assets: Record<string, string>) {
  const store = new Map<string, Buffer>(
    Object.entries(assets).map(([k, v]) => [k, Buffer.from(v)]),
  );
  let processor: Processor | undefined;
  let stage: number | undefined;
  return {
    store,
    run: () => (processor as Processor)(),
    stage: () => stage,
    compilation: {
      hooks: {
        processAssets: {
          tapPromise: (o: { name: string; stage: number }, fn: Processor) => {
            stage = o.stage;
            processor = fn;
          },
        },
      },
      getAssets: () => [...store.keys()].map((name) => ({ name })),
      getAsset: (name: string) =>
        store.has(name) ? { source: { buffer: () => store.get(name) as Buffer } } : undefined,
      updateAsset: vi.fn((name: string, source: unknown) => {
        store.set(name, (source as RawSource).content);
      }),
    },
  };
}

type Compilation = ReturnType<typeof fakeCompilation>['compilation'];

/** A fake compiler: records taps and lets the test fire them. */
function fakeCompiler(options: { path?: string; api?: boolean } = {}) {
  let onThis: ((c: Compilation) => void) | undefined;
  let onEmit: ((c: Compilation) => Promise<void>) | undefined;
  const compiler = {
    options: { output: { path: options.path ?? '/out/.next/server/chunks' } },
    hooks: {
      thisCompilation: { tap: (_n: string, fn: (c: Compilation) => void) => (onThis = fn) },
      afterEmit: {
        tapPromise: (_n: string, fn: (c: Compilation) => Promise<void>) => (onEmit = fn),
      },
    },
    ...(options.api === false
      ? {}
      : {
          webpack: {
            Compilation: { PROCESS_ASSETS_STAGE_DEV_TOOLING: 100 },
            sources: { RawSource },
          },
        }),
  } as unknown as CompilerLike;
  return {
    compiler,
    startCompilation: (c: Compilation) => (onThis as (c: Compilation) => void)(c),
    emit: (c: Compilation) => (onEmit as (c: Compilation) => Promise<void>)(c),
    hasThis: () => onThis !== undefined,
    hasEmit: () => onEmit !== undefined,
  };
}

function context(
  overrides: Partial<BugseeNextContext['resolved']> = {},
  extra = {},
): BugseeNextContext {
  return {
    resolved: {
      enabled: true,
      appToken: 't',
      deleteMaps: true,
      registerBuild: 'release',
      dryRun: false,
      failOnError: false,
      ...overrides,
    } as BugseeNextContext['resolved'],
    serverSourceMaps: true,
    deleteServerMaps: false,
    say: vi.fn(),
    ...extra,
  };
}

const deps = (over: WebpackPluginDeps = {}): WebpackPluginDeps => ({
  stamp: vi.fn(async () => ({ stamped: [] })),
  upload: vi.fn(async () => undefined),
  exists: vi.fn(async () => true),
  ...over,
});

describe('nextAssetStore', () => {
  it('stages `../` asset names under a stand-in directory and maps them back', () => {
    const { compilation, store } = fakeCompilation({
      '../app/page.js': 'code',
      '../app/page.js.map': 'map',
      'chunks/1.js': 'one',
      '../../deep.js': 'deep',
    });
    const assets = nextAssetStore(compilation, RawSource);
    const names = assets.names();
    expect(names).toEqual([
      '__bugsee_up__/app/page.js',
      '__bugsee_up__/app/page.js.map',
      'chunks/1.js',
      '__bugsee_up__/__bugsee_up__/deep.js',
    ]);
    // Nothing staged escapes the staging directory.
    expect(names.some((n) => n.startsWith('..') || n.includes('/../'))).toBe(false);
    expect(assets.read('__bugsee_up__/app/page.js').toString()).toBe('code');
    expect(assets.read('chunks/1.js').toString()).toBe('one');
    assets.update('__bugsee_up__/app/page.js', Buffer.from('stamped'));
    expect(store.get('../app/page.js')?.toString()).toBe('stamped');
    assets.update('chunks/1.js', Buffer.from('stamped-one'));
    expect(store.get('chunks/1.js')?.toString()).toBe('stamped-one');
  });

  it('reads an unknown asset as empty rather than throwing', () => {
    const { compilation } = fakeCompilation({});
    expect(nextAssetStore(compilation, RawSource).read('nope.js')).toEqual(Buffer.alloc(0));
  });
});

describe('createNextWebpackPlugin', () => {
  it('does nothing when the plugin is not enabled', () => {
    const fake = fakeCompiler();
    createNextWebpackPlugin(context({ enabled: false }), 'client', deps()).apply(fake.compiler);
    expect(fake.hasThis()).toBe(false);
    expect(fake.hasEmit()).toBe(false);
  });

  it('does nothing for server and edge when server maps are off, but still serves the client', () => {
    const off = context({}, { serverSourceMaps: false });
    for (const kind of ['server', 'edge'] as const) {
      const fake = fakeCompiler();
      createNextWebpackPlugin(off, kind, deps()).apply(fake.compiler);
      expect(fake.hasEmit()).toBe(false);
    }
    const client = fakeCompiler();
    createNextWebpackPlugin(off, 'client', deps()).apply(client.compiler);
    expect(client.hasEmit()).toBe(true);
  });

  it('stamps the compilation one stage after dev-tooling', async () => {
    const d = deps();
    const fake = fakeCompiler();
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x' });
    fake.startCompilation(c.compilation);
    expect(c.stage()).toBe(101);
    await c.run();
    expect(d.stamp).toHaveBeenCalledTimes(1);
    expect(d.stamp).toHaveBeenCalledWith(expect.any(Object), { dryRun: false });
  });

  it('passes dryRun to the stamp', async () => {
    const d = deps();
    const fake = fakeCompiler();
    createNextWebpackPlugin(context({ dryRun: true }), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x' });
    fake.startCompilation(c.compilation);
    await c.run();
    expect(d.stamp).toHaveBeenCalledWith(expect.any(Object), { dryRun: true });
  });

  it('uploads after emit with the stamped flag, over exactly this compilation’s own files', async () => {
    const d = deps();
    const fake = fakeCompiler({ path: '/out/.next/server/chunks' });
    createNextWebpackPlugin(context(), 'server', d).apply(fake.compiler);
    const c = fakeCompilation({
      '../app/page.js': 'x',
      '../app/page.js.map': 'm',
      'chunks/1.js': 'x',
      'chunks/1.js.map': 'm',
      'no-map.js': 'x',
    });
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    expect(d.upload).toHaveBeenCalledTimes(1);
    const [resolved, outDir, options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      string,
      { bundler: unknown; preStamped: boolean; files: Record<string, string[]> },
    ];
    expect(outDir).toBe('/out/.next/server/chunks');
    expect(options.preStamped).toBe(true);
    expect(options.bundler).toEqual({ isProduction: true, configuration: 'server' });
    expect(options.files.scripts).toEqual([
      '/out/.next/server/app/page.js',
      '/out/.next/server/chunks/chunks/1.js',
    ]);
    expect(options.files.maps).toEqual([
      '/out/.next/server/app/page.js.map',
      '/out/.next/server/chunks/chunks/1.js.map',
    ]);
    // The server follows the server deletion policy and never registers the build.
    expect(resolved).toMatchObject({ deleteMaps: false, registerBuild: false });
  });

  it('gives the client the client policy: deleted maps, the build registered', async () => {
    const d = deps();
    const fake = fakeCompiler({ path: '/out/.next' });
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'static/a.js': 'x', 'static/a.js.map': 'm' });
    fake.startCompilation(c.compilation);
    await fake.emit(c.compilation);
    const [resolved] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(resolved).toMatchObject({ deleteMaps: true, registerBuild: 'release' });
  });

  it('honours deleteServerMaps for server and edge', async () => {
    const d = deps();
    const fake = fakeCompiler();
    createNextWebpackPlugin(context({}, { deleteServerMaps: true }), 'edge', d).apply(
      fake.compiler,
    );
    const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    fake.startCompilation(c.compilation);
    await fake.emit(c.compilation);
    const [resolved] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(resolved).toMatchObject({ deleteMaps: true });
  });

  it('only counts assets that exist on disk', async () => {
    const d = deps({ exists: vi.fn(async (p: string) => !p.endsWith('gone.js')) });
    const fake = fakeCompiler();
    createNextWebpackPlugin(context(), 'server', d).apply(fake.compiler);
    const c = fakeCompilation({
      'gone.js': 'x',
      'gone.js.map': 'm',
      'here.js': 'x',
      'here.js.map': 'm',
    });
    fake.startCompilation(c.compilation);
    await fake.emit(c.compilation);
    const [, , options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { files: { scripts: string[] } },
    ];
    expect(options.files.scripts).toEqual(['/out/.next/server/chunks/here.js']);
  });

  it('falls back to the post-emit stamp (preStamped false) and warns when the in-build stamp fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = deps({
      stamp: vi.fn(async () => {
        throw new Error('inject broke');
      }),
    });
    const fake = fakeCompiler();
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inject broke'));
    const [, , options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { preStamped: boolean },
    ];
    expect(options.preStamped).toBe(false);
    warn.mockRestore();
  });

  it('reports a stamp failure through onError', async () => {
    const onError = vi.fn();
    const d = deps({
      stamp: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const fake = fakeCompiler();
    createNextWebpackPlugin(context({ onError }), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x' });
    fake.startCompilation(c.compilation);
    await c.run();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });

  it('rethrows a stamp failure under failOnError', async () => {
    const d = deps({
      stamp: vi.fn(async () => {
        throw new Error('strict');
      }),
    });
    const fake = fakeCompiler();
    createNextWebpackPlugin(context({ failOnError: true }), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x' });
    fake.startCompilation(c.compilation);
    await expect(c.run()).rejects.toThrow('strict');
  });

  it('a stamp from the previous compilation cannot vouch for the next one (watch mode)', async () => {
    const d = deps();
    const fake = fakeCompiler();
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const first = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    fake.startCompilation(first.compilation);
    await first.run();
    const second = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    fake.startCompilation(second.compilation);
    await fake.emit(second.compilation);
    const [, , options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { preStamped: boolean },
    ];
    expect(options.preStamped).toBe(false);
  });

  it('skips the in-build stamp when the compiler exposes no webpack API, and still uploads', async () => {
    const d = deps();
    const fake = fakeCompiler({ api: false });
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    expect(fake.hasThis()).toBe(false);
    const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    await fake.emit(c.compilation);
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('works through Rspack’s API object', async () => {
    const d = deps();
    const fake = fakeCompiler();
    const raw = fake.compiler as unknown as { webpack?: unknown; rspack?: unknown };
    raw.rspack = raw.webpack;
    raw.webpack = undefined;
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    expect(fake.hasThis()).toBe(true);
  });

  it('says so when the browser build emitted no maps, and does not upload', async () => {
    const d = deps();
    const ctx = context();
    const fake = fakeCompiler();
    createNextWebpackPlugin(ctx, 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x' });
    fake.startCompilation(c.compilation);
    await fake.emit(c.compilation);
    expect(d.upload).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('productionBrowserSourceMaps'));
  });

  it('is quiet when a server compilation emitted no maps', async () => {
    const d = deps();
    const ctx = context();
    const fake = fakeCompiler();
    createNextWebpackPlugin(ctx, 'server', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x' });
    await fake.emit(c.compilation);
    expect(d.upload).not.toHaveBeenCalled();
    expect(ctx.say).not.toHaveBeenCalled();
  });

  it('does nothing after emit when the compiler has no output path', async () => {
    const d = deps();
    const fake = fakeCompiler();
    (fake.compiler as unknown as { options: unknown }).options = {};
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    await fake.emit(fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' }).compilation);
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('uses the real stamp, upload and filesystem when none are injected', async () => {
    const fake = fakeCompiler({ path: '/definitely/not/here' });
    createNextWebpackPlugin(context({ enabled: true }), 'server').apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    // Nothing exists on disk, so the real `exists` filters everything out and nothing is uploaded.
    await expect(fake.emit(c.compilation)).resolves.toBeUndefined();
  });
});
