import { describe, expect, it, vi } from 'vitest';
import { readDebugId } from './debug-ids';
import { type AssetStore, stampAssets } from './stamp-assets';

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
      run: fakeInject((path, content) => (path === 'a.js' ? `${content}//# stamped\n` : undefined)),
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
