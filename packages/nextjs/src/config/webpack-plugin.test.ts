import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { BugseeNextContext } from './context';
import {
  type CompilerLike,
  createNextWebpackPlugin,
  nextAssetStore,
  pairRecorded,
  removeFile,
  type WebpackPluginDeps,
} from './webpack-plugin';

// Native absolute paths: the plugin resolves and joins with the host's path API (win32: `C:\out\.next`).
// Compilation asset names (`../app/page.js`) stay as the bundler reports them.
const p = (path: string): string => resolve(path);

/**
 * webpack-sources' RawSource, as far as it matters here: a STRING source is text webpack can still rewrite after
 * the stamp (RealContentHashPlugin renames `[contenthash]` references in string sources only), a Buffer source is
 * opaque to it. A stamp that hands a Buffer to `updateAsset` leaves lazy-chunk URLs pointing at files that were
 * renamed afterwards (measured on real Next builds: ChunkLoadError), so the fake refuses one.
 */
class RawSource {
  constructor(readonly content: string | Buffer) {}
}

type Processor = () => Promise<void>;

/** A fake webpack compilation holding named assets, recording updates. */
function fakeCompilation(
  assets: Record<string, string>,
  related: Record<string, string | string[]> = {},
) {
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
        store.has(name)
          ? {
              source: { buffer: () => store.get(name) as Buffer },
              info: related[name] === undefined ? {} : { related: { sourceMap: related[name] } },
            }
          : undefined,
      updateAsset: vi.fn((name: string, source: unknown) => {
        const { content } = source as RawSource;
        if (typeof content !== 'string') {
          throw new Error(`${name}: a Buffer source cannot be rewritten by RealContentHashPlugin`);
        }
        store.set(name, Buffer.from(content, 'utf8'));
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
    options: { output: { path: options.path ?? p('/out/.next/server/chunks') } },
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
  stamp: vi.fn(async () => ({ stamped: [], maps: {}, bundles: 1 })),
  upload: vi.fn(async () => undefined),
  exists: vi.fn(async () => true),
  hasSriManifest: vi.fn(async () => false),
  tail: vi.fn(async () => 'code();\n//# debugId=00000000-0000-5000-8000-000000000001\n'),
  remove: vi.fn(async () => undefined),
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
    const fake = fakeCompiler({ path: p('/out/.next/server/chunks') });
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
    expect(outDir).toBe(p('/out/.next/server/chunks'));
    expect(options.preStamped).toBe(true);
    expect(options.bundler).toEqual({ isProduction: true, configuration: 'server' });
    expect(options.files.scripts).toEqual([
      p('/out/.next/server/app/page.js'),
      p('/out/.next/server/chunks/chunks/1.js'),
    ]);
    expect(options.files.maps).toEqual([
      p('/out/.next/server/app/page.js.map'),
      p('/out/.next/server/chunks/chunks/1.js.map'),
    ]);
    // The server follows the server deletion policy and never registers the build.
    expect(resolved).toMatchObject({ deleteMaps: false, registerBuild: false });
  });

  it('gives the client the client policy: deleted maps, the build registered', async () => {
    const d = deps();
    const fake = fakeCompiler({ path: p('/out/.next') });
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
    expect(options.files.scripts).toEqual([p('/out/.next/server/chunks/here.js')]);
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

  it('reports a stamp failure through onError, once the build knows what follows', async () => {
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
    expect(onError).not.toHaveBeenCalled();
    await fake.emit(c.compilation);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(onError).toHaveBeenCalledTimes(1);
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

describe('nextAssetStore: sources webpack can still rewrite', () => {
  it('updates an asset with a STRING source, never a Buffer', () => {
    const { compilation, store } = fakeCompilation({ 'static/a.js': 'old' });
    const assets = nextAssetStore(compilation, RawSource);
    assets.names();
    assets.update('static/a.js', Buffer.from('new \u00e9 text', 'utf8'));
    expect(compilation.updateAsset).toHaveBeenCalledTimes(1);
    const [, source] = compilation.updateAsset.mock.calls[0] as [string, RawSource];
    expect(source.content).toBe('new \u00e9 text');
    expect(store.get('static/a.js')?.toString('utf8')).toBe('new \u00e9 text');
  });

  it('refuses bytes that are not valid UTF-8 up front (a string source would corrupt them)', () => {
    const { compilation } = fakeCompilation({ 'a.js': 'ok' });
    const assets = nextAssetStore(compilation, RawSource);
    expect(() => assets.check?.('a.js', Buffer.from([0xff, 0xfe, 0x00, 0x80]))).toThrow(
      /not valid UTF-8/,
    );
    expect(() => assets.update('a.js', Buffer.from([0xff, 0xfe]))).toThrow(/not valid UTF-8/);
    expect(compilation.updateAsset).not.toHaveBeenCalled();
    expect(() => assets.check?.('a.js', Buffer.from('fine \u00e9'))).not.toThrow();
  });

  it('keeps a byte-order mark instead of dropping it', () => {
    const { compilation, store } = fakeCompilation({ 'b.js': 'y' });
    const assets = nextAssetStore(compilation, RawSource);
    assets.update('b.js', Buffer.from('\ufeffwith bom'));
    expect(store.get('b.js')?.toString('utf8')).toBe('\ufeffwith bom');
  });
});

describe('nextAssetStore: query-free names and moved maps', () => {
  it('presents names without their ?query and maps them back to the real asset', () => {
    const { compilation, store } = fakeCompilation({
      'static/a.js?h1': 'a',
      'static/a.js.map?h1': 'm',
      'static/a#1.js': 'hash kept',
    });
    const assets = nextAssetStore(compilation, RawSource);
    expect(assets.names()).toEqual(['static/a.js', 'static/a.js.map', 'static/a#1.js']);
    expect(assets.read('static/a.js').toString()).toBe('a');
    assets.update('static/a.js', Buffer.from('b'));
    expect(store.get('static/a.js?h1')?.toString()).toBe('b');
    expect(assets.real('static/a.js')).toBe('static/a.js?h1');
    expect(assets.real('static/a#1.js')).toBe('static/a#1.js');
    expect(assets.real('unknown.js')).toBe('unknown.js');
  });

  it('keeps the real names of two assets that would collide once cleaned', () => {
    const { compilation } = fakeCompilation({ 'a.js?x': '1', 'a.js?y': '2' });
    expect(nextAssetStore(compilation, RawSource).names()).toEqual(['a.js?x', 'a.js?y']);
  });

  it('names the map the compilation recorded for a bundle, staged like the bundle', () => {
    const { compilation } = fakeCompilation(
      {
        '../app/page.js': 'x',
        '../maps/page.js.map?v': 'm',
        'a.js': 'x',
        'a.js.map': 'm',
        'b.js': 'x',
      },
      { '../app/page.js': '../maps/page.js.map?v', 'a.js': ['a.js.map', 'other'] },
    );
    const assets = nextAssetStore(compilation, RawSource);
    assets.names();
    expect(assets.mapOf?.('__bugsee_up__/app/page.js')).toBe('__bugsee_up__/maps/page.js.map');
    expect(assets.mapOf?.('a.js')).toBe('a.js.map');
    expect(assets.mapOf?.('b.js')).toBeUndefined();
  });
});

describe('createNextWebpackPlugin: the new core contract', () => {
  const asset = {
    '../app/page.js': 'x',
    '../app/page.js.map': 'm',
    'static/c.js': 'x',
    'static/c.js.map': 'm',
  };

  it('hands the on-disk re-check the FINAL names on disk: the bundles that carry a debug-ID now, with their maps', async () => {
    // The stamp saw `chunks/1.[old].js`; webpack renamed it afterwards, so the check goes by what is on disk.
    const d = deps({
      stamp: vi.fn(async () => ({
        stamped: ['chunks/1.OLDHASH.js'],
        maps: { 'chunks/1.OLDHASH.js': 'chunks/1.OLDHASH.js.map' },
        bundles: 1,
      })),
      tail: vi.fn(async (path: string) =>
        path.endsWith('1.NEWHASH.js')
          ? 'x\n//# debugId=00000000-0000-5000-8000-000000000009\n'
          : 'plain',
      ),
    });
    const fake = fakeCompiler({ path: p('/out/.next/server/chunks') });
    createNextWebpackPlugin(context(), 'server', d).apply(fake.compiler);
    const c = fakeCompilation({
      '../app/page.js': 'x',
      '../app/page.js.map': 'm',
      '1.NEWHASH.js': 'x',
      '1.NEWHASH.js.map': 'm',
    });
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    const [, , options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { stampedBundles: string[]; stampedMaps: Record<string, string> },
    ];
    expect(options.stampedBundles).toEqual(['1.NEWHASH.js']);
    expect(options.stampedMaps).toEqual({ '1.NEWHASH.js': '1.NEWHASH.js.map' });
  });

  it('reports a stamped bundle that lost its debug-ID on the way (instead of silently dropping it from the check)', async () => {
    const onError = vi.fn();
    const d = deps({
      stamp: vi.fn(async () => ({ stamped: ['a.js'], maps: { 'a.js': 'a.js.map' }, bundles: 1 })),
      tail: vi.fn(async () => 'plain, no id'),
    });
    const fake = fakeCompiler({ path: p('/o') });
    createNextWebpackPlugin(context({ onError }), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('1 of the 1 bundle(s)') }),
    );
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('warns on the console for it without onError, and rethrows under failOnError', async () => {
    const make = (ctx: BugseeNextContext) => {
      const d = deps({
        stamp: vi.fn(async () => ({ stamped: ['a.js'], maps: { 'a.js': 'a.js.map' }, bundles: 1 })),
        tail: vi.fn(async () => 'plain'),
      });
      const fake = fakeCompiler({ path: p('/o') });
      createNextWebpackPlugin(ctx, 'client', d).apply(fake.compiler);
      const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
      fake.startCompilation(c.compilation);
      return {
        run: async () => {
          await c.run();
          await fake.emit(c.compilation);
        },
      };
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await make(context()).run();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('do not carry their debug-ID'));
    warn.mockRestore();
    await expect(make(context({ failOnError: true })).run()).rejects.toThrow('do not carry');
  });

  it('pairs a recorded map elsewhere for the re-check', async () => {
    const d = deps({
      stamp: vi.fn(async () => ({
        stamped: ['static/a.js'],
        maps: { 'static/a.js': 'maps/a.js.map' },
        bundles: 1,
      })),
    });
    const fake = fakeCompiler({ path: p('/o') });
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation(
      { 'static/a.js': 'x', 'maps/a.js.map': 'm' },
      { 'static/a.js': 'maps/a.js.map' },
    );
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    const [, , options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { stampedMaps: Record<string, string> },
    ];
    expect(options.stampedMaps).toEqual({ 'static/a.js': 'maps/a.js.map' });
  });

  it('does not claim a stamp that staged nothing while the build emitted scripts: says so, stamps after emit', async () => {
    const d = deps({ stamp: vi.fn(async () => ({ stamped: [], maps: {}, bundles: 0 })) });
    const ctx = context();
    const fake = fakeCompiler();
    createNextWebpackPlugin(ctx, 'server', d).apply(fake.compiler);
    const c = fakeCompilation(asset);
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('no debug-ID could be stamped'));
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('server build'));
    const [, , options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { preStamped: boolean; stampedBundles?: string[] },
    ];
    expect(options.preStamped).toBe(false);
    expect(options.stampedBundles).toBeUndefined();
  });

  it('a compilation with no scripts at all and nothing staged is not an alarm', async () => {
    const d = deps({ stamp: vi.fn(async () => ({ stamped: [], maps: {}, bundles: 0 })) });
    const ctx = context();
    const fake = fakeCompiler();
    createNextWebpackPlugin(ctx, 'server', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.json': '{}' });
    fake.startCompilation(c.compilation);
    await c.run();
    expect(ctx.say).not.toHaveBeenCalled();
  });

  it('stamps and uploads nothing when the stamp is refused because a map lies outside the output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refusal = Object.assign(new Error('map outside the output'), { unreachableMap: true });
    const d = deps({
      stamp: vi.fn(async () => {
        throw refusal;
      }),
    });
    const fake = fakeCompiler();
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('half-stamp'));
    expect(d.upload).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('looks for an asset whose name carries a ?query at the query-free path on disk', async () => {
    const seen: string[] = [];
    const d = deps({
      exists: vi.fn(async (path: string) => {
        seen.push(path);
        return true;
      }),
    });
    const fake = fakeCompiler({ path: p('/out/.next') });
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'static/a.js?h': 'x', 'static/a.js.map?h': 'm' });
    await fake.emit(c.compilation);
    expect(seen).toEqual([p('/out/.next/static/a.js'), p('/out/.next/static/a.js.map')]);
  });
});

describe('createNextWebpackPlugin: the post-emit fallback on an SRI build', () => {
  const failing = () =>
    vi.fn(async () => {
      throw new Error('inject broke');
    });
  const run = async (ctx: BugseeNextContext, d: WebpackPluginDeps) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeCompiler();
    createNextWebpackPlugin(ctx, 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    warn.mockRestore();
  };

  it('does not stamp the written files when the app uses SRI (the config says so)', async () => {
    const ctx = context({}, { sri: true });
    const d = deps({ stamp: failing() });
    await run(ctx, d);
    expect(d.upload).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('Subresource Integrity'));
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('client build'));
  });

  it('nor when Next\u2019s integrity manifest sits next to the output', async () => {
    const ctx = context();
    const d = deps({ stamp: failing(), hasSriManifest: vi.fn(async () => true) });
    await run(ctx, d);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.hasSriManifest).toHaveBeenCalledWith(p('/out/.next/server/chunks'));
  });

  it('still falls back without SRI', async () => {
    const d = deps({ stamp: failing() });
    await run(context(), d);
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('uploads a stamp that took, SRI or not (it ran before anything hashed)', async () => {
    const d = deps();
    await run(context({}, { sri: true }), d);
    expect(d.upload).toHaveBeenCalledTimes(1);
    expect(d.hasSriManifest).not.toHaveBeenCalled();
  });
});

describe('createNextWebpackPlugin: no public maps Bugsee asked for when nothing is uploaded', () => {
  const failing = () =>
    vi.fn(async () => {
      throw new Error('inject broke');
    });
  const assets = {
    'static/a.js': 'x',
    'static/a.js.map': 'm',
    'static/a.css': 'c',
    'static/a.css.map': 'cm',
  };
  const run = async (kind: 'client' | 'server', ctx: BugseeNextContext, d: WebpackPluginDeps) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fake = fakeCompiler({ path: p('/out/.next') });
      createNextWebpackPlugin(ctx, kind, d).apply(fake.compiler);
      const c = fakeCompilation(assets);
      fake.startCompilation(c.compilation);
      await c.run();
      await fake.emit(c.compilation);
      return warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore(); // also when the hook rejects
    }
  };

  it('deletes the browser maps it turned on when an SRI build\u2019s stamp failed (nothing is uploaded)', async () => {
    const ctx = context({}, { sri: true, forcedMaps: true });
    const d = deps({ stamp: failing() });
    await run('client', ctx, d);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.remove).toHaveBeenCalledTimes(2);
    expect(d.remove).toHaveBeenCalledWith(p('/out/.next/static/a.js.map'));
    expect(d.remove).toHaveBeenCalledWith(p('/out/.next/static/a.css.map'));
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('were removed'));
  });

  it('keeps maps the app asked for, and says they are public', async () => {
    const ctx = context({}, { sri: true });
    const d = deps({ stamp: failing() });
    await run('client', ctx, d);
    expect(d.remove).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('publicly served'));
  });

  it('never touches a server compilation\u2019s maps (not public)', async () => {
    const ctx = context({}, { sri: true, forcedMaps: true });
    const d = deps({ stamp: failing() });
    await run('server', ctx, d);
    expect(d.remove).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.not.stringContaining('browser source maps'));
  });

  it('deletes them when the stamp was abandoned (a map outside the output), too', async () => {
    const d = deps({
      stamp: vi.fn(async () => {
        throw Object.assign(new Error('outside'), { unreachableMap: true });
      }),
    });
    await run('client', context({}, { forcedMaps: true }), d);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.remove).toHaveBeenCalledTimes(2);
  });

  it('after a CONFIRMED upload it still removes a forced map that was kept on disk (an unkeyed, restored one)', async () => {
    const d = deps({ upload: vi.fn(async () => ({ uploaded: true }) as never) });
    await run('client', context({}, { forcedMaps: true }), d);
    expect(d.upload).toHaveBeenCalledTimes(1);
    // the sweep tolerates what the upload already deleted (removeFile ignores ENOENT) and takes what is left
    expect(d.remove).toHaveBeenCalledWith(p('/out/.next/static/a.js.map'));
  });

  it('deletes them when the upload ran but was NOT confirmed (contained failure), and when it throws', async () => {
    const unconfirmed = deps(); // resolves undefined: nothing confirmed
    await run('client', context({}, { forcedMaps: true }), unconfirmed);
    expect(unconfirmed.remove).toHaveBeenCalledWith(p('/out/.next/static/a.js.map'));
    expect(unconfirmed.remove).toHaveBeenCalledWith(p('/out/.next/static/a.css.map'));

    const notUploaded = deps({ upload: vi.fn(async () => ({ uploaded: false }) as never) });
    await run('client', context({}, { forcedMaps: true }), notUploaded);
    expect(notUploaded.remove).toHaveBeenCalledTimes(2);

    const throwing = deps({
      upload: vi.fn(async () => {
        throw new Error('upload broke');
      }),
    });
    await expect(run('client', context({}, { forcedMaps: true }), throwing)).rejects.toThrow(
      'upload broke',
    );
    expect(throwing.remove).toHaveBeenCalledTimes(2);
  });

  it('keeps them with deleteMaps: false, on a dry run, when the app asked for them, and on a server compilation', async () => {
    for (const [overrides, extra, kind] of [
      [{ deleteMaps: false }, { forcedMaps: true }, 'client'],
      [{ dryRun: true }, { forcedMaps: true }, 'client'],
      [{}, {}, 'client'],
      [{}, { forcedMaps: true }, 'server'],
    ] as const) {
      const d = deps();
      await run(kind, context({ ...overrides }, { ...extra }), d);
      expect(d.upload).toHaveBeenCalledTimes(1);
      expect(d.remove).not.toHaveBeenCalled();
    }
  });

  it('an SRI refusal removes forced maps whose script a later stage dropped, too', async () => {
    const ctx = context({}, { sri: true, forcedMaps: true });
    const d = deps({ stamp: failing() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fake = fakeCompiler({ path: p('/out/.next') });
      createNextWebpackPlugin(ctx, 'client', d).apply(fake.compiler);
      const c = fakeCompilation({ 'static/a.js': 'x', 'static/orphan.js.map': 'm' });
      fake.startCompilation(c.compilation);
      await c.run();
      await fake.emit(c.compilation);
    } finally {
      warn.mockRestore();
    }
    expect(d.remove).toHaveBeenCalledWith(p('/out/.next/static/orphan.js.map'));
  });

  it('strict: an SRI build whose scripts could not be staged fails (nothing was rewritten or uploaded)', async () => {
    const ctx = context({ failOnError: true }, { sri: true });
    const d = deps({ stamp: vi.fn(async () => ({ stamped: [], maps: {}, bundles: 0 })) });
    await expect(run('client', ctx, d)).rejects.toThrow(/could be staged/);
    expect(d.upload).not.toHaveBeenCalled();
    // not strict: reported, returns
    const lenient = deps({ stamp: vi.fn(async () => ({ stamped: [], maps: {}, bundles: 0 })) });
    await expect(run('client', context({}, { sri: true }), lenient)).resolves.toBeDefined();
  });

  it('strict: a stamped bundle whose map vanished before the upload is a failure, otherwise reported', async () => {
    const stampedOne = () =>
      vi.fn(async () => ({ stamped: [], maps: { 'static/a.js': 'static/a.js.map' }, bundles: 1 }));
    const emitOnlyScript = async (ctx: BugseeNextContext, d: WebpackPluginDeps) => {
      const fake = fakeCompiler({ path: p('/out/.next') });
      createNextWebpackPlugin(ctx, 'client', d).apply(fake.compiler);
      const c = fakeCompilation({ 'static/a.js': 'x' });
      fake.startCompilation(c.compilation);
      await c.run();
      await fake.emit(c.compilation);
    };
    await expect(
      emitOnlyScript(context({ failOnError: true }), deps({ stamp: stampedOne() })),
    ).rejects.toThrow(/no map left on disk/);
    const onError = vi.fn();
    await emitOnlyScript(context({ onError }), deps({ stamp: stampedOne() }));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('no map left') }),
    );
  });

  it('a lost pair with no onError is a console warning; an upload failure wins over a failing cleanup', async () => {
    const lostPair = deps({
      stamp: vi.fn(async () => ({
        stamped: [],
        maps: { 'static/a.js': 'static/a.js.map' },
        bundles: 1,
      })),
    });
    const fake = fakeCompiler({ path: p('/out/.next') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      createNextWebpackPlugin(context(), 'client', lostPair).apply(fake.compiler);
      const c = fakeCompilation({ 'static/a.js': 'x' });
      fake.startCompilation(c.compilation);
      await c.run();
      await fake.emit(c.compilation);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no map left on disk'));
    } finally {
      warn.mockRestore();
    }
    const both = deps({
      upload: vi.fn(async () => {
        throw new Error('upload broke');
      }),
      remove: vi.fn(async () => {
        throw new Error('EPERM');
      }),
    });
    await expect(
      run('client', context({ failOnError: true }, { forcedMaps: true }), both),
    ).rejects.toThrow('upload broke');
  });

  it('an existence check that fails for a reason other than "not there" is reported (strict: thrown), not read as "no maps"', async () => {
    const eio = () =>
      vi.fn(async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      });
    await expect(
      run('client', context({ failOnError: true }), deps({ exists: eio() })),
    ).rejects.toThrow('EIO');
    const onError = vi.fn();
    await run('client', context({ onError }), deps({ exists: eio() }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EIO' }));
    const warned = await run('client', context(), deps({ exists: eio() }));
    expect(warned.join('\n')).toContain('could not look for an emitted asset');
  });

  it('prints ONE accurate message on an SRI build, never "falling back"', async () => {
    const onError = vi.fn();
    const ctx = context({ onError }, { sri: true, forcedMaps: true });
    const warned = await run('client', ctx, deps({ stamp: failing() }));
    expect(warned.join('\n')).not.toMatch(/falling back/);
    expect(ctx.say).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'inject broke' }));
  });

  it('the CAUSE is never hidden by `silent`: with no onError it is a console warning, not a notice', async () => {
    const ctx = context({}, { sri: true, forcedMaps: true });
    const warned = await run('client', ctx, deps({ stamp: failing() }));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/in-build debug-ID stamping did not apply: Error: inject broke/);
    // The notice does not carry the cause (so a silenced notice cannot be the only place it lives).
    expect(vi.mocked(ctx.say).mock.calls[0]?.[0]).not.toContain('inject broke');
  });

  it('a maps-removal failure never fails the build: reported through onError, then the notice says so', async () => {
    const onError = vi.fn();
    const ctx = context({ onError }, { sri: true, forcedMaps: true });
    const d = deps({
      stamp: failing(),
      remove: vi.fn(async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }),
    });
    await expect(run('client', ctx, d)).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EPERM' }));
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('could not all be removed'));
  });

  it('warns on the console when removal fails and there is no onError', async () => {
    const ctx = context({}, { sri: true, forcedMaps: true });
    const d = deps({
      stamp: failing(),
      remove: vi.fn(async () => {
        throw new Error('EPERM');
      }),
    });
    const warned = await run('client', ctx, d);
    expect(warned.some((w) => w.includes('could not remove the browser source maps'))).toBe(true);
  });

  it('rethrows a removal failure under failOnError (reachable when nothing could be staged on an SRI build)', async () => {
    const ctx = context({ failOnError: true }, { sri: true, forcedMaps: true });
    const d = deps({
      stamp: vi.fn(async () => ({ stamped: [], maps: {}, bundles: 0 })),
      remove: vi.fn(async () => {
        throw new Error('EPERM');
      }),
    });
    await expect(run('client', ctx, d)).rejects.toThrow('EPERM');
  });

  it('deletes nothing on a dry run, and says so', async () => {
    const ctx = context({ dryRun: true }, { sri: true, forcedMaps: true });
    const d = deps({ stamp: failing() });
    await run('client', ctx, d);
    expect(d.remove).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('Dry run: nothing was deleted'));
  });

  it('an abandoned stamp deletes nothing on a dry run either', async () => {
    const d = deps({
      stamp: vi.fn(async () => {
        throw Object.assign(new Error('outside'), { unreachableMap: true });
      }),
    });
    await run('client', context({ dryRun: true }, { forcedMaps: true }), d);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('an SRI build where nothing could be staged (no thrown cause) still reports through onError / console.warn', async () => {
    const nothing = () => vi.fn(async () => ({ stamped: [], maps: {}, bundles: 0 }));
    const onError = vi.fn();
    await run(
      'client',
      context({ onError }, { sri: true, forcedMaps: true }),
      deps({ stamp: nothing() }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('could be staged') }),
    );
    const warned = await run(
      'client',
      context({}, { sri: true, forcedMaps: true }),
      deps({ stamp: nothing() }),
    );
    expect(warned.some((w) => w.includes('could be staged'))).toBe(true);
  });

  it('tries every removal, then reports each failure (partial removal is reported, not hidden)', async () => {
    const onError = vi.fn();
    const remove = vi.fn(async (path: string) => {
      if (path.endsWith('a.js.map')) throw new Error(`EPERM ${path}`);
    });
    const ctx = context({ onError }, { sri: true, forcedMaps: true });
    await run('client', ctx, deps({ stamp: failing(), remove }));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('a.js.map') }),
    );
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('could not all be removed'));
  });

  it('a throwing onError aborts the hook, as the core\u2019s own does', async () => {
    const onError = vi.fn(() => {
      throw new Error('host logger down');
    });
    const ctx = context({ onError }, { sri: true, forcedMaps: true });
    await expect(
      run(
        'client',
        ctx,
        deps({
          stamp: failing(),
          remove: vi.fn(async () => {
            throw new Error('EPERM');
          }),
        }),
      ),
    ).rejects.toThrow('host logger down');
  });

  it('only claims a dry run deleted nothing when something would have been deleted', async () => {
    const forced = context({ dryRun: true }, { sri: true, forcedMaps: true });
    await run('client', forced, deps({ stamp: failing() }));
    expect(forced.say).toHaveBeenCalledWith(
      expect.stringContaining('Dry run: nothing was deleted'),
    );
    const own = context({ dryRun: true }, { sri: true });
    await run('client', own, deps({ stamp: failing() }));
    expect(own.say).toHaveBeenCalledWith(expect.not.stringContaining('Dry run'));
    expect(own.say).toHaveBeenCalledWith(expect.stringContaining('publicly served'));
  });

  it('an abandoned stamp on a dry run says the forced maps remain public', async () => {
    const abandon = () =>
      vi.fn(async () => {
        throw Object.assign(new Error('outside'), { unreachableMap: true });
      });
    const forced = context({ dryRun: true }, { forcedMaps: true });
    await run('client', forced, deps({ stamp: abandon() }));
    expect(forced.say).toHaveBeenCalledWith(expect.stringContaining('publicly served'));
    const own = context({ dryRun: true });
    await run('client', own, deps({ stamp: abandon() }));
    expect(own.say).not.toHaveBeenCalled();
  });

  it('deleteMaps: false keeps the forced browser maps when stamping is refused or abandoned, and the notice says so', async () => {
    const keep = context({ deleteMaps: false }, { sri: true, forcedMaps: true });
    const d = deps({ stamp: failing() });
    await run('client', keep, d);
    expect(d.remove).not.toHaveBeenCalled();
    expect(keep.say).toHaveBeenCalledWith(expect.stringContaining('`deleteMaps: false`'));
    expect(keep.say).toHaveBeenCalledWith(expect.stringContaining('publicly served'));
    expect(keep.say).toHaveBeenCalledWith(expect.not.stringContaining('were removed'));

    // maps the app asked for are not "the ones Bugsee turned on": the notice does not claim them
    const own = context({ deleteMaps: false }, { sri: true });
    await run('client', own, deps({ stamp: failing() }));
    expect(own.say).toHaveBeenCalledWith(expect.not.stringContaining('`deleteMaps: false`'));

    const abandoned = deps({
      stamp: vi.fn(async () => {
        throw Object.assign(new Error('outside'), { unreachableMap: true });
      }),
    });
    const keepAbandoned = context({ deleteMaps: false }, { forcedMaps: true });
    await run('client', keepAbandoned, abandoned);
    expect(abandoned.remove).not.toHaveBeenCalled();
    expect(keepAbandoned.say).toHaveBeenCalledWith(expect.stringContaining('`deleteMaps: false`'));
  });

  it('sweeps the forced browser maps when a later stage dropped the last client script but left its map', async () => {
    const orphanRun = async (ctx: BugseeNextContext, d: WebpackPluginDeps) => {
      const fake = fakeCompiler({ path: p('/out/.next') });
      createNextWebpackPlugin(ctx, 'client', d).apply(fake.compiler);
      const c = fakeCompilation({ 'static/a.js.map': 'm', 'static/a.css.map': 'cm' });
      fake.startCompilation(c.compilation);
      await c.run();
      await fake.emit(c.compilation);
    };
    const d = deps();
    await orphanRun(context({}, { forcedMaps: true }), d);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.remove).toHaveBeenCalledWith(p('/out/.next/static/a.js.map'));
    expect(d.remove).toHaveBeenCalledWith(p('/out/.next/static/a.css.map'));

    // not on a dry run, not with deleteMaps: false, not for maps the app asked for, not for a server compilation
    for (const [resolved, extra] of [
      [{ dryRun: true }, { forcedMaps: true }],
      [{ deleteMaps: false }, { forcedMaps: true }],
      [{}, {}],
    ] as const) {
      const kept = deps();
      await orphanRun(context(resolved, extra), kept);
      expect(kept.remove).not.toHaveBeenCalled();
    }
  });

  it('on a build without SRI the fallback message is printed, once', async () => {
    const warned = await run('client', context(), deps({ stamp: failing() }));
    expect(warned.filter((w) => w.includes('falling back to stamping after emit'))).toHaveLength(1);
  });

  it('the default remover tolerates a file that is already gone and reports other errors', async () => {
    const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-rm-'));
    try {
      writeFileSync(join(dir, 'a.js'), 'x');
      writeFileSync(join(dir, 'a.js.map'), 'm');
      const ctx = context({}, { sri: true, forcedMaps: true });
      const fake = fakeCompiler({ path: dir });
      createNextWebpackPlugin(ctx, 'client', {
        ...deps({ stamp: failing() }),
        remove: undefined,
        exists: undefined,
      }).apply(fake.compiler);
      const c = fakeCompilation({
        'a.js': 'x',
        'a.js.map': 'm',
        'gone.js': 'x',
        'gone.js.map': 'm',
      });
      fake.startCompilation(c.compilation);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await c.run();
      await fake.emit(c.compilation);
      warn.mockRestore();
      expect(existsSync(join(dir, 'a.js.map'))).toBe(false);
      expect(existsSync(join(dir, 'a.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeFile', () => {
  it('deletes a file, ignores one that is gone, and reports anything else', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-rmf-'));
    try {
      writeFileSync(join(dir, 'a.map'), 'm');
      await removeFile(join(dir, 'a.map'));
      expect(existsSync(join(dir, 'a.map'))).toBe(false);
      await expect(removeFile(join(dir, 'gone.map'))).resolves.toBeUndefined();
      mkdirSync(join(dir, 'd'));
      await expect(removeFile(join(dir, 'd'))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pairRecorded', () => {
  const emitted = (names: string[]) => names.map((n) => p(`/o/${n}`));

  it('pairs a script with the map the compilation recorded for it, wherever that map is', () => {
    const { compilation } = fakeCompilation(
      { 'static/a.js': 'x', 'maps/a.js.map': 'm', 'static/b.js': 'x', 'static/b.js.map': 'm' },
      { 'static/a.js': 'maps/a.js.map' },
    );
    const files = pairRecorded(
      compilation,
      p('/o'),
      emitted(['static/a.js', 'maps/a.js.map', 'static/b.js', 'static/b.js.map']),
    );
    expect(files.scripts).toEqual([p('/o/static/a.js'), p('/o/static/b.js')]);
    expect(files.maps).toEqual([p('/o/maps/a.js.map'), p('/o/static/b.js.map')]);
  });

  it('the map the compilation recorded wins over a same-named sibling a later stage emitted', () => {
    const { compilation } = fakeCompilation(
      { 'a.js': 'x', 'a.js.map': 'unrelated', 'maps/original.map': 'm' },
      { 'a.js': 'maps/original.map' },
    );
    const files = pairRecorded(
      compilation,
      p('/o'),
      emitted(['a.js', 'a.js.map', 'maps/original.map']),
    );
    expect(files.pairs?.[p('/o/a.js')]).toBe(p('/o/maps/original.map'));
  });

  it('accepts a recorded list and a ?query on the recorded map', () => {
    const { compilation } = fakeCompilation(
      { 'a.js': 'x', 'm/a.js.map?v': 'm' },
      { 'a.js': ['m/a.js.map?v', 'other'] },
    );
    expect(pairRecorded(compilation, p('/o'), emitted(['a.js', 'm/a.js.map'])).maps).toEqual([
      p('/o/m/a.js.map'),
    ]);
  });

  it('ignores a recorded map that was not emitted, and scripts with none recorded', () => {
    const { compilation } = fakeCompilation(
      { 'a.js': 'x', 'b.js': 'x', 'c.txt': 'x' },
      { 'a.js': 'gone.js.map' },
    );
    const files = pairRecorded(compilation, p('/o'), emitted(['a.js', 'b.js', 'c.txt']));
    expect(files.scripts).toEqual([]);
    expect(files.maps).toEqual([]);
  });

  it('does not pair a script that was not itself emitted', () => {
    const { compilation } = fakeCompilation(
      { 'a.js': 'x', 'm/a.js.map': 'm' },
      { 'a.js': 'm/a.js.map' },
    );
    expect(pairRecorded(compilation, p('/o'), emitted(['m/a.js.map'])).scripts).toEqual([]);
  });
});

describe('createNextWebpackPlugin: queries, recorded maps, registration', () => {
  it('goes by the query-free names on disk (webpack drops ?query when it writes the file)', async () => {
    const d = deps({
      stamp: vi.fn(async () => ({
        stamped: ['static/a.js'],
        maps: { 'static/a.js': 'static/a.js.map' },
        bundles: 1,
      })),
    });
    const fake = fakeCompiler({ path: p('/o') });
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation({ 'static/a.js?v=1': 'x', 'static/a.js.map?v=1': 'm' });
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
    const [, , options] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { stampedBundles: string[]; stampedMaps: Record<string, string> },
    ];
    expect(options.stampedBundles).toEqual(['static/a.js']);
    expect(options.stampedMaps).toEqual({ 'static/a.js': 'static/a.js.map' });
  });

  it('uploads maps a script\u2019s recorded relationship names even when none sits beside it', async () => {
    const d = deps();
    const fake = fakeCompiler({ path: p('/o') });
    createNextWebpackPlugin(context(), 'client', d).apply(fake.compiler);
    const c = fakeCompilation(
      { 'static/a.js': 'x', 'maps/a.js.map': 'm' },
      { 'static/a.js': 'maps/a.js.map' },
    );
    fake.startCompilation(c.compilation);
    await fake.emit(c.compilation);
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('the server compilation registers the build only when the app writes no browser maps', async () => {
    const reg = async (browserMaps: boolean | undefined, kind: 'client' | 'server' | 'edge') => {
      const d = deps();
      const fake = fakeCompiler({ path: p('/o') });
      createNextWebpackPlugin(
        context({}, { ...(browserMaps === undefined ? {} : { browserMaps }) }),
        kind,
        d,
      ).apply(fake.compiler);
      const c = fakeCompilation({ 'a.js': 'x', 'a.js.map': 'm' });
      fake.startCompilation(c.compilation);
      await fake.emit(c.compilation);
      return (d.upload as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        registerBuild: unknown;
      };
    };
    expect((await reg(false, 'server')).registerBuild).toBe('release');
    expect((await reg(true, 'server')).registerBuild).toBe(false);
    expect((await reg(undefined, 'server')).registerBuild).toBe(false);
    expect((await reg(false, 'edge')).registerBuild).toBe(false);
    expect((await reg(false, 'client')).registerBuild).toBe('release');
  });
});

describe('createNextWebpackPlugin: the on-disk scan and the no-maps notice', () => {
  const stampedDeps = (over: WebpackPluginDeps = {}) =>
    deps({
      stamp: vi.fn(async () => ({ stamped: ['a.js'], maps: { 'a.js': 'a.js.map' }, bundles: 1 })),
      ...over,
    });
  const emitWith = async (
    ctx: BugseeNextContext,
    d: WebpackPluginDeps,
    assets: Record<string, string>,
  ) => {
    const fake = fakeCompiler({ path: p('/o') });
    createNextWebpackPlugin(ctx, 'client', d).apply(fake.compiler);
    const c = fakeCompilation(assets);
    fake.startCompilation(c.compilation);
    await c.run();
    await fake.emit(c.compilation);
  };

  it('an unreadable bundle never fails the build: reported through onError, not counted as lost', async () => {
    const onError = vi.fn();
    const d = stampedDeps({
      tail: vi.fn(async () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }),
    });
    await expect(
      emitWith(context({ onError }), d, { 'a.js': 'x', 'a.js.map': 'm' }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EBUSY' }));
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('warns on the console for it without onError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = stampedDeps({
      tail: vi.fn(async () => {
        throw new Error('EMFILE');
      }),
    });
    await emitWith(context(), d, { 'a.js': 'x', 'a.js.map': 'm' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read a stamped client bundle'),
    );
    warn.mockRestore();
  });

  it('rethrows an unreadable bundle under failOnError', async () => {
    const d = stampedDeps({
      tail: vi.fn(async () => {
        throw new Error('EBUSY');
      }),
    });
    await expect(
      emitWith(context({ failOnError: true }), d, { 'a.js': 'x', 'a.js.map': 'm' }),
    ).rejects.toThrow('EBUSY');
  });

  it('says nothing about missing browser maps when the app chose that (or on a dry run)', async () => {
    const off = context({}, { browserMaps: false });
    await emitWith(off, deps(), { 'a.js': 'x' });
    expect(off.say).not.toHaveBeenCalled();
    const expected = context({}, { browserMaps: true });
    await emitWith(expected, deps(), { 'a.js': 'x' });
    expect(expected.say).toHaveBeenCalledWith(expect.stringContaining('emitted no source maps'));
  });
});

describe('the real existence check', () => {
  it('"not there" (ENOENT, ENOTDIR) is absent; an unreadable parent (EACCES) is reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-next-exists-'));
    try {
      writeFileSync(join(dir, 'file'), 'x');
      mkdirSync(join(dir, 'locked'));
      writeFileSync(join(dir, 'locked', 'a.js'), 'x');
      const emit = async (name: string, onError: (e: unknown) => void) => {
        const fake = fakeCompiler({ path: dir });
        const ctx = context({ onError });
        createNextWebpackPlugin(ctx, 'client', {
          stamp: vi.fn(async () => ({ stamped: [], maps: {}, bundles: 0 })),
          upload: vi.fn(async () => undefined),
          hasSriManifest: vi.fn(async () => false),
        }).apply(fake.compiler);
        const c = fakeCompilation({ [name]: 'x' });
        fake.startCompilation(c.compilation);
        await c.run();
        await fake.emit(c.compilation);
      };
      const quiet = vi.fn();
      await emit('missing.js', quiet); // ENOENT
      await emit('file/inside.js', quiet); // ENOTDIR
      expect(quiet).not.toHaveBeenCalled();
      if (process.getuid?.() !== 0 && process.platform !== 'win32') {
        chmodSync(join(dir, 'locked'), 0o000);
        const loud = vi.fn();
        try {
          await emit('locked/a.js', loud);
        } finally {
          chmodSync(join(dir, 'locked'), 0o755);
        }
        expect(loud).toHaveBeenCalledWith(expect.objectContaining({ code: 'EACCES' }));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
