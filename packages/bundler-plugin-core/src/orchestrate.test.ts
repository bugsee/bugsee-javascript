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

  it('dry-run: passes --dry-run to both commands and skips deletion', async () => {
    const { run, calls } = fakeRun();
    const deleteMapFiles = vi.fn(async () => ['x']);
    const result = await uploadSourcemaps({ ...base, run, deleteMapFiles, dryRun: true });
    expect(calls[0]?.args).toContain('--dry-run');
    expect(calls[1]?.args).toContain('--dry-run');
    expect(deleteMapFiles).not.toHaveBeenCalled();
    expect(result.deletedMaps).toEqual([]);
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
