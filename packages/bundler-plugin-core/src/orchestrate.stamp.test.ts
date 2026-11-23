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

  it('the snapshot covers the WHOLE output directory (inject stamps everything there): a bad stamp under src/, node_modules/ or a dot-directory is restored', async () => {
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'node_modules', 'dep.js'), 'dep();\n');
    await mkdir(join(dir, '.hidden'));
    await writeFile(join(dir, '.hidden', 'c.js'), 'c();\n');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'm.js'), 'm();\n');
    await writeFile(join(dir, 'a.css'), 'a{}');
    const { run } = cli({});
    const errors: unknown[] = [];
    const spy = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') {
        for (const f of ['node_modules/dep.js', '.hidden/c.js', 'src/m.js']) {
          await writeFile(join(dir, f), '{{');
        }
      }
      return run(args);
    });
    await uploadSourcemaps(opts({ run: spy, onError: (e: unknown) => errors.push(e) }));
    expect(errors).toHaveLength(1);
    expect(await readFile(join(dir, 'node_modules', 'dep.js'), 'utf8')).toBe('dep();\n');
    expect(await readFile(join(dir, '.hidden', 'c.js'), 'utf8')).toBe('c();\n');
    expect(await readFile(join(dir, 'src', 'm.js'), 'utf8')).toBe('m();\n');
  });

  it('the snapshot reaches any depth of an ordinary output directory (inject stamps that deep too)', async () => {
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
    const errors: unknown[] = [];
    await uploadSourcemaps(opts({ run: spy, onError: (e: unknown) => errors.push(e) }));
    expect(errors).toHaveLength(1);
    expect(await readFile(join(deep, 'deep.js'), 'utf8')).toBe('deep();\n');
  });

  it('does not snapshot or restore a directory that is the project root (or above): it says so, and inject still runs', async () => {
    await seed();
    const { run } = cli({ 'a.js': '{{' });
    const errors: unknown[] = [];
    const start = process.cwd();
    process.chdir(dir);
    try {
      await uploadSourcemaps(opts({ run, onError: (e: unknown) => errors.push(e) }));
    } finally {
      process.chdir(start);
    }
    expect(run.mock.calls.some((c) => c[0][1] === 'inject')).toBe(true);
    expect(String(errors[0])).toContain('project root');
    expect(await read('a.js')).toBe('{{'); // nothing was restored: nothing was snapshotted
  });

  it('does snapshot and verify an output dir that merely holds a package.json marker (dist/cjs)', async () => {
    await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}');
    await seed();
    const { run } = cli({ 'a.js': `a();\n{{${STAMP}`, 'a.js.map': stampedMap });
    const errors: unknown[] = [];
    await uploadSourcemaps(opts({ run, onError: (e: unknown) => errors.push(e) }));
    expect(String(errors[0])).toContain('no longer parses');
    expect(await read('a.js')).toBe('a();\n//# sourceMappingURL=a.js.map\n');
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

  it('an EMPTY debugId / debug_id is not a key: that map is kept and reported', async () => {
    await writeFile(join(dir, 'camel.js.map'), JSON.stringify({ debugId: '' }));
    await writeFile(join(dir, 'snake.js.map'), JSON.stringify({ debug_id: '' }));
    await writeFile(join(dir, 'num.js.map'), JSON.stringify({ debugId: 7 }));
    const errors: unknown[] = [];
    const result = await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      listMapFiles,
      findSri: async () => [],
      onError: (e) => errors.push(e),
    });
    expect(result.deletedMaps).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(['camel.js.map', 'num.js.map', 'snake.js.map']);
    for (const name of ['camel', 'snake', 'num']) {
      expect(String(errors[0])).toContain(`${name}.js.map`);
    }
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
    expect(result.uploaded).toBe(false); // nothing keyed: nothing uploaded
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
        listUploadMaps: async () => [], // never walk the project tree from a test
        onNotice: () => undefined,
        onError,
        deleteMaps: false,
      }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('without stampedBundles the on-disk re-check has nothing to name and does not run', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), '{"version":3}');
    const onError = vi.fn();
    await uploadSourcemaps(
      opts({ stampedBundles: undefined, onError, onNotice: () => undefined, deleteMaps: false }),
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

describe('a pre-stamped directory upload names its files (never the directory)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-explicit-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const record = () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    });
    return { run, calls };
  };
  const opts = (extra: object = {}) => ({
    ...base,
    outDir: dir,
    preStamped: true,
    verifySri: async () => [],
    ...extra,
  });
  const keyed = JSON.stringify({ debugId: ID });

  it('uploads only the maps that carry a debug-id: a vendor map beside the build is left alone, said as a NOTICE, and never fails the build', async () => {
    await writeFile(join(dir, 'a.js.map'), keyed);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'b.mjs.map'), keyed);
    await writeFile(join(dir, 'vendor.js.map'), '{"version":3}');
    await writeFile(join(dir, 'style.css.map'), '{"version":3}');
    const { run, calls } = record();
    const notices: string[] = [];
    const onError = vi.fn();
    const result = await uploadSourcemaps(
      opts({ run, failOnError: true, onError, onNotice: (m: string) => notices.push(m) }),
    );
    const upload = calls.find((c) => c[0] === 'debug-files') as string[];
    expect(upload.slice(0, 2)).toEqual(['debug-files', 'upload']);
    expect(upload).toContain(join(dir, 'a.js.map'));
    expect(upload).toContain(join(dir, 'sub', 'b.mjs.map'));
    expect(upload).not.toContain(dir);
    expect(upload).not.toContain(join(dir, 'vendor.js.map'));
    expect(upload).not.toContain(join(dir, 'style.css.map'));
    // The uploaded maps AND the stylesheet map (never sent, embeds the source) are deleted; the unkeyed vendor
    // script map is untouched.
    expect((await readdir(dir)).sort()).toEqual(['sub', 'vendor.js.map']);
    expect(result.uploaded).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('vendor.js.map');
    expect(notices[0]).toContain('were not uploaded');
    expect(notices[0]).not.toContain('not part of this build');
  });

  it('uploads and deletes a keyed map of ANY name (index.map), and deletes nothing that was not uploaded', async () => {
    await writeFile(join(dir, 'index.map'), keyed);
    await mkdir(join(dir, 'test'));
    await mkdir(join(dir, '.well-known'));
    await writeFile(join(dir, 'test', 'x.js.map'), keyed);
    await writeFile(join(dir, '.well-known', 'y.js.map'), keyed);
    await writeFile(join(dir, 'unkeyed.map'), '{"version":3}');
    await writeFile(join(dir, 'a.d.ts.map'), '{"version":3}');
    const { run, calls } = record();
    const deleted: string[][] = [];
    const result = await uploadSourcemaps(
      opts({
        run,
        failOnError: true,
        onNotice: () => undefined,
        deleteMapFiles: async (_d: string, only?: readonly string[]) => {
          deleted.push([...(only ?? [])]);
          return [...(only ?? [])];
        },
      }),
    );
    const upload = calls.find((c) => c[0] === 'debug-files') as string[];
    const uploaded = [
      join(dir, '.well-known', 'y.js.map'),
      join(dir, 'index.map'),
      join(dir, 'test', 'x.js.map'),
    ];
    for (const map of uploaded) {
      expect(upload).toContain(map);
    }
    expect(upload).not.toContain(join(dir, 'unkeyed.map'));
    // What was uploaded is deleted (test/ and dot-directories included), plus the declaration map that
    // was never uploadable; the UNKEYED script map is in neither.
    expect(deleted).toEqual([[...uploaded, join(dir, 'a.d.ts.map')]]);
    expect(result.deletedMaps).toEqual([...uploaded, join(dir, 'a.d.ts.map')]);
    expect(await readdir(dir)).toContain('unkeyed.map');
  });

  it('never deletes a map that was not in the uploaded set, whatever the directory walk saw', async () => {
    await writeFile(join(dir, 'a.js.map'), keyed);
    const { run } = record();
    const deleted: string[][] = [];
    const walk = vi.fn(async () => [join(dir, 'a.js.map'), join(dir, 'foreign.js.map')]);
    await uploadSourcemaps(
      opts({
        run,
        // The deletion snapshot lister would also report this map; it must not be consulted.
        listMapFiles: walk,
        deleteMapFiles: async (_d: string, only?: readonly string[]) => {
          deleted.push([...(only ?? [])]);
          return [];
        },
      }),
    );
    expect(deleted).toEqual([[join(dir, 'a.js.map')]]);
    expect(walk).not.toHaveBeenCalled();
  });

  it('deletes stylesheet and declaration maps only when an upload happened, and never an unkeyed script map', async () => {
    for (const name of ['a.css.map', 'a.d.ts.map', 'a.d.mts.map', 'a.d.cts.map', 'x.js.map']) {
      await writeFile(join(dir, name), name === 'x.js.map' ? '{"version":3}' : '{}');
    }
    const { run, calls } = record();
    await uploadSourcemaps(opts({ run, onNotice: () => undefined }));
    // Nothing keyed -> no upload -> nothing confirmed -> nothing deleted.
    expect(calls).toEqual([]);
    expect((await readdir(dir)).sort()).toHaveLength(5);

    await writeFile(join(dir, 'k.js.map'), keyed);
    await uploadSourcemaps(opts({ run, onNotice: () => undefined }));
    expect((await readdir(dir)).sort()).toEqual(['x.js.map']);
  });

  it('a map it cannot read is reported as not uploaded and left alone (never silently skipped)', async () => {
    await writeFile(join(dir, 'k.js.map'), keyed);
    await writeFile(join(dir, 'locked.js.map'), keyed);
    await chmod(join(dir, 'locked.js.map'), 0o000);
    const notices: string[] = [];
    try {
      const { run, calls } = record();
      await uploadSourcemaps(
        opts({ run, failOnError: true, onNotice: (m: string) => notices.push(m) }),
      );
      const upload = calls.find((c) => c[0] === 'debug-files') as string[];
      expect(upload).toContain(join(dir, 'k.js.map'));
      expect(upload).not.toContain(join(dir, 'locked.js.map'));
      expect(notices.join('\n')).toContain('locked.js.map');
    } finally {
      await chmod(join(dir, 'locked.js.map'), 0o644);
    }
  });

  it('does not re-read the maps it already classified when it decides what to delete', async () => {
    await writeFile(join(dir, 'k.js.map'), keyed);
    const partition = vi.fn(async (maps: readonly string[]) => ({
      deletable: [...maps],
      kept: [] as string[],
    }));
    await uploadSourcemaps(opts({ run: record().run, partitionMaps: partition }));
    expect(partition).toHaveBeenCalledOnce();
  });

  it('with nothing keyed there is nothing to upload: no CLI call, a notice, and a failure only under failOnError', async () => {
    await writeFile(join(dir, 'vendor.js.map'), '{"version":3}');
    const { run, calls } = record();
    const notices: string[] = [];
    const result = await uploadSourcemaps(opts({ run, onNotice: (m: string) => notices.push(m) }));
    expect(calls).toEqual([]);
    expect(result.uploaded).toBe(false);
    expect(notices).toHaveLength(1);
    await expect(uploadSourcemaps(opts({ run, failOnError: true }))).rejects.toThrow(
      /no source maps/,
    );
    expect(calls).toEqual([]);
  });

  it('batches explicit paths like any file run', async () => {
    for (let i = 0; i < 250; i++) {
      await writeFile(join(dir, `c${i}.js.map`), keyed);
    }
    const { run, calls } = record();
    await uploadSourcemaps(opts({ run, deleteMaps: false }));
    expect(calls.filter((c) => c[0] === 'debug-files')).toHaveLength(2);
  });

  it('a dry run still uploads the directory (nothing was stamped, nothing is deleted)', async () => {
    await writeFile(join(dir, 'vendor.js.map'), '{"version":3}');
    const { run, calls } = record();
    await uploadSourcemaps(opts({ run, dryRun: true }));
    expect(calls[0]?.slice(0, 3)).toEqual(['debug-files', 'upload', dir]);
  });

  it('a directory with no notice sink says nothing on stdout-breaking channels (default console.warn)', async () => {
    await writeFile(join(dir, 'vendor.js.map'), '{"version":3}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await uploadSourcemaps(opts({ run: record().run }));
      expect(String(warn.mock.calls[0]?.[0])).toContain('vendor.js.map');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the explicit upload is deterministic and its result is truthful', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-order-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const keyed = JSON.stringify({ debugId: ID });
  const opts = (extra: object = {}) => ({
    ...base,
    outDir: dir,
    preStamped: true,
    verifySri: async () => [],
    deleteMaps: false,
    ...extra,
  });

  it('sorts whatever the walk returned: batch composition and notice order are stable', async () => {
    const names = Array.from({ length: 205 }, (_, i) =>
      join(dir, `m${String(i).padStart(3, '0')}.js.map`),
    );
    for (const n of names) {
      await writeFile(n, keyed);
    }
    await writeFile(join(dir, 'zz.js.map'), '{"version":3}');
    await writeFile(join(dir, 'aa.js.map'), '{"version":3}');
    const unsorted = [join(dir, 'zz.js.map'), ...[...names].reverse(), join(dir, 'aa.js.map')];
    const calls: string[][] = [];
    const notices: string[] = [];
    await uploadSourcemaps(
      opts({
        listUploadMaps: async () => unsorted,
        run: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: '', stderr: '' };
        },
        onNotice: (m: string) => notices.push(m),
      }),
    );
    const uploads = calls.filter((c) => c[0] === 'debug-files');
    const files = uploads.map((c) => c.slice(2).filter((a) => a.endsWith('.map')));
    expect(files[0]).toEqual(names.slice(0, 200));
    expect(files[1]).toEqual(names.slice(200));
    expect(notices[0]?.indexOf('aa.js.map')).toBeLessThan(
      notices[0]?.indexOf('zz.js.map') as number,
    );
  });

  it('reports uploaded:false when nothing was uploaded, true when something was', async () => {
    await writeFile(join(dir, 'vendor.js.map'), '{"version":3}');
    const run = async () => ({ code: 0, stdout: '', stderr: '' });
    const none = await uploadSourcemaps(opts({ run, onNotice: () => undefined }));
    expect(none).toMatchObject({ injected: true, uploaded: false, deletedMaps: [] });
    await writeFile(join(dir, 'k.js.map'), keyed);
    const some = await uploadSourcemaps(opts({ run, onNotice: () => undefined }));
    expect(some.uploaded).toBe(true);
  });
});

describe('foreign maps in fenced directories are never touched, read for a notice, or deleted', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-foreign-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const keyed = JSON.stringify({ debugId: ID });
  const ok = async (): Promise<SpawnResult> => ({ code: 0, stdout: '', stderr: '' });
  const foreign = [
    'node_modules/pkg/style.css.map',
    'node_modules/pkg/types.d.ts.map',
    '.cache/x.d.ts.map',
    'src/old.d.ts.map',
  ];
  const seedForeign = async (): Promise<void> => {
    for (const rel of foreign) {
      await mkdir(join(dir, rel, '..'), { recursive: true });
      await writeFile(join(dir, rel), '{}');
    }
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'vendor.js.map'), '{"version":3}');
  };

  it("pre-stamped: this build's own css/declaration maps are deleted, foreign ones under node_modules/src/dot-dirs survive, and no notice names them", async () => {
    await seedForeign();
    await writeFile(join(dir, 'a.js.map'), keyed);
    await writeFile(join(dir, 'main.css.map'), '{}');
    await writeFile(join(dir, 'types.d.ts.map'), '{}');
    const notices: string[] = [];
    await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      preStamped: true,
      verifySri: async () => [],
      onNotice: (m) => notices.push(m),
    });
    const left = ((await readdir(dir, { recursive: true })) as string[])
      .filter((f) => f.endsWith('.map'))
      .sort();
    expect(left).toEqual([...foreign, 'node_modules/pkg/vendor.js.map'].sort());
    expect(notices.join('\n')).not.toContain('node_modules');
  });

  it('post-emit (default walker): the same rule, and keyed maps at any depth or under src/ ARE deleted', async () => {
    await seedForeign();
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'k.js.map'), keyed);
    let deep = dir;
    for (let i = 0; i < 8; i++) {
      deep = join(deep, `d${i}`);
      await mkdir(deep);
    }
    await writeFile(join(deep, 'deep.js.map'), keyed);
    await writeFile(join(dir, 'main.css.map'), '{}');
    const onError = vi.fn();
    await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      findSri: async () => [],
      spillRoot: tmpdir(),
      onError,
    });
    expect(onError).not.toHaveBeenCalled(); // the unkeyed vendor map under node_modules is not this build's to report
    const left = ((await readdir(dir, { recursive: true })) as string[])
      .filter((f) => f.endsWith('.map'))
      .sort();
    expect(left).toEqual([...foreign, 'node_modules/pkg/vendor.js.map'].sort());
  });
});

describe("the on-disk re-check uses the build's own bundle -> map names", () => {
  it('flags a moved map (that neither pointer nor sibling can name) that lost its id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugsee-known-'));
    try {
      await mkdir(join(dir, 'js'));
      await mkdir(join(dir, 'maps'));
      await writeFile(
        join(dir, 'js', 'a.js'),
        `a();\n//# sourceMappingURL=a.map\n\n;1;\n//# debugId=${ID}\n`,
      );
      await writeFile(join(dir, 'maps', 'a.js.map'), '{"version":3}');
      const errors: unknown[] = [];
      await uploadSourcemaps({
        ...base,
        outDir: dir,
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
        preStamped: true,
        verifySri: async () => [],
        stampedBundles: ['js/a.js'],
        stampedMaps: { 'js/a.js': 'maps/a.js.map' },
        deleteMaps: false,
        onNotice: () => undefined,
        onError: (e) => errors.push(e),
      });
      expect(String(errors[0])).toContain('maps/a.js.map');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ownFiles: only what THIS build emitted is deleted', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-own-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const keyed = JSON.stringify({ debugId: ID });
  const ok = async (): Promise<SpawnResult> => ({ code: 0, stdout: '', stderr: '' });
  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  };
  const left = async (): Promise<string[]> =>
    ((await readdir(dir, { recursive: true })) as string[])
      .filter((f) => f.endsWith('.map'))
      .sort();

  const modes = [
    ['pre-stamped', { preStamped: true, verifySri: async () => [] }],
    ['post-emit', { findSri: async () => [] }],
  ] as const;
  for (const [mode, extra] of modes) {
    it(`${mode}: own css/declaration maps under src/ are deleted, foreign ones (even outside fenced names) and foreign keyed maps stay, and the keyed leftover is said`, async () => {
      await put('src/a.js.map', keyed); // own, keyed
      await put('src/style.css.map', '{}'); // own, never uploaded
      await put('src/a.d.ts.map', '{}'); // own, never uploaded
      await put('vendor/bootstrap.css.map', '{}'); // foreign (copied from publicDir)
      await put('x.js.map', keyed); // foreign but keyed: uploaded as the CLI did, NOT deleted
      await put('node_modules/pkg/style.css.map', '{}'); // foreign
      await put('src/old.d.ts.map', '{}'); // foreign, in a name that looks like ours
      const notices: string[] = [];
      await uploadSourcemaps({
        ...base,
        outDir: dir,
        run: ok,
        ownFiles: ['src/a.js.map', 'src\\style.css.map', './src/a.d.ts.map'],
        onNotice: (m) => notices.push(m),
        onError: () => undefined,
        ...extra,
      });
      expect(await left()).toEqual([
        'node_modules/pkg/style.css.map',
        'src/old.d.ts.map',
        'vendor/bootstrap.css.map',
        'x.js.map',
      ]);
      expect(notices.join('\n')).toContain('x.js.map');
      expect(notices.join('\n')).toContain('not produced by this build');
    });
  }

  it('says it on console.warn when no notice sink is given', async () => {
    await put('x.js.map', keyed);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await uploadSourcemaps({
        ...base,
        outDir: dir,
        run: ok,
        ownFiles: [],
        findSri: async () => [],
      });
      expect(String(warn.mock.calls[0]?.[0])).toContain('not produced by this build');
    } finally {
      warn.mockRestore();
    }
  });

  it('without ownFiles the name fence still applies (post-emit CLI directory mode)', async () => {
    await put('assets/a.js.map', keyed);
    await put('assets/a.css.map', '{}');
    await put('src/old.css.map', '{}');
    await uploadSourcemaps({ ...base, outDir: dir, run: ok, findSri: async () => [] });
    expect(await left()).toEqual(['src/old.css.map']);
  });

  it('the esbuild/files path is unchanged: it deletes exactly its listed files', async () => {
    await put('a.js.map', keyed);
    await put('a.css.map', '{}');
    await put('other.css.map', '{}');
    await uploadSourcemaps({
      ...base,
      outDir: dir,
      run: ok,
      ownFiles: [],
      files: {
        scripts: [join(dir, 'a.js')],
        maps: [join(dir, 'a.js.map')],
        stylesheetMaps: [join(dir, 'a.css.map')],
      },
    });
    expect(await left()).toEqual(['other.css.map']);
  });
});

describe("catch-up: the build's OWN script maps that carry no debug-id (Vite workers) are stamped before the upload", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-catchup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const STAMPED = `w();\n//# sourceMappingURL=w.js.map\n${STAMP_FOR_CATCHUP()}`;
  function STAMP_FOR_CATCHUP(): string {
    return `\n;!function(){try{var e=globalThis;e._bugseeDebugIds=e._bugseeDebugIds||{}}catch(e){}}();\n//# debugId=${ID}\n`;
  }
  const plainMap = '{"version":3,"sources":["w.ts"],"names":[],"mappings":"AAAA"}';
  /** A faithful-enough CLI: inject stamps the bundle if it is not (appending), and puts its id in the map. */
  const cli = () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      calls.push(args);
      if (args[1] === 'inject') {
        const paths = args.slice(2);
        for (const path of paths.filter((x) => /\.js$/.test(x))) {
          const code = await readFile(path, 'utf8');
          if (!code.includes('//# debugId=')) {
            await writeFile(path, code + STAMP_FOR_CATCHUP());
          }
        }
        for (const path of paths.filter((x) => x.endsWith('.map'))) {
          await writeFile(
            path,
            JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), debugId: ID }),
          );
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    return { run, calls };
  };
  const opts = (extra: object = {}) => ({
    ...base,
    outDir: dir,
    preStamped: true,
    verifySri: async () => [],
    findSri: async () => [],
    ownFiles: ['w.js', 'w.js.map'],
    onNotice: () => undefined,
    ...extra,
  });

  it('an already-stamped worker whose map lost its id: injected (idempotent), then uploaded and deleted, no error', async () => {
    await writeFile(join(dir, 'w.js'), STAMPED);
    await writeFile(join(dir, 'w.js.map'), plainMap);
    const { run, calls } = cli();
    const onError = vi.fn();
    const result = await uploadSourcemaps(opts({ run, onError, stampedBundles: ['w.js'] }));
    const inject = calls.find((c) => c[1] === 'inject') as string[];
    expect(inject.slice(2)).toEqual([join(dir, 'w.js'), join(dir, 'w.js.map')]);
    expect(await readFile(join(dir, 'w.js'), 'utf8')).toBe(STAMPED); // untouched
    expect(onError).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(true);
    expect(await readdir(dir)).toEqual(['w.js']);
  });

  it('an UNSTAMPED worker (Vite 7: never in the stamped bundle) is stamped with its map, unless SRI pins it', async () => {
    await writeFile(join(dir, 'w.js'), 'w();\n//# sourceMappingURL=w.js.map\n');
    await writeFile(join(dir, 'w.js.map'), plainMap);
    const { run } = cli();
    await uploadSourcemaps(opts({ run }));
    expect(await readFile(join(dir, 'w.js'), 'utf8')).toContain('//# debugId=');
    expect(await readdir(dir)).toEqual(['w.js']);

    // Pinned by an integrity hash: stamping would break the page, so it is left alone and said.
    await writeFile(join(dir, 'w.js'), 'w();\n//# sourceMappingURL=w.js.map\n');
    await writeFile(join(dir, 'w.js.map'), plainMap);
    const notices: string[] = [];
    const second = cli();
    await uploadSourcemaps(
      opts({
        run: second.run,
        findSri: async () => [
          { html: join(dir, 'index.html'), script: join(dir, 'w.js'), integrity: 'sha384-X' },
        ],
        onNotice: (m: string) => notices.push(m),
      }),
    );
    expect(second.calls.some((c) => c[1] === 'inject')).toBe(false);
    expect(await readFile(join(dir, 'w.js'), 'utf8')).not.toContain('debugId');
    expect(await readdir(dir)).toContain('w.js.map');
    expect(notices.join('\n')).toContain('w.js');
    expect(notices.join('\n')).toContain('Subresource Integrity');
  });

  it('says a blocked (SRI-pinned, unstamped) worker on console.warn when no notice sink is given', async () => {
    await writeFile(join(dir, 'w.js'), 'w();\n//# sourceMappingURL=w.js.map\n');
    await writeFile(join(dir, 'w.js.map'), plainMap);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await uploadSourcemaps(
        opts({
          run: cli().run,
          onNotice: undefined,
          findSri: async () => [
            { html: join(dir, 'i.html'), script: join(dir, 'w.js'), integrity: 'sha384-X' },
          ],
        }),
      );
      expect(String(warn.mock.calls[0]?.[0])).toContain('Subresource Integrity');
    } finally {
      warn.mockRestore();
    }
  });

  it('a pinned worker that is ALREADY stamped is still caught up (its bytes do not change)', async () => {
    await writeFile(join(dir, 'w.js'), STAMPED);
    await writeFile(join(dir, 'w.js.map'), plainMap);
    const { run, calls } = cli();
    await uploadSourcemaps(
      opts({
        run,
        findSri: async () => [
          { html: join(dir, 'i.html'), script: join(dir, 'w.js'), integrity: 'sha384-X' },
        ],
      }),
    );
    expect(calls.some((c) => c[1] === 'inject')).toBe(true);
    expect(await readFile(join(dir, 'w.js'), 'utf8')).toBe(STAMPED);
  });

  it('never touches a map this build did not emit (a publicDir vendor script), nor without ownFiles, nor on a dry run', async () => {
    await writeFile(join(dir, 'vendor.js'), 'v();\n//# sourceMappingURL=vendor.js.map\n');
    await writeFile(join(dir, 'vendor.js.map'), plainMap);
    for (const extra of [
      {},
      { ownFiles: undefined },
      { dryRun: true, ownFiles: ['vendor.js', 'vendor.js.map'] },
    ]) {
      const { run, calls } = cli();
      await uploadSourcemaps(opts({ run, ...extra }));
      expect(calls.some((c) => c[1] === 'inject')).toBe(false);
    }
    expect(await readFile(join(dir, 'vendor.js'), 'utf8')).not.toContain('debugId');
  });

  it('a map with no bundle beside it, or a css map, is not a catch-up candidate', async () => {
    await writeFile(join(dir, 'w.js.map'), plainMap); // no w.js
    await writeFile(join(dir, 'a.css.map'), plainMap);
    await writeFile(join(dir, 'x.ts'), 'x();\n'); // a file beside the map that is not a script bundle
    await writeFile(join(dir, 'x.ts.map'), plainMap);
    const { run, calls } = cli();
    const onError = vi.fn();
    await uploadSourcemaps(
      opts({ run, onError, ownFiles: ['w.js.map', 'a.css.map', 'x.ts', 'x.ts.map'] }),
    );
    expect(calls.some((c) => c[1] === 'inject')).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(await readFile(join(dir, 'x.ts'), 'utf8')).toBe('x();\n');
  });

  it('a catch-up stamp that does not verify is restored and reported', async () => {
    await writeFile(join(dir, 'w.js'), 'w();\n//# sourceMappingURL=w.js.map\n');
    await writeFile(join(dir, 'w.js.map'), plainMap);
    const broken = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') {
        await writeFile(join(dir, 'w.js'), '{{');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const errors: unknown[] = [];
    await uploadSourcemaps(opts({ run: broken, onError: (e: unknown) => errors.push(e) }));
    expect(await readFile(join(dir, 'w.js'), 'utf8')).toBe('w();\n//# sourceMappingURL=w.js.map\n');
    expect(String(errors[0])).toContain('did not verify');
  });
});

describe('catch-up is best effort and never costs the build its other maps', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-catchup2-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const REG =
    '!function(){try{var e=globalThis;e._bugseeDebugIds=e._bugseeDebugIds||{}}catch(e){}}();';
  const STAMP = `\n;${REG}\n//# debugId=${ID}\n`;
  const plainMap = '{"version":3,"sources":["w.ts"],"names":[],"mappings":"AAAA"}';
  const keyed = JSON.stringify({ debugId: ID });
  const cli = (failFor?: string) => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      calls.push(args);
      if (args[1] === 'inject') {
        const paths = args.slice(2);
        if (failFor !== undefined && paths.some((x) => x.includes(failFor))) {
          for (const x of paths.filter((y) => y.includes(failFor) && y.endsWith('.js'))) {
            await writeFile(x, '{{'); // a partial, broken rewrite before the CLI dies
          }
          throw new Error('bugsee-cli exited 11');
        }
        for (const x of paths.filter((y) => /\.[cm]?js$/.test(y))) {
          const code = await readFile(x, 'utf8');
          if (!code.includes('//# debugId=')) await writeFile(x, code + STAMP);
        }
        for (const x of paths.filter((y) => y.endsWith('.map'))) {
          await writeFile(
            x,
            JSON.stringify({ ...JSON.parse(await readFile(x, 'utf8')), debugId: ID }),
          );
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    return { run, calls };
  };
  const opts = (extra: object = {}) => ({
    ...base,
    outDir: dir,
    preStamped: true,
    verifySri: async () => [],
    findSri: async () => [],
    ownFiles: [] as string[],
    onNotice: () => undefined,
    ...extra,
  });
  const own = (...names: string[]) => names.flatMap((n) => [n, `${n}.map`]);
  const seedPair = async (name: string, map = plainMap): Promise<void> => {
    await writeFile(join(dir, name), `${name}();\n//# sourceMappingURL=${name}.map\n`);
    await writeFile(join(dir, `${name}.map`), map);
  };

  for (const [label, bad] of [
    ['empty', ''],
    ['not JSON', 'not json'],
    ['an array', '[]'],
    ['null', 'null'],
  ] as const) {
    it(`a ${label} own map is skipped (never fed to the CLI), left untouched, and the good worker + a keyed map still upload`, async () => {
      await writeFile(join(dir, 'k.js.map'), keyed); // keyed, uploaded and deleted
      await seedPair('good.js');
      await seedPair('ext.js', bad);
      const { run, calls } = cli();
      const onError = vi.fn();
      const result = await uploadSourcemaps(
        opts({
          run,
          onError,
          failOnError: true,
          ownFiles: [...own('good.js', 'ext.js'), 'k.js.map'],
        }),
      );
      const inject = calls.filter((c) => c[1] === 'inject');
      expect(inject.flatMap((c) => c.slice(2)).some((x) => x.includes('ext.js'))).toBe(false);
      expect(onError).not.toHaveBeenCalled();
      expect(result.uploaded).toBe(true);
      expect(await readFile(join(dir, 'ext.js.map'), 'utf8')).toBe(bad);
      expect(await readdir(dir)).toContain('ext.js.map');
      expect(await readdir(dir)).not.toContain('good.js.map'); // stamped, uploaded, deleted
    });
  }

  it('a batch the CLI rejects is retried pair by pair: the good pair is stamped, the bad one restored and reported, the upload goes on', async () => {
    await seedPair('good.js');
    await seedPair('bad.js');
    const { run, calls } = cli('bad.js');
    const errors: unknown[] = [];
    const result = await uploadSourcemaps(
      opts({ run, onError: (e: unknown) => errors.push(e), ownFiles: own('good.js', 'bad.js') }),
    );
    expect(await readFile(join(dir, 'good.js'), 'utf8')).toContain('//# debugId=');
    expect(await readFile(join(dir, 'bad.js'), 'utf8')).toBe(
      'bad.js();\n//# sourceMappingURL=bad.js.map\n',
    ); // restored
    expect(errors.map(String).join('\n')).toContain('bad.js');
    expect(errors.map(String).join('\n')).toContain('exited 11');
    expect(calls.some((c) => c[0] === 'debug-files')).toBe(true);
    expect(result.uploaded).toBe(true);
  });

  it('a CLI failure (rewrite restored) is reported, never thrown, even under failOnError', async () => {
    await seedPair('bad.js');
    await writeFile(join(dir, 'k.js.map'), keyed);
    const errors: unknown[] = [];
    const result = await uploadSourcemaps(
      opts({
        run: cli('bad.js').run,
        failOnError: true,
        onError: (e: unknown) => errors.push(e),
        ownFiles: [...own('bad.js'), 'k.js.map'],
      }),
    );
    expect(result).toBeDefined();
    expect(errors.map(String).join('\n')).toContain('bad.js');
    expect(await readFile(join(dir, 'bad.js'), 'utf8')).toBe(
      'bad.js();\n//# sourceMappingURL=bad.js.map\n',
    );
  });

  it('a stamp that does not verify AND cannot be restored is a failOnError failure (unsafe state)', async () => {
    await seedPair('v.js');
    const sneaky = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') {
        await writeFile(join(dir, 'v.js'), '{{');
        await chmod(dir, 0o555); // the restore cannot create its temp file
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      await expect(
        uploadSourcemaps(
          opts({ run: sneaky, failOnError: true, ownFiles: own('v.js'), onError: () => undefined }),
        ),
      ).rejects.toThrow(/COULD NOT restore/);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('a stamp that does not verify but IS restored is reported (safe state)', async () => {
    await seedPair('v.js');
    await writeFile(join(dir, 'k.js.map'), keyed);
    const sneaky = vi.fn(async (args: string[]): Promise<SpawnResult> => {
      if (args[1] === 'inject') await writeFile(join(dir, 'v.js'), '{{');
      return { code: 0, stdout: '', stderr: '' };
    });
    const errors: unknown[] = [];
    await uploadSourcemaps(
      opts({
        run: sneaky,
        failOnError: true,
        ownFiles: [...own('v.js'), 'k.js.map'],
        onError: (e: unknown) => errors.push(e),
      }),
    );
    expect(String(errors[0])).toContain('did not verify');
    expect(await readFile(join(dir, 'v.js'), 'utf8')).toBe(
      'v.js();\n//# sourceMappingURL=v.js.map\n',
    );
  });

  it('an unexpected failure inside the catch-up is reported and the upload still happens', async () => {
    await writeFile(join(dir, 'k.js.map'), keyed);
    await seedPair('w.js');
    const { run, calls } = cli();
    const errors: unknown[] = [];
    await uploadSourcemaps(
      opts({
        run,
        onError: (e: unknown) => errors.push(e),
        ownFiles: [...own('w.js'), 'k.js.map'],
        findSri: async () => {
          throw new Error('sri scan exploded');
        },
      }),
    );
    expect(errors.map(String).join('\n')).toContain('sri scan exploded');
    expect(calls.some((c) => c[0] === 'debug-files')).toBe(true);
  });

  it('stamps .mjs and .cjs pairs too', async () => {
    await seedPair('m.mjs');
    await seedPair('c.cjs');
    const { run, calls } = cli();
    await uploadSourcemaps(opts({ run, ownFiles: own('m.mjs', 'c.cjs') }));
    const injected = calls.filter((c) => c[1] === 'inject').flatMap((c) => c.slice(2));
    expect(injected).toEqual(expect.arrayContaining([join(dir, 'm.mjs'), join(dir, 'c.cjs')]));
    expect(await readFile(join(dir, 'm.mjs'), 'utf8')).toContain('//# debugId=');
    expect(await readFile(join(dir, 'c.cjs'), 'utf8')).toContain('//# debugId=');
  });

  it('says nothing about blocked scripts when none is blocked, and removes its spill directory', async () => {
    await seedPair('w.js');
    const notices: string[] = [];
    const spillRoot = await mkdtemp(join(tmpdir(), 'bugsee-spill-cu-'));
    try {
      await uploadSourcemaps(
        opts({
          run: cli().run,
          ownFiles: own('w.js'),
          onNotice: (m: string) => notices.push(m),
          spillRoot,
        }),
      );
      expect(notices.join('\n')).not.toContain('Subresource Integrity');
      expect(await readdir(spillRoot)).toEqual([]);
    } finally {
      await rm(spillRoot, { recursive: true, force: true });
    }
  });

  it('a pinned bundle with the registration but NO debugId comment is not "stamped" either', async () => {
    await writeFile(join(dir, 'r.js'), `r();\n//# sourceMappingURL=r.js.map\n;${REG}\n`);
    await writeFile(join(dir, 'r.js.map'), plainMap);
    const { run, calls } = cli();
    await uploadSourcemaps(
      opts({
        run,
        ownFiles: own('r.js'),
        findSri: async () => [
          { html: join(dir, 'i.html'), script: join(dir, 'r.js'), integrity: 'sha384-X' },
        ],
      }),
    );
    expect(calls.some((c) => c[1] === 'inject')).toBe(false);
  });

  it('a pinned bundle with a FOREIGN debugId comment but no registration snippet is not "stamped" (inject would append the snippet): left alone', async () => {
    await writeFile(join(dir, 'f.js'), `f();\n//# sourceMappingURL=f.js.map\n//# debugId=${ID}\n`);
    await writeFile(join(dir, 'f.js.map'), plainMap);
    const { run, calls } = cli();
    const notices: string[] = [];
    await uploadSourcemaps(
      opts({
        run,
        ownFiles: own('f.js'),
        onNotice: (m: string) => notices.push(m),
        findSri: async () => [
          { html: join(dir, 'i.html'), script: join(dir, 'f.js'), integrity: 'sha384-X' },
        ],
      }),
    );
    expect(calls.some((c) => c[1] === 'inject')).toBe(false);
    expect(notices.join('\n')).toContain('f.js');
  });
});
