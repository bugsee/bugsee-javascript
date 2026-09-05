import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDeleteMapFiles, uploadSourcemaps } from './orchestrate';
import type { RunBugseeCliOptions, SpawnResult } from './run-cli';

/** A fake `run` that records (args, options) in order and returns success. */
function fakeRun() {
  const calls: Array<{ args: string[]; options: RunBugseeCliOptions }> = [];
  const run = vi.fn(async (args: string[], options: RunBugseeCliOptions): Promise<SpawnResult> => {
    calls.push({ args, options });
    return { code: 0, stdout: '', stderr: '' };
  });
  return { run, calls };
}

const base = {
  outDir: '/build/dist',
  appToken: 'tok',
  appVersion: '1.0.0',
  appBuild: '7',
};

describe('uploadSourcemaps', () => {
  it('runs `sourcemaps inject` then `debug-files upload` (in that order) with the right argv', async () => {
    const { run, calls } = fakeRun();
    const deleteMapFiles = vi.fn(async () => [] as string[]);
    await uploadSourcemaps({ ...base, endpoint: 'https://api.test', run, deleteMapFiles });

    expect(calls[0]?.args).toEqual(['sourcemaps', 'inject', '/build/dist']);
    expect(calls[1]?.args).toEqual([
      'debug-files',
      'upload',
      '/build/dist',
      '--type',
      'sourcemaps',
      '--version',
      '1.0.0',
      '--build',
      '7',
    ]);
    // token + endpoint forwarded to the upload
    expect(calls[1]?.options.token).toBe('tok');
    expect(calls[1]?.options.endpoint).toBe('https://api.test');
  });

  it('deletes the .map files after upload by default and returns them', async () => {
    const { run } = fakeRun();
    const order: string[] = [];
    const runOrdered = vi.fn(async (args: string[]) => {
      order.push(args[0] as string);
      return { code: 0, stdout: '', stderr: '' };
    });
    const deleteMapFiles = vi.fn(async () => {
      order.push('delete');
      return ['/build/dist/app.js.map'];
    });
    const result = await uploadSourcemaps({ ...base, run: runOrdered, deleteMapFiles });
    expect(deleteMapFiles).toHaveBeenCalledWith('/build/dist');
    expect(result.deletedMaps).toEqual(['/build/dist/app.js.map']);
    expect(order).toEqual(['sourcemaps', 'debug-files', 'delete']); // delete is last
    void run;
  });

  it('does NOT delete when deleteMaps is false', async () => {
    const { run } = fakeRun();
    const deleteMapFiles = vi.fn(async () => ['x']);
    const result = await uploadSourcemaps({ ...base, run, deleteMapFiles, deleteMaps: false });
    expect(deleteMapFiles).not.toHaveBeenCalled();
    expect(result.deletedMaps).toEqual([]);
  });

  it('dry-run: injects dry, skips the upload that cannot succeed, and deletes nothing', async () => {
    // This used to assert `--dry-run` reached BOTH commands — i.e. it pinned the defect. Measured against
    // the real bugsee-cli v0.7.2: `sourcemaps inject --dry-run` exits 0 and writes nothing, so the maps
    // still carry no debug_id, and `debug-files upload --dry-run` then exits 11 with "source map has no
    // debug_id … run 'sourcemaps inject' first" — aborting the build from the one option documented as the
    // safe diagnostic, on every freshly-built output directory.
    const { run, calls } = fakeRun();
    const deleteMapFiles = vi.fn(async () => ['x']);
    const result = await uploadSourcemaps({ ...base, run, deleteMapFiles, dryRun: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('--dry-run');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['sourcemaps', 'inject']);
    expect(deleteMapFiles).not.toHaveBeenCalled();
    expect(result).toMatchObject({ injected: true, uploaded: false, deletedMaps: [] });
  });

  it('throws when appToken is missing', async () => {
    const { run } = fakeRun();
    await expect(
      uploadSourcemaps({ ...base, appToken: '', run, deleteMapFiles: async () => [] }),
    ).rejects.toThrow(/appToken/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('defaultDeleteMapFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-del-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('unlinks every .map (recursively), leaves other files, returns the deleted paths', async () => {
    await writeFile(join(dir, 'app.js'), 'x');
    await writeFile(join(dir, 'app.js.map'), '{}');
    const sub = join(dir, 'chunks');
    await mkdir(sub);
    await writeFile(join(sub, 'vendor.mjs.map'), '{}');
    await writeFile(join(sub, 'vendor.mjs'), 'y');

    const deleted = await defaultDeleteMapFiles(dir);

    expect(deleted.map((p) => p.split('/').pop()).sort()).toEqual(['app.js.map', 'vendor.mjs.map']);
    // the .js files remain, the .map files are gone
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'chunks']);
    expect(await readdir(sub)).toEqual(['vendor.mjs']);
  });

  it('returns an empty list when there are no maps', async () => {
    await writeFile(join(dir, 'app.js'), 'x');
    expect(await defaultDeleteMapFiles(dir)).toEqual([]);
  });
});

// WAVE 7 — a telemetry side effect must not harm the user's build.
//
// All four defects below share that shape, and together they mean the plugin could delete a developer's
// files, break a production deploy, or hang CI — for a source-map upload.
describe('the plugin cannot harm the build (Wave 7)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bugsee-harm-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string): Promise<string> => {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, 'x');
    return full;
  };

  describe('SEV1 #3 — recursive *.map deletion in the working tree', () => {
    it('never descends into node_modules', async () => {
      // A relative `output.file` resolves the out dir to '.', so the walk starts at the project root.
      // `path.dirname('bundle.js') === '.'` — an entirely ordinary Rollup library config.
      await write('node_modules/left-pad/index.js.map');
      await write('bundle.js.map');
      const deleted = await defaultDeleteMapFiles(root);
      expect(deleted.map((p) => p.slice(root.length + 1))).toEqual(['bundle.js.map']);
    });

    it('never deletes AUTHORED maps under src/', async () => {
      await write('src/authored.ts.map');
      await write('dist/app.js.map');
      const deleted = await defaultDeleteMapFiles(root);
      expect(deleted.map((p) => p.slice(root.length + 1))).toEqual([join('dist', 'app.js.map')]);
    });

    it('is bounded in depth rather than walking an arbitrary tree', async () => {
      // No depth limit meant a stray out-dir could walk an entire disk. Build output is shallow.
      await write('a/b/c/d/e/f/g/h/deep.js.map');
      const deleted = await defaultDeleteMapFiles(root);
      expect(deleted).toEqual([]);
    });

    it('still deletes real build maps — the canary', async () => {
      // Without this, "deletes nothing dangerous" is satisfied by deleting nothing at all.
      await write('assets/app.js.map');
      await write('chunk-abc.js.map');
      const deleted = await defaultDeleteMapFiles(root);
      expect(deleted).toHaveLength(2);
    });
  });

  describe('SEV1 #1 — dryRun aborted the build', () => {
    it('runs INJECT dry, but does not run the upload that cannot succeed', async () => {
      // Measured against the real bugsee-cli v0.7.2: `sourcemaps inject --dry-run` exits 0 and writes
      // nothing, so the maps still carry no debug_id — and `debug-files upload --dry-run` then exits 11
      // ("source map has no debug_id … run 'sourcemaps inject' first"), which aborted the build. dryRun is
      // documented as the SAFE diagnostic; it failed on every freshly-built output directory.
      const calls: string[][] = [];
      const run = vi.fn(async (args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      });
      const result = await uploadSourcemaps({
        outDir: root,
        appToken: 'tok',
        appVersion: '1.0.0',
        appBuild: '7',
        dryRun: true,
        run: run as never,
      });
      expect(calls.map((c) => c.slice(0, 2))).toEqual([['sourcemaps', 'inject']]);
      expect(result.uploaded).toBe(false); // …and it says so, rather than claiming an upload
    });
  });

  describe('SEV1 #2 — a CLI failure aborted the build', () => {
    const failing = vi.fn(async () => {
      throw new Error('bugsee-cli exited 20');
    });

    it('does not reject by default — the build survives a failed upload', async () => {
      const onError = vi.fn();
      const result = await uploadSourcemaps({
        outDir: root,
        appToken: 'tok',
        appVersion: '1',
        appBuild: '1',
        run: failing as never,
        onError,
      });
      expect(result.uploaded).toBe(false);
      expect(onError).toHaveBeenCalled(); // reported, never swallowed
    });

    it('does not delete the maps when the upload failed', async () => {
      // Deleting after a failed upload destroys the only copy of the mapping — the maps are gone AND the
      // symbols were never delivered.
      await write('app.js.map');
      const result = await uploadSourcemaps({
        outDir: root,
        appToken: 'tok',
        appVersion: '1',
        appBuild: '1',
        run: failing as never,
      });
      expect(result.deletedMaps).toEqual([]);
      expect((await readdir(root)).length).toBe(1);
    });

    it('CAN be made strict, for a team that wants the build to fail', async () => {
      await expect(
        uploadSourcemaps({
          outDir: root,
          appToken: 'tok',
          appVersion: '1',
          appBuild: '1',
          run: failing as never,
          failOnError: true,
        }),
      ).rejects.toThrow();
    });

    it('still reports success on a clean run — the canary', async () => {
      const ok = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
      const result = await uploadSourcemaps({
        outDir: root,
        appToken: 'tok',
        appVersion: '1',
        appBuild: '1',
        run: ok as never,
      });
      expect(result).toMatchObject({ injected: true, uploaded: true });
    });
  });
});

// The three gaps below all made the *default* behaviour untested: the walk's exclusions, its exact depth
// boundary, and the failure sink a user without an `onError` actually gets.
describe('defaultDeleteMapFiles — exclusions and bounds (defaults, not injected)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bugsee-walk-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string): Promise<void> => {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, 'x');
  };
  const rel = (paths: string[]): string[] => paths.map((p) => p.slice(root.length + 1)).sort();

  it('never descends into a TEST directory (test / tests / __tests__)', async () => {
    // Fixture maps under a test directory are authored files, not build output — deleting them is the
    // same unrecoverable working-tree loss as deleting src/.
    await write(join('test', 'fixture.js.map'));
    await write(join('tests', 'fixture.js.map'));
    await write(join('__tests__', 'fixture.js.map'));
    await write('app.js.map');
    expect(rel(await defaultDeleteMapFiles(root))).toEqual(['app.js.map']);
  });

  it('never descends into ANY dot-directory, not only the ones named in the list', async () => {
    // `.vercel` / `.output` / `.turbo` are not in NEVER_WALK; the leading-dot rule is what covers them,
    // and every tool that appears next year.
    await write(join('.vercel', 'output', 'fn.js.map'));
    await write(join('.turbo', 'cache.js.map'));
    await write('app.js.map');
    expect(rel(await defaultDeleteMapFiles(root))).toEqual(['app.js.map']);
  });

  it('deletes at the deepest ALLOWED level and stops one level further (the exact boundary)', async () => {
    // MAX_DELETE_DEPTH is 6: six directory levels below the out dir are still build output, the seventh
    // is treated as a mis-resolved root. Pinning both sides keeps the limit from drifting silently.
    await write(join('a', 'b', 'c', 'd', 'e', 'f', 'at-limit.js.map'));
    await write(join('a', 'b', 'c', 'd', 'e', 'f', 'g', 'past-limit.js.map'));
    expect(rel(await defaultDeleteMapFiles(root))).toEqual([
      join('a', 'b', 'c', 'd', 'e', 'f', 'at-limit.js.map'),
    ]);
  });

  it('leaves non-.map files alone even when they merely CONTAIN ".map"', async () => {
    await write('sourcemap.js');
    await write('app.map.js');
    await write('app.js.map');
    expect(rel(await defaultDeleteMapFiles(root))).toEqual(['app.js.map']);
    expect((await readdir(root)).sort()).toEqual(['app.map.js', 'sourcemap.js']);
  });
});

describe('the DEFAULT failure sink (no onError supplied)', () => {
  it('warns on the console, naming the plugin and the error', async () => {
    // Without an injected `onError` this is the only thing a user sees. A silent failure here is a
    // source-map pipeline that does nothing, forever, with no signal at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await uploadSourcemaps({
        ...base,
        run: vi.fn(async () => {
          throw new Error('bugsee-cli exited 20');
        }) as never,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('[bugsee]');
      expect(message).toContain('bugsee-cli exited 20');
      // and the result must not claim the inject/upload happened
      expect(result).toEqual({ injected: false, uploaded: false, deletedMaps: [] });
    } finally {
      warn.mockRestore();
    }
  });

  it('reports injected:false even when it was the UPLOAD (step 2) that failed', async () => {
    // `injected` is what tells a caller whether the built files were rewritten. Claiming true after a
    // contained failure would make a later "already injected" decision wrong.
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'debug-files') throw new Error('upload failed');
      return { code: 0, stdout: '', stderr: '' };
    });
    const onError = vi.fn();
    const result = await uploadSourcemaps({ ...base, run: run as never, onError });
    expect(result).toEqual({ injected: false, uploaded: false, deletedMaps: [] });
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('uploadSourcemaps — VCS metadata passthrough', () => {
  const vcs = { commit_sha: 'a'.repeat(40), branch: 'main' };

  it('echoes the supplied VCS metadata on a successful run', async () => {
    const { run } = fakeRun();
    const result = await uploadSourcemaps({
      ...base,
      run,
      deleteMapFiles: async () => [],
      vcs,
    });
    expect(result.vcs).toEqual(vcs);
  });

  it('echoes it on a DRY run too — this is the diagnostic that shows what was captured', async () => {
    const { run } = fakeRun();
    const result = await uploadSourcemaps({ ...base, run, dryRun: true, vcs });
    expect(result.vcs).toEqual(vcs);
  });

  it('echoes it on the CONTAINED-FAILURE path, so a failed upload still reports what it had', async () => {
    const run = vi.fn(async () => {
      throw new Error('cli failed');
    });
    const result = await uploadSourcemaps({
      ...base,
      run: run as never,
      onError: () => undefined,
      vcs,
    });
    expect(result.uploaded).toBe(false);
    expect(result.vcs).toEqual(vcs);
  });

  it('omits `vcs` from the result when none was supplied', async () => {
    const { run } = fakeRun();
    const result = await uploadSourcemaps({ ...base, run, deleteMapFiles: async () => [] });
    expect('vcs' in result).toBe(false);
  });
});
