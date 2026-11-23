import { describe, expect, it, vi } from 'vitest';
import { readDebugId } from './debug-ids';
import {
  type AssetStore,
  rollupAssetStore,
  rollupUnstampableMaps,
  StampVerificationError,
  stampAssets,
} from './stamp-assets';

/** An in-memory stand-in for a webpack compilation's asset table. */
function memoryStore(initial: Record<string, string>): AssetStore & {
  assets: Map<string, string>;
  updates: string[];
} {
  const assets = new Map(Object.entries(initial));
  const updates: string[] = [];
  return {
    assets,
    updates,
    names: () => [...assets.keys()],
    read: (name) => Buffer.from(assets.get(name) as string),
    update: (name, content) => {
      updates.push(name);
      assets.set(name, content.toString('utf8'));
    },
  };
}

describe('stampAssets — with the real bugsee-cli', () => {
  // The whole point of this module is that the Rust `inject` stays the ONE implementation of the
  // debug-id algorithm and the runtime stub. So the check that matters runs the real binary.
  it('stamps each bundle and its map in place, in the asset table', async () => {
    const store = memoryStore({
      'static/js/main.js': 'console.log("main");\n//# sourceMappingURL=main.js.map',
      'static/js/main.js.map':
        '{"version":3,"file":"main.js","sources":["a.ts"],"names":[],"mappings":"AAAA"}',
      'index.html': '<script src="static/js/main.js"></script>',
    });

    const result = await stampAssets(store);

    const js = store.assets.get('static/js/main.js') as string;
    const map = JSON.parse(store.assets.get('static/js/main.js.map') as string) as {
      debugId: string;
      debug_id: string;
    };
    const id = readDebugId(js);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // The bundle and its map agree — which is what lets a crash frame find its map.
    expect(map.debugId).toBe(id);
    expect(map.debug_id).toBe(id);
    // The runtime registration the SDK reads at crash time.
    expect(js).toContain('_bugseeDebugIds');
    // Only what inject rewrote is written back; the HTML is not touched.
    expect(store.updates.sort()).toEqual(['static/js/main.js', 'static/js/main.js.map']);
    expect(store.assets.get('index.html')).toBe('<script src="static/js/main.js"></script>');
    expect(result.stamped).toEqual(['static/js/main.js']);
  });

  it('is deterministic, so a rebuild of the same output stamps the same id', async () => {
    const source = {
      'a.js': 'x()\n//# sourceMappingURL=a.js.map',
      'a.js.map': '{"version":3,"sources":["x.ts"],"names":[],"mappings":"AAAA"}',
    };
    const first = memoryStore(source);
    const second = memoryStore(source);
    await stampAssets(first);
    await stampAssets(second);
    expect(first.assets.get('a.js')).toBe(second.assets.get('a.js'));
  });

  it('writes nothing back on a dry run', async () => {
    const store = memoryStore({
      'a.js': 'x()\n',
      'a.js.map': '{"version":3,"sources":[],"mappings":""}',
    });
    const result = await stampAssets(store, { dryRun: true });
    expect(store.updates).toEqual([]);
    expect(result.stamped).toEqual([]);
  });
});

const STAMP_COMMENT = '//# debugId=b039c7fb-d958-5fe6-b76f-136179e9a728';

describe('stampAssets — the round trip', () => {
  const fakeInject =
    (edit: (path: string, content: string) => string | undefined) => async (args: string[]) => {
      const { readdir, readFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const root = args[2] as string;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else {
            const next = edit(full.slice(root.length + 1), await readFile(full, 'utf8'));
            if (next !== undefined) {
              await writeFile(full, next);
            }
          }
        }
      };
      await walk(root);
      return { code: 0, stdout: '', stderr: '' };
    };

  it('runs `sourcemaps inject` over the staged directory, with no credentials', async () => {
    // Inject is a local rewrite. Handing it the app token would expose it to one more process
    // for nothing — the same rule the VCS probe follows.
    const run = vi.fn(fakeInject(() => undefined));
    await stampAssets(memoryStore({ 'a.js': 'x()\n' }), { run });
    expect(run).toHaveBeenCalledOnce();
    const [args, options] = run.mock.calls[0] as unknown as [string[], Record<string, unknown>];
    expect(args.slice(0, 2)).toEqual(['sourcemaps', 'inject']);
    expect(options).toEqual({});
  });

  it('writes nothing back on a dry run, whatever is on disk afterwards', async () => {
    // The guarantee is this module's, not the CLI's: a preview never alters the build, even if the
    // staged files changed underneath it.
    const store = memoryStore({ 'a.js': 'x()\n' });
    const result = await stampAssets(store, {
      dryRun: true,
      run: fakeInject((_path, content) => `${content}//# changed\n`),
    });
    expect(store.updates).toEqual([]);
    expect(result.stamped).toEqual([]);
  });

  it('forwards --dry-run to inject', async () => {
    const run = vi.fn(fakeInject(() => undefined));
    await stampAssets(memoryStore({ 'a.js': 'x()\n' }), { run, dryRun: true });
    expect((run.mock.calls[0] as unknown as [string[]])[0]).toContain('--dry-run');
  });

  it('preserves the directory layout, so a bundle still finds its map', async () => {
    // inject pairs a bundle with its map through `//# sourceMappingURL=` relative to the BUNDLE, or
    // the `<bundle>.map` sibling. Flattening the staged tree would break both.
    const seen: string[] = [];
    await stampAssets(
      memoryStore({ 'static/js/a.js': 'x()\n', 'static/js/a.js.map': '{}', 'b.mjs': 'y()\n' }),
      {
        run: fakeInject((path) => {
          seen.push(path);
          return undefined;
        }),
      },
    );
    expect(seen.sort()).toEqual(['b.mjs', 'static/js/a.js', 'static/js/a.js.map']);
  });

  it('stages only bundles and maps', async () => {
    const seen: string[] = [];
    await stampAssets(
      memoryStore({ 'a.js': 'x()\n', 'a.css': 'b{}', 'index.html': '<p/>', 'img.png': 'PNG' }),
      {
        run: fakeInject((path) => {
          seen.push(path);
          return undefined;
        }),
      },
    );
    expect(seen).toEqual(['a.js']);
  });

  it('writes back ONLY what inject changed', async () => {
    // An unchanged asset keeps its original Source object — webpack's own caching and any source
    // map information it carries survive untouched.
    const store = memoryStore({ 'a.js': 'x()\n', 'b.js': 'y()\n' });
    await stampAssets(store, {
      run: fakeInject((path, content) =>
        path === 'a.js' ? `${content};1;\n${STAMP_COMMENT}\n` : undefined,
      ),
    });
    expect(store.updates).toEqual(['a.js']);
  });

  it('refuses to stage an asset whose name would escape the staging directory', async () => {
    // Asset names come from the build config. One that climbs out must not be WRITTEN outside the
    // temp directory — the harm is the write itself, so that is what is checked, at the exact path
    // the escape would have reached (a sibling of the staging directory, inside the OS temp dir).
    const { access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const escaped = `bugsee-escape-${process.pid}-${Date.now()}.js`;
    const seen: string[] = [];
    const store = memoryStore({ [`../${escaped}`]: 'x()\n', '/abs.js': 'y()\n', 'ok.js': 'z()\n' });
    await stampAssets(store, {
      run: fakeInject((path) => {
        seen.push(path);
        return undefined;
      }),
    });
    expect(seen).toEqual(['ok.js']);
    await expect(access(join(tmpdir(), escaped))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does nothing at all for a build with no bundles', async () => {
    const run = vi.fn(fakeInject(() => undefined));
    const result = await stampAssets(memoryStore({ 'a.css': 'b{}' }), { run });
    expect(run).not.toHaveBeenCalled();
    expect(result.stamped).toEqual([]);
  });

  it('propagates an inject failure, for the caller to contain', async () => {
    // The plugin decides what a failure means (fall back to the post-emit path, or fail the build
    // under failOnError); this layer must not swallow it into "nothing was stamped".
    await expect(
      stampAssets(memoryStore({ 'a.js': 'x()\n' }), {
        run: async () => {
          throw new Error('bugsee-cli exited 20');
        },
      }),
    ).rejects.toThrow(/exited 20/);
  });

  it('removes the staging directory afterwards, even when inject fails', async () => {
    const { access } = await import('node:fs/promises');
    let staged = '';
    const capture = async (args: string[]) => {
      staged = args[2] as string;
      return { code: 0, stdout: '', stderr: '' };
    };
    await stampAssets(memoryStore({ 'a.js': 'x()\n' }), { run: capture });
    await expect(access(staged)).rejects.toMatchObject({ code: 'ENOENT' });

    await stampAssets(memoryStore({ 'a.js': 'x()\n' }), {
      run: async (args) => {
        staged = args[2] as string;
        throw new Error('boom');
      },
    }).catch(() => undefined);
    await expect(access(staged)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('stampAssets — names that collide when staged', () => {
  it('refuses assets whose names differ only by case (they would overwrite each other on a case-insensitive disk), before running inject', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const store = memoryStore({ 'A.js': 'one();\n', 'a.js': 'two();\n' });
    await expect(stampAssets(store, { run })).rejects.toThrow(
      /A\.js and a\.js differ only by case/,
    );
    // Whichever comes second, upper or lower case.
    await expect(
      stampAssets(memoryStore({ 'a.js': 'one();\n', 'A.js': 'two();\n' }), { run }),
    ).rejects.toThrow(/a\.js and A\.js differ only by case/);
    expect(run).not.toHaveBeenCalled();
    expect(store.updates).toEqual([]);
  });

  it('distinct names, and the same name in different directories, are fine', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await stampAssets(memoryStore({ 'a.js': 'x\n', 'b/a.js': 'y\n', 'a.js.map': '{}' }), { run });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('stampAssets — verifying the stamp before it is written back', () => {
  const inject =
    (edit: (path: string, content: string) => string | undefined) => async (args: string[]) => {
      const { readdir, readFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const root = args[2] as string;
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const next = edit(entry.name, await readFile(join(root, entry.name), 'utf8'));
        if (next !== undefined) {
          await writeFile(join(root, entry.name), next);
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    };

  it('writes NOTHING back when any stamped bundle no longer parses (all or nothing)', async () => {
    const store = memoryStore({ 'a.js': 'a();\n', 'b.js': 'b();\n' });
    await expect(
      stampAssets(store, {
        run: inject((path, content) =>
          path === 'a.js'
            ? `${content};1;\n${STAMP_COMMENT}\n`
            : `${content}{{\n${STAMP_COMMENT}\n`,
        ),
      }),
    ).rejects.toThrow(StampVerificationError);
    expect(store.updates).toEqual([]);
    expect(store.assets.get('a.js')).toBe('a();\n');
  });

  it('names the asset and the reason, and keeps every issue on the error', async () => {
    const store = memoryStore({ 'a.js': 'a();\n' });
    const error = (await stampAssets(store, { run: inject((_p, c) => `${c}{{\n`) }).catch(
      (e: unknown) => e,
    )) as StampVerificationError;
    expect(error).toBeInstanceOf(StampVerificationError);
    expect(error.message).toContain('a.js');
    expect(error.message).toContain('no longer parses');
    expect(error.issues.map((i) => i.name)).toContain('a.js');
    expect(error.name).toBe('StampVerificationError');
  });

  it('flags a stamp whose bundle and map disagree', async () => {
    const store = memoryStore({
      'a.js': 'a();\n//# sourceMappingURL=a.js.map\n',
      'a.js.map': '{"version":3,"sources":[],"names":[],"mappings":""}',
    });
    await expect(
      stampAssets(store, {
        run: inject((path, content) =>
          path === 'a.js'
            ? `${content};1;\n${STAMP_COMMENT}\n`
            : content.replace(/\}$/, ',"debugId":"4adb7053-e754-594c-96b5-09c18263b153"}'),
        ),
      }),
    ).rejects.toThrow(/does not match/);
    expect(store.updates).toEqual([]);
  });

  it('a dry run is not verified (it writes nothing, whatever it finds)', async () => {
    const store = memoryStore({ 'a.js': 'a();\n' });
    await expect(
      stampAssets(store, { dryRun: true, run: inject((_p, c) => `${c}{{\n`) }),
    ).resolves.toEqual({ stamped: [], maps: {} });
  });

  it('uses an injected parser', async () => {
    const store = memoryStore({ 'a.js': 'a();\n' });
    const parse = vi.fn(() => true);
    await stampAssets(store, {
      parse,
      run: inject((_p, c) => `${c};1;\n${STAMP_COMMENT}\n`),
    });
    expect(parse).toHaveBeenCalled();
  });
});

describe('rollupAssetStore — a Rollup / Vite output bundle as an asset table', () => {
  const chunk = (fileName: string, code: string, extra: object = {}) => ({
    type: 'chunk' as const,
    fileName,
    code,
    map: { version: 3 },
    ...extra,
  });
  const asset = (fileName: string, source: string | Uint8Array) => ({
    type: 'asset' as const,
    fileName,
    source,
  });

  it('lists chunks and the map / script assets, and nothing else', () => {
    const store = rollupAssetStore({
      'a.js': chunk('a.js', 'x'),
      'a.js.map': asset('a.js.map', '{}'),
      'index.html': asset('index.html', '<p/>'),
      'vendor.js': asset('vendor.js', 'v'),
      'logo.png': asset('logo.png', new Uint8Array([1])),
    });
    expect(store.names().sort()).toEqual(['a.js', 'a.js.map', 'vendor.js']);
  });

  it('reads a chunk as its code and an asset as its source, string or bytes', () => {
    const store = rollupAssetStore({
      'a.js': chunk('a.js', 'héllo'),
      'a.js.map': asset('a.js.map', '{"a":1}'),
      'b.js.map': asset('b.js.map', new Uint8Array(Buffer.from('{"b":2}'))),
    });
    expect(store.read('a.js').toString('utf8')).toBe('héllo');
    expect(store.read('a.js.map').toString('utf8')).toBe('{"a":1}');
    expect(store.read('b.js.map').toString('utf8')).toBe('{"b":2}');
  });

  it('writes a chunk back to .code, and an asset back in the type it had', () => {
    const bundle = {
      'a.js': chunk('a.js', 'x'),
      'a.js.map': asset('a.js.map', '{}'),
      'b.js.map': asset('b.js.map', new Uint8Array([1])),
    };
    const store = rollupAssetStore(bundle);
    store.update('a.js', Buffer.from('stamped ✓'));
    store.update('a.js.map', Buffer.from('{"debugId":"x"}'));
    store.update('b.js.map', Buffer.from('bytes'));
    expect(bundle['a.js'].code).toBe('stamped ✓');
    expect(bundle['a.js.map'].source).toBe('{"debugId":"x"}');
    expect(bundle['b.js.map'].source).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bundle['b.js.map'].source as Uint8Array).toString()).toBe('bytes');
  });

  it('carries the stamped ids onto chunk.map too, so a bundler that rebuilds the map from it keeps them', () => {
    // Vite rewrites a chunk with dynamic imports AFTER generateBundle hooks and regenerates its `.map`
    // asset from `chunk.map`, keeping only what `chunk.map` carries (its `debugId`). Measured, Vite 7.3/8.3.
    const map: Record<string, unknown> = { version: 3 };
    const bundle = {
      'a.js': chunk('a.js', 'x', { map }),
      'a.js.map': asset('a.js.map', '{}'),
      'b.js': chunk('b.js', 'y', { map: null }),
      'b.js.map': asset('b.js.map', '{}'),
      'c.js': chunk('c.js', 'z', { map: { version: 3 }, sourcemapFileName: 'maps/c.map' }),
      'maps/c.map': asset('maps/c.map', '{}'),
    };
    const store = rollupAssetStore(bundle);
    store.update('a.js.map', Buffer.from('{"debugId":"ID-1","debug_id":"ID-1"}'));
    store.update('b.js.map', Buffer.from('{"debugId":"ID-2"}'));
    store.update('maps/c.map', Buffer.from('{"debug_id":"ID-3"}'));
    expect(map).toEqual({ version: 3, debugId: 'ID-1', debug_id: 'ID-1' });
    expect(bundle['b.js'].map).toBeNull(); // nothing to carry onto
    expect(bundle['c.js'].map).toEqual({ version: 3, debug_id: 'ID-3', debugId: 'ID-3' });
  });

  it('leaves chunk.map alone when the new map is not JSON or has no id', () => {
    const map: Record<string, unknown> = { version: 3 };
    const bundle = { 'a.js': chunk('a.js', 'x', { map }), 'a.js.map': asset('a.js.map', '{}') };
    const store = rollupAssetStore(bundle);
    store.update('a.js.map', Buffer.from('not json'));
    store.update('a.js.map', Buffer.from('{"version":3}'));
    store.update('a.js.map', Buffer.from('[1]'));
    expect(map).toEqual({ version: 3 });
  });

  it('reads an unknown name as empty rather than throwing', () => {
    expect(rollupAssetStore({}).read('nope.js').length).toBe(0);
  });

  it('stamps a Rollup bundle through the real bugsee-cli, map included', async () => {
    const bundle = {
      'a.js': chunk('a.js', 'console.log(1);\n//# sourceMappingURL=a.js.map'),
      'a.js.map': asset(
        'a.js.map',
        '{"version":3,"file":"a.js","sources":["a.ts"],"names":[],"mappings":"AAAA"}',
      ),
    };
    const result = await stampAssets(rollupAssetStore(bundle));
    const id = readDebugId(bundle['a.js'].code);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(bundle['a.js.map'].source as string).debugId).toBe(id);
    expect(result.stamped).toEqual(['a.js']);
  });
});

describe('rollupUnstampableMaps — chunks whose map cannot be stamped in memory', () => {
  it('is empty when every mapped chunk has its map as a bundle asset', () => {
    expect(
      rollupUnstampableMaps({
        'a.js': { type: 'chunk', fileName: 'a.js', code: '', map: {} },
        'a.js.map': { type: 'asset', fileName: 'a.js.map', source: '{}' },
        'b.js': { type: 'chunk', fileName: 'b.js', code: '', map: null },
      }),
    ).toEqual([]);
  });

  it('names a chunk that has a map but no map asset (older Rollup, inline maps)', () => {
    expect(
      rollupUnstampableMaps({
        'a.js': { type: 'chunk', fileName: 'a.js', code: '', map: {} },
        'b.js': { type: 'chunk', fileName: 'b.js', code: '', map: {} },
        'b.js.map': { type: 'asset', fileName: 'b.js.map', source: '{}' },
      }),
    ).toEqual(['a.js']);
  });

  it('honours a custom sourcemapFileName', () => {
    expect(
      rollupUnstampableMaps({
        'a.js': {
          type: 'chunk',
          fileName: 'a.js',
          code: '',
          map: {},
          sourcemapFileName: 'maps/a.map',
        },
        'maps/a.map': { type: 'asset', fileName: 'maps/a.map', source: '{}' },
      }),
    ).toEqual([]);
  });

  it('only considers script chunks', () => {
    expect(
      rollupUnstampableMaps({
        'a.css': { type: 'chunk', fileName: 'a.css', code: '', map: {} },
      }),
    ).toEqual([]);
  });
});

describe('stampAssets — a map that is not the bundle sibling (sourcemapFileNames moved it)', () => {
  const chunk = (fileName: string, code: string, extra: object = {}) => ({
    type: 'chunk' as const,
    fileName,
    code,
    map: { version: 3 },
    ...extra,
  });
  const asset = (fileName: string, source: string) => ({
    type: 'asset' as const,
    fileName,
    source,
  });
  const MAP = '{"version":3,"file":"a.js","sources":["a.ts"],"names":[],"mappings":"AAAA"}';
  const moved = () => ({
    'js/a.js': chunk('js/a.js', 'console.log(1);\n//# sourceMappingURL=a.js.map\n', {
      sourcemapFileName: 'maps/a.js.map',
    }),
    'maps/a.js.map': asset('maps/a.js.map', MAP),
  });

  it('stamps the bundle AND its moved map with the same id, through the real bugsee-cli', async () => {
    const bundle = moved();
    const result = await stampAssets(rollupAssetStore(bundle));
    const id = readDebugId(bundle['js/a.js'].code);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(bundle['maps/a.js.map'].source).debugId).toBe(id);
    expect(result.stamped).toEqual(['js/a.js']);
  });

  it('stages the map as the bundle sibling (that is how inject pairs them), and writes it back at its real name', async () => {
    const seen: string[] = [];
    const bundle = moved();
    await stampAssets(rollupAssetStore(bundle), {
      run: async (args) => {
        const { readdir, writeFile, readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const root = args[2] as string;
        for (const dir of ['js']) {
          for (const f of await readdir(join(root, dir))) {
            seen.push(`${dir}/${f}`);
          }
        }
        await writeFile(
          join(root, 'js/a.js'),
          `${await readFile(join(root, 'js/a.js'), 'utf8')};1;\n${STAMP_COMMENT}\n`,
        );
        await writeFile(
          join(root, 'js/a.js.map'),
          MAP.replace(/\}$/, `,"debugId":"b039c7fb-d958-5fe6-b76f-136179e9a728"}`),
        );
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(seen.sort()).toEqual(['js/a.js', 'js/a.js.map']);
    expect(bundle['maps/a.js.map'].source).toContain('debugId');
  });

  it('refuses (before inject) when the sibling name is already taken by another asset', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const bundle = { ...moved(), 'js/a.js.map': asset('js/a.js.map', '{}') };
    await expect(stampAssets(rollupAssetStore(bundle), { run })).rejects.toThrow(/js\/a\.js\.map/);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a stamped bundle whose map cannot be staged at all (not a .map name): never a silent half-stamp', async () => {
    const bundle = {
      'a.js': chunk('a.js', 'x();\n', { sourcemapFileName: 'maps/a.json' }),
      'maps/a.json': asset('maps/a.json', MAP),
    };
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const error = (await stampAssets(rollupAssetStore(bundle), { run }).catch(
      (e: unknown) => e,
    )) as StampVerificationError;
    expect(error).toBeInstanceOf(StampVerificationError);
    expect(error.message).toContain('maps/a.json');
  });

  it('a store with no mapOf behaves exactly as before', async () => {
    const store = memoryStore({
      'a.js': 'x()\n//# sourceMappingURL=a.js.map',
      'a.js.map': '{"version":3,"sources":["x.ts"],"names":[],"mappings":"AAAA"}',
    });
    await stampAssets(store);
    expect(JSON.parse(store.assets.get('a.js.map') as string).debugId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rollupAssetStore.mapOf names the map asset of a chunk, or nothing', () => {
    const store = rollupAssetStore({
      ...moved(),
      'b.js': chunk('b.js', 'x'),
      'c.js': chunk('c.js', 'x'),
      'c.js.map': asset('c.js.map', '{}'),
      'logo.png': asset('logo.png', 'x'),
    });
    expect(store.mapOf?.('js/a.js')).toBe('maps/a.js.map');
    expect(store.mapOf?.('b.js')).toBeUndefined(); // no map asset
    expect(store.mapOf?.('c.js')).toBe('c.js.map');
    expect(store.mapOf?.('logo.png')).toBeUndefined(); // not a chunk
    expect(store.mapOf?.('nope.js')).toBeUndefined();
  });
});

describe('stampAssets — result details', () => {
  const run = async (args: string[]) => {
    const { readdir, readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = args[2] as string;
    for (const f of await readdir(root)) {
      if (f.endsWith('.js')) {
        await writeFile(
          join(root, f),
          `${await readFile(join(root, f), 'utf8')};1;\n${STAMP_COMMENT}\n`,
        );
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  it('lists the stamped bundles SORTED whatever order the store names them in', async () => {
    const store = memoryStore({ 'c.js': 'c\n', 'a.js': 'a\n', 'b.js': 'b\n' });
    expect((await stampAssets(store, { run })).stamped).toEqual(['a.js', 'b.js', 'c.js']);
  });

  it('stages and stamps an UPPERCASE .JS bundle (the CLI stamps it too)', async () => {
    const store = memoryStore({
      'A.JS': 'x();\n//# sourceMappingURL=A.JS.map\n',
      'A.JS.map': '{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}',
    });
    const result = await stampAssets(store);
    expect(result.stamped).toEqual(['A.JS']);
    expect(readDebugId(store.assets.get('A.JS') as string)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a stamped bundle whose map pointer leaves the output (never a silent half-stamp)', async () => {
    const store = memoryStore({ 'js/a.js': 'x();\n//# sourceMappingURL=../../maps/a.js.map\n' });
    const error = (await stampAssets(store).catch((e: unknown) => e)) as StampVerificationError;
    expect(error).toBeInstanceOf(StampVerificationError);
    expect(error.message).toContain('outside the output directory');
    expect(error.unreachableMap).toBe(true);
    expect(store.updates).toEqual([]);
  });

  it('result.maps: bundle -> its real map name', async () => {
    const bundle = {
      'js/a.js': {
        type: 'chunk' as const,
        fileName: 'js/a.js',
        code: 'x();\n',
        map: {},
        sourcemapFileName: 'maps/a.js.map',
      },
      'maps/a.js.map': {
        type: 'asset' as const,
        fileName: 'maps/a.js.map',
        source: '{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}',
      },
      'b.js': { type: 'chunk' as const, fileName: 'b.js', code: 'y();\n', map: null },
    };
    const result = await stampAssets(rollupAssetStore(bundle));
    expect(result.maps).toEqual({ 'js/a.js': 'maps/a.js.map' });
    expect(result.stamped).toEqual(['b.js', 'js/a.js']);
  });
});

describe('stampAssets — a store whose map is named outside the output', () => {
  it('says so (outside the output directory) rather than a generic staging failure', async () => {
    const store = {
      ...memoryStore({ 'js/a.js': 'x();\n' }),
      mapOf: () => '../maps/a.js.map',
    };
    const error = (await stampAssets(store).catch((e: unknown) => e)) as StampVerificationError;
    expect(error.message).toContain('lies outside the output directory');
  });
});
