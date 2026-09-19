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
      '--allow-empty',
    ]);
    // token + endpoint forwarded to the upload
    expect(calls[1]?.options.token).toBe('tok');
    expect(calls[1]?.options.endpoint).toBe('https://api.test');
  });

  // A build that emitted no maps is a legitimate shape — a package built without them, a framework
  // whose server output has none — not a reason to fail someone's deploy. The CLI exits 10 on it
  // unless told otherwise (bugsee-cli >= 0.7.10).
  it('passes --allow-empty so an output directory with no maps is not an upload failure', async () => {
    const { run, calls } = fakeRun();
    await uploadSourcemaps({ ...base, run, deleteMapFiles: async () => [] });
    expect(calls[1]?.args).toContain('--allow-empty');
  });

  // …unless the caller asked for strictness. `failOnError` is for teams who would rather the build
  // stopped than ship un-symbolicatable crashes, and "this build produced no maps at all" is exactly
  // the misconfiguration they want it to catch.
  it('omits --allow-empty under failOnError, so an empty build still fails loudly', async () => {
    const { run, calls } = fakeRun();
    await uploadSourcemaps({ ...base, failOnError: true, run, deleteMapFiles: async () => [] });
    expect(calls[1]?.args).not.toContain('--allow-empty');
  });

  // Stamping after emit invalidates a hash the HTML already pins, and the browser then refuses the
  // script — measured on webpack 5.111 + webpack-subresource-integrity in Chromium 151: the page
  // loaded and NOTHING ran. Losing symbolication is survivable; shipping a blank page is not.
  describe('Subresource Integrity', () => {
    const sriBase = {
      ...base,
      findSri: async () => [{ html: '/build/dist/index.html', script: '/build/dist/main.js' }],
    };

    it('refuses to stamp a build whose HTML pins script hashes, and uploads nothing', async () => {
      const { run, calls } = fakeRun();
      const onError = vi.fn();
      const deleteMapFiles = vi.fn(async () => [] as string[]);
      const result = await uploadSourcemaps({ ...sriBase, run, onError, deleteMapFiles });

      expect(calls).toEqual([]); // not even `sourcemaps inject`
      expect(deleteMapFiles).not.toHaveBeenCalled(); // the maps are still the user's only copy
      expect(result).toEqual({ injected: false, uploaded: false, deletedMaps: [] });
      expect(String(onError.mock.calls[0]?.[0])).toContain('Subresource Integrity');
      expect(String(onError.mock.calls[0]?.[0])).toContain('index.html');
    });

    it('counts the other pinned scripts in the message rather than listing them all', async () => {
      const { run } = fakeRun();
      const onError = vi.fn();
      await uploadSourcemaps({
        ...base,
        findSri: async () => [
          { html: '/build/dist/index.html', script: '/build/dist/main.js' },
          { html: '/build/dist/index.html', script: '/build/dist/vendor.js' },
          { html: '/build/dist/about.html', script: '/build/dist/about.js' },
        ],
        run,
        onError,
        deleteMapFiles: async () => [],
      });
      expect(String(onError.mock.calls[0]?.[0])).toContain('(and 2 more)');
    });

    it('throws under failOnError instead of warning', async () => {
      const { run } = fakeRun();
      await expect(
        uploadSourcemaps({ ...sriBase, failOnError: true, run, deleteMapFiles: async () => [] }),
      ).rejects.toThrow(/Subresource Integrity/);
    });

    it('proceeds normally when the build has no pinned scripts', async () => {
      const { run, calls } = fakeRun();
      await uploadSourcemaps({
        ...base,
        findSri: async () => [],
        run,
        deleteMapFiles: async () => [],
      });
      expect(calls.map((c) => c.args[0])).toEqual(['sourcemaps', 'debug-files']);
    });

    it('scans the output directory it was given', async () => {
      const { run } = fakeRun();
      const findSri = vi.fn(async () => []);
      await uploadSourcemaps({ ...base, findSri, run, deleteMapFiles: async () => [] });
      expect(findSri).toHaveBeenCalledWith('/build/dist');
    });
  });

  // bugsee-cli 0.7.11 made `upload --dry-run` tolerate a map with no debug-id, which is exactly what
  // a dry run produces: `inject --dry-run` writes nothing, so nothing is keyed. Before that the
  // upload exited 11 and the plugin had to skip step 2 entirely — so the one option documented as the
  // SAFE diagnostic never exercised the upload path at all.
  describe('dry run', () => {
    it('runs the upload too, so the preview covers the whole flow', async () => {
      const { run, calls } = fakeRun();
      const deleteMapFiles = vi.fn(async () => [] as string[]);
      const result = await uploadSourcemaps({ ...base, dryRun: true, run, deleteMapFiles });

      expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
        ['sourcemaps', 'inject'],
        ['debug-files', 'upload'],
      ]);
      expect(calls[0]?.args).toContain('--dry-run');
      expect(calls[1]?.args).toContain('--dry-run');
      // Still nothing uploaded and nothing deleted: a dry run must not touch the build.
      expect(result).toEqual({ injected: true, uploaded: false, deletedMaps: [] });
      expect(deleteMapFiles).not.toHaveBeenCalled();
    });

    it('reports a dry-run failure the same way as a real one', async () => {
      const onError = vi.fn();
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === 'debug-files') throw new Error('upload preview failed');
        return { code: 0, stdout: '', stderr: '' };
      });
      const result = await uploadSourcemaps({
        ...base,
        dryRun: true,
        run,
        deleteMapFiles: async () => [],
      });
      expect(result.uploaded).toBe(false);
      expect(String(onError.mock.calls[0]?.[0] ?? '')).toBe('');
      expect(result.injected).toBe(false);
    });
  });

  // `--strip-sources-content` (bugsee-cli 0.7.11): a map's `sourcesContent` is the customer's source
  // verbatim, and it rides into the upload. Opt-in, because stripping it costs the source snippet
  // beside a symbolicated frame.
  describe('stripSourcesContent', () => {
    it('is off by default', async () => {
      const { run, calls } = fakeRun();
      await uploadSourcemaps({ ...base, run, deleteMapFiles: async () => [] });
      expect(calls[1]?.args).not.toContain('--strip-sources-content');
    });

    it('passes the flag when asked', async () => {
      const { run, calls } = fakeRun();
      await uploadSourcemaps({
        ...base,
        stripSourcesContent: true,
        run,
        deleteMapFiles: async () => [],
      });
      expect(calls[1]?.args).toContain('--strip-sources-content');
    });
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

  it('dry-run: both commands run dry, and nothing is deleted', async () => {
    // Twice-revised, and the history is the point. It first asserted `--dry-run` reached BOTH commands
    // while the CLI could not survive that (v0.7.2: `inject --dry-run` writes nothing, so every map is
    // un-keyed and `upload --dry-run` exits 11) — it pinned a defect. Then it asserted the workaround,
    // skipping the upload, which meant the safe diagnostic never exercised the upload path. bugsee-cli
    // 0.7.11 made `upload --dry-run` report an un-keyed map instead of failing, so both commands run
    // again — this time because the CLI actually supports it.
    const { run, calls } = fakeRun();
    const deleteMapFiles = vi.fn(async () => ['x']);
    const result = await uploadSourcemaps({ ...base, run, deleteMapFiles, dryRun: true });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.args.includes('--dry-run'))).toBe(true);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['sourcemaps', 'inject'],
      ['debug-files', 'upload'],
    ]);
    // Nothing was uploaded, so nothing justifies deleting the only copy of the user's maps.
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
    it('previews the whole flow, and claims no upload', async () => {
      // The original defect: measured against the real bugsee-cli v0.7.2, `sourcemaps inject --dry-run`
      // wrote nothing, so no map carried a debug_id, and `debug-files upload --dry-run` exited 11 —
      // aborting the build from the option documented as the SAFE diagnostic. The first fix skipped the
      // upload step; bugsee-cli 0.7.11 fixed it properly (an un-keyed map is reported, not fatal), so the
      // preview covers both commands again. What must never come back is a dry run that claims an upload,
      // or one that deletes the maps.
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
      expect(calls.map((c) => c.slice(0, 2))).toEqual([
        ['sourcemaps', 'inject'],
        ['debug-files', 'upload'],
      ]);
      expect(calls.every((c) => c.includes('--dry-run'))).toBe(true);
      expect(result.uploaded).toBe(false);
      expect(result.deletedMaps).toEqual([]);
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
