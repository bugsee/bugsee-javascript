// IN-BUILD STAMPING, PART 2 — what happens AFTER `sourcemaps inject` rewrote the output on disk, and what is
// allowed to delete the maps. Real temp directories; a fake CLI that edits them the way a (mis)behaving
// inject would.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listMapFiles, uploadSourcemaps } from './orchestrate';
import type { SpawnResult } from './run-cli';

const base = {
  outDir: '/build/dist',
  appToken: 'tok',
  appVersion: '1.0.0',
  appBuild: '7',
};

const ID = 'b039c7fb-d958-5fe6-b76f-136179e9a728';

describe('post-emit stamp verification', () => {
  const STAMP = `\n;1;\n//# debugId=${ID}\n`;
  const stampedMap = JSON.stringify({ version: 3, sources: [], mappings: '', debugId: ID });
  const plainMap = JSON.stringify({ version: 3, sources: [], mappings: '' });
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-verify-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A fake CLI: `inject` rewrites the named files as `rewrite` says; `upload` just succeeds. */
  const cli = (rewrite: Record<string, string>) => {
    const run = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') {
        for (const [name, content] of Object.entries(rewrite)) {
          await writeFile(join(dir, name), content);
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    return { run };
  };
  const seed = async (): Promise<void> => {
    await writeFile(join(dir, 'a.js'), 'a();\n//# sourceMappingURL=a.js.map\n');
    await writeFile(join(dir, 'a.js.map'), plainMap);
    await writeFile(join(dir, 'b.js'), 'b();\n//# sourceMappingURL=b.js.map\n');
    await writeFile(join(dir, 'b.js.map'), plainMap);
  };
  const read = (name: string): Promise<string> => readFile(join(dir, name), 'utf8');
  const opts = (extra: object = {}) => ({
    ...base,
    outDir: dir,
    findSri: async () => [],
    deleteMaps: false,
    ...extra,
  });

  it('restores a bundle (and its map) whose stamp no longer parses, reports it, keeps the good stamp', async () => {
    await seed();
    const { run } = cli({
      'a.js': `a();\n//# sourceMappingURL=a.js.map\n{{${STAMP}`,
      'a.js.map': stampedMap,
      'b.js': `b();\n//# sourceMappingURL=b.js.map\n${STAMP}`,
      'b.js.map': stampedMap,
    });
    const errors: unknown[] = [];
    const result = await uploadSourcemaps(opts({ run, onError: (e: unknown) => errors.push(e) }));

    // The broken one is exactly as the bundler wrote it — bundle AND map.
    expect(await read('a.js')).toBe('a();\n//# sourceMappingURL=a.js.map\n');
    expect(await read('a.js.map')).toBe(plainMap);
    // The healthy one keeps its stamp.
    expect(await read('b.js')).toContain(`//# debugId=${ID}`);
    expect(await read('b.js.map')).toBe(stampedMap);
    expect(String(errors[0])).toContain('a.js');
    expect(String(errors[0])).toContain('no longer parses');
    expect(String(errors[0])).toContain('2 file(s) were restored');
    // The upload still happened for what is stamped.
    expect(run.mock.calls.some((c) => c[0][0] === 'debug-files')).toBe(true);
    expect(result.uploaded).toBe(true);
  });

  it('a map-only failure restores the bundle too, so a pair is never half-stamped', async () => {
    await seed();
    const { run } = cli({
      'a.js': `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`,
      'a.js.map': 'not json',
    });
    const errors: unknown[] = [];
    await uploadSourcemaps(opts({ run, onError: (e: unknown) => errors.push(e) }));
    expect(await read('a.js')).toBe('a();\n//# sourceMappingURL=a.js.map\n');
    expect(await read('a.js.map')).toBe(plainMap);
    expect(String(errors[0])).toContain('a.js.map');
  });

  it('throws under failOnError, with the files restored', async () => {
    await seed();
    const { run } = cli({ 'a.js': `a();\n{{${STAMP}`, 'a.js.map': stampedMap });
    await expect(uploadSourcemaps(opts({ run, failOnError: true }))).rejects.toThrow(
      /did not verify/,
    );
    expect(await read('a.js')).toBe('a();\n//# sourceMappingURL=a.js.map\n');
  });

  it('a clean stamp raises nothing', async () => {
    await seed();
    const { run } = cli({
      'a.js': `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`,
      'a.js.map': stampedMap,
    });
    const onError = vi.fn();
    await uploadSourcemaps(opts({ run, onError }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('is not checked on a dry run (inject wrote nothing)', async () => {
    await seed();
    const { run } = cli({ 'a.js': '{{' });
    const onError = vi.fn();
    await uploadSourcemaps(opts({ run, onError, dryRun: true }));
    expect(onError).not.toHaveBeenCalled();
    // The fake wrote anyway; the point is that nothing was snapshotted, so nothing was restored.
    expect(await read('a.js')).toBe('{{');
  });

  it('checks exactly the files a `files` run names, and restores them', async () => {
    await seed();
    await writeFile(join(dir, 'other.js'), 'other();\n');
    const { run } = cli({ 'a.js': `a();\n{{${STAMP}`, 'other.js': 'CHANGED{{' });
    const errors: unknown[] = [];
    await uploadSourcemaps({
      ...base,
      outDir: dir,
      run,
      deleteMaps: false,
      onError: (e) => errors.push(e),
      files: { scripts: [join(dir, 'a.js')], maps: [join(dir, 'a.js.map')] },
    });
    expect(await read('a.js')).toBe('a();\n//# sourceMappingURL=a.js.map\n');
    // Not named, so not this build's: neither verified nor restored.
    expect(await read('other.js')).toBe('CHANGED{{');
    expect(errors).toHaveLength(1);
  });

  it("a missing output directory is the CLI's error to report, not a verification crash", async () => {
    const run = vi.fn(async (): Promise<SpawnResult> => ({ code: 0, stdout: '', stderr: '' }));
    const onError = vi.fn();
    const result = await uploadSourcemaps({
      ...base,
      outDir: join(dir, 'does-not-exist'),
      run,
      onError,
      deleteMaps: false,
      findSri: async () => [],
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(true);
  });

  it('the snapshot skips node_modules, dot-directories and non-stampable files', async () => {
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'node_modules', 'dep.js'), 'dep();\n');
    await mkdir(join(dir, '.hidden'));
    await writeFile(join(dir, '.hidden', 'c.js'), 'c();\n');
    await writeFile(join(dir, 'a.css'), 'a{}');
    const { run } = cli({});
    const onError = vi.fn();
    // Rewrites skipped files: were they snapshotted, the broken result would be flagged and restored.
    const spy = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') {
        await writeFile(join(dir, 'node_modules', 'dep.js'), '{{');
        await writeFile(join(dir, '.hidden', 'c.js'), '{{');
      }
      return run(args);
    });
    await uploadSourcemaps(opts({ run: spy, onError }));
    expect(onError).not.toHaveBeenCalled();
    expect(await readFile(join(dir, 'node_modules', 'dep.js'), 'utf8')).toBe('{{');
    expect(await readFile(join(dir, '.hidden', 'c.js'), 'utf8')).toBe('{{');
  });

  it('the snapshot stops at the depth limit, like the map walk (a mis-resolved root must not traverse a disk)', async () => {
    let deep = dir;
    for (let i = 0; i < 8; i++) {
      deep = join(deep, `d${i}`);
      await mkdir(deep);
    }
    await writeFile(join(deep, 'deep.js'), 'deep();\n');
    const spy = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') {
        await writeFile(join(deep, 'deep.js'), '{{');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const onError = vi.fn();
    await uploadSourcemaps(opts({ run: spy, onError }));
    expect(onError).not.toHaveBeenCalled(); // beyond the limit: never snapshotted, so never "restored"
    expect(await readFile(join(deep, 'deep.js'), 'utf8')).toBe('{{');
  });

  it('does not snapshot or restore a directory that is the project root (or above): it says so, and inject still runs', async () => {
    await writeFile(join(dir, 'package.json'), '{}');
    await seed();
    const { run } = cli({ 'a.js': '{{' });
    const errors: unknown[] = [];
    await uploadSourcemaps(opts({ run, onError: (e: unknown) => errors.push(e) }));
    expect(run.mock.calls.some((c) => c[0][1] === 'inject')).toBe(true);
    expect(String(errors[0])).toContain('project root');
    expect(await read('a.js')).toBe('{{'); // nothing was restored: nothing was snapshotted
  });

  it('names a file it could not restore, and says it still carries the unverified stamp', async () => {
    await seed();
    const run = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') {
        await writeFile(join(dir, 'a.js'), `a();\n{{${STAMP}`);
        await chmod(dir, 0o555); // restore cannot create its temp file
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const errors: unknown[] = [];
    try {
      await uploadSourcemaps(
        opts({ run, onError: (e: unknown) => errors.push(e), outDir: join(dir, '.') }),
      );
    } finally {
      await chmod(dir, 0o755);
    }
    expect(String(errors[0])).toContain('COULD NOT restore');
    expect(String(errors[0])).toContain('a.js');
  });

  it('spills the originals outside memory and removes the spill directory afterwards, success or failure', async () => {
    await seed();
    const spillRoot = await mkdtemp(join(tmpdir(), 'bugsee-spillroot-'));
    try {
      const seen: string[][] = [];
      const run = vi.fn(async (args: string[]): Promise<SpawnResult> => {
        if (args[1] === 'inject') {
          seen.push(await readdir(spillRoot)); // while inject runs, the originals are on disk
        }
        return { code: 0, stdout: '', stderr: '' };
      });
      await uploadSourcemaps(opts({ run, spillRoot }));
      expect(seen[0]).toHaveLength(1);
      expect(await readdir(spillRoot)).toEqual([]);

      const failing = vi.fn(async (): Promise<SpawnResult> => {
        throw new Error('cli exploded');
      });
      await uploadSourcemaps(opts({ run: failing, spillRoot, onError: () => undefined }));
      expect(await readdir(spillRoot)).toEqual([]);
    } finally {
      await rm(spillRoot, { recursive: true, force: true });
    }
  });

  it('the pre-stamped path never runs inject (and so never restores anything)', async () => {
    await seed();
    const { run } = cli({ 'a.js': '{{' });
    await uploadSourcemaps(
      opts({ run, onError: () => undefined, preStamped: true, verifySri: async () => [] }),
    );
    expect(run.mock.calls.every((c) => c[0][1] !== 'inject')).toBe(true);
    expect(await read('a.js')).toBe('a();\n//# sourceMappingURL=a.js.map\n');
  });
});

describe('maps are deleted only when they were actually keyed for upload', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-keyed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ok = async (): Promise<SpawnResult> => ({ code: 0, stdout: '', stderr: '' });

  it('an unstamped map is KEPT (the CLI skips it and exits 0), a stamped one is deleted, and it is said', async () => {
    await writeFile(join(dir, 'keyed.js.map'), JSON.stringify({ debugId: ID }));
    await writeFile(join(dir, 'snake.js.map'), JSON.stringify({ debug_id: ID }));
    await writeFile(join(dir, 'unkeyed.js.map'), '{"version":3}');
    await writeFile(join(dir, 'broken.js.map'), 'not json');
    // A stylesheet map is never uploaded and is deleted regardless (it embeds the source too).
    await writeFile(join(dir, 'style.css.map'), '{"version":3}');
    const errors: unknown[] = [];
    const result = await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      listMapFiles,
      findSri: async () => [],
      onError: (e) => errors.push(e),
    });
    expect((await readdir(dir)).sort()).toEqual(['broken.js.map', 'unkeyed.js.map']);
    expect(result.deletedMaps.map((p) => p.split('/').pop()).sort()).toEqual([
      'keyed.js.map',
      'snake.js.map',
      'style.css.map',
    ]);
    expect(String(errors[0])).toContain('unkeyed.js.map');
    expect(String(errors[0])).toContain('broken.js.map');
    expect(String(errors[0])).toContain('not uploaded');
    expect(result.uploaded).toBe(true);
  });

  it('throws under failOnError (a map that was not uploaded is a failed upload), after deleting the rest', async () => {
    await writeFile(join(dir, 'keyed.js.map'), JSON.stringify({ debugId: ID }));
    await writeFile(join(dir, 'unkeyed.js.map'), '{}');
    await expect(
      uploadSourcemaps({
        ...base,
        outDir: dir,
        run: ok,
        listMapFiles,
        findSri: async () => [],
        failOnError: true,
      }),
    ).rejects.toThrow(/unkeyed\.js\.map/);
    expect(await readdir(dir)).toEqual(['unkeyed.js.map']);
  });

  it('applies to a `files` run too, and stays quiet when everything was keyed', async () => {
    const keyed = join(dir, 'a.js.map');
    const unkeyed = join(dir, 'b.js.map');
    await writeFile(keyed, JSON.stringify({ debugId: ID }));
    await writeFile(unkeyed, '{}');
    const onError = vi.fn();
    const result = await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      onError,
      files: { scripts: [join(dir, 'a.js'), join(dir, 'b.js')], maps: [keyed, unkeyed] },
    });
    expect(await readdir(dir)).toEqual(['b.js.map']);
    expect(result.deletedMaps).toEqual([keyed]);
    expect(onError).toHaveBeenCalledOnce();

    onError.mockClear();
    await writeFile(keyed, JSON.stringify({ debugId: ID }));
    await rm(unkeyed);
    await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      onError,
      files: { scripts: [join(dir, 'a.js')], maps: [keyed] },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a map that vanished before the check is simply not there (nothing to keep or delete)', async () => {
    const onError = vi.fn();
    const result = await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      listMapFiles: async () => [join(dir, 'gone.js.map')],
      findSri: async () => [],
      onError,
    });
    expect(result.deletedMaps).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('deleteMaps: false never reads or reports a map', async () => {
    await writeFile(join(dir, 'unkeyed.js.map'), '{}');
    const onError = vi.fn();
    await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      listMapFiles,
      findSri: async () => [],
      deleteMaps: false,
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['unkeyed.js.map']);
  });

  it('a failed upload deletes nothing, keyed or not', async () => {
    await writeFile(join(dir, 'keyed.js.map'), JSON.stringify({ debugId: ID }));
    const run = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[0] === 'debug-files') {
        throw new Error('exit 20');
      }
      return ok();
    });
    const result = await uploadSourcemaps({
      ...base,
      outDir: dir,
      run,
      listMapFiles,
      findSri: async () => [],
      onError: () => undefined,
    });
    expect(result.uploaded).toBe(false);
    expect(await readdir(dir)).toEqual(['keyed.js.map']);
  });
});

describe('an in-build stamp is checked again on disk, after the bundler wrote the output', () => {
  const STAMP = `\n;1;\n//# debugId=${ID}\n`;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-prestamped-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ok = vi.fn(async (): Promise<SpawnResult> => ({ code: 0, stdout: '', stderr: '' }));
  const opts = (extra: object = {}) => ({
    ...base,
    outDir: dir,
    run: ok,
    preStamped: true,
    stampedBundles: ['a.js'],
    verifySri: async () => [],
    ...extra,
  });

  it('reports a map that lost its debugId after the stamp (a bundler regenerated it), and keeps that map', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), '{"version":3}');
    const errors: unknown[] = [];
    const result = await uploadSourcemaps(
      opts({ listMapFiles, onError: (e: unknown) => errors.push(e) }),
    );
    expect(String(errors[0])).toContain('a.js.map');
    expect(String(errors[0])).toContain('after the build wrote it');
    // The run goes on (what is keyed is still uploaded), and the unkeyed map is NOT deleted.
    expect(result.uploaded).toBe(true);
    expect(await readdir(dir)).toContain('a.js.map');
  });

  it('throws under failOnError, before uploading', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), '{"version":3}');
    ok.mockClear();
    await expect(uploadSourcemaps(opts({ failOnError: true }))).rejects.toThrow(/a\.js\.map/);
    expect(ok).not.toHaveBeenCalled();
  });

  it('is quiet for a build whose bundles and maps agree', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), JSON.stringify({ debugId: ID }));
    const onError = vi.fn();
    await uploadSourcemaps(opts({ onError, deleteMaps: false }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('is skipped on a dry run, where nothing was stamped', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    await writeFile(join(dir, 'a.js.map'), '{"version":3}');
    const onError = vi.fn();
    await uploadSourcemaps(opts({ onError, dryRun: true }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('judges only the bundles the stamp wrote: an unstamped vendor script with a map beside them is not a failure', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), JSON.stringify({ debugId: ID }));
    await writeFile(join(dir, 'vendor.min.js'), 'v();\n//# sourceMappingURL=vendor.min.js.map\n');
    await writeFile(join(dir, 'vendor.min.js.map'), '{"version":3}');
    const onError = vi.fn();
    await uploadSourcemaps(opts({ onError, deleteMaps: false, failOnError: true }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('with an output directory of "." only the named bundles are read (never the project tree)', async () => {
    const onError = vi.fn();
    await uploadSourcemaps(
      opts({
        outDir: '.',
        stampedBundles: ['no-such-bundle-bugsee.js'],
        onError,
        deleteMaps: false,
        failOnError: true,
      }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('without stampedBundles the on-disk re-check has nothing to name and does not run', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), '{"version":3}');
    const onError = vi.fn();
    await uploadSourcemaps(
      opts({ stampedBundles: undefined, onError, deleteMaps: false, failOnError: true }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('checks the named files of a `files` run only', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), JSON.stringify({ debugId: ID }));
    await writeFile(join(dir, 'foreign.js'), 'f();\n');
    await writeFile(join(dir, 'foreign.js.map'), '{"version":3}');
    const onError = vi.fn();
    await uploadSourcemaps(
      opts({
        onError,
        deleteMaps: false,
        files: {
          scripts: [join(dir, 'a.js')],
          maps: [join(dir, 'a.js.map')],
        },
      }),
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
