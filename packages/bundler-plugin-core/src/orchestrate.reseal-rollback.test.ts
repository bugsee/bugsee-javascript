// A re-seal that fails must leave the build as the bundler emitted it. The stamp is already undone when it does not
// verify (step 1b); the re-seal rewrites more than the stamp touched (pages, server modules, runtime tables), so it
// is undone the same way, from its own snapshot, and nothing is uploaded for bundles that went back unstamped.
// Real `bugsee-cli` for the stamp; only the re-seal (or its verdict) is made to fail.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadSourcemaps } from './orchestrate';
import { resolveBugseeCli, runBugseeCli } from './run-cli';

const cli = resolveBugseeCli();
const probe = cli.endsWith('.js')
  ? spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  : spawnSync(cli, ['--version'], { encoding: 'utf8' });
const required = process.env.CI !== undefined || process.env.BUGSEE_REQUIRE_CLI !== undefined;
const describeReal = probe.status === 0 || required ? describe : describe.skip;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sha384 = (text: string) => `sha384-${createHash('sha384').update(text).digest('base64')}`;

/** An output directory with one hashed bundle + map, a page pinning it, and an SSR copy of the page elsewhere. */
function build() {
  const root = mkdtempSync(join(tmpdir(), 'bugsee-rollback-'));
  made.push(root);
  const out = join(root, 'browser');
  const server = join(root, 'server');
  mkdirSync(out);
  mkdirSync(server);
  const js = 'console.log(1);\n//# sourceMappingURL=main.js.map\n';
  writeFileSync(join(out, 'main.js'), js);
  writeFileSync(
    join(out, 'main.js.map'),
    JSON.stringify({ version: 3, file: 'main.js', sources: ['a.ts'], names: [], mappings: 'AAAA' }),
  );
  const page = `<script src="main.js" integrity="${sha384(js)}"></script>`;
  writeFileSync(join(out, 'index.html'), page);
  writeFileSync(join(out, 'about.html'), '<p>no hashes</p>');
  writeFileSync(join(server, 'index.html.mjs'), `export default ${JSON.stringify(page)};`);
  return { root, out, server };
}

const snapshot = (...dirs: string[]) =>
  Object.fromEntries(
    dirs.flatMap((dir) =>
      readdirSync(dir).map((name) => [join(dir, name), readFileSync(join(dir, name), 'utf8')]),
    ),
  );

const options = (out: string, server: string, extra: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const run = vi.fn(async (args: string[], o: Parameters<typeof runBugseeCli>[1]) => {
    calls.push(args[0] === 'debug-files' ? 'upload' : args.slice(0, 2).join(' '));
    if (args[0] === 'debug-files') {
      return { code: 0, stdout: '', stderr: '' };
    }
    return runBugseeCli(args, o);
  });
  const errors: unknown[] = [];
  return {
    calls,
    errors,
    opts: {
      outDir: out,
      appToken: 'tok',
      appVersion: '1',
      appBuild: '1',
      resealSri: true,
      resealDirs: [out, server],
      run,
      onError: (e: unknown) => errors.push(e),
      ...extra,
    },
  };
};

describeReal('uploadSourcemaps re-seal rollback', () => {
  it('seals a good build (control): page verifies, upload runs', async () => {
    const { out, server } = build();
    const { opts, calls, errors } = options(out, server);
    const result = await uploadSourcemaps(opts);
    expect(errors).toEqual([]);
    expect(result.uploaded).toBe(true);
    expect(calls).toContain('upload');
  });

  it('puts every original byte back when the re-seal throws midway, and uploads nothing', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      reseal: async () => {
        // It had already written one file when the disk failed.
        writeFileSync(join(out, 'index.html'), 'HALF-SEALED');
        throw new Error('ENOSPC: no space left on device');
      },
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false, deletedMaps: [] });
    const message = String(errors[0]);
    expect(message).toContain('ENOSPC');
    expect(message).toMatch(/restored/);
  });

  it('puts every original byte back when a hash is still stale after the re-seal, and uploads nothing', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      verifySri: async () => [
        { html: join(out, 'index.html'), script: join(out, 'main.js'), integrity: 'sha384-X' },
      ],
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('still does not match');
    // Only what changed is put back: main.js, its map and the two copies of the page, not about.html.
    expect(String(errors[0])).toContain('(4 file(s))');
    // The maps were not deleted either: the unstamped bundles still need them if the user opts out of SRI.
    expect(readdirSync(out)).toContain('main.js.map');
  });

  it('brings back a file the failed re-seal removed', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts } = options(out, server, {
      reseal: async () => {
        rmSync(join(out, 'index.html'));
        throw new Error('boom');
      },
    });
    await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
  });

  it('reports a re-seal that rejects with something that is not an Error', async () => {
    const { out, server } = build();
    const { opts, errors } = options(out, server, {
      reseal: async () => {
        throw 'plain string failure';
      },
    });
    await uploadSourcemaps(opts);
    expect(String(errors[0])).toContain('plain string failure');
  });

  it('removes the temporary copies of the originals it took', async () => {
    const { out, server, root } = build();
    const spillRoot = join(root, 'spill');
    mkdirSync(spillRoot);
    const { opts } = options(out, server, { spillRoot });
    await uploadSourcemaps(opts);
    expect(readdirSync(spillRoot)).toEqual([]);
  });

  it('throws the failure under failOnError, after restoring', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts } = options(out, server, {
      failOnError: true,
      reseal: async () => {
        throw new Error('EACCES');
      },
    });
    await expect(uploadSourcemaps(opts)).rejects.toThrow(/EACCES/);
    expect(snapshot(out, server)).toEqual(before);
  });

  it('restores everything when a service worker manifest still does not match its files, and uploads nothing', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      verifyServiceWorker: async () => [{ manifest: join(out, 'ngsw.json'), url: '/main.js' }],
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('ngsw.json');
    expect(String(errors[0])).toContain('/main.js');
    expect(String(errors[0])).toMatch(/restored/);
  });

  it('seals a build with a real service worker manifest (control)', async () => {
    const { out, server } = build();
    const js = readFileSync(join(out, 'main.js'), 'utf8');
    const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');
    writeFileSync(
      join(out, 'ngsw.json'),
      JSON.stringify({ hashTable: { '/main.js': sha1(js) } }, null, 2),
    );
    const { opts, calls, errors } = options(out, server);
    const result = await uploadSourcemaps(opts);
    expect(errors).toEqual([]);
    expect(result.uploaded).toBe(true);
    expect(calls).toContain('upload');
    const manifest = JSON.parse(readFileSync(join(out, 'ngsw.json'), 'utf8'));
    expect(manifest.hashTable['/main.js']).toBe(sha1(readFileSync(join(out, 'main.js'), 'utf8')));
    expect(manifest.hashTable['/main.js']).not.toBe(sha1(js));
  });

  it('names a file it could not restore', async () => {
    const { out, server } = build();
    const { opts, errors } = options(out, server, {
      verifySri: async () => [
        { html: join(out, 'index.html'), script: join(out, 'main.js'), integrity: 'sha384-X' },
      ],
      restoreFile: async (_spill: string, target: string) => {
        throw new Error(`EPERM on ${target}`);
      },
    });
    await uploadSourcemaps(opts);
    expect(String(errors[0])).toMatch(/COULD NOT restore/);
    expect(String(errors[0])).toContain('EPERM');
  });
});
